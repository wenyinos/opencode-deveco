import { describe, it, expect, afterEach } from "vitest"
import {
  normalizeOpenAIAssistantThink,
  normalizeOpenAIChatBody,
  normalizeOpenAIDeveloperRole,
  normalizeOpenAIMaxTokens,
  normalizeOpenAIReasoningEffort,
  normalizeOpenAIThinkingSplit,
  normalizeOpenAIToolChoice,
  snapEffortToDeclared,
} from "./openai-normalize.js"
import { getDevecoProviderConfig, resetModelCache } from "./models.js"

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

describe("normalizeOpenAIDeveloperRole", () => {
  it("downgrades every developer message to system, content intact", () => {
    const body = {
      model: "GLM-5.1",
      messages: [
        { role: "developer", content: "You are a coding agent." },
        { role: "user", content: "hi" },
        { role: "developer", content: "Extra instructions." },
      ],
    }
    const r = normalizeOpenAIDeveloperRole(body)
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "hi" },
      { role: "system", content: "Extra instructions." },
    ])
    expect(body.messages[0].role).toBe("developer")
  })

  it("leaves system/user/assistant/tool messages untouched", () => {
    const body = {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "tool", content: "t", tool_call_id: "1" },
      ],
    }
    const r = normalizeOpenAIDeveloperRole(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })

  it("tolerates a missing or malformed messages array", () => {
    expect(normalizeOpenAIDeveloperRole({}).changed).toBe(false)
    expect(normalizeOpenAIDeveloperRole({ messages: "nope" }).changed).toBe(false)
    const r = normalizeOpenAIDeveloperRole({ messages: [null, 7, { role: "developer", content: "x" }] })
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([null, 7, { role: "system", content: "x" }])
  })
})

describe("normalizeOpenAIMaxTokens", () => {
  it("renames max_completion_tokens to max_tokens", () => {
    const r = normalizeOpenAIMaxTokens({ max_completion_tokens: 100_000 })
    expect(r.changed).toBe(true)
    expect(r.body.max_tokens).toBe(100_000)
    expect("max_completion_tokens" in r.body).toBe(false)
  })

  it("keeps an explicit max_tokens and drops the alias", () => {
    const r = normalizeOpenAIMaxTokens({ max_tokens: 16, max_completion_tokens: 100_000 })
    expect(r.body.max_tokens).toBe(16)
    expect("max_completion_tokens" in r.body).toBe(false)
  })

  it("drops a non-numeric cap instead of forwarding garbage", () => {
    const r = normalizeOpenAIMaxTokens({ max_completion_tokens: "lots" })
    expect(r.changed).toBe(true)
    expect("max_tokens" in r.body).toBe(false)
  })

  it("leaves bodies without the alias untouched", () => {
    const body = { max_tokens: 32 }
    const r = normalizeOpenAIMaxTokens(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })
})

describe("normalizeOpenAIReasoningEffort", () => {
  it("maps none/off to thinking disabled and drops the effort", () => {
    for (const effort of ["none", "off"]) {
      const r = normalizeOpenAIReasoningEffort({ reasoning_effort: effort })
      expect(r.changed).toBe(true)
      expect("reasoning_effort" in r.body).toBe(false)
      expect(r.body.thinking).toEqual({ type: "disabled" })
    }
  })

  it("tolerates case and surrounding whitespace", () => {
    for (const effort of ["None", " OFF "]) {
      const r = normalizeOpenAIReasoningEffort({ reasoning_effort: effort })
      expect(r.changed).toBe(true)
      expect(r.body.thinking).toEqual({ type: "disabled" })
    }
  })

  it("overrides an explicit thinking field", () => {
    const r = normalizeOpenAIReasoningEffort({
      reasoning_effort: "none",
      thinking: { type: "enabled" },
    })
    expect(r.body.thinking).toEqual({ type: "disabled" })
  })

  it("forwards DevEco's enum values untouched", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = { reasoning_effort: effort }
      const r = normalizeOpenAIReasoningEffort(body)
      expect(r.changed).toBe(false)
      expect(r.body).toBe(body)
    }
  })

  it("leaves unknown values for the upstream validator", () => {
    const body = { reasoning_effort: "minimal" }
    expect(normalizeOpenAIReasoningEffort(body).changed).toBe(false)
    expect(normalizeOpenAIReasoningEffort({}).changed).toBe(false)
  })
})

