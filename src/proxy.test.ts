import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { browserOpenCommand, parseJwt, parseRealName, userInfoFromJwt } from "./auth-login.js"
import {
  ConcurrencyGate,
  conversationKey,
  DevEcoProxy,
  idleBudget,
  mergeAbortSignals,
  sessionKeyFromHeaders,
} from "./proxy.js"
import { JsonTokenStore } from "./token-store.js"
import { log, maxQueue, queueCooldownMs } from "./config.js"

// Helper: build a minimal JWT (header.payload.signature) with a given payload.
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.fake-sig`
}

describe("parseJwt", () => {
  it("extracts userId and userName from a valid JWT", () => {
    const token = makeJwt({ userId: "u123", userName: "Alice", exp: 1700000000 })
    const result = parseJwt(token)
    expect(result.userId).toBe("u123")
    expect(result.userName).toBe("Alice")
    expect(result.exp).toBe(1700000000)
  })

  it("returns empty strings for missing userId/userName", () => {
    const token = makeJwt({ exp: 100 })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })

  it("throws on a token without 3 parts", () => {
    expect(() => parseJwt("ab.cd")).toThrow("Invalid jwtToken format")
    expect(() => parseJwt("")).toThrow("Invalid jwtToken format")
  })

  it("handles non-string userId gracefully", () => {
    const token = makeJwt({ userId: 42, userName: true })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })
})

describe("userInfoFromJwt", () => {
  const tokens = { accessToken: "at", refreshToken: "rt" }

  it("rebuilds the identity a headless refresh doesn't return", () => {
    // Field names match a real DevEco jwtToken payload.
    const jwt = makeJwt({ userId: "u1", userName: "Alice", nationalCode: "CN", isRealName: true })
    const info = userInfoFromJwt(jwt, tokens)
    expect(info).toMatchObject({
      userId: "u1",
      userName: "Alice",
      countryCode: "CN",
      isRealName: true,
      accessToken: "at",
      refreshToken: "rt",
      jwtToken: jwt,
    })
  })

  it("falls back without inventing a real-name status", () => {
    const info = userInfoFromJwt(makeJwt({ userId: "u2", userName: "Bob" }), tokens)
    expect(info?.countryCode).toBe("CN")
    expect(info?.isRealName).toBe(false)
  })

  it("returns null for an unparseable token instead of throwing", () => {
    expect(userInfoFromJwt("not-a-jwt", tokens)).toBeNull()
  })
})

describe("browserOpenCommand", () => {
  // A real login URL: the `&` separators are what break unquoted cmd.
  const url =
    "https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&appid=1008&code=deadbeef"

  it("keeps the URL quoted on Windows so cmd doesn't split it at &", () => {
    const { command, args, shell } = browserOpenCommand("win32", url)
    expect(shell).toBe(true)
    expect(args).toEqual([])
    expect(command).toBe(`start "" "${url}"`)
  })

  it("passes the URL as a single argv on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({
      command: "open",
      args: [url],
      shell: false,
    })
    expect(browserOpenCommand("linux", url)).toEqual({
      command: "xdg-open",
      args: [url],
      shell: false,
    })
  })
})

describe("parseRealName", () => {
  it("accepts the boolean shape DevEco returns today", () => {
    expect(parseRealName(true)).toBe(true)
    expect(parseRealName(false)).toBe(false)
  })

  it("still accepts the legacy string shape", () => {
    expect(parseRealName("true")).toBe(true)
    expect(parseRealName("false")).toBe(false)
    expect(parseRealName(undefined)).toBe(false)
  })
})

describe("/v2 path stripping", () => {
  const strip = (p: string) => p.replace(/^\/v2(?=\/|$)/, "") || "/"

  it("strips /v2 prefix", () => {
    expect(strip("/v2/chat/completions")).toBe("/chat/completions")
    expect(strip("/v2/models")).toBe("/models")
    expect(strip("/v2/status")).toBe("/status")
  })

  it("leaves non-/v2 paths unchanged", () => {
    expect(strip("/chat/completions")).toBe("/chat/completions")
    expect(strip("/models")).toBe("/models")
  })

  it("does not strip words that merely start with /v2", () => {
    expect(strip("/v2models")).toBe("/v2models")
  })

  it("maps bare /v2 to /", () => {
    expect(strip("/v2")).toBe("/")
    expect(strip("/v2/")).toBe("/")
  })
})

describe("idleBudget", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("aborts once the upstream goes quiet", async () => {
    const b = idleBudget(120)
    expect(b.signal.aborted).toBe(false)
    await sleep(200)
    expect(b.signal.aborted).toBe(true)
    b.done()
  })

  it("lets a slow but live stream run past the idle window", async () => {
    const b = idleBudget(120)
    // Five 80ms gaps: 400ms total, well beyond the window, never silent for it.
    for (let i = 0; i < 5; i++) {
      await sleep(80)
      b.touch()
    }
    expect(b.signal.aborted).toBe(false)
    b.done()
  })

  it("stops the clock once the turn is done", async () => {
    const b = idleBudget(100)
    b.done()
    await sleep(200)
    expect(b.signal.aborted).toBe(false)
  })
})

describe("mergeAbortSignals", () => {
  it("aborts as soon as any source aborts, carrying its reason", () => {
    const first = new AbortController()
    const second = new AbortController()
    const merged = mergeAbortSignals(first.signal, second.signal)

    expect(merged.aborted).toBe(false)
    first.abort(new Error("upstream silent"))
    expect(merged.aborted).toBe(true)
    expect((merged.reason as Error).message).toBe("upstream silent")
  })

  it("is born aborted when a source already aborted", () => {
    const gone = new AbortController()
    gone.abort(new Error("client disconnected"))
    const merged = mergeAbortSignals(gone.signal, new AbortController().signal)
    expect(merged.aborted).toBe(true)
    expect((merged.reason as Error).message).toBe("client disconnected")
  })

  it("never aborts a source that is still live", () => {
    const first = new AbortController()
    const second = new AbortController()
    mergeAbortSignals(first.signal, second.signal)
    first.abort()
    expect(second.signal.aborted).toBe(false)
  })
})

describe("queueCooldownMs", () => {
  const OLD = process.env.DEVECO_QUEUE_COOLDOWN_SEC

  afterEach(() => {
    if (OLD === undefined) delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    else process.env.DEVECO_QUEUE_COOLDOWN_SEC = OLD
  })

  it("defaults to one second and lets an explicit zero switch the pause off", () => {
    delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    expect(queueCooldownMs()).toBe(1000)
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
    expect(queueCooldownMs()).toBe(0)
  })

  it("accepts fractional seconds and ignores unparseable values", () => {
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0.5"
    expect(queueCooldownMs()).toBe(500)
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "abc"
    expect(queueCooldownMs()).toBe(1000)
  })
})

describe("maxQueue", () => {
  const OLD = process.env.DEVECO_MAX_QUEUE

  afterEach(() => {
    if (OLD === undefined) delete process.env.DEVECO_MAX_QUEUE
    else process.env.DEVECO_MAX_QUEUE = OLD
  })

  it("defaults to three waiting requests", () => {
    delete process.env.DEVECO_MAX_QUEUE
    expect(maxQueue()).toBe(3)
  })

  it("accepts an explicit zero (never queue) and ignores junk", () => {
    process.env.DEVECO_MAX_QUEUE = "0"
    expect(maxQueue()).toBe(0)
    process.env.DEVECO_MAX_QUEUE = "5"
    expect(maxQueue()).toBe(5)
    for (const bad of ["", "  ", "-1", "abc", "1.5"]) {
      process.env.DEVECO_MAX_QUEUE = bad
      expect(maxQueue()).toBe(3)
    }
  })
})

describe("ConcurrencyGate", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  // Drains pending microtasks only, never timers: an admission that is gated on
  // the cooldown cannot sneak through, while one that wrongly happened on the
  // spot (a plain promise resolution) always does. Load-independent either way.
  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it("admits up to `limit` holders at once and queues the rest", async () => {
    const gate = new ConcurrencyGate(2)
    const order: number[] = []
    let running = 0
    let peak = 0

    const task = async (id: number) => {
      await gate.acquire(`t${id}`)
      running++
      peak = Math.max(peak, running)
      order.push(id)
      await tick()
      running--
      gate.release()
    }

    await Promise.all([task(1), task(2), task(3)])
    expect(peak).toBe(2)
    // The third waits for a slot instead of failing.
    expect(order).toEqual([1, 2, 3])
  })

  it("serves waiters in arrival order after releases", async () => {
    const gate = new ConcurrencyGate(1)
    const order: number[] = []
    const task = async (id: number) => {
      await gate.acquire(`t${id}`)
      order.push(id)
      await tick()
      gate.release()
    }
    await Promise.all([task(1), task(2), task(3), task(4)])
    expect(order).toEqual([1, 2, 3, 4])
  })

  it("never exceeds the limit even when a holder throws", async () => {
    const gate = new ConcurrencyGate(1)
    let running = 0
    let peak = 0
    const task = async () => {
      await gate.acquire("boom")
      running++
      peak = Math.max(peak, running)
      try {
        throw new Error("upstream blew up")
      } finally {
        running--
        gate.release()
      }
    }
    await Promise.allSettled([task(), task()])
    expect(peak).toBe(1)
  })

  // --- queued-request cooldown (DEVECO_QUEUE_COOLDOWN_SEC) -------------------

  it("never cools down a request that finds a free slot", async () => {
    const gate = new ConcurrencyGate(2, 80)
    const started = Date.now()
    await gate.acquire("a")
    await gate.acquire("b")
    // Both slots were free, so neither owes the cooldown (nothing but
    // microtasks happens in between; a >60ms stall would be machine noise, and
    // an applied cooldown could never fire in under its 80ms).
    expect(Date.now() - started).toBeLessThan(60)
    gate.release()
    gate.release()
  })

  it("cools down before admitting a queued waiter", async () => {
    const gate = new ConcurrencyGate(1, 60)
    await gate.acquire("holder")
    const admittedAt: number[] = []
    const waiter = gate.acquire("waiter").then(() => admittedAt.push(Date.now()))
    await tick()
    const releasedAt = Date.now()
    gate.release()
    // Still cooling down: even after every pending microtask has run, the
    // waiter cannot have started (its wake-up needs a timer).
    await flushMicrotasks()
    expect(admittedAt).toEqual([])
    await waiter
    expect(admittedAt[0] - releasedAt).toBeGreaterThanOrEqual(50)
    gate.release()
  })

  it("cools down per freed slot when the limit is wider", async () => {
    const gate = new ConcurrencyGate(2, 60)
    await gate.acquire("a")
    await gate.acquire("b")
    const admittedAt: number[] = []
    const queued = gate.acquire("queued").then(() => admittedAt.push(Date.now()))
    await tick()
    const releasedAt = Date.now()
    gate.release() // one of the two slots frees up; `b` keeps running
    // Same as above: microtasks only, so the queued request can't be running.
    await flushMicrotasks()
    expect(admittedAt).toEqual([])
    await queued
    expect(admittedAt[0] - releasedAt).toBeGreaterThanOrEqual(50)
    gate.release()
    gate.release()
  })

  it("keeps the freed slot reserved so a latecomer can't jump the queue", async () => {
    const gate = new ConcurrencyGate(1, 40)
    await gate.acquire("holder")
    const order: string[] = []
    const first = gate.acquire("first").then(() => order.push("first"))
    await tick()
    gate.release() // the slot already belongs to `first`, which is cooling down
    const latecomer = gate.acquire("latecomer").then(() => order.push("latecomer"))
    // If the slot had been freed outright, the latecomer would grab it on the
    // spot and land in `order` within these microtasks; because it is reserved
    // for `first` (still cooling down), the latecomer has to queue instead.
    await flushMicrotasks()
    expect(order).toEqual([])
    await first
    expect(order).toEqual(["first"])
    gate.release()
    await latecomer
    expect(order).toEqual(["first", "latecomer"])
    gate.release()
  })

  // --- cancellable waiters ---------------------------------------------------

  it("refuses a slot to a caller that was already gone", async () => {
    const gate = new ConcurrencyGate(1)
    await gate.acquire("holder")
    const ctrl = new AbortController()
    ctrl.abort()
    // Never enters the queue, so waiting on it costs the gate nothing.
    expect(await gate.acquire("dead", ctrl.signal)).toBe("abandoned")
    gate.release()
    expect(await gate.acquire("next")).toBe("admitted")
    gate.release()
  })

  it("drops a queued waiter whose caller gave up instead of admitting it", async () => {
    const gate = new ConcurrencyGate(1)
    await gate.acquire("holder")
    const ctrl = new AbortController()
    const dead = gate.acquire("dead", ctrl.signal)
    let liveAdmitted = false
    const live = gate.acquire("live").then((outcome) => (liveAdmitted = outcome === "admitted"))
    ctrl.abort()
    // The abandoned waiter resolves without a slot — it is not admitted first
    // just to notice its client is gone (which is what it used to do).
    expect(await dead).toBe("abandoned")
    gate.release()
    await live
    expect(liveAdmitted).toBe(true)
    gate.release()
  })

  it("passes a granted slot on when the caller gives up during the cooldown", async () => {
    const gate = new ConcurrencyGate(1, 40)
    await gate.acquire("holder")
    const ctrl = new AbortController()
    const dead = gate.acquire("dead", ctrl.signal)
    await tick()
    gate.release() // `dead` is granted and now cooling down
    let liveAdmitted = false
    const live = gate.acquire("live").then((outcome) => (liveAdmitted = outcome === "admitted"))
    ctrl.abort()
    expect(await dead).toBe("abandoned")
    // The promised slot was not dropped with it: the waiter behind still gets in.
    await live
    expect(liveAdmitted).toBe(true)
    gate.release()
  })

  // --- bounded queue length --------------------------------------------------

  it("refuses a request once the queue is at capacity", async () => {
    const gate = new ConcurrencyGate(1, 0, 1)
    await gate.acquire("holder")
    const queued = gate.acquire("queued")
    await tick()
    // One waiter is allowed; the request arriving behind it is refused outright
    // instead of growing the backlog.
    expect(await gate.acquire("overflow")).toBe("queue-full")
    gate.release()
    expect(await queued).toBe("admitted")
    gate.release()
    // The refusal never took a slot: the gate is idle again.
    expect(await gate.acquire("later")).toBe("admitted")
    gate.release()
  })

  it("treats a zero-length queue as 'never queue'", async () => {
    const gate = new ConcurrencyGate(1, 0, 0)
    await gate.acquire("holder")
    expect(await gate.acquire("second")).toBe("queue-full")
    gate.release()
    expect(await gate.acquire("later")).toBe("admitted")
    gate.release()
  })

  it("frees queue capacity as waiters are admitted", async () => {
    const gate = new ConcurrencyGate(1, 0, 2)
    await gate.acquire("holder")
    const first = gate.acquire("first")
    const second = gate.acquire("second")
    await tick()
    expect(await gate.acquire("overflow")).toBe("queue-full")
    gate.release() // admits `first`
    expect(await first).toBe("admitted")
    // `first` holds the slot now, and only `second` is left waiting: room again.
    const third = gate.acquire("third")
    await tick()
    expect(await gate.acquire("fourth")).toBe("queue-full")
    gate.release()
    expect(await second).toBe("admitted")
    gate.release()
    expect(await third).toBe("admitted")
    gate.release()
  })
})

describe("sessionKeyFromHeaders", () => {
  it("reads the supported explicit session headers in order", () => {
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1" })).toBe("s1")
    expect(sessionKeyFromHeaders({ "x-session-affinity": "s2" })).toBe("s2")
    expect(sessionKeyFromHeaders({ "x-session-id": "s3" })).toBe("s3")
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1", "x-session-id": "s3" })).toBe("s1")
  })

  it("returns null for missing or blank headers", () => {
    expect(sessionKeyFromHeaders({})).toBeNull()
    expect(sessionKeyFromHeaders({ "x-session-id": "   " })).toBeNull()
  })
})

describe("conversationKey", () => {
  const first = { role: "user", content: "开始" }
  const OLD_MODE = process.env.DEVECO_SESSION_KEY_MODE

  afterEach(() => {
    if (OLD_MODE === undefined) delete process.env.DEVECO_SESSION_KEY_MODE
    else process.env.DEVECO_SESSION_KEY_MODE = OLD_MODE
  })

  it("stays put as the conversation grows", () => {
    const round1 = conversationKey({ system: "sys", messages: [first] })
    const round2 = conversationKey({
      system: "sys",
      messages: [first, { role: "assistant", content: "好" }, { role: "user", content: "继续" }],
    })
    expect(round2).toBe(round1)
  })

  it("separates different conversations", () => {
    expect(conversationKey({ system: "sys", messages: [first] })).not.toBe(
      conversationKey({ system: "sys", messages: [{ role: "user", content: "另一个话题" }] }),
    )
  })

  it("keeps the key stable when only the system prompt changes (default mode)", () => {
    delete process.env.DEVECO_SESSION_KEY_MODE
    expect(conversationKey({ system: "system-A", messages: [first] })).toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })

  it("anchors on the first USER message when the system prompt sits in messages[0]", () => {
    // OpenAI wire format (opencode): system lives at messages[0] and changes
    // every turn (current time, cwd…). The key must stay stable anyway.
    delete process.env.DEVECO_SESSION_KEY_MODE
    const body = (system: string) => ({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "开始" },
      ],
    })
    expect(conversationKey(body("system with time: 1"))).toBe(
      conversationKey(body("system with time: 2")),
    )
  })

  it("includes the system prompt when DEVECO_SESSION_KEY_MODE=system-first", () => {
    process.env.DEVECO_SESSION_KEY_MODE = "system-first"
    expect(conversationKey({ system: "system-A", messages: [first] })).not.toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })

  it("includes the OpenAI-style system message under system-first mode", () => {
    process.env.DEVECO_SESSION_KEY_MODE = "system-first"
    const body = (system: string) => ({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "开始" },
      ],
    })
    expect(conversationKey(body("system-A"))).not.toBe(conversationKey(body("system-B")))
  })
})

// ---------------------------------------------------------------------------
// DevEcoProxy integration: DevEco's real endpoints are replaced with a mocked
// global fetch, so the full proxy pipeline (auth refresh → forward → usage
// logging) runs against a fake upstream.
// ---------------------------------------------------------------------------

describe("DevEcoProxy integration", () => {
  const OLD_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR
  let tmpDir: string
  let proxy: DevEcoProxy | null = null
  let originalFetch: typeof fetch
  const randomPort = () => 20000 + Math.floor(Math.random() * 1000)

  const mockUpstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    // Requests to the local proxy under test go through the real HTTP stack;
    // only the proxy's outbound calls to DevEco are faked.
    if (url.includes("127.0.0.1")) return originalFetch(input, init)
    if (url.includes("jwToken/check")) {
      return new Response(
        JSON.stringify({
          status: true,
          userInfo: { accessToken: "mock-at", refreshToken: "mock-rt", nationalCode: "CN", realName: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (url.includes("/chat/completions")) {
      // A large non-streaming body split across many small chunks (> 4, which
      // is what the SSE tail-buffer used to cap at).
      const big = JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "GLM-5.1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x".repeat(100_000) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
      })
      const bytes = new TextEncoder().encode(big)
      let offset = 0
      const chunkSize = 4_000
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          while (offset < bytes.length) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize))
            offset += chunkSize
          }
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.includes("exitSessionQueue")) return new Response("ok", { status: 200 })
    return new Response("{}", { status: 404 })
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-int-"))
    process.env.OPENCODE_CONFIG_DIR = tmpDir
    originalFetch = globalThis.fetch
    globalThis.fetch = mockUpstreamFetch as typeof fetch
  })

  afterEach(async () => {
    if (OLD_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = OLD_CONFIG_DIR
    globalThis.fetch = originalFetch
    if (proxy) await proxy.stop().catch(() => {})
    proxy = null
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const startProxy = async (): Promise<DevEcoProxy> => {
    proxy = new DevEcoProxy({ port: randomPort(), hostname: "127.0.0.1" })
    await proxy.start()
    return proxy
  }

  /** Spy on the proxy's debug log and return a predicate over its lines. */
  const spyOnDebugLog = (): ((needle: string) => boolean) => {
    const spy = vi.spyOn(log, "debug")
    return (needle) =>
      spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes(needle)))
  }

  it("reports logged_in:true when only an expired jwtToken exists (silent refresh possible)", async () => {
    // An already-expired JWT: tryRestoreSession's refresh short-circuits
    // without a network call, leaving no live session.
    const expired = makeJwt({ userId: "u1", userName: "Old", exp: Math.floor(Date.now() / 1000) - 3600 })
    await new JsonTokenStore().save(expired)
    const p = await startProxy()
    const res = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(res.logged_in).toBe(true)
  })

  it("reports logged_in:false when no credentials exist at all", async () => {
    const p = await startProxy()
    const res = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(res.logged_in).toBe(false)
  })

  it("extracts usage from a large non-streaming response split across many chunks", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)
    const p = await startProxy()
    const spy = vi.spyOn(log, "info")

    const res = await fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.choices[0].message.content.length).toBe(100_000)
    // The proxy's own log line must carry the parsed usage.
    const logged = spy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("in=111 out=222")),
    )
    expect(logged).toBe(true)
  })

  it("answers 500 instead of exiting when the upstream fetch fails", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)
    const p = await startProxy()

    // The upstream drops the connection before sending anything (DevEco resets
    // it when a request runs past its gateway limit). That rejection used to
    // escape handle() and kill the process as an unhandled rejection.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      throw new TypeError("fetch failed")
    }) as typeof fetch

    const res = await fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(500)
    expect(String((await res.json()).error)).toContain("upstream fetch failed")

    // Still serving: the next request must not find a dead process.
    const status = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(status.logged_in).toBe(true)
  })

  it("serialises upstream requests and honours DEVECO_MAX_CONCURRENCY", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let inFlight = 0
    let peak = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 120))
      inFlight--
      return new Response(
        JSON.stringify({
          id: "chatcmpl-gate",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const chat = (port: number) =>
      fetch(`http://127.0.0.1:${port}/v2/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
      })

    try {
      // This test measures the concurrency width itself; the (default-on)
      // queue cooldown would only add dead time here.
      process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
      // Default: one upstream request at a time, the rest queue.
      delete process.env.DEVECO_MAX_CONCURRENCY
      const serial = await startProxy()
      await Promise.all([chat(serial.getPort()), chat(serial.getPort()), chat(serial.getPort())])
      expect(peak).toBe(1)

      // Raised cap: two may overlap, the third still waits.
      await serial.stop()
      peak = 0
      process.env.DEVECO_MAX_CONCURRENCY = "2"
      const parallel = await startProxy()
      await Promise.all([
        chat(parallel.getPort()),
        chat(parallel.getPort()),
        chat(parallel.getPort()),
      ])
      expect(peak).toBe(2)
    } finally {
      delete process.env.DEVECO_MAX_CONCURRENCY
      delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    }
  })

  it("aborts the upstream turn and frees the slot when the client disconnects", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let upstreamCancelled = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      // The proxy forwards the client body as a Buffer (or a string on some
      // paths), so look at the bytes rather than assuming a type.
      const rawBody = init?.body
      const bodyText =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody).toString("utf8")
            : ""
      if (bodyText.includes('"stream":true')) {
        // A stream that never ends on its own; a real fetch would tear the
        // upstream connection down when the signal aborts, so model that here.
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
            init?.signal?.addEventListener("abort", () => {
              upstreamCancelled = true
              controller.error(new Error("aborted"))
            })
          },
          pull: () => new Promise((r) => setTimeout(r, 50)),
          cancel: () => {
            upstreamCancelled = true
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-quick",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    // Slot release is what's under test here, not the cooldown: keep the
    // (default-on) pause out of the timing below.
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
    const p = await startProxy()
    delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    const chatUrl = `http://127.0.0.1:${p.getPort()}/v2/chat/completions`
    const payload = (stream: boolean) =>
      JSON.stringify({
        model: "GLM-5.1",
        messages: [{ role: "user", content: "hi" }],
        ...(stream ? { stream: true } : {}),
      })

    const ac = new AbortController()
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(true),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()

    // The client walks away mid-stream.
    await reader.cancel().catch(() => {})
    ac.abort()

    // The proxy must notice and stop draining the upstream...
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true), { timeout: 2000 })

    // ...and release the concurrency slot: the next request is served at once.
    const started = Date.now()
    const second = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(false),
    })
    expect(second.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  /**
   * A client that hangs up while its request is still queued must not start an
   * upstream turn once the slot frees: `close` fired before the turn began, so
   * the turn has to be skipped instead of streaming into a dead socket.
   */
  const queuedDisconnectSkipsTurn = async (endpoint: string, payload: string): Promise<void> => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    // Held until the test has let the queued request be abandoned.
    let releaseFirstTurn!: () => void
    const firstTurnHeld = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })

    let upstreamTurns = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      upstreamTurns++
      // The first turn occupies the only slot until the test releases it.
      if (upstreamTurns === 1) await firstTurnHeld
      return new Response(
        JSON.stringify({
          id: "chatcmpl-queued",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    // This test is about the disconnect path, not the cooldown: disable the
    // (default-on) pause so the slot handover stays immediate. The gate reads
    // the env at construction, so it can be cleared again right away.
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
    const p = await startProxy()
    delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    const url = `http://127.0.0.1:${p.getPort()}${endpoint}`
    const post = (signal?: AbortSignal) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal,
      })

    const logged = spyOnDebugLog()

    const first = post()
    await vi.waitFor(() => expect(upstreamTurns).toBe(1), { timeout: 2000 })

    // The second request queues behind the first, then its client walks away.
    const ac = new AbortController()
    void post(ac.signal).catch(() => {
      /* the abort rejects client-side; expected */
    })
    await vi.waitFor(() => expect(logged("proxy: queued")).toBe(true), { timeout: 2000 })
    ac.abort()
    // Wait until the hang-up actually reached the server before freeing the
    // slot: that the skipped turn was still queued when the abort landed is
    // exactly the case under test. (Releasing first would race the socket
    // close through the event loop and sometimes admit the turn too early.)
    await vi.waitFor(() => expect(logged("client disconnected")).toBe(true), { timeout: 2000 })

    releaseFirstTurn()
    expect((await first).status).toBe(200)

    // Only the first turn ever reached upstream, and the slot was handed on:
    // the next request is served immediately.
    const started = Date.now()
    expect((await post()).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(upstreamTurns).toBe(2)
  }

  it("skips the upstream turn when a queued chat client disconnects", async () => {
    await queuedDisconnectSkipsTurn(
      "/v2/chat/completions",
      JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    )
  })

  it("skips the upstream turn when a queued anthropic client disconnects", async () => {
    await queuedDisconnectSkipsTurn(
      "/v2/anthropic/v1/messages",
      JSON.stringify({ model: "GLM-5.1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    )
  })

  it("cools down before admitting a queued turn when DEVECO_QUEUE_COOLDOWN_SEC is set", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let releaseFirstTurn!: () => void
    const firstTurnHeld = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const upstreamStarts: number[] = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      upstreamStarts.push(Date.now())
      if (upstreamStarts.length === 1) await firstTurnHeld
      return new Response(
        JSON.stringify({
          id: "chatcmpl-cooldown",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0.4"
    try {
      const p = await startProxy()
      const logged = spyOnDebugLog()
      const chatUrl = `http://127.0.0.1:${p.getPort()}/v2/chat/completions`
      const post = () =>
        fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
        })

      const first = post()
      await vi.waitFor(() => expect(upstreamStarts.length).toBe(1), { timeout: 2000 })

      // The second turn has to queue, so it owes the cooldown.
      const second = post()
      await vi.waitFor(() => expect(logged("proxy: queued")).toBe(true), { timeout: 2000 })

      releaseFirstTurn()
      const firstRes = await first
      await firstRes.text()
      const slotFreedAt = Date.now()
      expect((await second).status).toBe(200)

      // Only the two turns reached upstream, and the queued one started only
      // after the 400ms cooldown. `slotFreedAt` is read client-side, so the
      // bound sits below the cooldown (absorbing that skew) while staying far
      // above the ~0ms a missing cooldown would show.
      expect(upstreamStarts).toHaveLength(2)
      expect(upstreamStarts[1] - slotFreedAt).toBeGreaterThanOrEqual(250)
    } finally {
      delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    }
  })

  it("answers 429 when the queue is already full instead of stacking more turns", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let releaseFirstTurn!: () => void
    const firstTurnHeld = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    let upstreamTurns = 0

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      upstreamTurns++
      if (upstreamTurns === 1) await firstTurnHeld
      return new Response(
        JSON.stringify({
          id: "chatcmpl-full",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    // A one-deep queue keeps the assertion short; the cooldown is unrelated here.
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
    process.env.DEVECO_MAX_QUEUE = "1"
    try {
      const p = await startProxy()
      const logged = spyOnDebugLog()
      const chatUrl = `http://127.0.0.1:${p.getPort()}/v2/chat/completions`
      const post = () =>
        fetch(chatUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
        })

      const first = post()
      await vi.waitFor(() => expect(upstreamTurns).toBe(1), { timeout: 2000 })

      // Fills the queue while the only slot is busy.
      const queued = post()
      await vi.waitFor(() => expect(logged("proxy: queued")).toBe(true), { timeout: 2000 })

      // The next caller is refused outright (had it queued, this await would
      // hang until the test's own timeout).
      const refused = await post()
      expect(refused.status).toBe(429)
      const body = (await refused.json()) as { error: { type: string; message: string } }
      expect(body.error.type).toBe("rate_limit_error")
      expect(body.error.message).toContain("queue is full")

      releaseFirstTurn()
      expect((await first).status).toBe(200)
      expect((await queued).status).toBe(200)
      // Only the two accepted turns ever reached upstream.
      expect(upstreamTurns).toBe(2)
    } finally {
      delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
      delete process.env.DEVECO_MAX_QUEUE
    }
  })

  it("answers /v2/models while a turn holds the only slot", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let releaseTurn!: () => void
    const turnHeld = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    let turnStarted = false

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      if (url.includes("/modelConfig")) {
        return new Response(
          JSON.stringify({
            code: 200,
            body: {
              inner_models: [
                {
                  model_configs: [
                    { model_id: "GLM-5.1", thinking_mode: "on", tool_call_mode: "tool_calls" },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      // The turn occupies the only upstream slot until the test lets it go.
      turnStarted = true
      await turnHeld
      return new Response(
        JSON.stringify({
          id: "chatcmpl-models",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const p = await startProxy()
    const turn = fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    })
    await vi.waitFor(() => expect(turnStarted).toBe(true), { timeout: 2000 })

    // A metadata read must not queue behind the turn (it used to, which stalled
    // the client's model picker for as long as the turn ran).
    const res = await fetch(`http://127.0.0.1:${p.getPort()}/v2/models`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as { data: Array<{ id: string }> }
    expect(list.data.map((m) => m.id)).toContain("GLM-5.1")

    releaseTurn()
    expect((await turn).status).toBe(200)
  })

  it("starts the next turn only after DevEco confirms the server-side queue exit", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    const upstreamStarts: number[] = []
    let exitFinishedAt = 0

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check")) return mockUpstreamFetch(input, init)
      if (url.includes("exitSessionQueue")) {
        // A slow but successful release: the next turn has to wait for it.
        // Only the first exit is timed — the second one belongs to the turn
        // under test and would otherwise move the reference point.
        await new Promise((r) => setTimeout(r, 300))
        if (!exitFinishedAt) exitFinishedAt = Date.now()
        return new Response("ok", { status: 200 })
      }
      upstreamStarts.push(Date.now())
      // Held long enough that the second turn is guaranteed to queue behind it.
      await new Promise((r) => setTimeout(r, 200))
      return new Response(
        JSON.stringify({
          id: "chatcmpl-exit",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    // Isolate the exit wait from the (default-on) cooldown.
    process.env.DEVECO_QUEUE_COOLDOWN_SEC = "0"
    try {
      const p = await startProxy()
      const post = () =>
        fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
        })
      await Promise.all([post(), post()])

      expect(upstreamStarts).toHaveLength(2)
      expect(exitFinishedAt).toBeGreaterThan(0)
      // Without the wait the second turn would have started ~300ms earlier,
      // while DevEco still had the first turn's queue slot leased.
      expect(upstreamStarts[1]).toBeGreaterThanOrEqual(exitFinishedAt)
    } finally {
      delete process.env.DEVECO_QUEUE_COOLDOWN_SEC
    }
  })
})
