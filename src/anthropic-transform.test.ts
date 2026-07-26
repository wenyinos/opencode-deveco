import { describe, it, expect } from "vitest"
import {
  anthropicToOpenaiChat,
  openaiChatToAnthropic,
  openaiChatStreamToAnthropic,
  type AnthropicRequest,
} from "./anthropic-transform.js"

/** Collect a transformed SSE stream into one string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe("anthropicToOpenaiChat", () => {
  const baseReq: AnthropicRequest = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
  }

  it("converts basic text request", () => {
    const result = anthropicToOpenaiChat(baseReq)
    expect(result.model).toBe("claude-sonnet-4-20250514")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({ role: "user", content: "hello" })
    expect(result.stream).toBe(false)
  })

  it("converts system prompt", () => {
    const req = { ...baseReq, system: "You are a helpful assistant." }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." })
  })

  it("converts array system prompt", () => {
    const req = { ...baseReq, system: [{ type: "text" as const, text: "Line 1" }, { type: "text" as const, text: "Line 2" }] }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: "system", content: "Line 1\nLine 2" })
  })

  it("sets stream_options when streaming", () => {
    const req = { ...baseReq, stream: true }
    const result = anthropicToOpenaiChat(req)
    expect(result.stream).toBe(true)
    expect(result.stream_options).toEqual({ include_usage: true })
  })

  it("converts tools", () => {
    const req = {
      ...baseReq,
      tools: [{
        name: "bash",
        description: "Run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe("bash")
    expect(result.tools![0].function.parameters).toEqual(req.tools[0].input_schema)
  })

  it("filters BatchTool", () => {
    const req = {
      ...baseReq,
      tools: [
        { name: "BatchTool", description: "batch", input_schema: {} },
        { name: "bash", description: "run", input_schema: {} },
      ],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe("bash")
  })

  it("converts tool_choice", () => {
    expect(anthropicToOpenaiChat({ ...baseReq, tool_choice: { type: "auto" } }).tool_choice).toBe("auto")
    expect(anthropicToOpenaiChat({ ...baseReq, tool_choice: { type: "any" } }).tool_choice).toBe("required")
    expect(anthropicToOpenaiChat({ ...baseReq, tool_choice: { type: "none" } }).tool_choice).toBe("none")
  })

  it("emulates a forced tool without the object form DevEco rejects", () => {
    // DevEco types tool_choice as an enum, so {type:"function",...} fails the
    // whole request with a ToolChoiceMode deserialisation error. Requiring a
    // call while offering only the named tool is the same thing to the model.
    const result = anthropicToOpenaiChat({
      ...baseReq,
      tool_choice: { type: "tool", name: "bash" },
      tools: [
        { name: "bash", description: "run", input_schema: {} },
        { name: "read", description: "read", input_schema: {} },
      ],
    })
    expect(result.tool_choice).toBe("required")
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe("bash")
  })

  it("forwards max_tokens", () => {
    expect(anthropicToOpenaiChat({ ...baseReq, max_tokens: 64 }).max_tokens).toBe(64)
  })

  it("converts thinking to reasoning_effort", () => {
    expect(anthropicToOpenaiChat({ ...baseReq, thinking: { type: "enabled", budget_tokens: 500 } }).reasoning_effort).toBe("low")
    expect(anthropicToOpenaiChat({ ...baseReq, thinking: { type: "enabled", budget_tokens: 5000 } }).reasoning_effort).toBe("medium")
    expect(anthropicToOpenaiChat({ ...baseReq, thinking: { type: "enabled", budget_tokens: 20000 } }).reasoning_effort).toBe("high")
    expect(anthropicToOpenaiChat({ ...baseReq, thinking: { type: "enabled" } }).reasoning_effort).toBe("high")
  })

  it("converts assistant tool_use blocks to tool_calls", () => {
    const req: AnthropicRequest = {
      ...baseReq,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll run ls" },
            { type: "tool_use", id: "tc_1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tc_1", content: "file1.txt\nfile2.txt" },
          ],
        },
      ],
    }
    const result = anthropicToOpenaiChat(req)
    // system: none, assistant msg, tool msg, user msg
    const assistantMsg = result.messages.find((m) => m.role === "assistant")!
    expect(assistantMsg.content).toBe("I'll run ls")
    expect(assistantMsg.tool_calls).toHaveLength(1)
    expect(assistantMsg.tool_calls![0].id).toBe("tc_1")

    const toolMsg = result.messages.find((m) => m.role === "tool")!
    expect(toolMsg.tool_call_id).toBe("tc_1")
    expect(toolMsg.content).toBe("file1.txt\nfile2.txt")
  })
})

describe("openaiChatToAnthropic", () => {
  it("converts basic text response", () => {
    const response = {
      id: "chatcmpl-123",
      model: "GLM-5.1",
      choices: [{
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const result = openaiChatToAnthropic(response, "GLM-5.1")
    expect(result.type).toBe("message")
    expect(result.role).toBe("assistant")
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }])
    expect(result.stop_reason).toBe("end_turn")
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  it("converts reasoning content", () => {
    const response = {
      id: "chatcmpl-123",
      model: "GLM-5.1",
      choices: [{
        message: { role: "assistant", content: "Answer", reasoning: "Let me think..." },
        finish_reason: "stop",
      }],
    }
    const result = openaiChatToAnthropic(response, "GLM-5.1")
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." })
    expect(result.content[1]).toEqual({ type: "text", text: "Answer" })
  })

  it("converts tool calls", () => {
    const response = {
      id: "chatcmpl-123",
      model: "GLM-5.1",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function" as const,
            function: { name: "bash", arguments: '{"cmd":"ls"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }
    const result = openaiChatToAnthropic(response, "GLM-5.1")
    expect(result.stop_reason).toBe("tool_use")
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "bash",
      input: { cmd: "ls" },
    })
  })

  it("maps finish reasons correctly", () => {
    const make = (reason: string | null) => openaiChatToAnthropic({
      id: "x", model: "m",
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: reason }],
    }, "m")

    expect(make("stop").stop_reason).toBe("end_turn")
    expect(make("tool_calls").stop_reason).toBe("tool_use")
    expect(make("length").stop_reason).toBe("max_tokens")
    expect(make(null).stop_reason).toBe("end_turn")
  })

  it("handles empty choices", () => {
    const response = { id: "x", model: "m", choices: [] }
    const result = openaiChatToAnthropic(response, "m")
    expect(result.content).toEqual([{ type: "text", text: "" }])
    expect(result.stop_reason).toBe("end_turn")
  })

  it("subtracts cache tokens from input", () => {
    const response = {
      id: "x", model: "m",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 } },
    }
    const result = openaiChatToAnthropic(response, "m")
    expect(result.usage.input_tokens).toBe(70)
    expect(result.usage.cache_read_input_tokens).toBe(30)
  })
})

describe("openaiChatStreamToAnthropic", () => {
  const chunk = (delta: unknown) =>
    `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ delta, index: 0 }] })}\n\n`

  /** A stream that emits some chunks and then fails, like an aborted upstream. */
  function dyingStream(fail: Error): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let sent = false
    return new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(chunk({ content: "部分" })))
          return
        }
        controller.error(fail)
      },
    })
  }

  it("reports why a stream died instead of just truncating", async () => {
    const out = await drain(
      openaiChatStreamToAnthropic(dyingStream(new Error("upstream silent for 120000ms")), "m"),
    )
    // The text that did arrive is kept, its block is closed, and the client is
    // told the real reason rather than being left on a dangling stream.
    expect(out).toContain("部分")
    expect(out).toContain("content_block_stop")
    expect(out).toContain("event: error")
    expect(out).toContain("upstream silent for 120000ms")
  })

  it("pings the idle watchdog on every upstream chunk", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ content: "a" })))
        controller.enqueue(encoder.encode(": keep-alive\n\n"))
        controller.close()
      },
    })
    let pings = 0
    await drain(openaiChatStreamToAnthropic(body, "m", () => pings++))
    // Two raw chunks — including the keep-alive that produces no client event.
    expect(pings).toBe(2)
  })
})
