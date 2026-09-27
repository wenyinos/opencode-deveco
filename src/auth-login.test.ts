import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createLoginService } from "./auth-login.js"
import { JsonTokenStore } from "./token-store.js"

const FAKE_JWT = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      userId: "u1",
      userName: "Tester",
      nationalCode: "CN",
      isRealName: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url"),
  "fake-sig",
].join(".")

describe("login generation guard", () => {
  const OLD_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR
  let tmpDir: string
  let originalFetch: typeof fetch

  const setup = () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-login-"))
    process.env.OPENCODE_CONFIG_DIR = tmpDir
    originalFetch = globalThis.fetch
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (OLD_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = OLD_CONFIG_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("does not persist tokens when the login was superseded mid-exchange", async () => {
    setup()
    let releaseExchange: () => void = () => {}
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve
    })

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("temptoken/check")) {
        // Held open so the test can cancel while the exchange is in flight.
        await exchangeGate
        return new Response(FAKE_JWT, { status: 200 })
      }
      if (url.includes("jwToken/check")) {
        return new Response(
          JSON.stringify({
            status: true,
            userInfo: { accessToken: "at", refreshToken: "rt", nationalCode: "CN", realName: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("{}", { status: 404 })
    }) as typeof fetch

    const store = new JsonTokenStore()
    const service = createLoginService(store)
    const { url, result } = await service.startLogin({ openBrowser: false })

    // Play the browser: hit the callback while the exchange is still blocked.
    const parsed = new URL(url)
    const callback = originalFetch(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback` +
        `?code=${parsed.searchParams.get("code")}&tempToken=tt&siteId=1`,
    ).catch(() => undefined)

    await new Promise((r) => setTimeout(r, 30))
    service.cancel() // the user gives up (or signs out) while it is in flight
    releaseExchange()

    const outcome = await result
    expect(outcome.success).toBe(false)
    expect(await store.load()).toBeNull()

    await callback
  }, 20_000)

  it("persists tokens for a login nobody interrupted", async () => {
    setup()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("temptoken/check")) return new Response(FAKE_JWT, { status: 200 })
      if (url.includes("jwToken/check")) {
        return new Response(
          JSON.stringify({
            status: true,
            userInfo: { accessToken: "at", refreshToken: "rt", nationalCode: "CN", realName: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response("{}", { status: 404 })
    }) as typeof fetch

    const store = new JsonTokenStore()
    const service = createLoginService(store)
    const { url, result } = await service.startLogin({ openBrowser: false })

    const parsed = new URL(url)
    const callback = originalFetch(
      `http://127.0.0.1:${parsed.searchParams.get("port")}/callback` +
        `?code=${parsed.searchParams.get("code")}&tempToken=tt&siteId=1`,
    ).catch(() => undefined)

    const outcome = await result
    expect(outcome.success).toBe(true)
    expect(await store.load()).toBe(FAKE_JWT)

    await callback
  }, 20_000)
})
