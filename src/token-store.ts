// Persist the long-lived jwtToken used to refresh DevEco access tokens.
//
// Per the chosen design (simple 0600 JSON file), we store the jwtToken at
//   <opencode config dir>/opencode-deveco/jwt.json
// which is independent from deveco-code's own ~/.config/deveco/token.enc.
// No encryption (user-accepted tradeoff for v1); the file is chmod 0600.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { log } from "./config.js"

export interface TokenStore {
  /** Save the jwtToken. Returns false on failure (logged, not thrown). */
  save(jwtToken: string): Promise<boolean>
  /** Load the jwtToken, or null if absent/corrupt. */
  load(): Promise<string | null>
  /** Remove the stored jwtToken. */
  clear(): Promise<void>
}

function configDir(): string {
  return (
    process.env.XDG_CONFIG_HOME ||
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "opencode")
  )
}

export function defaultTokenFilePath(): string {
  return path.join(configDir(), "opencode-deveco", "jwt.json")
}

interface StoredShape {
  jwt?: string
  savedAt?: number
}

export class JsonTokenStore implements TokenStore {
  private readonly filePath: string

  constructor(filePath: string = defaultTokenFilePath()) {
    this.filePath = filePath
  }

  async save(jwtToken: string): Promise<boolean> {
    if (!jwtToken) return false
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const payload: StoredShape = { jwt: jwtToken, savedAt: Date.now() }
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
      // best-effort tighten perms even if the file pre-existed
      try {
        fs.chmodSync(this.filePath, 0o600)
      } catch {
        /* chmod may fail on some platforms; ignore */
      }
      return true
    } catch (err) {
      log.error("token-store: failed to save jwtToken", { error: String(err) })
      return false
    }
  }

  async load(): Promise<string | null> {
    try {
      if (!fs.existsSync(this.filePath)) return null
      const raw = fs.readFileSync(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as StoredShape
      if (typeof parsed.jwt !== "string" || !parsed.jwt) return null
      return parsed.jwt
    } catch (err) {
      log.warn("token-store: failed to load jwtToken, clearing", { error: String(err) })
      try {
        await this.clear()
      } catch {
        /* ignore */
      }
      return null
    }
  }

  async clear(): Promise<void> {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath)
    } catch (err) {
      log.warn("token-store: failed to clear jwtToken", { error: String(err) })
    }
  }
}
