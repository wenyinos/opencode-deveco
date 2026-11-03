// Outgoing HTTP that honours HTTP(S)_PROXY / NO_PROXY when configured.
//
// Node's built-in fetch ignores the proxy environment (unlike Bun's, which is
// what the upstream DevEco Code client runs on). Behind a corporate proxy the
// browser completes the Huawei OAuth flow but the token exchange then dies with
// `getaddrinfo ENOTFOUND cn.devecostudio.huawei.com`, so every outgoing call in
// this process goes through this wrapper.
//
// When no proxy variable is set we keep the global fetch: that is a no-op for
// normal users and it leaves tests' fetch stubs in charge.
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici"
import { log } from "./config.js"

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const

/** Whether the process was started with a proxy configured. */
export function envProxyConfigured(): boolean {
  return PROXY_ENV_KEYS.some((key) => {
    const value = process.env[key]
    return typeof value === "string" && value.trim() !== ""
  })
}

let dispatcher: EnvHttpProxyAgent | undefined

type ProxyInit = RequestInit & { duplex?: "half" }

/**
 * undici's fetch only accepts its own Request class, not Node's global one
 * (opencode passes a Request to the auth-loader's fetch). Normalise it back to
 * a URL plus init, merging the caller's overrides in fetch-spec order.
 */
function isRequest(input: string | URL | Request): input is Request {
  return typeof Request !== "undefined" && input instanceof Request
}

function normalizeInput(
  input: string | URL | Request,
  init?: RequestInit,
): { input: string | URL; init?: ProxyInit } {
  if (!isRequest(input)) return { input, init }

  const headers = new Headers(input.headers)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  const merged: ProxyInit = {
    ...init,
    method: init?.method ?? input.method,
    headers,
    body: init?.body ?? input.body,
  }
  // A streamed body needs the other half of the duplex pair; without this
  // undici rejects the request before it reaches the proxy.
  if (merged.body !== null && typeof merged.body === "object" && "getReader" in merged.body) {
    merged.duplex ??= "half"
  }
  return { input: input.url, init: merged }
}

/**
 * Drop-in replacement for the global fetch. With a proxy configured it uses
 * undici's EnvHttpProxyAgent, which also applies NO_PROXY; otherwise the
 * global fetch is used unchanged.
 */
export function envFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!envProxyConfigured()) return fetch(input, init)
  try {
    dispatcher ??= new EnvHttpProxyAgent()
  } catch (err) {
    // A malformed HTTP(S)_PROXY must not take the whole process down; lose the
    // proxy (and say so) rather than every request.
    log.warn("invalid proxy environment, falling back to a direct connection", {
      error: String(err),
    })
    return fetch(input, init)
  }
  const normalized = normalizeInput(input, init)
  return undiciFetch(
    normalized.input as Parameters<typeof undiciFetch>[0],
    { ...(normalized.init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>
}
