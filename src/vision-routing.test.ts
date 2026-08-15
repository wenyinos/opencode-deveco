import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  applyVisionRouting,
  anyMessageHasImage,
  currentTurnHasImage,
  newestUserMessageHasImage,
  stripImages,
} from "./vision-routing.js"

const OLD_VISION_MODEL = process.env.DEVECO_VISION_MODEL
const OLD_TEXT_ONLY = process.env.DEVECO_TEXT_ONLY_MODELS

function imagePart(dataUrl = "data:image/png;base64,AAAA") {
  return { type: "image_url", image_url: { url: dataUrl } }
}

describe("vision routing", () => {
  beforeEach(() => {
    delete process.env.DEVECO_VISION_MODEL
    delete process.env.DEVECO_TEXT_ONLY_MODELS
  })
  afterEach(() => {
    if (OLD_VISION_MODEL === undefined) delete process.env.DEVECO_VISION_MODEL
    else process.env.DEVECO_VISION_MODEL = OLD_VISION_MODEL
    if (OLD_TEXT_ONLY === undefined) delete process.env.DEVECO_TEXT_ONLY_MODELS
    else process.env.DEVECO_TEXT_ONLY_MODELS = OLD_TEXT_ONLY
  })

  it("reroutes a text-only model when the newest user message has an image", () => {
    const r = applyVisionRouting({
      model: "GLM-5.1",
      messages: [
        { role: "user", content: [{ type: "text", text: "看这个图" }, imagePart()] },
      ],
      tools: [{ type: "function", function: { name: "bash" } }],
      tool_choice: "auto",
    })!
    expect(r.rerouted).toBe(true)
    expect(r.upstreamModel).toBe("Qwen3_VL_235B_A22B_Instruct")
    expect(r.body.model).toBe("Qwen3_VL_235B_A22B_Instruct")
    // VL models don't do structured tool calls — tools must not leak through.
    expect("tools" in r.body).toBe(false)
    expect("tool_choice" in r.body).toBe(false)
  })

  it("routes when the current turn's tool message contains an image", () => {
    const r = applyVisionRouting({
      model: "GLM-5.1",
      messages: [
        { role: "user", content: "看截图" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "shot" } }] },
        { role: "tool", tool_call_id: "t1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] },
      ],
    })!
    expect(r.rerouted).toBe(true)
    expect(r.upstreamModel).toBe("Qwen3_VL_235B_A22B_Instruct")
  })

  it("keeps a text-only model when images only exist in history, and strips them", () => {
    const messages = [
      { role: "user", content: [imagePart(), { type: "text", text: "图里是什么" }] },
      { role: "assistant", content: "这是红底图" },
      { role: "user", content: "继续说" },
    ]
    const r = applyVisionRouting({ model: "GLM-5.1", messages })!
    expect(r.rerouted).toBe(false)
    expect(r.upstreamModel).toBe("GLM-5.1")
    expect(r.imagesStripped).toBe(true)
    const stripped = r.body.messages as Array<{ content: unknown }>
    expect(JSON.stringify(stripped[0].content)).toContain("[图片]")
    expect(JSON.stringify(stripped[0].content)).not.toContain("image_url")
    expect(stripped[2]).toEqual({ role: "user", content: "继续说" })
  })

  it("leaves vision-capable models and their images untouched", () => {
    const body = {
      model: "Qwen3_VL_235B_A22B_Instruct",
      messages: [{ role: "user", content: [imagePart()] }],
      tools: [{ type: "function", function: { name: "x" } }],
    }
    const r = applyVisionRouting(body)!
    expect(r.rerouted).toBe(false)
    expect(r.imagesStripped).toBe(false)
    expect(r.body).toBe(body)
    expect("tools" in r.body).toBe(true)
  })

  it("leaves text-only requests without images untouched", () => {
    const body = { model: "GLM-5.1", messages: [{ role: "user", content: "你好" }] }
    const r = applyVisionRouting(body)!
    expect(r.rerouted).toBe(false)
    expect(r.imagesStripped).toBe(false)
    expect(r.body).toBe(body)
  })

  it("honours DEVECO_VISION_MODEL and DEVECO_TEXT_ONLY_MODELS overrides", () => {
    process.env.DEVECO_VISION_MODEL = "my-vl-model"
    process.env.DEVECO_TEXT_ONLY_MODELS = "GLM-5.1,glm-5"
    expect(applyVisionRouting({ model: "glm-5", messages: [{ role: "user", content: [imagePart()] }] })?.upstreamModel).toBe("my-vl-model")
    expect(applyVisionRouting({ model: "GLM-5.1", messages: [{ role: "user", content: [imagePart()] }] })?.upstreamModel).toBe("my-vl-model")
  })

  it("returns null when the body has no model", () => {
    expect(applyVisionRouting({ messages: [{ role: "user", content: [imagePart()] }] })).toBeNull()
  })
})

describe("image detection helpers", () => {
  it("finds images in any message but only routes on the newest user message", () => {
    const messages = [
      { role: "user", content: [imagePart()] },
      { role: "assistant", content: "看到图了" },
      { role: "user", content: "还有问题" },
    ]
    expect(anyMessageHasImage(messages)).toBe(true)
    expect(newestUserMessageHasImage(messages)).toBe(false)
  })

  it("handles string content and non-array messages", () => {
    expect(anyMessageHasImage([{ role: "user", content: "文本" }])).toBe(false)
    expect(anyMessageHasImage("not-an-array")).toBe(false)
    expect(stripImages("not-an-array")).toBe("not-an-array")
  })

  it("ignores history images before the last assistant message for current-turn detection", () => {
    const messages = [
      { role: "user", content: [imagePart()] },
      { role: "assistant", content: "历史回复" },
      { role: "user", content: "当前无图" },
    ]
    expect(currentTurnHasImage(messages)).toBe(false)
    const withCurrentImage = [
      ...messages,
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "x", content: [imagePart()] },
    ]
    expect(currentTurnHasImage(withCurrentImage)).toBe(true)
  })
})
