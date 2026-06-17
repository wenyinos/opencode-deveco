// The opencode-deveco plugin entry (hybrid architecture).
//
// The published opencode binary does NOT load external plugins' auth hooks, so
// this plugin cannot inject the DevEco Bearer token directly. Instead it uses a
// HYBRID approach:
//
//   1. On load, it starts a LOCAL PROXY server (DevEcoProxy) that holds the
//      DevEco credentials and forwards requests to the real DevEco backend.
//   2. The config hook injects a `deveco` provider whose baseURL points at the
//      local proxy. opencode then sends normal OpenAI-style requests to the
//      proxy; the proxy adds auth + applies DevEco URL quirks + forwards.
//
// The `auth` hook (loader + methods) is still returned for forward-compat: on
// opencode versions that DO load external plugin auth, the auth.loader's custom
// fetch takes over (bypassing the proxy). On versions that don't, the proxy is
// the live path.

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import {
  ACCESS_TOKEN_EXPIRES_MS,
  DEVECO_DEFAULTS,
  OAUTH_DUMMY_KEY,
  PROVIDER_ID,
  type ProviderInfo,
  log,
} from "./config.js"
import { createLoginService } from "./auth-login.js"
import { JsonTokenStore } from "./token-store.js"
import { getDevecoProviderConfig, resetModelCache } from "./models.js"
import { DevEcoProxy } from "./proxy.js"

