// Local proxy server that bridges opencode (or any OpenAI-compatible client)
// to DevEco Code's model API.
//
// Why this exists: the published opencode binary does not load external
// plugins' auth hooks, so we cannot inject the DevEco Bearer token via the
// plugin system. Instead, opencode talks to THIS local proxy as if it were an
// OpenAI endpoint; the proxy holds the DevEco credentials, injects the right
// Authorization header, applies DevEco's URL quirks, and forwards to the real
// DevEco backend.
//
// Endpoints (under http://127.0.0.1:<port>/v2):
//   POST /v2/chat/completions   — forwarded to DevEco (stream or /no-stream)
//   GET  /v2/models             — lists available DevEco models (static + dynamic)
//   GET  /v2/login              — triggers browser Huawei OAuth login (optional;
//                                  if not logged in, the first request auto-triggers)
//   GET  /v2/status             — { logged_in, user, expires_in_ms }
//   GET  /v2/logout             — clears stored credentials

import http from "node:http"
import crypto from "node:crypto"
import {
  ACCESS_TOKEN_EXPIRES_MS,
  DEVECO_API_BASE,
  DEVECO_DEFAULTS,
  DEVECO_BASE_URL,
  log,
} from "./config.js"
import { createLoginService, type UserInfo } from "./auth-login.js"
import { JsonTokenStore } from "./token-store.js"
import { getDevecoProviderConfig } from "./models.js"

const DEVECO_ORIGIN = new URL(DEVECO_API_BASE).origin // https://cn.devecostudio.huawei.com
const DEVECO_API_PREFIX = new URL(DEVECO_API_BASE).pathname.replace(/\/$/, "") // /sse/codeGenie/maas/v2

interface Session {
  userInfo: UserInfo | null
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
}

export interface ProxyOptions {
  port?: number
  hostname?: string
}

interface UsageInfo {
  prompt_tokens?: number
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

export class DevEcoProxy {
  private readonly port: number
  private readonly hostname: string
  private server: http.Server | null = null
  private session: Session | null = null
  private readonly loginService
  private readonly tokenStore
  // Per-session Chat-Id mapping for the DevEco backend.
  private readonly sessionChatIdMap = new Map<string, string>()
  // Track in-flight requests for graceful shutdown.
  private readonly activeRequests = new Set<http.ServerResponse>()

  constructor(opts: ProxyOptions = {}) {
    this.port = opts.port ?? 17128
    this.hostname = opts.hostname ?? "127.0.0.1"
    this.tokenStore = new JsonTokenStore()
    this.loginService = createLoginService(this.tokenStore)
  }

