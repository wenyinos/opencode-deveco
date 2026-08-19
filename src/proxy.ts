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
import { getDevecoProviderConfig, resetModelCache } from "./models.js"
import {
  anthropicToOpenaiChat,
  openaiChatToAnthropic,
  openaiChatStreamToAnthropic,
  type AnthropicRequest,
} from "./anthropic-transform.js"
import { applyVisionRouting } from "./vision-routing.js"
import { normalizeOpenAIToolChoice } from "./openai-normalize.js"

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
 * conversation's opening user message never changes as it grows — so by default
 * we hash only that first user message. This keeps the Chat-Id stable even when
 * Claude Code's system prompt contains volatile content (date, cwd, etc.),
 * which previously minted a new DevEco session every turn and hit the upstream
 * "New session request rate exceeded" 403.
 *
 * Set DEVECO_SESSION_KEY_MODE=system-first to restore the old behaviour
 * (system + first message) if you need system prompts to separate sessions.
 */
export function conversationKey(body: unknown): string {
  try {
    const b = body as { system?: unknown; messages?: unknown[] }
    const mode = (process.env.DEVECO_SESSION_KEY_MODE || "first-message").toLowerCase()
    const messages = b.messages ?? []
    // The OpenAI wire format puts the system prompt at messages[0], and
    // opencode's system prompt carries volatile content (current time, cwd…),
    // so the stable anchor is the conversation's FIRST *user* message, not
    // messages[0]. Anthropic requests keep `system` in its own field, so the
    // first user message works for both wire formats.
    const firstUserMessage =
      messages.find(
        (m): boolean => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user",
      ) ?? messages[0] ?? ""
    // system-first mode keys on the system prompt too. Anthropic carries it in
    // the top-level `system` field; OpenAI puts it in the first system message.
    const systemMessage = messages.find(
      (m): boolean => !!m && typeof m === "object" && (m as { role?: unknown }).role === "system",
    ) as { content?: unknown } | undefined
    const systemText =
      (typeof b.system === "string" ? b.system : "") ||
      (typeof systemMessage?.content === "string" ? systemMessage.content : "")
    const head =
      mode === "system-first"
        ? JSON.stringify([systemText, firstUserMessage])
        : JSON.stringify(firstUserMessage)
    return crypto.createHash("sha256").update(head).digest("hex").slice(0, 32)
  } catch {
    return crypto.randomUUID().replace(/-/g, "")
  }
}

