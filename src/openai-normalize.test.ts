import { describe, it, expect } from "vitest"
import { normalizeOpenAIToolChoice } from "./openai-normalize.js"

function tool(name: string) {
  return { type: "function", function: { name } }
}

describe("normalizeOpenAIToolChoice", () => {
  it("leaves strings and undefined untouched", () => {
    expect(normalizeOpenAIToolChoice({ tool_choice: "required" }).changed).toBe(false)
    expect(normalizeOpenAIToolChoice({}).changed).toBe(false)
  })

  it("collapses enum-shaped objects to DevEco's enum strings", () => {
    for (const type of ["auto", "none", "required"]) {
      const r = normalizeOpenAIToolChoice({ tool_choice: { type } })
      expect(r.changed).toBe(true)
      expect(r.body.tool_choice).toBe(type)
    }
  })

  it("converts the OpenAI function object to required + narrowed tools", () => {
    const body = {
      tool_choice: { type: "function", function: { name: "bash" } },
      tools: [tool("bash"), tool("read")],
    }
    const r = normalizeOpenAIToolChoice(body)
    expect(r.changed).toBe(true)
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toEqual([tool("bash")])
  })

  it("accepts the Anthropic-style {type:tool,name} object too", () => {
    const r = normalizeOpenAIToolChoice({
      tool_choice: { type: "tool", name: "read" },
      tools: [tool("read")],
    })
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toHaveLength(1)
  })

  it("degrades to auto when the forced tool is not declared", () => {
    const r = normalizeOpenAIToolChoice({
      tool_choice: { type: "function", function: { name: "missing" } },
      tools: [tool("bash")],
    })
    expect(r.body.tool_choice).toBe("auto")
    expect(r.body.tools).toEqual([tool("bash")])
  })

  it("drops non-object garbage that DevEco would reject", () => {
    const r = normalizeOpenAIToolChoice({ tool_choice: 42 })
    expect(r.changed).toBe(true)
    expect("tool_choice" in r.body).toBe(false)
  })
})
