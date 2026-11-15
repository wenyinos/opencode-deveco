// Turn the upstream's over-limit rejection into a message the caller can act
// on. DevEco's explicit length errors name the limit in different shapes
// (deepseek: "OverLimitRequestBody" / "maximum input length"; other gateways:
// "prompt length" or "context length"), so the check stays pattern-based.
//
// GLM models sometimes report a 403 ModelServiceError instead. That response is
// indistinguishable from a genuine backend overload, so it is deliberately not
// rewritten here.

import { DEVECO_GLM_CONTEXT_LIMIT } from "./config.js"

const OVER_LIMIT_PATTERNS = [
  /OverLimitRequestBody/i,
  /prompt length/i,
  /maximum input length/i,
  /context length/i,
  /too many tokens/i,
]

export function describeUpstreamLimitError(status: number, bodyText: string): string | null {
  if (status !== 400 && status !== 413) return null
  if (!OVER_LIMIT_PATTERNS.some((pattern) => pattern.test(bodyText))) return null
  return (
    `DevEco rejected the prompt as too long. This channel allows ` +
    `${DEVECO_GLM_CONTEXT_LIMIT.toLocaleString("en-US")} context tokens for ` +
    `GLM-5.1-DevEco / GLM-5.3-DevEco; reduce the prompt and retry.`
  )
}

/** Append the hint to the upstream error message, preserving the rest of the
 * payload (OpenAI and Anthropic error bodies both carry `error.message`). */
export function appendLimitHint(bodyText: string, hint: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (error && typeof error === "object") {
        const nested = error as Record<string, unknown>
        if (typeof nested.message === "string") {
          nested.message = `${nested.message}\n\n${hint}`
          return JSON.stringify(record)
        }
      }
      if (typeof record.message === "string") {
        record.message = `${record.message}\n\n${hint}`
        return JSON.stringify(record)
      }
    }
  } catch {
    /* fall through to a fresh error object */
  }
  return JSON.stringify({
    error: {
      message: `${bodyText.slice(0, 500)}\n\n${hint}`,
      type: "invalid_request_error",
    },
  })
}
