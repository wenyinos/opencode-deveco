import { describe, it, expect, afterEach } from "vitest"
import { browserOpenCommand, parseJwt, parseRealName, userInfoFromJwt } from "./auth-login.js"
import { conversationKey, idleBudget, sessionKeyFromHeaders } from "./proxy.js"

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

describe("parseRealName", () => {
  it("accepts the boolean shape DevEco returns today", () => {
    expect(parseRealName(true)).toBe(true)
    expect(parseRealName(false)).toBe(false)
  })

  it("still accepts the legacy string shape", () => {
    expect(parseRealName("true")).toBe(true)
    expect(parseRealName("false")).toBe(false)
    expect(parseRealName(undefined)).toBe(false)
  })
})

describe("/v2 path stripping", () => {
  const strip = (p: string) => p.replace(/^\/v2(?=\/|$)/, "") || "/"

  it("strips /v2 prefix", () => {
    expect(strip("/v2/chat/completions")).toBe("/chat/completions")
    expect(strip("/v2/models")).toBe("/models")
    expect(strip("/v2/status")).toBe("/status")
  })

  it("leaves non-/v2 paths unchanged", () => {
    expect(strip("/chat/completions")).toBe("/chat/completions")
    expect(strip("/models")).toBe("/models")
  })

  it("does not strip words that merely start with /v2", () => {
    expect(strip("/v2models")).toBe("/v2models")
  })

  it("maps bare /v2 to /", () => {
    expect(strip("/v2")).toBe("/")
    expect(strip("/v2/")).toBe("/")
  })
})

describe("idleBudget", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("aborts once the upstream goes quiet", async () => {
    const b = idleBudget(120)
    expect(b.signal.aborted).toBe(false)
    await sleep(200)
    expect(b.signal.aborted).toBe(true)
    b.done()
  })

  it("lets a slow but live stream run past the idle window", async () => {
    const b = idleBudget(120)
    // Five 80ms gaps: 400ms total, well beyond the window, never silent for it.
    for (let i = 0; i < 5; i++) {
      await sleep(80)
      b.touch()
    }
    expect(b.signal.aborted).toBe(false)
    b.done()
  })

  it("stops the clock once the turn is done", async () => {
    const b = idleBudget(100)
    b.done()
    await sleep(200)
    expect(b.signal.aborted).toBe(false)
  })
})

describe("sessionKeyFromHeaders", () => {
  it("reads the supported explicit session headers in order", () => {
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1" })).toBe("s1")
    expect(sessionKeyFromHeaders({ "x-session-affinity": "s2" })).toBe("s2")
    expect(sessionKeyFromHeaders({ "x-session-id": "s3" })).toBe("s3")
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1", "x-session-id": "s3" })).toBe("s1")
  })

  it("returns null for missing or blank headers", () => {
    expect(sessionKeyFromHeaders({})).toBeNull()
    expect(sessionKeyFromHeaders({ "x-session-id": "   " })).toBeNull()
  })
})

describe("conversationKey", () => {
  const first = { role: "user", content: "开始" }
  const OLD_MODE = process.env.DEVECO_SESSION_KEY_MODE

  afterEach(() => {
    if (OLD_MODE === undefined) delete process.env.DEVECO_SESSION_KEY_MODE
    else process.env.DEVECO_SESSION_KEY_MODE = OLD_MODE
  })

  it("stays put as the conversation grows", () => {
    const round1 = conversationKey({ system: "sys", messages: [first] })
    const round2 = conversationKey({
      system: "sys",
      messages: [first, { role: "assistant", content: "好" }, { role: "user", content: "继续" }],
    })
    expect(round2).toBe(round1)
  })

  it("separates different conversations", () => {
    expect(conversationKey({ system: "sys", messages: [first] })).not.toBe(
      conversationKey({ system: "sys", messages: [{ role: "user", content: "另一个话题" }] }),
    )
  })

  it("keeps the key stable when only the system prompt changes (default mode)", () => {
    delete process.env.DEVECO_SESSION_KEY_MODE
    expect(conversationKey({ system: "system-A", messages: [first] })).toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })

  it("includes the system prompt when DEVECO_SESSION_KEY_MODE=system-first", () => {
    process.env.DEVECO_SESSION_KEY_MODE = "system-first"
    expect(conversationKey({ system: "system-A", messages: [first] })).not.toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })
})