describe("normalizeOpenAIChatBody", () => {
  it("applies the role, token-cap and tool_choice quirks in one pass", () => {
    const r = normalizeOpenAIChatBody({
      messages: [{ role: "developer", content: "sys" }],
      max_completion_tokens: 500,
      tool_choice: { type: "function", function: { name: "read" } },
      tools: [tool("read"), tool("write")],
    })
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([{ role: "system", content: "sys" }])
    expect(r.body.max_tokens).toBe(500)
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toEqual([tool("read")])
  })

  it("maps reasoning_effort off/none inside the combined pass", () => {
    const r = normalizeOpenAIChatBody({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "off",
    })
    expect(r.changed).toBe(true)
    expect("reasoning_effort" in r.body).toBe(false)
    expect(r.body.thinking).toEqual({ type: "disabled" })
  })

  it("adds the reasoning-channel flag in the combined pass", () => {
    const r = normalizeOpenAIChatBody({ messages: [{ role: "user", content: "hi" }] })
    expect(r.changed).toBe(true)
    expect(r.body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("reports a DevEco-clean body as unchanged", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: true },
    }
    const r = normalizeOpenAIChatBody(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })
})

describe("snapEffortToDeclared", () => {
  const levels = ["low", "high", "max"]

  it("keeps a declared tier and snaps the wider OpenAI vocabulary onto a declared one", () => {
    expect(snapEffortToDeclared("high", levels)).toBe("high")
    expect(snapEffortToDeclared("minimal", levels)).toBe("low")
    expect(snapEffortToDeclared("medium", levels)).toBe("high") // tie → stronger tier
    expect(snapEffortToDeclared("xhigh", levels)).toBe("max")
    expect(snapEffortToDeclared("none", levels)).toBe("low")
  })

  it("uses a declared `none` tier when the model has one", () => {
    expect(snapEffortToDeclared("none", ["none", "high", "max"])).toBe("none")
  })

  it("passes an unknown vocabulary through for the upstream to judge", () => {
    expect(snapEffortToDeclared("turbo", levels)).toBe("turbo")
  })
})

describe("normalizeOpenAIReasoningEffort against a cached model config", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetModelCache()
  })

  const primeConfig = async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 200,
          body: {
            inner_models: [
              {
                model_configs: [
                  {
                    model_id: "GLM-5.3",
                    thinking_mode: "on",
                    reasoning_effort: '{"level":["low","high","max"],"default":"high"}',
                  },
                  { model_id: "GLM-5.1", thinking_mode: "on" },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch
    await getDevecoProviderConfig("mock-token")
  }

  it("snaps an undeclared tier instead of letting it land on undefined behaviour", async () => {
    await primeConfig()
    const r = normalizeOpenAIReasoningEffort({ model: "GLM-5.3", reasoning_effort: "medium" })
    expect(r.changed).toBe(true)
    expect(r.body.reasoning_effort).toBe("high")
  })

  it("leaves a declared tier alone", async () => {
    await primeConfig()
    const r = normalizeOpenAIReasoningEffort({ model: "GLM-5.3", reasoning_effort: "max" })
    expect(r.changed).toBe(false)
  })

  it("keeps the none/off path for a model that declares no tiers", async () => {
    await primeConfig()
    const r = normalizeOpenAIReasoningEffort({ model: "GLM-5.1", reasoning_effort: "off" })
    expect(r.changed).toBe(true)
    expect("reasoning_effort" in r.body).toBe(false)
    expect(r.body.thinking).toEqual({ type: "disabled" })
  })
})

describe("normalizeOpenAIThinkingSplit", () => {
  it("asks the upstream to report reasoning on its own channel", () => {
    const r = normalizeOpenAIThinkingSplit({ messages: [] })
    expect(r.changed).toBe(true)
    expect(r.body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it("keeps other chat_template_kwargs, and an explicit client choice", () => {
    const other = normalizeOpenAIThinkingSplit({ chat_template_kwargs: { foo: 1 } })
    expect(other.body.chat_template_kwargs).toEqual({ foo: 1, enable_thinking: true })

    const explicit = { chat_template_kwargs: { enable_thinking: false } }
    const r = normalizeOpenAIThinkingSplit(explicit)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(explicit)
  })
})

describe("normalizeOpenAIAssistantThink", () => {
  it("drops the scratchpad an earlier turn left in an assistant message", () => {
    const r = normalizeOpenAIAssistantThink({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Let me work this out.\n</think>42" },
        { role: "user", content: "again" },
      ],
    })
    expect(r.changed).toBe(true)
    expect((r.body.messages as Array<{ content: string }>)[1].content).toBe("42")
    expect((r.body.messages as Array<{ content: string }>)[0].content).toBe("hi")
  })

  it("leaves user messages and clean assistant turns alone", () => {
    const body = {
      messages: [
        { role: "user", content: "what does </think> mean?" },
        { role: "assistant", content: "A stray closing tag." },
      ],
    }
    const r = normalizeOpenAIAssistantThink(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })
})
