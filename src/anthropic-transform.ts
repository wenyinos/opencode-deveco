// Anthropic Messages API ↔ OpenAI Chat Completions bidirectional transform.
//
// Adapts the protocol translation from cc-haha (cc-switch, Jason Young, MIT)
// for the opencode-deveco proxy use case. Strips DeepSeek/Responses-API
// specifics; focuses on OpenAI Chat Completions format used by DevEco.

// ─── Types ───────────────────────────────────────────────────

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: unknown }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean; cache_control?: unknown }
  | { type: "thinking"; thinking: string; signature?: string }

export type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicRequest = {
  model: string
  system?: string | Array<{ type: "text"; text: string; cache_control?: unknown }>
  messages: AnthropicMessage[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: unknown
  }>
  tool_choice?: unknown
  thinking?: {
    type: string
    budget_tokens?: number
  }
}

export type AnthropicResponse = {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> | null
  name?: string
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: unknown }
  }>
  tool_call_id?: string
}

type OpenAIChatRequest = {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: Array<{
    type: "function"
    function: { name: string; description?: string; parameters?: Record<string, unknown> }
  }>
  tool_choice?: unknown
  reasoning_effort?: "low" | "medium" | "high"
}

type OpenAIChatResponse = {
  id: string
  model: string
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }>
      reasoning_content?: string
      reasoning?: string
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type OpenAIChatStreamChunk = {
  id?: string
  model?: string
  choices?: Array<{
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

// ─── Request transform: Anthropic → OpenAI Chat ──────────────

export function anthropicToOpenaiChat(body: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = []

  // System prompt
  if (body.system) {
    const text = typeof body.system === "string"
      ? body.system
      : body.system.map((b) => b.text).filter(Boolean).join("\n")
    if (text) {
      messages.push({ role: "system", content: text })
    }
  }

  // Messages
  for (const msg of body.messages) {
    convertMessage(msg, messages)
  }

  const result: OpenAIChatRequest = {
    model: body.model,
    messages,
    stream: body.stream === true,
  }

  if (result.stream) {
    result.stream_options = { include_usage: true }
  }

  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p

  if (body.stop_sequences?.length) {
    result.stop = body.stop_sequences
  }

  // Tools
  if (body.tools?.length) {
    result.tools = body.tools
      .filter((t) => t.name !== "BatchTool")
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
  }

  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  // thinking → reasoning_effort
  if (body.thinking) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning_effort = "low"
      else if (budget <= 8192) result.reasoning_effort = "medium"
      else result.reasoning_effort = "high"
    } else if (body.thinking.type === "enabled") {
      result.reasoning_effort = "high"
    }
  }

  return result
}

function convertMessage(msg: AnthropicMessage, output: OpenAIChatMessage[]): void {
  const content = msg.content

  if (typeof content === "string") {
    output.push({ role: msg.role, content })
    return
  }

  if (!Array.isArray(content) || content.length === 0) {
    output.push({ role: msg.role, content: "" })
    return
  }

  if (msg.role === "user") {
    convertUserMessage(content, output)
  } else {
    convertAssistantMessage(content, output)
  }
}

function convertUserMessage(blocks: AnthropicContentBlock[], output: OpenAIChatMessage[]): void {
  const contentParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = []

  for (const block of blocks) {
    if (block.type === "text") {
      contentParts.push({ type: "text", text: block.text })
    } else if (block.type === "image") {
      const url = `data:${block.source.media_type};base64,${block.source.data}`
      contentParts.push({ type: "image_url", image_url: { url } })
    } else if (block.type === "tool_result") {
      const resultContent = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content
            .filter((b): b is Extract<AnthropicContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n")
          : ""
      output.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: resultContent,
      })
    }
  }

  if (contentParts.length > 0) {
    output.push({
      role: "user",
      content: contentParts.length === 1 && contentParts[0].type === "text"
        ? contentParts[0].text
        : contentParts,
    })
  }
}

