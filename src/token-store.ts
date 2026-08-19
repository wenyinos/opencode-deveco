// Persist the long-lived jwtToken used to refresh DevEco access tokens.
//
// Per the chosen design (simple 0600 JSON file), we store the jwtToken at
//   <opencode config dir>/opencode-deveco/jwt.json
// where the opencode config dir is:
//   1. $OPENCODE_CONFIG_DIR (explicit override), or
//   2. $XDG_CONFIG_HOME/opencode (standard XDG base + app dir), or
//   3. ~/.config/opencode
// which is independent from deveco-code's own ~/.config/deveco/token.enc.
// No encryption (user-accepted tradeoff for v1); the file is chmod 0600.
//
// Earlier releases treated XDG_CONFIG_HOME itself as the opencode config dir
// and wrote to <XDG base>/opencode-deveco/jwt.json. On load we migrate that
// legacy file to the correct location so restarts never split the login state
// depending on how the process was launched.

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

function xdgConfigBase(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
}

function configDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return path.join(xdgConfigBase(), "opencode")
}

export function defaultTokenFilePath(): string {
  return path.join(configDir(), "opencode-deveco", "jwt.json")
}

/**
 * Where pre-fix releases wrote the token when XDG_CONFIG_HOME pointed at the
 * base directory (the bundled systemd unit does exactly that).
 */
export function legacyTokenFilePath(): string {
  return path.join(xdgConfigBase(), "opencode-deveco", "jwt.json")
}

interface StoredShape {
  jwt?: string
  savedAt?: number
}

function validJwt(jwt: unknown): jwt is string {
  return typeof jwt === "string" && jwt !== "" && jwt.split(".").length === 3
}

export class JsonTokenStore implements TokenStore {
  private readonly filePath: string
  private readonly legacyFilePath: string

  constructor(
    filePath: string = defaultTokenFilePath(),
    legacyFilePath: string = legacyTokenFilePath(),
  ) {
    this.filePath = filePath
    this.legacyFilePath = legacyFilePath
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
      // Once the canonical path holds a token, a stale legacy copy must not be
      // able to shadow it if the process is ever launched without XDG set.
      if (this.legacyFilePath !== this.filePath && fs.existsSync(this.legacyFilePath)) {
        try {
          fs.unlinkSync(this.legacyFilePath)
          log.info("token-store: removed legacy jwtToken copy", { path: this.legacyFilePath })
        } catch {
          /* ignore */
        }
      }
      return true
    } catch (err) {
      log.error("token-store: failed to save jwtToken", { error: String(err) })
      return false
    }
  }

  async load(): Promise<string | null> {
    const canonical = fs.existsSync(this.filePath) ? this.readTokenFile(this.filePath) : null
    const legacy =
      this.legacyFilePath !== this.filePath && fs.existsSync(this.legacyFilePath)
        ? this.readTokenFile(this.legacyFilePath)
        : null

    // Both locations can exist after the path fix: the canonical one may be a
    // format-valid but server-expired token while the legacy one is fresh.
    // Newest save wins; the loser is deleted so it can never shadow again.
    if (canonical && legacy && legacy.savedAt > canonical.savedAt) {
      if (await this.save(legacy.jwt)) {
        log.info("token-store: migrated newer jwtToken to canonical path", {
          from: this.legacyFilePath,
        })
        return legacy.jwt
      }
      // Migration failed (e.g. unwritable dir): never delete the fresher
      // legacy token nor hand back a stale canonical one — prefer the newer
      // token; the next successful save cleans the duplicate up.
      log.warn("token-store: failed to migrate newer jwtToken, keeping legacy copy")
      return legacy.jwt
    }
    if (canonical) {
      this.removeLegacyCopy()
      return canonical.jwt
    }
    if (legacy) {
      if (await this.save(legacy.jwt)) {
        log.info("token-store: migrated jwtToken to canonical path", {
          from: this.legacyFilePath,
        })
        return legacy.jwt
      }
    }
    return null
  }

  private removeLegacyCopy(): void {
    if (
      this.legacyFilePath !== this.filePath &&
      fs.existsSync(this.legacyFilePath)
    ) {
      this.clearFile(this.legacyFilePath)
    }
  }

  private readTokenFile(file: string): { jwt: string; savedAt: number } | null {
    try {
      const raw = fs.readFileSync(file, "utf8")
      const parsed = JSON.parse(raw) as StoredShape
      if (!validJwt(parsed.jwt)) {
        log.warn("token-store: stored jwtToken is malformed, clearing", { path: file })
        this.clearFile(file)
        return null
      }
      return {
        jwt: parsed.jwt,
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      }
    } catch (err) {
      log.warn("token-store: failed to load jwtToken, clearing", {
        path: file,
        error: String(err),
      })
      this.clearFile(file)
      return null
    }
  }

  private clearFile(file: string): void {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (err) {
      log.warn("token-store: failed to clear jwtToken", { path: file, error: String(err) })
    }
  }

  async clear(): Promise<void> {
    this.clearFile(this.filePath)
    if (this.legacyFilePath !== this.filePath) this.clearFile(this.legacyFilePath)
  }
}