/** Read an explicit conversation/session id from request headers, if present. */
export function sessionKeyFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value =
    headers["x-deveco-session"] ??
    headers["x-session-affinity"] ??
    headers["x-session-id"]
  if (typeof value === "string" && value.trim()) return value.trim()
  return null
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
  // Auto-triggered browser logins are throttled so a logged-out client that
  // keeps polling can't pop a new browser window / callback server each time.
  // Explicit GET /v2/login is never throttled.
  private lastLoginTriggeredAt = 0
  private static readonly LOGIN_TRIGGER_COOLDOWN_MS = 5 * 60_000

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
    const server = this.server
    this.server = null
    // Stop accepting new connections and wait briefly for in-flight requests.
    // Long-lived SSE streams would otherwise hold close() open forever, so a
    // short grace period is followed by a forced teardown of the rest.
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        log.warn("graceful shutdown timed out; forcing remaining connections closed")
        server.closeAllConnections?.()
        resolve()
      }, 5_000)
      server.close(() => {
        clearTimeout(force)
        resolve()
      })
      server.closeIdleConnections?.()
    })
  }

  getPort(): number {
    return this.port
  }

  /**
   * An explicit session id supplied by the client, if any. This is more stable
   * than the system+first-message heuristic and lets callers pin a DevEco
   * conversation across requests whose system prompt changes.
   */
  private sessionKeyFromRequest(req: http.IncomingMessage): string | null {
    const key = sessionKeyFromHeaders(req.headers as Record<string, string | string[] | undefined>)
    if (key) log.debug("using explicit session id", { session: key })
    return key
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
      log.debug("minted Chat-Id", { key, chatId })
    } else {
      log.debug("reusing Chat-Id", { key, chatId })
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
    const attempt = (retriesLeft: number): void => {
      fetch(url, {
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
          if (r.ok) {
            log.debug(`exitSessionQueue -> ${r.status}`)
          } else if (retriesLeft > 0) {
            log.warn(`exitSessionQueue -> HTTP ${r.status}, retrying`)
            setTimeout(() => attempt(retriesLeft - 1), 500)
          } else {
            log.warn(`exitSessionQueue -> HTTP ${r.status}`)
          }
        })
        .catch((err) => {
          if (retriesLeft > 0) {
            log.warn("exitSessionQueue failed, retrying", { error: String(err) })
            setTimeout(() => attempt(retriesLeft - 1), 500)
          } else {
            log.warn("exitSessionQueue failed", { error: String(err) })
          }
        })
    }
    attempt(1) // one initial attempt + one retry
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
            resetModelCache()
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

  /**
   * Ensure we have a non-expired access token; refresh as needed.
   *
   * With `allowLogin` (default) a missing credential starts a browser login and
   * throws with the login URL. With `allowLogin = false` callers that just want
   * to read something (e.g. the model list) get an empty token back instead of
   * a browser popup.
   */
  private async ensureToken(allowLogin = true): Promise<string> {
    if (this.session && this.session.expiresAt > Date.now()) {
      return this.session.accessToken
    }

    // Try refresh first (cheaper, headless).
    const jwtToken = await this.tokenStore.load()
    if (this.session || jwtToken) {
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

    if (!allowLogin) return ""

    // No usable credentials. Kick off a browser login in the background and
    // fail *this* request immediately: waiting here would hang the client for
    // the full 10-minute callback window, which is what "no reply" looks like.
    if (
      this.lastLoginTriggeredAt &&
      Date.now() - this.lastLoginTriggeredAt < DevEcoProxy.LOGIN_TRIGGER_COOLDOWN_MS
    ) {
      throw new Error(
        "DevEco login required (auto-login throttled). Visit GET /v2/login to start a new login.",
      )
    }
    this.lastLoginTriggeredAt = Date.now()
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
    const host = req.headers.host || `${this.hostname}:${this.port}`
    const url = new URL(req.url ?? "/", `http://${host}`)
    // Normalise: strip /v2 prefix so all route checks are simple.
    const p = url.pathname.replace(/^\/v2(?=\/|$)/, "") || "/"

    try {
      if (p === "/status") {
        // A stored jwtToken means the session is recoverable by a silent
        // refresh, so report logged_in whenever credentials exist — not only
        // while the current access token is unexpired (it expires every 30
        // minutes and is refreshed headlessly on the next request).
        const hasCredentials = (await this.tokenStore.load()) !== null
        const loggedIn = !!this.session || hasCredentials
        return this.json(res, 200, {
          logged_in: loggedIn,
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
        resetModelCache()
        return this.json(res, 200, { ok: true })
      }

      if (p === "/models") {
        // Listing models must not pop a browser: use the current session when
        // available and fall back to the static defaults when logged out.
        const token = await this.ensureToken(false)
        const cfg = await getDevecoProviderConfig(token)
        const data = Object.keys(cfg.models ?? {}).map((id) => ({ id, object: "model" }))
        return this.json(res, 200, { object: "list", data })
      }

      if (p === "/chat/completions" && req.method === "POST") {
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
    let parsedBody: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf8"))
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>
        // Default to non-streaming: only an explicit `stream: true` opts in to
        // SSE (opencode's streamText always sends `stream: true`; other clients
        // usually expect a JSON reply when they don't ask for a stream).
        if (obj.stream !== true) stream = false
        if (typeof obj.model === "string") model = obj.model
        // Prefer an explicit client session id; otherwise hash the ORIGINAL
        // body (vision rerouting may rewrite messages upstream, but the
        // conversation identity must stay stable).
        convKey = this.sessionKeyFromRequest(req) ?? conversationKey(parsed)
        parsedBody = obj
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

    // DevEco rejects the OpenAI object form of tool_choice; rewrite it before
    // anything else. The vision fallback below may then strip tools entirely.
    let routedBody: Record<string, unknown> | null = null
    if (parsedBody) {
      const normalized = normalizeOpenAIToolChoice(parsedBody)
      if (normalized.changed) routedBody = normalized.body
    }

    // Vision fallback: a text-only model asking about an image in the newest
    // user message goes to the vision model instead; stale images in history
    // are replaced with placeholders so GLM keeps working on later turns.
    let upstreamModel = model
    // fetch's BodyInit type under our DOM lib settings doesn't accept Buffer/
    // Uint8Array directly, but node's fetch accepts raw bytes at runtime.
    let bodyInit = bodyBuffer as unknown as BodyInit
    const bodyForRouting = routedBody ?? parsedBody
    if (bodyForRouting) {
      const routing = applyVisionRouting(bodyForRouting)
      if (routing) {
        upstreamModel = routing.upstreamModel
        if (routing.rerouted || routing.imagesStripped) {
          routedBody = routing.body
          bodyInit = Buffer.from(JSON.stringify(routedBody)) as unknown as BodyInit
        }
      }
    }
    if (routedBody) {
      bodyInit = Buffer.from(JSON.stringify(routedBody)) as unknown as BodyInit
    }

    const ctx = { model, stream, upstreamUrl, t0: Date.now() }
    log.info(
      `-> POST ${stream ? "stream" : "no-stream"} model=${model}` +
        (upstreamModel !== model ? ` → vision:${upstreamModel}` : ""),
    )

    const budget = idleBudget(UPSTREAM_IDLE_TIMEOUT_MS)

    // Forward to DevEco and stream/passthrough the response back. The queue
    // slot must be released on EVERY path that reached upstream, including
    // fetch failures and the 401 retry — otherwise silent slot leaks build up.
    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: bodyInit,
        signal: budget.signal,
      }).catch((err) => {
        throw new Error(`upstream fetch failed: ${String(err)}`)
      })

      // If DevEco says our token is bad/refresh needed, try one refresh+retry.
      let responseToPipe = upstream
      if (upstream.status === 401 && this.session) {
        const jwtToken = await this.tokenStore.load()
        if (jwtToken) {
          const refreshed = await this.refreshAccessToken(jwtToken)
          if (refreshed) {
            accessToken = refreshed.accessToken
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

      await this.pipeResponse(responseToPipe, res, stream, ctx, budget.touch)
    } finally {
      budget.done()
      this.exitQueue(convKey, chatId, upstreamModel, accessToken)
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
    // Same vision fallback as the OpenAI path, applied to the transformed body.
    const routing = applyVisionRouting(openaiReq as unknown as Record<string, unknown>)
    const openaiBody = JSON.stringify(routing?.body ?? openaiReq)
    const upstreamModel = routing?.upstreamModel ?? model

    const upstreamPath = isStream
      ? `${DEVECO_API_PREFIX}/chat/completions`
      : `${DEVECO_API_PREFIX}/no-stream/chat/completions`
    const upstreamUrl = `${DEVECO_ORIGIN}${upstreamPath}`

    const convKey = this.sessionKeyFromRequest(req) ?? conversationKey(anthropicReq)
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
    log.info(
      `-> POST anthropic/${isStream ? "stream" : "no-stream"} model=${model}` +
        (upstreamModel !== model ? ` → vision:${upstreamModel}` : ""),
    )

    const budget = idleBudget(UPSTREAM_IDLE_TIMEOUT_MS)
    const finishTurn = () => {
      budget.done()
      this.exitQueue(convKey, chatId, upstreamModel, accessToken)
    }

    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: openaiBody,
        signal: budget.signal,
      })

      // 401 retry — kept inside the same try so a retry fetch failure still
      // releases the queue slot via the catch below.
      if (upstream.status === 401 && this.session) {
        const jwtToken = await this.tokenStore.load()
        if (jwtToken) {
          const refreshed = await this.refreshAccessToken(jwtToken)
          if (refreshed) {
            accessToken = refreshed.accessToken
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
          // The client went away: stop draining the upstream into a dead pipe.
          reader.cancel().catch(() => {})
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
            // SSE: only the tail carries usage, keep a few chunks. Non-stream:
            // the whole response is one JSON document, keep it all so the
            // usage parse below can see the complete body.
            if (ctx.stream && tailChunks.length > TAIL_KEEP) tailChunks.shift()
          }
        }
      } catch (err) {
        // The response head is already on the wire, so this can't become an
        // error status — swallowing it here also keeps the throw from reaching
        // handle()'s catch, which would try to write headers a second time and
        // take the whole process down with an unhandled rejection.
        log.error("upstream stream ended early", { error: String(err) })
        // Stop draining the upstream: the client is gone or the stream died,
        // and leaving the reader active would leak the backend connection.
        await reader.cancel().catch(() => {})
        // Leave OpenAI-compatible SSE clients a real error instead of a
        // silently truncated stream. (The Anthropic transform already emits an
        // `event: error` on its own path.)
        if (stream) {
          const msg = err instanceof Error ? err.message : String(err)
          res.write(
            `data: ${JSON.stringify({ error: { message: msg, type: "api_error" } })}\n\n`,
          )
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
      let size = 0
      // Chat requests can carry base64 images, but a runaway client must not
      // be able to exhaust the proxy's memory.
      const MAX_BODY_BYTES = 128 * 1024 * 1024
      req.on("data", (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
          req.destroy()
          return
        }
        chunks.push(c)
      })
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
  function parsePort(value: string | undefined, source: string): number | undefined {
    if (value === undefined) return undefined
    const port = Number(value)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      log.error(`invalid ${source}: ${value}`)
      process.exit(1)
    }
    return port
  }

  const portArg = process.argv.find((a) => a.startsWith("--port="))
  const port =
    parsePort(portArg?.split("=")[1], "--port") ??
    parsePort(process.env.DEVECO_PROXY_PORT, "DEVECO_PROXY_PORT") ??
    17128

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