function convertAssistantMessage(blocks: AnthropicContentBlock[], output: OpenAIChatMessage[]): void {
  let textContent = ""
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for (const block of blocks) {
    if (block.type === "text") {
      textContent += block.text
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        },
      })
    }
  }

  const msg: OpenAIChatMessage = {
    role: "assistant",
    content: textContent || null,
  }

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
  }

  output.push(msg)
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice
  if (typeof choice === "object" && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === "auto") return "auto"
    if (c.type === "any") return "required"
    if (c.type === "none") return "none"
    if (c.type === "tool" && typeof c.name === "string") {
      return { type: "function", function: { name: c.name } }
    }
  }
  return "auto"
}

// ─── Response transform: OpenAI Chat → Anthropic ─────────────

export function openaiChatToAnthropic(response: OpenAIChatResponse, model: string): AnthropicResponse {
  const choice = response.choices?.[0]
  if (!choice) {
    return {
      id: response.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: response.model || model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: mapUsage(response.usage),
    }
  }

  const content: AnthropicContentBlock[] = []
  const msg = choice.message as Record<string, unknown>

  // Reasoning content (GLM-5.1 uses `reasoning` field)
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content })
  } else if (typeof msg.reasoning === "string" && msg.reasoning) {
    content.push({ type: "thinking", thinking: msg.reasoning })
  }

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>
      if (typeof tc.function.arguments === "string") {
        try { input = JSON.parse(tc.function.arguments) } catch { input = { raw: tc.function.arguments } }
      } else {
        input = (tc.function.arguments as Record<string, unknown>) ?? {}
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" })
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: response.model || model,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response.usage),
  }
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop": return "end_turn"
    case "tool_calls": return "tool_use"
    case "length": return "max_tokens"
    case "content_filter": return "end_turn"
    default: return "end_turn"
  }
}

function mapUsage(usage: OpenAIChatResponse["usage"]): AnthropicResponse["usage"] {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }
  const input = usage.prompt_tokens ?? 0
  const output = usage.completion_tokens ?? 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0

  const result: AnthropicResponse["usage"] = {
    input_tokens: cacheRead > 0 ? Math.max(0, input - cacheRead) : input,
    output_tokens: output,
  }
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead
  return result
}

// ─── Stream transform: OpenAI SSE → Anthropic SSE ────────────

type SseEvent = { event: string; data: unknown }

type StreamState = {
  queue: SseEvent[]
  currentBlockType: "text" | "thinking" | "tool_use"
  currentBlockIndex: number
  nextContentIndex: number
  blockStartSent: boolean
  blockStopSent: boolean
  toolBlocks: Map<number, { id: string; name: string; argsBuffer: string; started: boolean; anthropicIndex: number }>
  model: string
  messageStartSent: boolean
  messageDeltaSent: boolean
  messageStopSent: boolean
  heldMessageDelta: SseEvent | null
}

function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createState(model: string): StreamState {
  return {
    queue: [],
    currentBlockType: "text",
    currentBlockIndex: -1,
    nextContentIndex: 0,
    blockStartSent: false,
    blockStopSent: false,
    toolBlocks: new Map(),
    model,
    messageStartSent: false,
    messageDeltaSent: false,
    messageStopSent: false,
    heldMessageDelta: null,
  }
}

export function openaiChatStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ""
  const state = createState(model)

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(":")) continue

            if (trimmed === "data: [DONE]") {
              finalizeStream(state)
              flushQueue(state, controller, encoder)
              continue
            }

            if (!trimmed.startsWith("data: ")) continue

            let chunk: OpenAIChatStreamChunk
            try {
              chunk = JSON.parse(trimmed.slice(6))
            } catch {
              continue
            }

            processChunk(chunk, state)
            flushQueue(state, controller, encoder)
          }
        }
      } catch (err) {
        controller.error(err)
        return
      }

      finalizeStream(state)
      flushQueue(state, controller, encoder)
      controller.close()
    },
  })
}

