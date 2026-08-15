// DevEco Code login flow: local HTTP callback server + token exchange.
//
// Ported from deveco-code packages/opencode/src/plugin/deveco.ts (lines ~280-769)
// with all fork-internal dependencies removed:
//   - no @/auth (saveAuthToDisk / loadAccessTokenFromDisk) — opencode auth is
//     persisted via the plugin's client.auth.set instead
//   - no @/security/local-crypto — jwtToken stored via the injected TokenStore
//   - no Global.Path / GlobalBus / Log — uses config.log + node stdlib
//
// Public surface: createLoginService(tokenStore) -> { login, refreshToken, ... }.

import { spawn } from "node:child_process"
import crypto from "node:crypto"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { type TokenStore } from "./token-store.js"
import {
  ACCESS_TOKEN_EXPIRES_MS,
  CALLBACK_PORTS,
  DEFAULT_CONFIG,
  type LoginConfig,
  log,
} from "./config.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LoginCancelledError extends Error {
  constructor(message: string = "Login cancelled by user") {
    super(message)
    this.name = "LoginCancelledError"
  }
}

export class UnsupportedRegionError extends Error {
  constructor(message: string = "Unsupported region") {
    super(message)
    this.name = "UnsupportedRegionError"
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserInfo {
  userId: string
  userName: string
  accessToken: string
  refreshToken: string
  jwtToken: string
  countryCode: string
  language: string
  isRealName: boolean
}

/**
 * DevEco has shipped both `realName: true` (boolean, current) and the string
 * form "true"/"false" — normalise either to a boolean.
 */
export function parseRealName(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true"
  return false
}

export interface LoginResult {
  success: boolean
  cancelled?: boolean
  unsupportedRegion?: boolean
  userInfo?: UserInfo
  jwtToken?: string
  error?: string
}

interface CallbackData {
  tempToken: string
  siteId: string
  quit?: string
}

interface TokenCheckResponse {
  status: boolean
  userInfo?: {
    accessToken: string
    refreshToken?: string
    nationalCode: string
    // DevEco returns a boolean here (verified live), but older payloads may
    // have carried the string "true"/"false".
    realName: string | boolean
  }
}

interface JwtPayload {
  userId: string
  userName: string
  exp?: number
  iat?: number
  nationalCode?: string
  isRealName?: boolean
}

export interface RefreshResult {
  accessToken: string
  refreshToken: string
}

/** A login in progress: the URL to visit, and the eventual outcome. */
export interface StartedLogin {
  url: string
  result: Promise<LoginResult>
}

/**
 * Build the command that opens a URL in the default browser.
 *
 * Windows must go through cmd's `start`, which parses the command line itself:
 * the login URL's `&` query separators would be read as command separators
 * unless the URL stays double-quoted (node only auto-quotes arguments
 * containing spaces, tabs or quotes — never `&`). macOS/Linux take the URL as
 * a single argv with no shell in the way.
 *
 * Exported so the quoting can be tested off-Windows.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[]; shell: boolean } {
  if (platform === "win32") return { command: `start "" "${url}"`, args: [], shell: true }
  if (platform === "darwin") return { command: "open", args: [url], shell: false }
  return { command: "xdg-open", args: [url], shell: false }
}

function toLoginFailure(err: unknown): LoginResult {
  if (err instanceof LoginCancelledError) {
    return { success: false, cancelled: true, error: err.message }
  }
  if (err instanceof UnsupportedRegionError) {
    return {
      success: false,
      unsupportedRegion: true,
      error: "Sorry, only China site accounts are currently supported",
    }
  }
  log.error("login failed", { error: err instanceof Error ? err.message : String(err) })
  return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
}

// ---------------------------------------------------------------------------
// LocalAuthServer — listens on 127.0.0.1 and receives the browser redirect.
// ---------------------------------------------------------------------------

class LocalAuthServer {
  private server: http.Server | null = null
  private port: number
  private readonly clientSecret: string
  private readonly callbackPath = "/callback"
  private resolveCallback: ((value: CallbackData) => void) | null = null
  private rejectCallback: ((reason: Error) => void) | null = null
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  private readonly baseUrl: string
  private readonly successRedirectUrl: string
  private readonly failedRedirectUrl: string

  constructor(
    port: number,
    clientSecret: string,
    baseUrl: string,
    successRedirectUrl: string,
    failedRedirectUrl: string,
  ) {
    this.port = port
    this.clientSecret = clientSecret
    this.baseUrl = baseUrl
    this.successRedirectUrl = successRedirectUrl
    this.failedRedirectUrl = failedRedirectUrl
  }

  async start(): Promise<number> {
    const portsToTry = [this.port, ...CALLBACK_PORTS.filter((p) => p !== this.port)]
    for (const port of portsToTry) {
      try {
        const actualPort = await this.tryPort(port)
        this.port = actualPort
        return actualPort
      } catch {
        if (port === portsToTry[portsToTry.length - 1]) {
          throw new Error(
            "All auth server ports are in use. Please free up a port or close other DevEco / opencode instances.",
          )
        }
      }
    }
    throw new Error("Failed to start server")
  }

  private tryPort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res))
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") reject(new Error("Port is already in use"))
        else reject(err)
      })
      server.listen(port, "127.0.0.1", () => {
        this.server = server
        resolve(port)
      })
    })
  }

  waitForCallback(timeout: number = 30_000): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = (value) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId)
          this.timeoutId = null
        }
        resolve(value)
      }
      this.rejectCallback = (reason) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId)
          this.timeoutId = null
        }
        reject(reason)
      }
      this.timeoutId = setTimeout(() => {
        this.timeoutId = null
        this.rejectCallback?.(new Error("Callback timeout"))
      }, timeout)
    })
  }

  cancel(): void {
    if (this.rejectCallback) {
      this.rejectCallback(new LoginCancelledError("Login cancelled by user"))
      this.rejectCallback = null
      this.resolveCallback = null
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
  }

  async stop(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host || `localhost:${this.port}`
    const url = new URL(req.url ?? "", `http://${host}`)

    if (url.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end("Not Found")
      return
    }

    try {
      const urlParams = url.searchParams
      if (req.method === "POST") {
        let body = ""
        req.on("data", (chunk) => {
          body += chunk.toString()
        })
        req.on("end", () => {
          this.handleCallbackRequest(res, urlParams, body)
        })
      } else {
        this.handleCallbackRequest(res, urlParams, "")
      }
    } catch (err) {
      res.writeHead(500)
      res.end("Internal Server Error")
      log.error("local auth server request error", { error: String(err) })
      this.rejectCallback?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private handleCallbackRequest(
    res: ServerResponse,
    urlParams: URLSearchParams,
    body: string,
  ): void {
    try {
      const params: URLSearchParams =
        body && body.trim() ? new URLSearchParams(body) : urlParams

      const code = params.get("code")
      const tempToken = params.get("tempToken")
      const siteId = params.get("siteId")
      const quit = params.get("quit")

      // code must match the clientSecret we generated for this session;
      // a mismatch means the request isn't our callback — silently ignore.
      if (!code || code !== this.clientSecret) {
        log.warn("login callback: code mismatch or missing, ignoring")
        return
      }

      if (quit === "true" || quit === "access_denied") {
        this.rejectCallback?.(
          new LoginCancelledError(
            quit === "access_denied" ? "Access denied by user" : "Login cancelled by user",
          ),
        )
        res.writeHead(302, { Location: `${this.baseUrl}/${this.failedRedirectUrl}` })
        res.end()
        return
      }

      if (!tempToken || !siteId) {
        this.rejectCallback?.(new Error("Login cancelled by user"))
        res.writeHead(302, { Location: `${this.baseUrl}/${this.failedRedirectUrl}` })
        res.end()
        return
      }

      if (siteId !== "1") {
        this.rejectCallback?.(new UnsupportedRegionError("Unsupported region"))
        res.writeHead(302, { Location: `${this.baseUrl}/${this.failedRedirectUrl}` })
        res.end()
        return
      }

      const callbackData: CallbackData = { tempToken, siteId, quit: quit ?? undefined }
      this.resolveCallback?.(callbackData)

      res.writeHead(302, { Location: `${this.baseUrl}/${this.successRedirectUrl}` })
      res.end()
    } catch (err) {
      res.writeHead(500)
      res.end("Internal Server Error")
      log.error("local auth server callback error", { error: String(err) })
      this.rejectCallback?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  getPort(): number {
    return this.port
  }
}

// ---------------------------------------------------------------------------
// LoginService
// ---------------------------------------------------------------------------

class LoginService {
  private readonly config: LoginConfig
  private readonly tokenStore: TokenStore
  private server: LocalAuthServer | null = null
  private userInfo: UserInfo | null = null

  constructor(tokenStore: TokenStore, config?: Partial<LoginConfig>) {
    this.tokenStore = tokenStore
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Begin a login and return the Huawei login URL *immediately*, alongside a
   * promise that settles when the browser callback arrives (up to
   * config.timeout later).
   *
   * Splitting the flow this way lets a caller hand the URL to whoever asked —
   * e.g. redirect a browser straight to it — instead of blocking for the whole
   * callback window. Set `openBrowser: false` when the caller will navigate to
   * the URL itself.
   */
  async startLogin(opts: { openBrowser?: boolean } = {}): Promise<StartedLogin> {
    const clientSecret = this.generateClientSecret()
    const server = new LocalAuthServer(
      this.config.defaultPort,
      clientSecret,
      this.config.baseUrl,
      this.config.successRedirectUrl,
      this.config.failedRedirectUrl,
    )
    await server.start()
    this.server = server

    // Arm the callback promise BEFORE the login page can be reached, so
    // resolveCallback/rejectCallback are ready the instant a request lands.
    const callbackPromise = server.waitForCallback(this.config.timeout)
    const url = this.buildLoginUrl(server.getPort(), clientSecret)
    this.validateLoginUrl(url)
    if (opts.openBrowser !== false) this.openLoginPage(url)

    const result = this.finishLogin(callbackPromise).finally(async () => {
      await server.stop().catch(() => {})
      if (this.server === server) this.server = null
    })
    return { url, result }
  }

  async login(): Promise<LoginResult> {
    try {
      const { result } = await this.startLogin()
      return await result
    } catch (err) {
      return toLoginFailure(err)
    }
  }

  private async finishLogin(callbackPromise: Promise<CallbackData>): Promise<LoginResult> {
    try {
      const callbackData = await callbackPromise
      const jwtToken = await this.getJwtToken(callbackData.tempToken)
      const userInfo = await this.getUserInfoFromJwt(jwtToken)

      await this.tokenStore.save(jwtToken)
      this.userInfo = userInfo

      return { success: true, userInfo, jwtToken }
    } catch (err) {
      return toLoginFailure(err)
    }
  }

  cancel(): void {
    this.server?.cancel()
  }

  async isLoggedIn(): Promise<boolean> {
    if (this.userInfo) return true
    const token = await this.tokenStore.load()
    return token !== null
  }

  getUserInfo(): UserInfo | null {
    return this.userInfo
  }

  async logout(): Promise<void> {
    await this.tokenStore.clear()
    this.userInfo = null
  }

  private generateClientSecret(): string {
    return crypto.randomUUID().replace(/-/g, "")
  }

  private buildLoginUrl(port: number, clientSecret: string): string {
    return `${this.config.baseUrl}/${this.config.authUrl}?port=${port}&appid=${this.config.appId}&code=${clientSecret}`
  }

  /**
   * Reject a login URL before it reaches the OS launcher. `new URL` leaves `$`
   * and backticks in place, which stay active in the Windows launcher's
   * PowerShell `Start "..."` string — so both the scheme and the character set
   * are explicitly allowlisted.
   */
  private validateLoginUrl(loginUrl: string): void {
    const parsed = new URL(loginUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Unsupported login URL scheme: ${parsed.protocol}`)
    }
    if (!/^[A-Za-z0-9._~:/?=&%#@+-]+$/.test(parsed.href)) {
      throw new Error("Login URL contains disallowed characters")
    }
  }

  /**
   * Best-effort browser open. Never blocks and never throws: when the proxy
   * runs as a background service there may be no desktop session to open into
   * (no DISPLAY), and the caller falls back to handing the URL to its client.
   */
  private openLoginPage(loginUrl: string): void {
    // Never log the clientSecret embedded in the login URL.
    const safeUrl = loginUrl.replace(/code=[^&]*/g, "code=***")
    const { command, args, shell } = browserOpenCommand(process.platform, loginUrl)
    try {
      // detached + ignored stdio: a browser that outlives this call must not
      // keep us waiting on its pipes.
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        shell,
        windowsHide: true,
      })
      child.on("error", (err) =>
        log.warn("could not open login page in a browser; open the URL manually", {
          command,
          url: safeUrl,
          error: String(err),
        }),
      )
      child.unref()
    } catch (err) {
      log.warn("could not open login page in a browser; open the URL manually", {
        url: safeUrl,
        error: String(err),
      })
    }
  }

  private async getJwtToken(tempToken: string): Promise<string> {
    const actualTempToken = tempToken.split("&")[0]
    const params = new URLSearchParams({
      tempToken: actualTempToken,
      site: "CN",
      version: "1.0.0",
      appid: this.config.appId,
    })
    const url = `${this.config.baseUrl}/${this.config.tempTokenCheckUrl}?${params}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "accept-language": "zh-CN" },
    })

