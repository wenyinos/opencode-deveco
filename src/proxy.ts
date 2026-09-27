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
  EXIT_QUEUE_GRACE_MS,
  UPSTREAM_IDLE_TIMEOUT_MS,
  log,
  maxConcurrency,
  maxQueue,
  queueCooldownMs,
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
import { normalizeOpenAIChatBody } from "./openai-normalize.js"

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
 * Combine abort signals the way `AbortSignal.any` does. That API only exists
 * from Node 18.17/20.3 on, and this package still supports Node 18, so the
 * merge is done by hand. Sources are per-request objects that die with their
 * request, so the listeners cannot accumulate.
 */
export function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const merged = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      merged.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => merged.abort(signal.reason), { once: true })
  }
  return merged.signal
}

/**
 * How an `acquire` ended: `admitted` = slot granted (the caller then owes one
 * `release()`), `abandoned` = the caller gave up while queued (no slot, nothing
 * owed), `queue-full` = the queue was at capacity, so the request was refused
 * and never entered it.
 */
export type AcquireOutcome = "admitted" | "abandoned" | "queue-full"

/** Client-visible message of the 429 answering a `queue-full` refusal. */
const QUEUE_FULL_MESSAGE = "proxy request queue is full, please retry shortly"

/**
 * A queued request waiting for a slot. `granted` marks the moment release()
 * promises the slot to it (the cooldown timer is what delays the hand-over).
 */
interface Waiter {
  label: string
  /** `admitted` = one release() owed; `abandoned` = caller gave up, no slot. */
  resolve: (outcome: AcquireOutcome) => void
  enqueuedAt: number
  granted: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Detaches the abort listener so a late abort can't touch a granted slot. */
  detach: () => void
}

/**
 * FIFO semaphore capping how many upstream requests run at once. DevEco
 * throttles bursts per account, so a burst degrades into a queue instead of a
 * failure; waiters are admitted in arrival order. The width comes from
 * `DEVECO_MAX_CONCURRENCY` (1 = strictly one at a time).
 *
 * `cooldownMs` (from `DEVECO_QUEUE_COOLDOWN_SEC`) pauses before a waiter is let
 * through, so consecutive turns don't hammer the backend back-to-back. Only
 * requests that actually had to queue pay it — one that finds a free slot
 * starts immediately.
 *
 * The queue itself is bounded by `maxQueue` (from `DEVECO_MAX_QUEUE`): a
 * request arriving at a full queue is refused (`queue-full`) rather than
 * stacked, so the backlog can't grow without limit behind a long turn.
 */
export class ConcurrencyGate {
  private readonly limit: number
  private readonly cooldownMs: number
  private readonly maxQueue: number
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(limit: number, cooldownMs = 0, maxQueue = Number.POSITIVE_INFINITY) {
    this.limit = Math.max(1, Math.floor(limit))
    this.cooldownMs = Math.max(0, cooldownMs)
    this.maxQueue = Math.max(0, Math.floor(maxQueue))
  }