// ─── Stream internals ────────────────────────────────────────

function enqueue(state: StreamState, event: string, data: unknown): void {
  state.queue.push({ event, data })
}

function flushQueue(
  state: StreamState,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): void {
  for (const item of state.queue) {
    controller.enqueue(encoder.encode(formatSse(item.event, item.data)))
  }
  state.queue.length = 0
}

function ensureMessageStart(state: StreamState, chunkId?: string): void {
  if (state.messageStartSent) return
  state.messageStartSent = true
  enqueue(state, "message_start", {
    type: "message_start",
    message: {
      id: chunkId || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

function openBlock(state: StreamState, blockType: StreamState["currentBlockType"], block: Record<string, unknown>): number {
  const index = state.nextContentIndex++
  state.currentBlockType = blockType
  state.currentBlockIndex = index
  state.blockStartSent = true
  state.blockStopSent = false
  enqueue(state, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  })
  return index
}

function emitDelta(state: StreamState, index: number, delta: Record<string, unknown>): void {
  enqueue(state, "content_block_delta", { type: "content_block_delta", index, delta })
}

function closeCurrentBlock(state: StreamState): void {
  if (!state.blockStartSent || state.blockStopSent) return
  state.blockStopSent = true
  enqueue(state, "content_block_stop", { type: "content_block_stop", index: state.currentBlockIndex })
}

function closeAllToolBlocks(state: StreamState): void {
  for (const [, block] of state.toolBlocks) {
    if (block.started) {
      enqueue(state, "content_block_stop", { type: "content_block_stop", index: block.anthropicIndex })
    }
  }
  state.toolBlocks.clear()
  if (state.currentBlockType === "tool_use") {
    state.blockStopSent = true
  }
}

function closeAllOpenBlocks(state: StreamState): void {
  if (state.currentBlockType !== "tool_use") {
    closeCurrentBlock(state)
  }
  closeAllToolBlocks(state)
}

function extractReasoning(delta: Record<string, unknown>): { thinking: string } | null {
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    return { thinking: delta.reasoning_content }
  }
  if (typeof delta.reasoning === "string" && delta.reasoning) {
    return { thinking: delta.reasoning }
  }
  return null
}

function processChunk(chunk: OpenAIChatStreamChunk, state: StreamState): void {
  const choice = chunk.choices?.[0]

  if (!choice) {
    if (chunk.usage && state.heldMessageDelta) {
      mergeUsageIntoHeldDelta(state, chunk.usage)
    }
    return
  }

  state.model = chunk.model || state.model
  ensureMessageStart(state, chunk.id)

  const delta = choice.delta as Record<string, unknown>

  // Detect block type (priority: tool > text > reasoning)
  type ToolCallDelta = { index: number; id?: string; function?: { name?: string; arguments?: string } }
  const toolCalls = delta.tool_calls as ToolCallDelta[] | undefined
  const hasToolCalls = toolCalls && toolCalls.length > 0
  const hasText = delta.content != null && delta.content !== ""
  const reasoning = extractReasoning(delta)

  if (hasToolCalls) {
    const isNew = state.currentBlockType !== "tool_use" || !!(toolCalls![0]?.function?.name)
    if (isNew && state.blockStartSent && !state.blockStopSent) {
      if (state.currentBlockType !== "tool_use") closeCurrentBlock(state)
    }
    handleToolCalls(toolCalls!, state)
  } else if (hasText) {
    const isNew = state.currentBlockType !== "text" || !state.blockStartSent
    if (isNew && state.blockStartSent && !state.blockStopSent) {
      if (state.currentBlockType === "tool_use") closeAllToolBlocks(state)
      else closeCurrentBlock(state)
    }
    handleText(delta, state)
  } else if (reasoning) {
    const isNew = state.currentBlockType !== "thinking" || !state.blockStartSent
    if (isNew && state.blockStartSent && !state.blockStopSent) {
      if (state.currentBlockType === "tool_use") closeAllToolBlocks(state)
      else closeCurrentBlock(state)
    }
    handleThinking(reasoning, state)
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state)
  }
}

function handleText(delta: Record<string, unknown>, state: StreamState): void {
  if (delta.content == null || delta.content === "") return
  if (state.currentBlockType !== "text" || !state.blockStartSent) {
    openBlock(state, "text", { type: "text", text: "" })
  }
  emitDelta(state, state.currentBlockIndex, { type: "text_delta", text: delta.content })
}

function handleThinking(reasoning: { thinking: string }, state: StreamState): void {
  if (state.currentBlockType !== "thinking" || !state.blockStartSent) {
    openBlock(state, "thinking", { type: "thinking", thinking: "" })
  }
  emitDelta(state, state.currentBlockIndex, { type: "thinking_delta", thinking: reasoning.thinking })
}

function handleToolCalls(
  toolCalls: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>,
  state: StreamState,
): void {
  if (!toolCalls) return

  for (const tc of toolCalls) {
    const tcIndex = tc.index

    if (!state.toolBlocks.has(tcIndex)) {
      state.toolBlocks.set(tcIndex, { id: "", name: "", argsBuffer: "", started: false, anthropicIndex: -1 })
    }

    const block = state.toolBlocks.get(tcIndex)!
    if (tc.id) block.id = tc.id
    if (tc.function?.name) block.name += tc.function.name
    if (tc.function?.arguments) block.argsBuffer += tc.function.arguments

    if (!block.started && block.id && block.name) {
      block.started = true
      block.anthropicIndex = state.nextContentIndex++
      state.currentBlockType = "tool_use"
      state.currentBlockIndex = block.anthropicIndex
      state.blockStartSent = true
      state.blockStopSent = false

      enqueue(state, "content_block_start", {
        type: "content_block_start",
        index: block.anthropicIndex,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      })

      if (block.argsBuffer) {
        emitDelta(state, block.anthropicIndex, { type: "input_json_delta", partial_json: block.argsBuffer })
      }
    } else if (block.started && tc.function?.arguments) {
      emitDelta(state, block.anthropicIndex, { type: "input_json_delta", partial_json: tc.function.arguments })
    }
  }
}

function handleFinishReason(finishReason: string, chunk: OpenAIChatStreamChunk, state: StreamState): void {
  if (state.messageDeltaSent) return

  closeAllOpenBlocks(state)

  const stopReason = mapFinishReason(finishReason)
  const usage = chunk.usage
    ? { output_tokens: chunk.usage.completion_tokens ?? 0 }
    : { output_tokens: 0 }

  const messageDelta: SseEvent = {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    },
  }

  if (chunk.usage) {
    state.messageDeltaSent = true
    state.queue.push(messageDelta)
  } else {
    state.heldMessageDelta = messageDelta
  }
}

function mergeUsageIntoHeldDelta(
  state: StreamState,
  usage: NonNullable<OpenAIChatStreamChunk["usage"]>,
): void {
  if (!state.heldMessageDelta) return
  const data = state.heldMessageDelta.data as Record<string, unknown>
  const usageData = data.usage as Record<string, number>
  usageData.output_tokens = usage.completion_tokens ?? 0
  state.messageDeltaSent = true
  state.queue.push(state.heldMessageDelta)
  state.heldMessageDelta = null
}

function finalizeStream(state: StreamState): void {
  if (state.messageStopSent) return
  state.messageStopSent = true

  ensureMessageStart(state)
  closeAllOpenBlocks(state)

  if (state.heldMessageDelta && !state.messageDeltaSent) {
    state.messageDeltaSent = true
    state.queue.push(state.heldMessageDelta)
    state.heldMessageDelta = null
  }

  if (!state.messageDeltaSent) {
    state.messageDeltaSent = true
    enqueue(state, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    })
  }

  enqueue(state, "message_stop", { type: "message_stop" })
}
