// Write the country/region setting shared with DevEco Studio.
//
// Ported from deveco-code packages/opencode/src/plugin/deveco/country-region.ts
// (`cc7a159dc`). The file lives at `~/.config/deveco/country.region.xml` on
// every platform: that location is fixed by the product requirement because
// DevEco Studio reads it, and it must not follow this project's own config
// directory elsewhere.

import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { log } from "./config.js"

export const COUNTRY_REGION_FILE = "country.region.xml"

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const COUNTRY_CODE_INPUT_PATTERN = /^[A-Za-z]{2}$/

/** Windows refuses to replace a file another process holds open; retry the
 * sharing violations instead of failing the login side effect. */
const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"])
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160]

/** `DEVECO_COUNTRY_REGION_DIR` is a test seam; production uses the fixed path. */
export function countryRegionDir(): string {
  return process.env.DEVECO_COUNTRY_REGION_DIR || path.join(os.homedir(), ".config", "deveco")
}

export function countryRegionFilePath(dir: string = countryRegionDir()): string {
  return path.join(dir, COUNTRY_REGION_FILE)
}

/** Render the IntelliJ-style document DevEco Studio reads; null for a value
 * that is not a two-letter ASCII country code. */
export function renderCountryRegionXml(countryCode: string): string | null {
  const trimmed = countryCode.trim()
  if (!COUNTRY_CODE_INPUT_PATTERN.test(trimmed)) return null
  const code = trimmed.toUpperCase()
  if (!COUNTRY_CODE_PATTERN.test(code)) return null
  return [
    "<application>",
    '  <component name="CountryRegionSetting">',
    `    <countryregion name="${code}"/>`,
    "  </component>",
    "</application>",
    "",
  ].join("\n")
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const code = (err as { code: unknown }).code
  return typeof code === "string" ? code : undefined
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !RETRYABLE_RENAME_ERRORS.has(errorCode(err) ?? "")) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Persist `countryCode`. A temp sibling is renamed over the target so a reader
 * never sees a half-written document; an invalid code returns false without
 * touching the disk, and an I/O failure is thrown for the caller to log.
 */
export async function saveCountryRegion(
  countryCode: string,
  dir: string = countryRegionDir(),
): Promise<boolean> {
  const xml = renderCountryRegionXml(countryCode)
  if (xml === null) {
    log.warn("country code is not a two-letter country code; country region file not written", {
      countryCode,
    })
    return false
  }

  const target = countryRegionFilePath(dir)
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.mkdir(dir, { recursive: true })
    // 0o644: DevEco Studio reads this file as the same user; the content is a
    // two-letter code, not a secret.
    await fs.writeFile(temp, xml, { encoding: "utf8", mode: 0o644 })
    await renameWithRetry(temp, target)
    return true
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}
