import { describe, expect, it } from "vitest"
import { describeNetworkError } from "./network-error.js"

describe("describeNetworkError", () => {
  it("names the host and points at the proxy variables for DNS failures", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND cn.devecostudio.huawei.com"), {
      cause: Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" }),
    })
    const hint = describeNetworkError(err, "https://cn.devecostudio.huawei.com/auth")
    expect(hint).toContain("cn.devecostudio.huawei.com")
    expect(hint).toContain("DNS")
    expect(hint).toContain("HTTPS_PROXY")
  })

  it("recognises refused connections and timeouts", () => {
    expect(describeNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:7890"))).toContain(
      "connection refused",
    )
    expect(describeNetworkError(new Error("TimeoutError: operation timed out"))).toContain(
      "timed out",
    )
  })

  it("returns null for errors that are not network related", () => {
    expect(describeNetworkError(new Error("Model config API returned code 500"))).toBeNull()
    expect(describeNetworkError(undefined)).toBeNull()
  })
})
