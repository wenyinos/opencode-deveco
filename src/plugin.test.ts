import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyConfigHook, mergeModels } from "./plugin.js"
import { persistModels } from "./models.js"
import { PROVIDER_ID, type ProviderInfo } from "./config.js"

const OLD_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR

afterEach(() => {
  if (OLD_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = OLD_CONFIG_DIR
})

function withTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-plugin-"))
  process.env.OPENCODE_CONFIG_DIR = dir
  return dir
}

describe("mergeModels", () => {
  it("keeps cloud metadata under a user's per-model overrides", () => {
    const catalog = {
      "GLM-5.3": { name: "GLM-5.3", limit: { context: 170000 }, variants: { high: {} } },
    }
    const merged = mergeModels(catalog, {
      "GLM-5.3": { name: "My GLM" },
      "my-model": { name: "Mine" },
    })
    // The user's field wins, the cloud's metadata is not lost.
    expect(merged["GLM-5.3"].name).toBe("My GLM")
    expect(merged["GLM-5.3"].limit).toEqual({ context: 170000 })
    expect(merged["GLM-5.3"].variants).toEqual({ high: {} })
    // A model the user added on their own survives.
    expect(merged["my-model"]).toEqual({ name: "Mine" })
    expect(Object.keys(merged)).toEqual(["GLM-5.3", "my-model"])
  })
})

describe("applyConfigHook", () => {
  it("injects the persisted cloud catalog when there is no provider entry", () => {
    const dir = withTempConfigDir()
    try {
      persistModels({ models: { "GLM-5.3": { name: "GLM-5.3" }, "GLM-5.1": { name: "GLM-5.1" } } } as ProviderInfo)
      const cfg: { provider?: Record<string, unknown> } = {}
      applyConfigHook(cfg)
      const entry = cfg.provider?.[PROVIDER_ID] as ProviderInfo
      expect(Object.keys(entry.models ?? {}).sort()).toEqual(["GLM-5.1", "GLM-5.3"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("points the small model at the cloud's declared one unless the user set one", () => {
    const dir = withTempConfigDir()
    try {
      persistModels({ models: { "GLM-5.3": { name: "GLM-5.3" } } } as ProviderInfo, {
        small_model: "GLM-5.3",
      })
      const fresh: { provider?: Record<string, unknown>; small_model?: string } = {}
      applyConfigHook(fresh)
      expect(fresh.small_model).toBe(`${PROVIDER_ID}/GLM-5.3`)

      const mine: { provider?: Record<string, unknown>; small_model?: string } = {
        small_model: "anthropic/claude-haiku",
      }
      applyConfigHook(mine)
      expect(mine.small_model).toBe("anthropic/claude-haiku") // the user's choice wins
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("merges into a user-owned entry without clobbering its fields", () => {
    const dir = withTempConfigDir()
    try {
      persistModels({ models: { "GLM-5.3": { name: "GLM-5.3", limit: { context: 170000 } } } } as ProviderInfo)
      const cfg = {
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:17128/v2", setCacheKey: true },
            models: { "GLM-5.3": { name: "My GLM" } },
          },
        },
      }
      applyConfigHook(cfg)
      const entry = cfg.provider[PROVIDER_ID] as Record<string, unknown>
      // User fields survive…
      expect(entry.options).toEqual({ baseURL: "http://127.0.0.1:17128/v2", setCacheKey: true })
      // …and their model gains the cloud's metadata.
      expect(entry.models).toEqual({
        "GLM-5.3": { name: "My GLM", limit: { context: 170000 } },
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
