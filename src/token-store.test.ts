import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  JsonTokenStore,
  defaultTokenFilePath,
  legacyTokenFilePath,
} from "./token-store.js"

const OLD_XDG = process.env.XDG_CONFIG_HOME
const OLD_OPENCODE = process.env.OPENCODE_CONFIG_DIR

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-token-test-"))
})

afterEach(() => {
  if (OLD_XDG === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = OLD_XDG
  if (OLD_OPENCODE === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = OLD_OPENCODE
  fs.rmSync(tmp, { recursive: true, force: true })
})

const JWT = "a.b.c"

describe("defaultTokenFilePath", () => {
  it("appends opencode to the XDG base instead of treating it as the app dir", () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    expect(defaultTokenFilePath()).toBe(path.join(tmp, "opencode", "opencode-deveco", "jwt.json"))
    expect(legacyTokenFilePath()).toBe(path.join(tmp, "opencode-deveco", "jwt.json"))
  })

  it("prefers OPENCODE_CONFIG_DIR when set", () => {
    const dir = path.join(tmp, "custom")
    process.env.OPENCODE_CONFIG_DIR = dir
    process.env.XDG_CONFIG_HOME = path.join(tmp, "ignored")
    expect(defaultTokenFilePath()).toBe(path.join(dir, "opencode-deveco", "jwt.json"))
  })
})

describe("JsonTokenStore", () => {
  it("migrates a valid legacy jwtToken to the canonical path and removes the legacy copy", async () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    const legacy = legacyTokenFilePath()
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, JSON.stringify({ jwt: JWT, savedAt: Date.now() }), { mode: 0o600 })

    const store = new JsonTokenStore()
    expect(await store.load()).toBe(JWT)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.existsSync(defaultTokenFilePath())).toBe(true)
    expect(JSON.parse(fs.readFileSync(defaultTokenFilePath(), "utf8")).jwt).toBe(JWT)
  })

  it("keeps the canonical path authoritative once both exist", async () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    const store = new JsonTokenStore()
    await store.save("new.new.new")
    // Plant a stale legacy copy; the canonical (newer) one must win and the
    // legacy copy is removed.
    const legacy = legacyTokenFilePath()
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(legacy, JSON.stringify({ jwt: "old.old.old" }), { mode: 0o600 })

    expect(await store.load()).toBe("new.new.new")
    expect(fs.existsSync(legacy)).toBe(false)
  })

  it("migrates the legacy copy when it is newer than a stale canonical file", async () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    const file = defaultTokenFilePath()
    const legacy = legacyTokenFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ jwt: "stale.stale.stale", savedAt: 1 }), { mode: 0o600 })
    fs.writeFileSync(legacy, JSON.stringify({ jwt: JWT, savedAt: Date.now() }), { mode: 0o600 })

    expect(await new JsonTokenStore().load()).toBe(JWT)
    expect(fs.existsSync(legacy)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).jwt).toBe(JWT)
  })

  it("returns null and clears a malformed token file", async () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    const file = defaultTokenFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ jwt: "not-a-jwt" }))

    expect(await new JsonTokenStore().load()).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it("keeps the fresher legacy token when migration to canonical fails", async () => {
    process.env.XDG_CONFIG_HOME = tmp
    delete process.env.OPENCODE_CONFIG_DIR
    const file = defaultTokenFilePath()
    const legacy = legacyTokenFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ jwt: "stale.stale.stale", savedAt: 1 }), { mode: 0o600 })
    fs.writeFileSync(legacy, JSON.stringify({ jwt: JWT, savedAt: Date.now() }), { mode: 0o600 })

    // Simulate an unwritable canonical location: save() fails, so the legacy
    // copy must NOT be deleted and the newer token must still win.
    class FailingSaveStore extends JsonTokenStore {
      override async save(): Promise<boolean> {
        return false
      }
    }
    const store = new FailingSaveStore(file, legacy)
    expect(await store.load()).toBe(JWT)
    expect(fs.existsSync(legacy)).toBe(true)
  })
})