  /**
   * Take a slot, or wait for one. `admitted` means the caller owes exactly one
   * `release()`; `abandoned` means `signal` aborted while queued, in which case
   * no slot was taken and nothing is owed. Without the signal an abandoned
   * waiter was still admitted later, just to notice its client was gone, and
   * that hand-over cost the queue another cooldown. `queue-full` means the
   * queue already held `maxQueue` waiters: the request was not accepted, so a
   * burst is answered with 429s instead of unbounded waiting.
   */
  async acquire(label: string, signal?: AbortSignal): Promise<AcquireOutcome> {
    if (signal?.aborted) return "abandoned"
    if (this.active < this.limit) {
      this.active++
      return "admitted"
    }
    if (this.waiters.length >= this.maxQueue) {
      log.warn(`proxy: queue full (${this.waiters.length} waiting), refusing ${label}`)
      return "queue-full"
    }
    log.debug(
      `proxy: queued ${label} (all ${this.limit} upstream slot(s) busy, ${this.waiters.length} ahead)`,
    )
    return new Promise<AcquireOutcome>((resolve) => {
      const waiter: Waiter = {
        label,
        resolve,
        enqueuedAt: Date.now(),
        granted: false,
        timer: null,
        detach: () => {},
      }
      if (signal) {
        const onAbort = () => this.cancel(waiter)
        signal.addEventListener("abort", onAbort, { once: true })
        waiter.detach = () => signal.removeEventListener("abort", onAbort)
      }
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (!next) {
      this.active--
      return
    }
    // The freed slot moves straight to the next waiter — still counted as
    // active, so a request arriving during the cooldown queues behind it
    // instead of stealing the slot that was already promised.
    next.granted = true
    const admit = () => {
      next.timer = null
      next.detach()
      log.debug(
        `proxy: admitted ${next.label} after ${Date.now() - next.enqueuedAt}ms ` +
          `(${this.waiters.length} still queued)`,
      )
      next.resolve("admitted")
    }
    if (this.cooldownMs > 0) {
      log.debug(`proxy: cooling down ${this.cooldownMs}ms before admitting the next queued request`)
      next.timer = setTimeout(admit, this.cooldownMs)
    } else {
      admit()
    }
  }

  /**
   * Drop a waiter whose caller gave up. Still queued: take it out of the queue,
   * the slot count is untouched (a queued waiter was never counted). Already
   * granted and merely cooling down: the slot is HIS, so it is passed on
   * exactly as a release() would — never dropped on the floor.
   */
  private cancel(waiter: Waiter): void {
    if (waiter.granted) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.timer = null
      log.debug(`proxy: ${waiter.label} left during the cooldown, passing its slot on`)
      waiter.resolve("abandoned")
      this.release()
      return
    }
    const idx = this.waiters.indexOf(waiter)
    if (idx >= 0) this.waiters.splice(idx, 1)
    waiter.detach()
    log.debug(`proxy: dropped queued ${waiter.label} (caller gone)`)
    waiter.resolve("abandoned")
  }
}

/**
 * Abort the current turn as soon as the client hangs up. Without this the
 * upstream keeps generating into a socket nobody reads — 30s+ of wasted work,
 * a leased DevEco queue slot, and (with the concurrency gate) every later
 * request queued behind it. Listeners live on the per-request `res`, so they
 * are collected with it.
 */
export function abortOnClientClose(res: http.ServerResponse): AbortController {
  const controller = new AbortController()
  res.on("close", () => {
    // `close` also fires after a normal finish; only a premature one matters.
    if (res.writableFinished || controller.signal.aborted) return
    log.debug("proxy: client disconnected, aborting upstream turn")
    controller.abort(new Error("client disconnected"))
  })
  return controller
}

/**
 * Write to a client that may already be gone. A throw here would surface as an
 * unhandled rejection (the caller is usually a `catch` handler), so failures
 * are logged and reported instead.
 */
function safeWrite(res: http.ServerResponse, chunk: string | Uint8Array): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false
    res.write(chunk)
    return true
  } catch (err) {
    log.debug("proxy: write to a gone client failed", { error: String(err) })
    return false
  }
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
  // Serialises generation turns: DevEco throttles bursts per account, so only
  // DEVECO_MAX_CONCURRENCY turns run at once and the rest queue (at most
  // DEVECO_MAX_QUEUE of them — beyond that the client gets a 429 and can back
  // off). A queued turn additionally waits out DEVECO_QUEUE_COOLDOWN_SEC before
  // it starts. Metadata reads (/status, /models, /login…) never touch the gate
  // — nothing about them deserves a turn's slot.
  private readonly gate = new ConcurrencyGate(maxConcurrency(), queueCooldownMs(), maxQueue())

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

    // Last line of defence: a request must never be able to reject its way out
    // of the server callback — an unhandled rejection exits the process, and
    // the whole point of this proxy is to keep the client connected across
    // upstream failures.
    this.server = http.createServer((req, res) => {
      // A client that walks away turns later writes into socket errors; an
      // 'error' event with no listener is fatal, so every socket is guarded.
      req.on("error", (err: Error) => log.debug("proxy: request socket error", { error: String(err) }))
      res.on("error", (err: Error) => log.debug("proxy: response socket error", { error: String(err) }))
      this.handle(req, res).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        log.error("proxy request failed", { error: msg })
        this.json(res, 500, { error: msg })
      })
    })
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
   * Release the server-side queue slot this turn held. Resolves once DevEco
   * confirms the release, or after `EXIT_QUEUE_GRACE_MS` when the call wedges
   * (the retry chain then finishes in the background) — callers await it before
   * handing the concurrency slot to the next turn. Never rejects: this runs on
   * the slot-release path, where a throw would leak the slot.
   */
  private exitQueue(key: string, chatId: string, model: string, token: string): Promise<void> {
    // `encodeURIComponent` throws on a lone surrogate, and the model name is
    // client-supplied: an exit we cannot address must not blow up the release.
    let url = DEVECO_EXIT_QUEUE_URL
    try {
      url = `${DEVECO_EXIT_QUEUE_URL}?modelId=${encodeURIComponent(model)}`
    } catch {
      log.warn("exitSessionQueue: unencodable model name, releasing without modelId")
    }
    const attempt = async (retriesLeft: number): Promise<void> => {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Session-Id": key,
            "Chat-Id": chatId,
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(5_000),
        })
        if (r.ok) {
          // Silent when it works; a slot we failed to release is worth seeing,
          // since the symptom (errors after many turns) is otherwise baffling.
          log.debug(`exitSessionQueue -> ${r.status}`)
          return
        }
        if (retriesLeft <= 0) {
          log.warn(`exitSessionQueue -> HTTP ${r.status}`)
          return
        }
        log.warn(`exitSessionQueue -> HTTP ${r.status}, retrying`)
      } catch (err) {
        if (retriesLeft <= 0) {
          log.warn("exitSessionQueue failed", { error: String(err) })
          return
        }
        log.warn("exitSessionQueue failed, retrying", { error: String(err) })
      }
      await new Promise((r) => setTimeout(r, 500))
      return attempt(retriesLeft - 1)
    }

    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(grace)
        resolve()
      }
      const grace = setTimeout(() => {
        log.warn(
          `exitSessionQueue unresolved after ${EXIT_QUEUE_GRACE_MS}ms; letting the next turn through`,
        )
        resolve()
      }, EXIT_QUEUE_GRACE_MS)
      void attempt(1).then(finish, finish) // one initial attempt + one retry
    })
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
        .catch((err) => {
          // A rejected login promise used to escape as an unhandled rejection
          // and kill the proxy process.
          log.warn("DevEco login flow failed", { error: String(err) })
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
        // A metadata read, never queued: making it wait behind a streaming turn
        // would stall the client's model picker for as long as the turn runs.
        // It must not pop a browser either — use the current session when
        // available, fall back to the static defaults when logged out.
        const token = await this.ensureToken(false)
        const cfg = await getDevecoProviderConfig(token)
        const data = Object.keys(cfg.models ?? {}).map((id) => ({ id, object: "model" }))
        return this.json(res, 200, { object: "list", data })
      }

      if (p === "/chat/completions" && req.method === "POST") {
        // Awaited: an upstream failure rejects this promise, and returning it
        // bare would skip the catch below and kill the process instead.
        return await this.forwardChat(req, res)
      }

      if (p === "/anthropic/v1/messages" && req.method === "POST") {
        return await this.forwardAnthropic(req, res)
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
    // Armed before the token wait and the concurrency queue: `close` is a
    // one-shot event, so a client that hangs up while this request is still
    // waiting for a slot would be missed by a listener attached afterwards —
    // the turn would then run a full generation into a dead socket while
    // holding the slot.
    const clientGone = abortOnClientClose(res)
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

    // DevEco rejects several OpenAI-side shapes (the "developer" role, the
    // tool_choice object form) and ignores max_completion_tokens; rewrite them
    // all before anything else. The vision fallback below may then strip tools
    // entirely.
    let routedBody: Record<string, unknown> | null = null
    if (parsedBody) {
      const normalized = normalizeOpenAIChatBody(parsedBody)
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

    // Wait for an upstream slot first: the logged duration then measures the
    // upstream exchange, and the log order matches what the backend saw. The
    // signal makes the wait cancellable, so a client that leaves while queued is
    // dropped (no slot, no upstream call, no cooldown charged to those behind).
    const outcome = await this.gate.acquire(`chat ${model}`, clientGone.signal)
    if (outcome === "queue-full") {
      return this.json(res, 429, {
        error: { message: QUEUE_FULL_MESSAGE, type: "rate_limit_error" },
      })
    }
    if (outcome === "abandoned") {
      log.debug("proxy: client gone while queued, skipping chat turn", { model })
      return
    }
    if (clientGone.signal.aborted) {
      // Hung up between admission and here: hand the slot straight back.
      log.debug("proxy: client gone right after admission, skipping chat turn", { model })
      this.gate.release()
      return
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
      // Built inside the try: a synchronous throw here must still reach the
      // finally below, or the slot this turn just took would leak for good.
      const signal = mergeAbortSignals(budget.signal, clientGone.signal)
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: bodyInit,
        signal,
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
              signal,
            })
          }
        }
      }

      // `clientGone`, not the merged signal: only a hang-up should demote the
      // log line, while an upstream idle timeout must stay an error.
      await this.pipeResponse(
        responseToPipe,
        res,
        stream,
        { ...ctx, clientGone: clientGone.signal },
        budget.touch,
      )
    } finally {
      budget.done()
      // Hand the slot over only once DevEco confirms its queue slot is gone
      // (bounded inside exitQueue), and only after this turn stopped streaming.
      await this.exitQueue(convKey, chatId, upstreamModel, accessToken)
      this.gate.release()
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
    // Same as the OpenAI path: armed before the token wait and the queue, so a
    // client that hangs up while waiting for a slot is not missed.
    const clientGone = abortOnClientClose(res)

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
    // Same DevEco quirk rewrites as the OpenAI path — this body was built here,
    // not received from a client, so nothing else would apply them.
    const normalized = normalizeOpenAIChatBody(openaiReq as unknown as Record<string, unknown>)
    // Same vision fallback as the OpenAI path, applied to the transformed body.
    const routing = applyVisionRouting(normalized.body)
    const openaiBody = JSON.stringify(routing?.body ?? normalized.body)
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

    // Same cancellable wait as the OpenAI path, and the same teardown: the slot
    // goes to the next turn only after exitQueue settles. Callers that still owe
    // the client a response fire it without awaiting — the release happens
    // either way.
    const outcome = await this.gate.acquire(`anthropic ${model}`, clientGone.signal)
    if (outcome === "queue-full") {
      return this.json(res, 429, {
        type: "error",
        error: { type: "rate_limit_error", message: QUEUE_FULL_MESSAGE },
      })
    }
    if (outcome === "abandoned") {
      log.debug("proxy: client gone while queued, skipping anthropic turn", { model })
      return
    }
    if (clientGone.signal.aborted) {
      // Hung up between admission and here: hand the slot straight back.
      log.debug("proxy: client gone right after admission, skipping anthropic turn", { model })
      this.gate.release()
      return
    }
    const t0 = Date.now()
    log.info(
      `-> POST anthropic/${isStream ? "stream" : "no-stream"} model=${model}` +
        (upstreamModel !== model ? ` → vision:${upstreamModel}` : ""),
    )

    const budget = idleBudget(UPSTREAM_IDLE_TIMEOUT_MS)
    const finishTurn = async (): Promise<void> => {
      budget.done()
      await this.exitQueue(convKey, chatId, upstreamModel, accessToken)
      this.gate.release()
    }

    let upstream: Response
    try {
      // Same as the OpenAI path: built inside the try so a synchronous throw
      // still runs the catch, which releases the slot.
      const signal = mergeAbortSignals(budget.signal, clientGone.signal)
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: openaiBody,
        signal,
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
              signal,
            })
          }
        }
      }
    } catch (err) {
      void finishTurn()
      const msg = err instanceof Error ? err.message : String(err)
      log.error("anthropic upstream fetch failed", { error: msg })
      return this.json(res, 502, {
        type: "error",
        error: { type: "api_error", message: msg },
      })
    }

    if (!upstream.ok) {
      void finishTurn()
      const errText = await upstream.text().catch(() => "")
      log.error(`anthropic upstream error: HTTP ${upstream.status}`, { body: errText.slice(0, 200) })
      return this.json(res, upstream.status, {
        type: "error",
        error: { type: "api_error", message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}` },
      })
    }

    if (isStream) {
      if (!upstream.body) {
        void finishTurn()
        return this.json(res, 502, {
          type: "error",
          error: { type: "api_error", message: "Upstream returned no body for stream" },
        })
      }

      const anthropicStream = openaiChatStreamToAnthropic(upstream.body, model, budget.touch)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const reader = anthropicStream.getReader()
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            // A failed write means the client is gone: stop pulling upstream.
            if (!safeWrite(res, value)) break
          }
        } finally {
          // Whatever ended the loop, never leave the upstream pipe open.
          await reader.cancel().catch(() => {})
          res.end()
        }
        const dur = Date.now() - t0
        log.info(`<- 200 ${dur}ms anthropic/stream model=${model}`)
      }
      void pump()
        .catch((err) => {
          log.error("anthropic stream pipe error", { error: String(err) })
        })
        .finally(finishTurn)
      return
    }

    // Non-streaming. The slot is released only after the body has been read and
    // answered — same as the OpenAI path — so "serial" covers the whole upstream
    // exchange, not just its response head.
    try {
      const openaiResponse = await upstream.json()
      const anthropicResponse = openaiChatToAnthropic(openaiResponse, model)
      const dur = Date.now() - t0
      const usage = anthropicResponse.usage
      log.info(
        `<- 200 ${dur}ms anthropic/no-stream in=${usage.input_tokens} out=${usage.output_tokens} model=${model}`,
      )
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(anthropicResponse))
    } finally {
      await finishTurn()
    }
  }

  private async pipeResponse(
    upstream: Response,
    res: http.ServerResponse,
    stream: boolean,
    ctx?: { model: string; stream: boolean; upstreamUrl: string; t0: number; clientGone?: AbortSignal },
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
        const msg = err instanceof Error ? err.message : String(err)
        // A client that hung up is routine (the editor's stop button), so it
        // does not deserve an error line; an upstream that dies on its own does.
        if (ctx?.clientGone?.aborted || res.destroyed) {
          log.debug("proxy: upstream stopped with the client gone", { error: msg })
        } else {
          log.error("upstream stream ended early", { error: msg })
        }
        // Stop draining the upstream: the client is gone or the stream died,
        // and leaving the reader active would leak the backend connection.
        await reader.cancel().catch(() => {})
        // Leave OpenAI-compatible SSE clients a real error instead of a
        // silently truncated stream. (The Anthropic transform already emits an
        // `event: error` on its own path.)
        if (stream) {
          safeWrite(res, `data: ${JSON.stringify({ error: { message: msg, type: "api_error" } })}\n\n`)
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
    // throws ERR_HTTP_HEADERS_SENT, and a client that already went away makes
    // the write itself throw — all that is left is to try to close the response.
    try {
      if (res.headersSent || res.writableEnded) {
        res.end()
        return
      }
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    } catch (err) {
      log.debug("proxy: could not answer (client already gone?)", {
        status,
        error: String(err),
      })
    }
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

  // A proxy that dies takes every client with it, so an unexpected throw or a
  // stray rejected promise is logged and survived instead of being fatal. Both
  // handlers exist only here: the plugin path runs inside opencode, whose own
  // error handling must not be hijacked.
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception (proxy keeps running)", { error: String(err) })
  })
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection (proxy keeps running)", { error: String(reason) })
  })

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
