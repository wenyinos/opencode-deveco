import { describe, expect, it } from "vitest"
import { exposedModelId, normalizeAffinityId, upstreamModelId } from "./config.js"

describe("model naming", () => {
  it("exposes the Huawei-deployed names and maps them back to wire ids", () => {
    expect(exposedModelId("GLM-5.1")).toBe("GLM-5.1-DevEco")
    expect(exposedModelId("GLM-5.3")).toBe("GLM-5.3-DevEco")
    expect(upstreamModelId("GLM-5.1-DevEco")).toBe("GLM-5.1")
    expect(upstreamModelId("GLM-5.3-DevEco")).toBe("GLM-5.3")
  })

  it("is idempotent for unknown models and already-mapped ids", () => {
    expect(exposedModelId("GLM-5.1-DevEco")).toBe("GLM-5.1-DevEco")
    expect(upstreamModelId("GLM-5.1")).toBe("GLM-5.1")
    expect(exposedModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash")
  })
})

describe("normalizeAffinityId", () => {
  it("compacts the 36-char UUID ZCode sends", () => {
    expect(normalizeAffinityId("f1ad4a5f-eb2c-4127-8d46-8de65ef8f7ec")).toBe(
      "f1ad4a5feb2c41278d468de65ef8f7ec",
    )
  })

  it("keeps short ids and hashes over-long ones into 32 hex chars", () => {
    expect(normalizeAffinityId("s1")).toBe("s1")
    expect(normalizeAffinityId("x".repeat(40))).toMatch(/^[0-9a-f]{32}$/)
    expect(normalizeAffinityId("   ")).toBe("")
  })
})
