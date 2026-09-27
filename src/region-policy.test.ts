import { describe, it, expect } from "vitest"
import { isEuropeanTimezone } from "./region-policy.js"

describe("isEuropeanTimezone", () => {
  it("matches the Europe/ namespace and the extra territories the upstream groups with it", () => {
    expect(isEuropeanTimezone("Europe/Berlin")).toBe(true)
    expect(isEuropeanTimezone("Europe/Moscow")).toBe(true)
    // Zones outside the namespace that the upstream client still refuses.
    expect(isEuropeanTimezone("Asia/Yekaterinburg")).toBe(true)
    expect(isEuropeanTimezone("Atlantic/Azores")).toBe(true)
    expect(isEuropeanTimezone("CET")).toBe(true)
    expect(isEuropeanTimezone("Turkey")).toBe(true)
  })

  it("leaves China and the rest of the world alone", () => {
    expect(isEuropeanTimezone("Asia/Shanghai")).toBe(false)
    expect(isEuropeanTimezone("Asia/Hong_Kong")).toBe(false)
    expect(isEuropeanTimezone("Asia/Tokyo")).toBe(false)
    expect(isEuropeanTimezone("America/New_York")).toBe(false)
    expect(isEuropeanTimezone("UTC")).toBe(false)
  })
})
