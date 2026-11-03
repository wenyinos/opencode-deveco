import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  COUNTRY_REGION_FILE,
  renderCountryRegionXml,
  saveCountryRegion,
} from "./country-region.js"

const dirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-region-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("renderCountryRegionXml", () => {
  it("renders the IntelliJ document DevEco Studio reads", () => {
    const xml = renderCountryRegionXml(" cn ")
    expect(xml).toContain('<component name="CountryRegionSetting">')
    expect(xml).toContain('<countryregion name="CN"/>')
  })

  it("rejects anything that is not a two-letter ASCII code", () => {
    expect(renderCountryRegionXml("")).toBeNull()
    expect(renderCountryRegionXml("CHN")).toBeNull()
    expect(renderCountryRegionXml('C"')).toBeNull()
    expect(renderCountryRegionXml("中国")).toBeNull()
  })
})

describe("saveCountryRegion", () => {
  it("writes the document under the given directory", async () => {
    const dir = tmpDir()
    expect(await saveCountryRegion("CN", dir)).toBe(true)
    const file = path.join(dir, COUNTRY_REGION_FILE)
    expect(fs.readFileSync(file, "utf8")).toContain('<countryregion name="CN"/>')
  })

  it("does not touch the disk for an invalid code", async () => {
    const dir = tmpDir()
    expect(await saveCountryRegion("USA", dir)).toBe(false)
    expect(fs.existsSync(path.join(dir, COUNTRY_REGION_FILE))).toBe(false)
  })
})
