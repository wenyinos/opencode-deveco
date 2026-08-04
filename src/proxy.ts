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
  DEVECO_EXIT_QUEUE_URL,
  UPSTREAM_IDLE_TIMEOUT_MS,
  log,
} from "./config.js"
import { createLoginService, userInfoFromJwt, type RefreshResult, type UserInfo } from "./auth-login.js"
import { JsonTokenStore } from "./token-store.js"
import { getDevecoProviderConfig } from "./models.js"
import {
  anthropicToOpenaiChat,
  openaiChatToAnthropic,
  openaiChatStreamToAnthropic,
  type AnthropicRequest,
} from "./anthropic-transform.js"

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

/**
 * An idle budget for one upstream call: aborts only after the backend has been
 * silent for `idleMs`. `touch()` restarts the clock on every byte received;
 * `done()` disarms it once the turn is over.
 */
export function idleBudget(idleMs: number): {
  signal: AbortSignal
  touch: () => void
  done: () => void
} {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const done = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const touch = () => {
    done()
    timer = setTimeout(
      () => controller.abort(new Error(`upstream silent for ${idleMs}ms`)),
      idleMs,
    )
  }
  touch()
  return { signal: controller.signal, touch, done }
}

/**
 * A stable per-conversation key.
 *
 * Neither the Anthropic nor the OpenAI wire format carries a session id, but a
 * conversation's opening turn never changes as it grows — so hashing the system
 * prompt plus the first message identifies the conversation across rounds, which
 * is what DevEco's Chat-Id is expected to track.
 */
export function conversationKey(body: unknown): string {
  try {
    const b = body as { system?: unknown; messages?: unknown[] }
    const head = JSON.stringify([b.system ?? "", b.messages?.[0] ?? ""])
    return crypto.createHash("sha256").update(head).digest("hex").slice(0, 32)
  } catch {
    return crypto.randomUUID().replace(/-/g, "")
  }
}

export class DevEcoProxy {
  private readonly port: number
  private readonly hostname: string
  private server: http.Server | null = null
  private session: Session | null = null
  private readonly loginService
  private readonly tokenStore
  // Conversation key -> the DevEco Chat-Id that conversation is pinned to.
  private readonly sessionChatIdMap = new Map<string, string>()
  // A browser login in flight, shared by all callers so concurrent requests
  // never spin up competing callback servers.
  private pendingLogin: Promise<string> | null = null
  // Single-flight + cooldown for access-token refresh: concurrent callers share
  // one in-flight refresh, and a recent failure short-circuits retries so an
  // invalid credential isn't hammered by every request.
  private refreshPromise: Promise<RefreshResult | null> | null = null
  private lastRefreshFailedAt = 0
  private static readonly REFRESH_COOLDOWN_MS = 30_000
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

  /**
   * The Chat-Id this conversation is pinned to, minted on first sight.
   *
   * DevEco keys server-side turn state on (Session-Id, Chat-Id); a fresh id per
   * request makes every turn look like a brand-new chat.
   */
  private chatIdFor(key: string): string {
    let chatId = this.sessionChatIdMap.get(key)
    if (!chatId) {
      // Bound the map: these are cheap, and a long-lived proxy would otherwise
      // accumulate one entry per conversation forever.
      if (this.sessionChatIdMap.size >= 500) {
        this.sessionChatIdMap.delete(this.sessionChatIdMap.keys().next().value!)
      }
      chatId = crypto.randomUUID().replace(/-/g, "")
      this.sessionChatIdMap.set(key, chatId)
    }
    return chatId
  }

