import { describe, it, expect, afterEach } from "vitest"
import {
  getDevecoProviderConfig,
  parseReasoningEfforts,
  reasoningLevelsFromConfig,
  resetModelCache,
} from "./models.js"

describe("parseReasoningEfforts", () => {
  it("reads the current {level,default} payload and the rollout-era array", () => {
    expect(parseReasoningEfforts('{"level":["low","high","max"],"default":"high"}')).toEqual({
      levels: ["low", "high", "max"],
      default: "high",
    })
    expect(parseReasoningEfforts('["low","high"]')).toEqual({ levels: ["low", "high"] })
  })

  it("ignores a default outside the level list and malformed payloads", () => {
    expect(parseReasoningEfforts('{"level":["low"],"default":"max"}')).toEqual({ levels: ["low"] })
    expect(parseReasoningEfforts("not json")).toEqual({ levels: [] })
    expect(parseReasoningEfforts(undefined)).toEqual({ levels: [] })
    expect(parseReasoningEfforts('{"level":["", 7, "low"]}')).toEqual({ levels: ["low"] })
  })
})

describe("model config projection", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetModelCache()
  })

  it("exposes cloud effort tiers as variants and the default as options", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 200,
          body: {
            inner_models: [
              {
                model_configs: [
                  {
                    model_id: "GLM-5.3",
                    thinking_mode: "on",
                    reasoning_effort: '{"level":["low","high","max"],"default":"high"}',
                  },
                  // Declares no efforts: the model must not gain variants.
                  { model_id: "GLM-5.1", thinking_mode: "on" },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch

    const cfg = await getDevecoProviderConfig("mock-token")
    expect(cfg.models?.["GLM-5.3"].variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
    expect(cfg.models?.["GLM-5.3"].options).toEqual({ reasoningEffort: "high" })
    expect(cfg.models?.["GLM-5.1"].variants).toBeUndefined()
    expect(cfg.models?.["GLM-5.1"].options).toBeUndefined()

    expect(reasoningLevelsFromConfig("GLM-5.3")).toEqual(["low", "high", "max"])
    expect(reasoningLevelsFromConfig("GLM-5.1")).toBeNull()
  })

  it("reports no declared levels when nothing is cached", () => {
    resetModelCache()
    expect(reasoningLevelsFromConfig("GLM-5.3")).toBeNull()
  })
})
