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
//
// DevEco's GLM models think inline: the reasoning is written into `content` and
// closed by a stray `</think>` (no opening tag), so clients render the model
// talking to itself as part of the answer. Setting
// `chat_template_kwargs.enable_thinking` makes the upstream report that
// reasoning on `reasoning_content` instead, and an assistant message that still
// carries such a scratchpad is cleaned on the way in. The thinking *level* is
// never touched — these models cannot stop thinking upstream anyway.

import { log } from "./config.js"
import { reasoningLevelsFromConfig } from "./models.js"

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

/** Effort tiers weakest to strongest, mirroring the upstream plugin's order
 * (transform.ts: OPENAI_EFFORTS plus GLM's `max`). */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Snap a client-supplied effort onto a tier the model's cloud config declares.
 * Generic clients speak the wider OpenAI vocabulary — opencode's defaults, and
 * this proxy's own Anthropic budget mapping, both produce `medium` — while the
 * cloud declares only what the model understands (GLM-5.3: low|high|max). A
 * tier outside that list is not rejected; it silently lands on undefined
 * behaviour, which measured as the *heaviest* reasoning of all tiers (medium →
 * 352 chars vs high → 103). Ties go to the stronger tier so a snap never
 * quietly weakens a request. A value from an unknown vocabulary is passed
 * through untouched for the upstream to judge.
 */
export function snapEffortToDeclared(value: string, levels: string[]): string {
  if (levels.includes(value)) return value
  const target = EFFORT_ORDER.indexOf(value)
  if (target < 0) return value

  let best = levels[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of levels) {
    const index = EFFORT_ORDER.indexOf(level)
    if (index < 0) continue
    const distance = Math.abs(index - target)
    if (distance < bestDistance || (distance === bestDistance && index > EFFORT_ORDER.indexOf(best))) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

/**
 * Keep `reasoning_effort` on a tier the model actually declares. The cloud
 * publishes the accepted tiers per model, and the upstream client only ever
 * offers those, so a value from outside the list has no defined meaning
 * upstream; it is snapped onto the nearest declared tier instead.
 *
 * When the cloud declares nothing (a model without effort support, or no
 * config cached yet), the historical best-effort applies: "none"/"off" is
 * expressed as thinking:{type:"disabled"} — which today's GLM models ignore,
 * but which is the correct way to say it and will work the day the upstream
 * honours it — and every other value is passed through.
 */
export function normalizeOpenAIReasoningEffort(
  body: Record<string, unknown>,
): BodyNormalization {
  const effort = body.reasoning_effort
  if (typeof effort !== "string") return { body, changed: false }
  const value = effort.trim().toLowerCase()

  const modelId = typeof body.model === "string" ? body.model : undefined
  const declared = modelId ? reasoningLevelsFromConfig(modelId) : null
  if (declared) {
    const snapped = snapEffortToDeclared(value, declared)
    if (snapped === effort) return { body, changed: false }
    log.debug("proxy: reasoning_effort snapped to a declared tier", {
      from: effort,
      to: snapped,
      declared: declared.join("|"),
    })
    return { body: { ...body, reasoning_effort: snapped }, changed: true }
  }

  if (value !== "none" && value !== "off") return { body, changed: false }

  const rest: Record<string, unknown> = { ...body }
  delete rest.reasoning_effort
  rest.thinking = { type: "disabled" }
  log.debug("proxy: reasoning_effort none/off → thinking disabled", { effort })
  return { body: rest, changed: true }
}

/**
 * DevEco's GLM models think *inline*: the reasoning is written into `content`
 * and closed by a stray `</think>` with no opening tag, so a client renders the
 * model talking to itself as part of the answer. The upstream chat template
 * routes that reasoning to `reasoning_content` instead when `enable_thinking`
 * is set — verified with GLM-5.3 and GLM-5.1, and harmless for the VL fallback
 * — and `anthropic-transform.ts` already maps `reasoning_content` onto a
 * thinking block, so both wire protocols end up with clean content.
 *
 * This asks for the reasoning to be *reported* on the channel built for it. It
 * is not a thinking switch: the level (`reasoning_effort`) passes through
 * untouched, and these models cannot stop thinking upstream anyway
 * (`enable_thinking:false` and `thinking:{type:"disabled"}` were both measured
 * to have no effect on GLM-5.3). A client that set the flag itself keeps its
 * choice.
 */
export function normalizeOpenAIThinkingSplit(
  body: Record<string, unknown>,
): BodyNormalization {
  const existing = body.chat_template_kwargs
  if (existing !== undefined && (typeof existing !== "object" || existing === null)) {
    return { body, changed: false }
  }
  const kwargs = (existing as Record<string, unknown> | undefined) ?? {}
  if ("enable_thinking" in kwargs) return { body, changed: false }

  log.debug("proxy: asking upstream to report reasoning separately")
  return {
    body: { ...body, chat_template_kwargs: { ...kwargs, enable_thinking: true } },
    changed: true,
  }
}

/**
 * A turn answered before this proxy requested a separate reasoning channel — or
 * pasted back verbatim by a client — can leave `<reasoning></think>answer` in
 * an assistant message. Sending that scratchpad upstream again wastes context
 * and teaches the model that thinking out loud in `content` is the expected
 * format, so only the answer after the last closing tag is kept.
 */
export function normalizeOpenAIAssistantThink(
  body: Record<string, unknown>,
): BodyNormalization {
  const messages = body.messages
  if (!Array.isArray(messages)) return { body, changed: false }

  const CLOSE = "</think>"
  let changed = false
  const rewritten = messages.map((message) => {
    if (!message || typeof message !== "object") return message
    const msg = message as Record<string, unknown>
    if (msg.role !== "assistant" || typeof msg.content !== "string") return message
    const idx = msg.content.lastIndexOf(CLOSE)
    if (idx < 0) return message
    changed = true
    return { ...msg, content: msg.content.slice(idx + CLOSE.length).trimStart() }
  })
  if (!changed) return { body, changed: false }

  log.debug("proxy: stripped inline reasoning left in assistant history")
  return { body: { ...body, messages: rewritten }, changed: true }
}

/**
 * Apply every DevEco chat-completions quirk in one pass: message rewrites
 * first (roles and leftover inline reasoning), then the token cap, then the
 * thinking channel, then tool_choice, which may narrow `tools` and therefore
 * has to run last.
 */
export function normalizeOpenAIChatBody(
  body: Record<string, unknown>,
): BodyNormalization {
  let current = body
  let changed = false
  for (const normalize of [
    normalizeOpenAIAssistantThink,
    normalizeOpenAIDeveloperRole,
    normalizeOpenAIMaxTokens,
    normalizeOpenAIReasoningEffort,
    normalizeOpenAIThinkingSplit,
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