    if (!res.ok) {
      log.error("failed to get jwtToken", { statusCode: res.status })
      throw new Error(`Failed to get jwtToken: ${res.status}`)
    }

    const jwtToken = (await res.text()).trim()
    if (jwtToken.split(".").length !== 3) {
      log.error("invalid jwtToken format received", { tokenLength: jwtToken.length })
      throw new Error("Invalid jwtToken format")
    }
    return jwtToken
  }

  private async getUserInfoFromJwt(jwtToken: string): Promise<UserInfo> {
    const tokenInfo = await this.checkJwtToken(jwtToken)
    if (!tokenInfo.status || !tokenInfo.userInfo) {
      log.error("invalid jwtToken: missing userInfo", { status: tokenInfo.status })
      throw new Error("Invalid jwtToken: missing userInfo")
    }
    const jwtPayload = parseJwt(jwtToken)
    const userInfo: UserInfo = {
      userId: jwtPayload.userId,
      userName: jwtPayload.userName,
      accessToken: tokenInfo.userInfo.accessToken,
      refreshToken: tokenInfo.userInfo.refreshToken ?? "",
      jwtToken,
      countryCode: "CN",
      language: "zh_CN",
      isRealName: parseRealName(tokenInfo.userInfo.realName),
    }
    return userInfo
  }

  private async checkJwtToken(jwtToken: string): Promise<TokenCheckResponse> {
    const url = `${this.config.baseUrl}/${this.config.jwtTokenCheckUrl}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { refresh: "false", jwtToken, "accept-language": "zh-CN" },
    })
    if (!res.ok) {
      log.error("failed to check jwtToken", { statusCode: res.status })
      throw new Error(`Failed to check jwtToken: ${res.status}`)
    }
    return (await res.json()) as TokenCheckResponse
  }

  /**
   * Refresh the accessToken using the stored jwtToken.
   * Returns new access/refresh tokens, or null on failure.
   */
  async refreshToken(jwtToken: string): Promise<RefreshResult | null> {
    // If the JWT itself has already expired, refreshing will always fail — skip
    // the network call and let the caller prompt a fresh login.
    try {
      const exp = parseJwt(jwtToken).exp
      if (exp && Date.now() >= exp * 1000) return null
    } catch {
      /* unparseable JWT — let the server decide */
    }

    const url = `${this.config.baseUrl}/${this.config.jwtTokenCheckUrl}`
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { refresh: "true", jwtToken, "accept-language": "zh-CN" },
      })
      if (!res.ok) {
        log.error(`refreshToken failed: HTTP ${res.status}`)
        return null
      }
      const result = (await res.json()) as TokenCheckResponse
      if (!result.status || !result.userInfo) {
        log.error("refreshToken failed: invalid response", { status: result.status })
        return null
      }
      return {
        accessToken: result.userInfo.accessToken,
        refreshToken: result.userInfo.refreshToken ?? "",
      }
    } catch (err) {
      log.error(`refreshToken error: ${String(err)}`)
      return null
    }
  }
}

/** Decode the JWT payload (no signature verification — DevEco issues these). */
export function parseJwt(token: string): JwtPayload {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error("Invalid jwtToken format")

  const base64Url = parts[1].replace(/-/g, "+").replace(/_/g, "/")
  const base64 = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=")
  const json = Buffer.from(base64, "base64").toString("utf8")
  const parsed = JSON.parse(json) as Record<string, unknown>

  return {
    userId: typeof parsed.userId === "string" ? parsed.userId : "",
    userName: typeof parsed.userName === "string" ? parsed.userName : "",
    exp: typeof parsed.exp === "number" ? parsed.exp : undefined,
    iat: typeof parsed.iat === "number" ? parsed.iat : undefined,
    nationalCode: typeof parsed.nationalCode === "string" ? parsed.nationalCode : undefined,
    isRealName: typeof parsed.isRealName === "boolean" ? parsed.isRealName : undefined,
  }
}

/**
 * Rebuild the signed-in identity from the stored jwtToken plus a fresh token
 * pair. A headless refresh returns only tokens — never a profile — so a session
 * restored at startup would otherwise report `logged_in` with a null user.
 *
 * Identity fields come straight out of the jwtToken payload; `language` is
 * fixed the same way the interactive login fixes it. Returns null for an
 * unparseable token rather than throwing, since this is only display data.
 */
export function userInfoFromJwt(jwtToken: string, tokens: RefreshResult): UserInfo | null {
  try {
    const payload = parseJwt(jwtToken)
    return {
      userId: payload.userId,
      userName: payload.userName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      jwtToken,
      countryCode: payload.nationalCode ?? "CN",
      language: "zh_CN",
      isRealName: payload.isRealName ?? false,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface LoginServiceHandle {
  login(): Promise<LoginResult>
  startLogin(opts?: { openBrowser?: boolean }): Promise<StartedLogin>
  refreshToken(jwtToken: string): Promise<RefreshResult | null>
  logout(): Promise<void>
  isLoggedIn(): Promise<boolean>
  getUserInfo(): UserInfo | null
  cancel(): void
}

export function createLoginService(
  tokenStore: TokenStore,
  config?: Partial<LoginConfig>,
): LoginServiceHandle {
  return new LoginService(tokenStore, config)
}

export { ACCESS_TOKEN_EXPIRES_MS }
