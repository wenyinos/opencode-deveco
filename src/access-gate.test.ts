import { describe, it, expect, beforeEach } from "vitest"
import {
  checkRealNameGate,
  resetRealNameCache,
  REAL_NAME_REQUIRED_MESSAGE,
  REAL_NAME_UNVERIFIED_MESSAGE,
} from "./access-gate.js"

describe("checkRealNameGate", () => {
  beforeEach(() => resetRealNameCache())

  it("passes a verified account and refuses an unverified one with an actionable message", async () => {
    expect(await checkRealNameGate({ userId: "u1", accessToken: "a1", verify: async () => true })).toBeNull()
    expect(await checkRealNameGate({ userId: "u2", accessToken: "a2", verify: async () => false })).toBe(
      REAL_NAME_REQUIRED_MESSAGE,
    )
  })

  it("reports an inconclusive check separately", async () => {
    expect(await checkRealNameGate({ userId: "u3", accessToken: "a3", verify: async () => null })).toBe(
      REAL_NAME_UNVERIFIED_MESSAGE,
    )
  })

  it("shares one in-flight check and reuses its verdict", async () => {
    let calls = 0
    const verify = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return false
    }
    const identity = { userId: "u4", accessToken: "a4", verify }
    const [first, second] = await Promise.all([
      checkRealNameGate(identity),
      checkRealNameGate(identity),
    ])
    expect(first).toBe(REAL_NAME_REQUIRED_MESSAGE)
    expect(second).toBe(REAL_NAME_REQUIRED_MESSAGE)
    expect(calls).toBe(1) // concurrent turns shared the round-trip

    await checkRealNameGate(identity)
    expect(calls).toBe(1) // and the verdict is reused within the window
  })

  it("does not carry a verdict across identities", async () => {
    let calls = 0
    const verify = async () => {
      calls++
      return false
    }
    await checkRealNameGate({ userId: "u5", accessToken: "a5", verify })
    await checkRealNameGate({ userId: "u6", accessToken: "a6", verify })
    expect(calls).toBe(2)
  })

  it("asks again after a verified account's token rotates", async () => {
    let calls = 0
    const verify = async () => {
      calls++
      return true
    }
    expect(await checkRealNameGate({ userId: "u7", accessToken: "old", verify })).toBeNull()
    expect(await checkRealNameGate({ userId: "u7", accessToken: "new", verify })).toBeNull()
    expect(calls).toBe(2)
  })
})
