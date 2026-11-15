import { describe, expect, it } from "vitest"
import { appendLimitHint, describeUpstreamLimitError } from "./upstream-limit.js"

describe("describeUpstreamLimitError", () => {
  it("recognises explicit length errors only on 400/413", () => {
    const body = JSON.stringify({ error: { message: "the prompt length 1044994 must less than the maximum input length 1044480" } })
    expect(describeUpstreamLimitError(400, body)).toContain("170,000")
    expect(describeUpstreamLimitError(413, "OverLimitRequestBody")).toContain("170,000")
    expect(describeUpstreamLimitError(403, body)).toBeNull()
    expect(describeUpstreamLimitError(400, "some other validation error")).toBeNull()
  })
})

describe("appendLimitHint", () => {
  it("keeps the upstream payload and appends the hint to its message", () => {
    const body = JSON.stringify({ error: { message: "too long", type: "BadRequest", code: "400" } })
    const out = JSON.parse(appendLimitHint(body, "hint")) as {
      error: { message: string; type: string; code: string }
    }
    expect(out.error.message).toBe("too long\n\nhint")
    expect(out.error.type).toBe("BadRequest")
    expect(out.error.code).toBe("400")
  })

  it("handles a non-JSON body with a fresh error object", () => {
    const out = JSON.parse(appendLimitHint("plain text", "hint")) as {
      error: { message: string; type: string }
    }
    expect(out.error.message).toContain("plain text")
    expect(out.error.message).toContain("hint")
    expect(out.error.type).toBe("invalid_request_error")
  })
})
