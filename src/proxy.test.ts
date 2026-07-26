import { describe, it, expect } from "vitest"
import { browserOpenCommand, parseJwt, userInfoFromJwt } from "./auth-login.js"

// Helper: build a minimal JWT (header.payload.signature) with a given payload.
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.fake-sig`
}

describe("parseJwt", () => {
  it("extracts userId and userName from a valid JWT", () => {
    const token = makeJwt({ userId: "u123", userName: "Alice", exp: 1700000000 })
    const result = parseJwt(token)
    expect(result.userId).toBe("u123")
    expect(result.userName).toBe("Alice")
    expect(result.exp).toBe(1700000000)
  })

  it("returns empty strings for missing userId/userName", () => {
    const token = makeJwt({ exp: 100 })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })

  it("throws on a token without 3 parts", () => {
    expect(() => parseJwt("ab.cd")).toThrow("Invalid jwtToken format")
    expect(() => parseJwt("")).toThrow("Invalid jwtToken format")
  })

  it("handles non-string userId gracefully", () => {
    const token = makeJwt({ userId: 42, userName: true })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })
})

describe("userInfoFromJwt", () => {
  const tokens = { accessToken: "at", refreshToken: "rt" }

  it("rebuilds the identity a headless refresh doesn't return", () => {
    // Field names match a real DevEco jwtToken payload.
    const jwt = makeJwt({ userId: "u1", userName: "Alice", nationalCode: "CN", isRealName: true })
    const info = userInfoFromJwt(jwt, tokens)
    expect(info).toMatchObject({
      userId: "u1",
      userName: "Alice",
      countryCode: "CN",
      isRealName: true,
      accessToken: "at",
      refreshToken: "rt",
      jwtToken: jwt,
    })
  })

  it("falls back without inventing a real-name status", () => {
    const info = userInfoFromJwt(makeJwt({ userId: "u2", userName: "Bob" }), tokens)
    expect(info?.countryCode).toBe("CN")
    expect(info?.isRealName).toBe(false)
  })

  it("returns null for an unparseable token instead of throwing", () => {
    expect(userInfoFromJwt("not-a-jwt", tokens)).toBeNull()
  })
})

describe("browserOpenCommand", () => {
  // A real login URL: the `&` separators are what break unquoted cmd.
  const url =
    "https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&appid=1008&code=deadbeef"

  it("keeps the URL quoted on Windows so cmd doesn't split it at &", () => {
    const { command, args, shell } = browserOpenCommand("win32", url)
    expect(shell).toBe(true)
    expect(args).toEqual([])
    expect(command).toBe(`start "" "${url}"`)
  })

  it("passes the URL as a single argv on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({
      command: "open",
      args: [url],
      shell: false,
    })
    expect(browserOpenCommand("linux", url)).toEqual({
      command: "xdg-open",
      args: [url],
      shell: false,
    })
  })
})

describe("/v2 path stripping", () => {
  const strip = (p: string) => p.replace(/^\/v2/, "") || "/"

  it("strips /v2 prefix", () => {
    expect(strip("/v2/chat/completions")).toBe("/chat/completions")
    expect(strip("/v2/models")).toBe("/models")
    expect(strip("/v2/status")).toBe("/status")
  })

  it("leaves non-/v2 paths unchanged", () => {
    expect(strip("/chat/completions")).toBe("/chat/completions")
    expect(strip("/models")).toBe("/models")
  })

  it("maps bare /v2 to /", () => {
    expect(strip("/v2")).toBe("/")
    expect(strip("/v2/")).toBe("/")
  })
})