// Default local proxy port. Kept in sync with README and the standalone CLI.
const PROXY_PORT = Number(process.env.DEVECO_PROXY_PORT) || 17128
const PROXY_HOST = "127.0.0.1"
const PROXY_BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}/v2`

// Shared singletons (used by the auth-hook fallback path).
const tokenStore = new JsonTokenStore()
const loginService = createLoginService(tokenStore)

// Per-session Chat-Id map for the auth-loader fallback path.
const sessionChatIdMap = new Map<string, string>()

// Proxy lifecycle — started once on plugin load.
let proxyStarted: Promise<DevEcoProxy> | null = null

function startProxy(): Promise<DevEcoProxy> {
  if (!proxyStarted) {
    proxyStarted = (async () => {
      const proxy = new DevEcoProxy({ port: PROXY_PORT, hostname: PROXY_HOST })
      await proxy.start()
      return proxy
    })().catch((err) => {
      proxyStarted = null // allow retry
      log.error("failed to start DevEco proxy", { error: String(err) })
      throw err
    })
  }
  return proxyStarted
}

// ---------------------------------------------------------------------------
// config hook — inject a `deveco` provider that points at our local proxy.
// Static default models are injected so `opencode models` lists them even when
// the dynamic fetch hasn't run yet. Does not clobber an existing entry.
// ---------------------------------------------------------------------------

function applyConfigHook(cfg: { provider?: Record<string, unknown> }): void {
  try {
    if (!cfg || typeof cfg !== "object") return
    cfg.provider ??= {}
    if (!cfg.provider[PROVIDER_ID]) {
      const provider: ProviderInfo = {
        name: "DevEco Code",
        npm: "@ai-sdk/openai-compatible",
        api: PROXY_BASE_URL,
        env: [],
        options: { apiKey: OAUTH_DUMMY_KEY, baseURL: PROXY_BASE_URL },
        models: { ...DEVECO_DEFAULTS.provider.models },
      }
      cfg.provider[PROVIDER_ID] = provider
    }
  } catch (err) {
    log.error("config hook failed", { error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// auth.loader (forward-compat fallback) — injects the Bearer token directly
// when opencode loads plugin auth. Used by opencode versions that support
// external plugin auth; otherwise unused (the proxy is the live path).
// ---------------------------------------------------------------------------

function isOAuthLike(v: unknown): v is {
  type: "oauth"
  access?: string
  refresh?: string
  expires?: number
} {
  return !!v && typeof v === "object" && (v as Record<string, unknown>).type === "oauth"
}

function buildAuthedFetch(
  getAuth: () => Promise<unknown>,
  persistAuth: (a: string, r: string, e: number) => Promise<void>,
) {
  return async function devEcoFetch(
    requestInput: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.delete("authorization")
        init.headers.delete("Authorization")
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter(([k]) => k.toLowerCase() !== "authorization")
      } else {
        const h = { ...init.headers }
        delete h["authorization"]
        delete h["Authorization"]
        init.headers = h as Record<string, string>
      }
    }

    const current = await getAuth()
    if (!isOAuthLike(current)) return fetch(requestInput as RequestInfo, init)

    if (!current.access || (current.expires ?? 0) < Date.now()) {
      const jwtToken = await tokenStore.load()
      if (jwtToken) {
        const refreshed = await loginService.refreshToken(jwtToken)
        if (refreshed?.accessToken) {
          const exp = Date.now() + ACCESS_TOKEN_EXPIRES_MS
          await persistAuth(refreshed.accessToken, refreshed.refreshToken, exp)
          current.access = refreshed.accessToken
          if (current.refresh !== undefined) current.refresh = refreshed.refreshToken
          current.expires = exp
        } else {
          return new Response(
            JSON.stringify({ error: "Token refresh failed. Please re-login." }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          )
        }
      } else {
        return new Response(
          JSON.stringify({ error: "DevEco login expired. Please re-login." }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        )
      }
    }

    const headers = new Headers()
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => headers.set(k, v))
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) if (v !== undefined) headers.set(k, String(v))
      } else {
        for (const [k, v] of Object.entries(init.headers))
          if (v !== undefined) headers.set(k, String(v))
      }
    }
    if (current.access) headers.set("authorization", `Bearer ${current.access}`)
    headers.set("lang", "en")
    const sessionId =
      headers.get("x-deveco-session") || headers.get("x-session-affinity")
    const chatId =
      (sessionId && sessionChatIdMap.get(sessionId)) ||
      crypto.randomUUID().replace(/-/g, "")
    headers.set("Chat-Id", chatId)
    if (sessionId) {
      sessionChatIdMap.set(sessionId, chatId)
      headers.set("Session-Id", sessionId)
    }

    let finalInput: RequestInfo | URL = requestInput
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as { stream?: unknown }
        if (body?.stream !== true) {
          const url =
            requestInput instanceof URL
              ? new URL(requestInput.toString())
              : new URL(
                  typeof requestInput === "string"
                    ? requestInput
                    : (requestInput as Request).url,
                )
          url.pathname = url.pathname
            .replace(/\/$/, "")
            .replace(/\/chat\/completions$/, "/no-stream/chat/completions")
          finalInput = url
        }
      } catch {
        /* ignore */
      }
    }
    void getDevecoProviderConfig(current.access ?? "").catch(() => {})
    return fetch(finalInput as RequestInfo, { ...init, headers })
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const DevEcoPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  log.info("opencode-deveco plugin LOADED; starting local proxy")

  // Start the proxy (fire-and-forget; failures are logged).
  void startProxy().catch(() => {
    /* logged in startProxy */
  })

  const persistAuth = async (a: string, r: string, e: number): Promise<void> => {
    try {
      await input.client.auth.set({
        path: { id: PROVIDER_ID },
        body: { type: "oauth", access: a, refresh: r, expires: e },
      })
    } catch (err) {
      log.error("failed to persist refreshed auth via client.auth.set", {
        error: String(err),
      })
    }
  }

  return {
    config: async (cfg) => applyConfigHook(cfg),
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth: () => Promise<unknown>, _provider: unknown) {
        const info = await getAuth()
        if (!info) return {}
        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: buildAuthedFetch(getAuth as () => Promise<unknown>, persistAuth),
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with Huawei DevEco Account",
          async authorize() {
            return {
              url: "",
              instructions: "Opening browser for login...",
              method: "auto" as const,
              async callback() {
                resetModelCache()
                const result = await loginService.login()
                if (!result.success) {
                  return {
                    type: "failed" as const,
                    error: result.unsupportedRegion
                      ? "Sorry, only China site accounts are currently supported"
                      : result.error || "Login failed",
                  }
                }
                return {
                  type: "success" as const,
                  provider: PROVIDER_ID,
                  access: result.userInfo?.accessToken || "",
                  refresh: result.userInfo?.refreshToken || "",
                  expires: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
                }
              },
            }
          },
        },
      ],
    },
  }
}
