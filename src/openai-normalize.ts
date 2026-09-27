// OpenAI-request normalisation for DevEco quirks.
//
// DevEco's `tool_choice` is an enum: only "auto" | "none" | "required" are
// accepted. The OpenAI object form ({type:"function",function:{name}} or
// {type:"tool",name}) makes the upstream reject the whole request with a
// ToolChoiceMode deserialisation error, so the proxy rewrites it the same way
// the Anthropic transform does: "required" + narrow `tools` to that one tool.
//
// DevEco's message `role` is an enum too: only "function" | "user" |
// "assistant" | "system" | "tool" are accepted. The newer OpenAI "developer"
// role still makes the upstream reject the whole request with a Role
// deserialisation error, so it is downgraded to "system".
//
// DevEco only knows the older `max_tokens`. `max_completion_tokens` is
// ignored, which leaves the model free to generate up to its own default cap —
// long enough for the non-streaming gateway to drop the connection.

import { log } from "./config.js"

export interface BodyNormalization {
  body: Record<string, unknown>
  changed: boolean
}

function forcedToolName(toolChoice: Record<string, unknown>): string | null {
  if (typeof toolChoice.function === "object" && toolChoice.function !== null) {
    const name = (toolChoice.function as Record<string, unknown>).name
    if (typeof name === "string" && name) return name
  }
  if (typeof toolChoice.name === "string" && toolChoice.name) return toolChoice.name
  return null
}

function narrowTools(tools: unknown, name: string): unknown[] | null {
  if (!Array.isArray(tools)) return null
  const narrowed = tools.filter((t) => {
    if (!t || typeof t !== "object") return false
    const fn = (t as Record<string, unknown>).function
    return !!fn && typeof fn === "object" && (fn as Record<string, unknown>).name === name
  })
  return narrowed.length > 0 ? narrowed : null
}

export function normalizeOpenAIToolChoice(
  body: Record<string, unknown>,
): BodyNormalization {
  const choice = body.tool_choice
  if (choice === undefined || typeof choice === "string") {
    return { body, changed: false }
  }
  if (typeof choice !== "object" || choice === null) {
    log.warn("proxy: dropping invalid tool_choice")
    const rest: Record<string, unknown> = { ...body }
    delete rest.tool_choice
    return { body: rest, changed: true }
  }

  const c = choice as Record<string, unknown>
  const type = typeof c.type === "string" ? c.type : ""

  // Enum-shaped objects are legal OpenAI and collapse to DevEco's enum.
  if (type === "auto" || type === "none" || type === "required") {
    return { body: { ...body, tool_choice: type }, changed: true }
  }

  // "Use exactly this tool" is emulated: DevEco's object form would 400.
  const name = forcedToolName(c)
  if (name) {
    const narrowed = narrowTools(body.tools, name)
    if (narrowed) {
      log.debug("proxy: tool_choice object → required + narrowed tools", { name })
      return {
        body: { ...body, tool_choice: "required", tools: narrowed },
        changed: true,
      }
    }
    // Forcing a tool the request doesn't declare cannot be honoured; degrade
    // to "auto" with the original tools instead of sending a 400.
    log.warn("proxy: forced tool not found in tools, falling back to tool_choice=auto", { name })
    return { body: { ...body, tool_choice: "auto" }, changed: true }
  }

  log.warn("proxy: unsupported tool_choice object, falling back to auto")
  return { body: { ...body, tool_choice: "auto" }, changed: true }
}

/**
 * Downgrade OpenAI's "developer" role to "system". SDKs routinely emit it for
 * any endpoint they assume to be OpenAI-compatible; DevEco's Role enum has no
 * such member and answers with a 400 before the model is ever called.
 */
export function normalizeOpenAIDeveloperRole(
  body: Record<string, unknown>,
): BodyNormalization {
  const messages = body.messages
  if (!Array.isArray(messages)) return { body, changed: false }

  let changed = false
  const rewritten = messages.map((message) => {
    if (!message || typeof message !== "object") return message
    const msg = message as Record<string, unknown>
    if (msg.role !== "developer") return message
    changed = true
    return { ...msg, role: "system" }
  })
  if (!changed) return { body, changed: false }

  log.debug("proxy: message role developer → system")
  return { body: { ...body, messages: rewritten }, changed: true }
}

/**
 * Translate OpenAI's newer `max_completion_tokens` into DevEco's `max_tokens`.
 * The upstream ignores the former, so the cap never applies: the model then
 * runs to its own default limit and the non-streaming gateway drops the
 * connection mid-generation. A non-numeric value is simply dropped.
 */
export function normalizeOpenAIMaxTokens(
  body: Record<string, unknown>,
): BodyNormalization {
  const maxCompletion = body.max_completion_tokens
  if (maxCompletion === undefined) return { body, changed: false }

  const rest: Record<string, unknown> = { ...body }
  delete rest.max_completion_tokens
  if (typeof maxCompletion === "number" && rest.max_tokens === undefined) {
    rest.max_tokens = maxCompletion
  }
  log.debug("proxy: max_completion_tokens → max_tokens", { maxCompletion })
  return { body: rest, changed: true }
}

/**
 * OpenAI clients spell "no reasoning" as reasoning_effort:"none" (some tools
 * send "off"). DevEco's enum only knows low|medium|high|xhigh|max and rejects
 * the whole request otherwise; the equivalent switch upstream is
 * thinking:{type:"disabled"}. Unrecognised values are left to the upstream
 * validator so a genuinely bogus effort still surfaces as a 400.
 */
export function normalizeOpenAIReasoningEffort(
  body: Record<string, unknown>,
): BodyNormalization {
  const effort = body.reasoning_effort
  if (typeof effort !== "string") return { body, changed: false }
  const value = effort.trim().toLowerCase()
  if (value !== "none" && value !== "off") return { body, changed: false }

  const rest: Record<string, unknown> = { ...body }
  delete rest.reasoning_effort
  rest.thinking = { type: "disabled" }
  log.debug("proxy: reasoning_effort none/off → thinking disabled", { effort })
  return { body: rest, changed: true }
}

/**
 * Apply every DevEco chat-completions quirk in one pass: roles first (a
 * body-level enum), then the token cap, then tool_choice, which may narrow
 * `tools` and therefore has to run last.
 */
export function normalizeOpenAIChatBody(
  body: Record<string, unknown>,
): BodyNormalization {
  let current = body
  let changed = false
  for (const normalize of [
    normalizeOpenAIDeveloperRole,
    normalizeOpenAIMaxTokens,
    normalizeOpenAIReasoningEffort,
    normalizeOpenAIToolChoice,
  ]) {
    const result = normalize(current)
    if (result.changed) {
      current = result.body
      changed = true
    }
  }
  return { body: current, changed }
}