  /**
   * Release the queue slot this turn held. Fire-and-forget, exactly as upstream
   * treats it: a failure here must never surface to the client, whose answer
   * has already been delivered.
   */
  private exitQueue(key: string, chatId: string, model: string, token: string): void {
    const url = `${DEVECO_EXIT_QUEUE_URL}?modelId=${encodeURIComponent(model)}`
    void fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Session-Id": key,
        "Chat-Id": chatId,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => {
        // Silent when it works; a slot we failed to release is worth seeing,
        // since the symptom (errors after many turns) is otherwise baffling.
        if (r.ok) log.debug(`exitSessionQueue -> ${r.status}`)
        else log.warn(`exitSessionQueue -> HTTP ${r.status}`)
      })
      .catch((err) => log.warn("exitSessionQueue failed", { error: String(err) }))
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
      const userInfo = this.loginService.getUserInfo() ?? userInfoFromJwt(jwtToken, refreshed)
      this.session = {
        userInfo,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
      }
      log.info(`restored DevEco session from stored jwtToken (user: ${userInfo?.userName ?? "?"})`)
    }
  }

  /**
   * Start a browser login, or join the one already running, and return the URL
   * to visit. Resolves as soon as the URL exists — the actual sign-in completes
   * in the background and installs the session when it lands.
   */
  private beginLogin(openBrowser: boolean): Promise<string> {
    if (this.pendingLogin) return this.pendingLogin

    const pending = (async () => {
      const { url, result } = await this.loginService.startLogin({ openBrowser })
      void result
        .then((r) => {
          if (r.success && r.userInfo) {
            this.session = {
              userInfo: r.userInfo,
              accessToken: r.userInfo.accessToken,
              refreshToken: r.userInfo.refreshToken,
              expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
            }
            log.info(`DevEco login complete (user: ${r.userInfo.userName})`)
          } else {
            log.warn("DevEco login did not complete", { error: r.error })
          }
        })
        .finally(() => {
          this.pendingLogin = null
        })
      return url
    })()

    // A login we failed to even start must not wedge every later attempt.
    pending.catch(() => {
      this.pendingLogin = null
    })
    this.pendingLogin = pending
    return pending
  }

  /**
   * Refresh the access token, deduped across concurrent callers and gated by a
   * cooldown after a recent failure. Returns new tokens, or null on failure.
   */
  private async refreshAccessToken(jwtToken: string): Promise<RefreshResult | null> {
    if (
      this.lastRefreshFailedAt &&
      Date.now() - this.lastRefreshFailedAt < DevEcoProxy.REFRESH_COOLDOWN_MS
    ) {
      log.warn("token refresh skipped: in cooldown after recent failure")
      return null
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.loginService.refreshToken(jwtToken).finally(() => {
        this.refreshPromise = null
      })
    }
    const refreshed = await this.refreshPromise
    if (refreshed) this.lastRefreshFailedAt = 0
    else this.lastRefreshFailedAt = Date.now()
    return refreshed
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
        const refreshed = await this.refreshAccessToken(jwtToken)
        if (refreshed) {
          this.session = {
            userInfo:
              this.session?.userInfo ??
              this.loginService.getUserInfo() ??
              userInfoFromJwt(jwtToken, refreshed),
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
          }
          log.info("refreshed DevEco access token")
          return this.session.accessToken
        }
      }
    }

    // No usable credentials. Kick off a browser login in the background and
    // fail *this* request immediately: waiting here would hang the client for
    // the full 10-minute callback window, which is what "no reply" looks like.
    log.info("no valid DevEco token; starting browser login")
    const url = await this.beginLogin(true)
    throw new Error(
      `DevEco login required. A browser should have opened — if it did not, visit: ${url}`,
    )
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
        // Whoever called this can already reach a browser — redirect them to
        // Huawei instead of opening a second window, and don't hold the
        // connection open for the callback. The JSON body means callers that
        // don't follow redirects (curl without -L) still get the URL.
        // Poll GET /v2/status to see when the sign-in lands.
        const url = await this.beginLogin(false)
        res.writeHead(302, { Location: url, "Content-Type": "application/json" })
        return void res.end(JSON.stringify({ login_url: url }))
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

      if (p === "/anthropic/v1/messages" && req.method === "POST") {
        return this.forwardAnthropic(req, res)
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
    let convKey = crypto.randomUUID().replace(/-/g, "")
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf8"))
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>
        // Default to non-streaming: only an explicit `stream: true` opts in to
        // SSE (opencode's streamText always sends `stream: true`; other clients
        // usually expect a JSON reply when they don't ask for a stream).
        if (obj.stream !== true) stream = false
        if (typeof obj.model === "string") model = obj.model
        convKey = conversationKey(parsed)
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
    const chatId = this.chatIdFor(convKey)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      lang: "en",
      "Chat-Id": chatId,
      "Session-Id": convKey,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "accept-language": "zh-CN",
    }

    const ctx = { model, stream, upstreamUrl, t0: Date.now() }
    log.info(`-> POST ${stream ? "stream" : "no-stream"} model=${model}`)

    // fetch's BodyInit type under our DOM lib settings doesn't accept Buffer/
    // Uint8Array directly, but node's fetch accepts raw bytes at runtime.
    const bodyInit = bodyBuffer as unknown as BodyInit

    const budget = idleBudget(UPSTREAM_IDLE_TIMEOUT_MS)

    // Forward to DevEco and stream/passthrough the response back.
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyInit,
      signal: budget.signal,
    }).catch((err) => {
      budget.done()
      throw new Error(`upstream fetch failed: ${String(err)}`)
    })

    // If DevEco says our token is bad/refresh needed, try one refresh+retry.
    let responseToPipe = upstream
    if (upstream.status === 401 && this.session) {
      const jwtToken = await this.tokenStore.load()
      if (jwtToken) {
        const refreshed = await this.refreshAccessToken(jwtToken)
        if (refreshed) {
          this.session.accessToken = refreshed.accessToken
          this.session.refreshToken = refreshed.refreshToken
          this.session.expiresAt = Date.now() + ACCESS_TOKEN_EXPIRES_MS
          headers.Authorization = `Bearer ${refreshed.accessToken}`
          log.warn("upstream 401 → refreshed token, retrying once")
          budget.touch()
          responseToPipe = await fetch(upstreamUrl, {
            method: "POST",
            headers,
            body: bodyInit,
            signal: budget.signal,
          })
        }
      }
    }

    try {
      await this.pipeResponse(responseToPipe, res, stream, ctx, budget.touch)
    } finally {
      budget.done()
      this.exitQueue(convKey, chatId, model, accessToken)
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic Messages API forwarding (Claude Code compatibility)
  // ---------------------------------------------------------------------------

  private async forwardAnthropic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const bodyBuffer = await this.readBody(req)

    let anthropicReq: AnthropicRequest
    try {
      anthropicReq = JSON.parse(bodyBuffer.toString("utf8"))
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      return void res.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
      }))
    }

    const isStream = anthropicReq.stream === true
    const model = anthropicReq.model

    let accessToken: string
    try {
      accessToken = await this.ensureToken()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(401, { "Content-Type": "application/json" })
      return void res.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: msg },
      }))
    }

    // Transform Anthropic → OpenAI
    const openaiReq = anthropicToOpenaiChat(anthropicReq)
    const openaiBody = JSON.stringify(openaiReq)

    const upstreamPath = isStream
      ? `${DEVECO_API_PREFIX}/chat/completions`
      : `${DEVECO_API_PREFIX}/no-stream/chat/completions`
    const upstreamUrl = `${DEVECO_ORIGIN}${upstreamPath}`

    const convKey = conversationKey(anthropicReq)
    const chatId = this.chatIdFor(convKey)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      lang: "en",
      "Chat-Id": chatId,
      "Session-Id": convKey,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "accept-language": "zh-CN",
    }

    const t0 = Date.now()
    log.info(`-> POST anthropic/${isStream ? "stream" : "no-stream"} model=${model}`)

    const budget = idleBudget(UPSTREAM_IDLE_TIMEOUT_MS)
    const finishTurn = () => {
      budget.done()
      this.exitQueue(convKey, chatId, model, accessToken)
    }

    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: openaiBody,
        signal: budget.signal,
      })
    } catch (err) {
      finishTurn()
      const msg = err instanceof Error ? err.message : String(err)
      log.error("anthropic upstream fetch failed", { error: msg })
      res.writeHead(502, { "Content-Type": "application/json" })
      return void res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: msg },
      }))
    }

    // 401 retry
    if (upstream.status === 401 && this.session) {
      const jwtToken = await this.tokenStore.load()
      if (jwtToken) {
        const refreshed = await this.refreshAccessToken(jwtToken)
        if (refreshed) {
          this.session.accessToken = refreshed.accessToken
          this.session.refreshToken = refreshed.refreshToken
          this.session.expiresAt = Date.now() + ACCESS_TOKEN_EXPIRES_MS
          headers.Authorization = `Bearer ${refreshed.accessToken}`
          log.warn("anthropic upstream 401 → refreshed token, retrying once")
          budget.touch()
          upstream = await fetch(upstreamUrl, {
            method: "POST",
            headers,
            body: openaiBody,
            signal: budget.signal,
          })
        }
      }
    }

    if (!upstream.ok) {
      finishTurn()
      const errText = await upstream.text().catch(() => "")
      log.error(`anthropic upstream error: HTTP ${upstream.status}`, { body: errText.slice(0, 200) })
      res.writeHead(upstream.status, { "Content-Type": "application/json" })
      return void res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}` },
      }))
    }

    if (isStream) {
      if (!upstream.body) {
        finishTurn()
        res.writeHead(502, { "Content-Type": "application/json" })
        return void res.end(JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Upstream returned no body for stream" },
        }))
      }

      const anthropicStream = openaiChatStreamToAnthropic(upstream.body, model, budget.touch)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const reader = anthropicStream.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
        const dur = Date.now() - t0
        log.info(`<- 200 ${dur}ms anthropic/stream model=${model}`)
      }
      void pump()
        .catch((err) => {
          log.error("anthropic stream pipe error", { error: String(err) })
          res.end()
        })
        .finally(finishTurn)
      return
    }

    // Non-streaming
    finishTurn()
    const openaiResponse = await upstream.json()
    const anthropicResponse = openaiChatToAnthropic(openaiResponse, model)
    const dur = Date.now() - t0
    const usage = anthropicResponse.usage
    log.info(
      `<- 200 ${dur}ms anthropic/no-stream in=${usage.input_tokens} out=${usage.output_tokens} model=${model}`,
    )
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(anthropicResponse))
  }

  private async pipeResponse(
    upstream: Response,
    res: http.ServerResponse,
    stream: boolean,
    ctx?: { model: string; stream: boolean; upstreamUrl: string; t0: number },
    touch?: () => void,
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
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          touch?.()
          res.write(value)
          if (ctx) {
            tailChunks.push(Buffer.from(value))
            if (tailChunks.length > TAIL_KEEP) tailChunks.shift()
          }
        }
      } catch (err) {
        // The response head is already on the wire, so this can't become an
        // error status — swallowing it here also keeps the throw from reaching
        // handle()'s catch, which would try to write headers a second time and
        // take the whole process down with an unhandled rejection.
        log.error("upstream stream ended early", { error: String(err) })
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
    // Once the head is out (a stream that failed midway) writing it again
    // throws ERR_HTTP_HEADERS_SENT; all we can still do is close the response.
    if (res.headersSent) {
      res.end()
      return
    }
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
