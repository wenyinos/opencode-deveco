// Transparent image fallback: GLM-5.1 (and any model listed in
// DEVECO_TEXT_ONLY_MODELS) cannot consume image content — DevEco rejects such
// requests with HTTP 403 / "Full inference timed out". This module decides, per
// request, whether the turn must be rerouted to the vision-capable model, and
// rewrites the OpenAI-shaped body accordingly.
//
// Rules (applied to the OpenAI wire shape, i.e. after the Anthropic transform
// has already run for /anthropic/v1/messages):
//   - vision-capable model + images            → untouched
//   - text-only model + image in NEWEST user message → model replaced with
//     DEVECO_VISION_FALLBACK_MODEL; tools/tool_choice removed (Qwen VL models
//     do not emit structured tool calls)
//   - text-only model + images only in history → model untouched, old image
//     parts replaced with a "[图片]" text placeholder so the text model keeps
//     the conversation without the payload it cannot see
//   - text-only model + no images              → untouched

import {
  DEVECO_TEXT_ONLY_MODELS,
  DEVECO_VISION_FALLBACK_MODEL,
} from "./config.js"

export interface ImageRoutingResult {
  /** The body to send upstream (same object when nothing changed). */
  body: Record<string, unknown>
  /** Model id the client asked for. */
  requestedModel: string
  /** Model id the request actually goes to. */
  upstreamModel: string
  /** True when the turn was redirected to the vision model. */
  rerouted: boolean
  /** True when old image history was replaced with placeholders. */
  imagesStripped: boolean
}

interface OpenAIContentPart {
  type?: string
  text?: string
  image_url?: unknown
}

interface OpenAIMessageLike {
  role?: string
  content?: string | null | Array<OpenAIContentPart | Record<string, unknown>>
}

export function visionModelId(): string {
  return process.env.DEVECO_VISION_MODEL || DEVECO_VISION_FALLBACK_MODEL
}

export function textOnlyModelIds(): Set<string> {
  const raw = process.env.DEVECO_TEXT_ONLY_MODELS || DEVECO_TEXT_ONLY_MODELS.join(",")
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function contentParts(msg: OpenAIMessageLike | undefined): OpenAIContentPart[] {
  if (!msg || !Array.isArray(msg.content)) return []
  return msg.content.filter(
    (p): p is OpenAIContentPart => !!p && typeof p === "object" && "type" in p,
  )
}

export function messageHasImage(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false
  return contentParts(msg as OpenAIMessageLike).some((p) => p.type === "image_url")
}

export function anyMessageHasImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => messageHasImage(m))
}

/**
 * Whether the current turn's input carries an image. The current turn is the
 * message tail after the last assistant message (or all messages for a first
 * turn). This covers both a user message with an image and a `tool` message
 * that returned a screenshot as tool_result.
 */
export function currentTurnHasImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as OpenAIMessageLike | undefined
    if (msg?.role === "assistant") {
      lastAssistant = i
      break
    }
  }
  const start = lastAssistant === -1 ? 0 : lastAssistant + 1
  for (let i = start; i < messages.length; i++) {
    if (messageHasImage(messages[i])) return true
  }
  return false
}

/** Whether the newest user message carries an image. */
export function newestUserMessageHasImage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as OpenAIMessageLike | undefined
    if (msg?.role === "user") return messageHasImage(msg)
  }
  return false
}

/** Replace image parts with a text placeholder, keeping everything else. */
export function stripImages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m
    const msg = m as OpenAIMessageLike
    if (!Array.isArray(msg.content)) return m
    const content = msg.content.map((p) => {
      if (p && typeof p === "object" && "type" in p && p.type === "image_url") {
        return { type: "text", text: "[图片]" } as OpenAIContentPart
      }
      return p
    })
    return { ...(m as Record<string, unknown>), content }
  })
}

/**
 * Decide and apply the vision routing for one request body.
 * Returns null when the body has no usable model id (caller forwards as-is).
 */
export function applyVisionRouting(body: Record<string, unknown>): ImageRoutingResult | null {
  const requestedModel = typeof body.model === "string" ? body.model : ""
  if (!requestedModel) return null

  const unchanged: ImageRoutingResult = {
    body,
    requestedModel,
    upstreamModel: requestedModel,
    rerouted: false,
    imagesStripped: false,
  }
  if (!textOnlyModelIds().has(requestedModel)) return unchanged

  const messages = body.messages
  if (currentTurnHasImage(messages)) {
    const fallback = visionModelId()
    const routed: Record<string, unknown> = { ...body, model: fallback }
    // The VL models DevEco exposes don't emit structured tool calls; dropping
    // tools avoids the pseudo "<tool_call>...</tool_call>" text they return.
    delete routed.tools
    delete routed.tool_choice
    return {
      body: routed,
      requestedModel,
      upstreamModel: fallback,
      rerouted: true,
      imagesStripped: false,
    }
  }

  if (anyMessageHasImage(messages)) {
    return {
      body: { ...body, messages: stripImages(messages) as unknown },
      requestedModel,
      upstreamModel: requestedModel,
      rerouted: false,
      imagesStripped: true,
    }
  }

  return unchanged
}
