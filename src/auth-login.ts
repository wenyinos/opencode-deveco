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

import { exec } from "node:child_process"
import { promisify } from "node:util"
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

const execAsync = promisify(exec)

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
    realName: string
  }
}

interface JwtPayload {
  userId: string
  userName: string
  exp?: number
  iat?: number
}

export interface RefreshResult {
  accessToken: string
  refreshToken: string
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

  async login(): Promise<LoginResult> {
    try {
      const clientSecret = this.generateClientSecret()

      this.server = new LocalAuthServer(
        this.config.defaultPort,
        clientSecret,
        this.config.baseUrl,
        this.config.successRedirectUrl,
        this.config.failedRedirectUrl,
      )
      await this.server.start()

      // Set up the callback promise BEFORE opening the browser page so that
      // resolveCallback/rejectCallback are ready the instant the server starts
      // receiving requests.
      const callbackPromise = this.server.waitForCallback(this.config.timeout)

      await this.openLoginPage(this.server.getPort(), clientSecret)

      const callbackData = await callbackPromise

      const jwtToken = await this.getJwtToken(callbackData.tempToken)
      const userInfo = await this.getUserInfoFromJwt(jwtToken)

      await this.tokenStore.save(jwtToken)
      this.userInfo = userInfo

      return { success: true, userInfo, jwtToken }
    } catch (err) {
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
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }
    } finally {
      if (this.server) {
        await this.server.stop()
        this.server = null
      }
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

  private async openLoginPage(port: number, clientSecret: string): Promise<void> {
    const loginUrl = `${this.config.baseUrl}/${this.config.authUrl}?port=${port}&appid=${this.config.appId}&code=${clientSecret}`

    const platform = process.platform
    let command: string
    switch (platform) {
      case "win32":
        command = `start "" "${loginUrl}"`
        break
      case "darwin":
        command = `open "${loginUrl}"`
        break
      default:
        command = `xdg-open "${loginUrl}"`
        break
    }
    try {
      await execAsync(command)
    } catch (err) {
      log.error("failed to open login page in browser", {
        command,
        error: err instanceof Error ? err.message : String(err),
      })
      throw new Error("Failed to open login page", { cause: err })
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
      isRealName: tokenInfo.userInfo.realName === "true",
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
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface LoginServiceHandle {
  login(): Promise<LoginResult>
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