  async start(): Promise<void> {
    // Try to restore an existing session from stored jwtToken (best-effort).
    await this.tryRestoreSession().catch(() => {
      /* ignore */
    })

    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject)
      this.server!.listen(this.port, this.hostname, () => resolve())
    })
    log.info(`opencode-deveco proxy listening on http://${this.hostname}:${this.port}`)
    log.info(`  forward POST /v2/chat/completions -> DevEco`)
    log.info(`  login:  GET  /v2/login   (or just send a request)`)
  }

  async stop(): Promise<void> {
    if (!this.server) return
    // Stop accepting new connections; wait for in-flight requests to finish.
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  getPort(): number {
    return this.port
  }

  /** Track a response so stop() can wait for it to finish. */
  private trackRequest(res: http.ServerResponse): void {
    this.activeRequests.add(res)
    res.on("finish", () => this.activeRequests.delete(res))
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  private async tryRestoreSession(): Promise<void> {
    const jwtToken = await this.tokenStore.load()
    if (!jwtToken) return
    // Try refreshing once on startup to validate the token still works.
    const refreshed = await this.loginService.refreshToken(jwtToken)
    if (refreshed) {
      this.session = {
        userInfo: this.loginService.getUserInfo(),
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
      }
      log.info("restored DevEco session from stored jwtToken")
    }
  }

  /** Ensure we have a non-expired access token; login or refresh as needed. */
  private async ensureToken(): Promise<string> {
    if (this.session && this.session.expiresAt > Date.now()) {
      return this.session.accessToken
    }

    // Try refresh first (cheaper, headless).
    if (this.session || (await this.tokenStore.load())) {
      const jwtToken = await this.tokenStore.load()
      if (jwtToken) {
        const refreshed = await this.loginService.refreshToken(jwtToken)
        if (refreshed) {
          this.session = {
            userInfo: this.session?.userInfo ?? this.loginService.getUserInfo(),
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
          }
          log.info("refreshed DevEco access token")
          return this.session.accessToken
        }
      }
    }

    // Fall back to interactive browser login.
    log.info("no valid DevEco token; starting browser login")
    const result = await this.loginService.login()
    if (!result.success || !result.userInfo) {
      throw new Error(result.error || "DevEco login failed")
    }
    this.session = {
      userInfo: result.userInfo,
      accessToken: result.userInfo.accessToken,
      refreshToken: result.userInfo.refreshToken,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
    }
    return this.session.accessToken
  }

  // ---------------------------------------------------------------------------
  // HTTP routing
  // ---------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.trackRequest(res)
    const host = req.headers.host || `${this.hostname}:${this.port}`
    const url = new URL(req.url ?? "/", `http://${host}`)
    // Normalise: strip /v2 prefix so all route checks are simple.
    const p = url.pathname.replace(/^\/v2/, "") || "/"

    try {
      if (p === "/status") {
        return this.json(res, 200, {
          logged_in: !!this.session,
          user: this.session?.userInfo?.userName ?? null,
          expires_in_ms: this.session ? Math.max(0, this.session.expiresAt - Date.now()) : 0,
        })
      }

      if (p === "/login") {
        const result = await this.loginService.login()
        if (!result.success || !result.userInfo) {
          return this.json(res, 401, { error: result.error || "login failed" })
        }
        this.session = {
          userInfo: result.userInfo,
          accessToken: result.userInfo.accessToken,
          refreshToken: result.userInfo.refreshToken,
          expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
        }
        return this.json(res, 200, {
          ok: true,
          user: result.userInfo.userName,
          expires_in_ms: ACCESS_TOKEN_EXPIRES_MS,
        })
      }

      if (p === "/logout") {
        await this.loginService.logout()
        this.session = null
        return this.json(res, 200, { ok: true })
      }

      if (p === "/models") {
        const token = await this.ensureToken().catch(() => "")
        const cfg = await getDevecoProviderConfig(token)
        const data = Object.keys(cfg.models ?? {}).map((id) => ({ id, object: "model" }))
        return this.json(res, 200, { object: "list", data })
      }

      if (p === "/chat/completions") {
        return this.forwardChat(req, res)
      }

      return this.json(res, 404, { error: `not found: ${url.pathname}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("proxy handle error", { error: msg })
      return this.json(res, 500, { error: msg })
    }
  }

  // ---------------------------------------------------------------------------
  // Forwarding
  // ---------------------------------------------------------------------------

  private async forwardChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Read the full request body.
    const bodyBuffer = await this.readBody(req)
    let stream = true
    let model = "?"
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf8"))
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>
        if (obj.stream === false) stream = false
        if (typeof obj.model === "string") model = obj.model
      }
    } catch {
      /* forward as-is if not JSON */
    }

    let accessToken: string
    try {
      accessToken = await this.ensureToken()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(401, { "Content-Type": "application/json" })
      return void res.end(JSON.stringify({ error: { message: msg, type: "auth_error" } }))
    }

    // Build the upstream URL. DevEco needs /no-stream in the path for
    // non-streaming requests:
    //   /v2/chat/completions        -> streaming
    //   /v2/no-stream/chat/completions -> non-streaming
    const upstreamPath = stream
      ? `${DEVECO_API_PREFIX}/chat/completions`
      : `${DEVECO_API_PREFIX}/no-stream/chat/completions`
    const upstreamUrl = `${DEVECO_ORIGIN}${upstreamPath}`

    // DevEco-required headers.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      lang: "en",
      "Chat-Id": crypto.randomUUID().replace(/-/g, ""),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "accept-language": "zh-CN",
    }

    const ctx = { model, stream, upstreamUrl, t0: Date.now() }
    log.info(`-> POST ${stream ? "stream" : "no-stream"} model=${model}`)

    // fetch's BodyInit type under our DOM lib settings doesn't accept Buffer/
    // Uint8Array directly, but node's fetch accepts raw bytes at runtime.
    const bodyInit = bodyBuffer as unknown as BodyInit

    // Forward to DevEco and stream/passthrough the response back.
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyInit,
      signal: AbortSignal.timeout(60_000),
    }).catch((err) => {
      throw new Error(`upstream fetch failed: ${String(err)}`)
    })

    // If DevEco says our token is bad/refresh needed, try one refresh+retry.
    let responseToPipe = upstream
    if (upstream.status === 401 && this.session) {
      const jwtToken = await this.tokenStore.load()
      if (jwtToken) {
        const refreshed = await this.loginService.refreshToken(jwtToken)
        if (refreshed) {
          this.session.accessToken = refreshed.accessToken
          this.session.refreshToken = refreshed.refreshToken
          this.session.expiresAt = Date.now() + ACCESS_TOKEN_EXPIRES_MS
          headers.Authorization = `Bearer ${refreshed.accessToken}`
          log.warn("upstream 401 → refreshed token, retrying once")
          responseToPipe = await fetch(upstreamUrl, {
            method: "POST",
            headers,
            body: bodyInit,
            signal: AbortSignal.timeout(60_000),
          })
        }
      }
    }

    return this.pipeResponse(responseToPipe, res, stream, ctx)
  }

  private async pipeResponse(
    upstream: Response,
    res: http.ServerResponse,
    stream: boolean,
    ctx?: { model: string; stream: boolean; upstreamUrl: string; t0: number },
  ): Promise<void> {
    const respHeaders: Record<string, string> = {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    }
    res.writeHead(upstream.status, respHeaders)

    // For logging: capture the last SSE `usage` (streaming) or the JSON
    // `usage` field (non-streaming). We accumulate a small tail buffer.
    let usage: UsageInfo | undefined = undefined
    let lastChunkModel: string | undefined
    const tailChunks: Buffer[] = []
    const TAIL_KEEP = 4 // keep last few SSE chunks to find usage

    if (upstream.body) {
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
        if (ctx) {
          tailChunks.push(Buffer.from(value))
          if (tailChunks.length > TAIL_KEEP) tailChunks.shift()
        }
      }
    }
    res.end()

    if (ctx) {
      // Try to extract usage from the captured tail.
      try {
        const tailStr = Buffer.concat(tailChunks).toString("utf8")
        // SSE: lines starting with "data: " ; the last non-[DONE] one has usage.
        const dataLines = tailStr
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .filter((l) => l && l !== "[DONE]")
        const lastJson = dataLines.length ? JSON.parse(dataLines[dataLines.length - 1]) : null
        if (lastJson?.usage) usage = lastJson.usage
        if (lastJson?.model) lastChunkModel = lastJson.model
        // Non-streaming: whole body is one JSON.
        if (!stream && !usage) {
          const whole = JSON.parse(tailStr)
          if (whole?.usage) usage = whole.usage
          if (whole?.model) lastChunkModel = whole.model
        }
      } catch {
        /* best-effort; skip if unparseable */
      }

      const dur = Date.now() - ctx.t0
      const status = upstream.status
      const tokStr = usage
        ? `in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}` +
          (usage.completion_tokens_details?.reasoning_tokens
            ? ` reasoning=${usage.completion_tokens_details.reasoning_tokens}`
            : "")
        : "tokens=?"
      const realModel = lastChunkModel ? ` (backend: ${lastChunkModel})` : ""
      const lvl = status >= 200 && status < 300 ? "info" : "warn"
      log[lvl](
        `<- ${status} ${dur}ms ${tokStr} model=${ctx.model}${realModel}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => resolve(Buffer.concat(chunks)))
      req.on("error", reject)
    })
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }
}

// ---------------------------------------------------------------------------
// Standalone CLI entry: `node dist/proxy.js` runs the proxy directly.
// ---------------------------------------------------------------------------

export async function runProxy(opts: ProxyOptions = {}): Promise<DevEcoProxy> {
  const proxy = new DevEcoProxy(opts)
  await proxy.start()
  return proxy
}

// Allow `node dist/proxy.js` to start a long-running proxy.
// (Guarded so importing the module doesn't auto-start.)
const isDirectRun = (() => {
  try {
    return process.argv[1] && /proxy\.js$/.test(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const portArg = process.argv.find((a) => a.startsWith("--port="))
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : 17128

  let proxy: DevEcoProxy | null = null

  async function shutdown() {
    if (!proxy) return
    log.info("shutting down gracefully...")
    await proxy.stop()
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  runProxy({ port })
    .then((p) => {
      proxy = p
    })
    .catch((err) => {
      log.error("proxy failed to start", { error: String(err) })
      process.exit(1)
    })
}

export { DEVECO_BASE_URL, DEVECO_DEFAULTS }
