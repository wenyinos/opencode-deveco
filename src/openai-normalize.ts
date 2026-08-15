// OpenAI-request normalisation for DevEco quirks.
//
// DevEco's `tool_choice` is an enum: only "auto" | "none" | "required" are
// accepted. The OpenAI object form ({type:"function",function:{name}} or
// {type:"tool",name}) makes the upstream reject the whole request with a
// ToolChoiceMode deserialisation error, so the proxy rewrites it the same way
// the Anthropic transform does: "required" + narrow `tools` to that one tool.

import { log } from "./config.js"

export interface ToolChoiceNormalization {
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
): ToolChoiceNormalization {
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
