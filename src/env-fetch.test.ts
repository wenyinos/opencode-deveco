import { afterEach, describe, expect, it } from "vitest"
import { envFetch, envProxyConfigured } from "./env-fetch.js"

describe("env-fetch", () => {
  const originalFetch = globalThis.fetch
  const originalProxy = process.env.HTTPS_PROXY

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = originalProxy
  })

  it("keeps using the global fetch when no proxy is configured", async () => {
    delete process.env.HTTPS_PROXY
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response("ok")
    }) as typeof fetch

    expect(envProxyConfigured()).toBe(false)
    const res = await envFetch("http://direct.example/")
    expect(res.status).toBe(200)
    expect(seen).toEqual(["http://direct.example/"])
  })
})
