// Centralised constants and default config for the opencode-deveco plugin.
//
// Values are ported from deveco-code:
//   packages/opencode/src/plugin/deveco.ts (LoginConfig, constants)
//   packages/opencode/src/plugin/deveco-models.ts (DEVECO_DEFAULTS)
// and stripped of fork-internal dependencies (Global.Path, Log, etc.).

import { createHash, randomBytes } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const packageJson = require("../package.json") as { version?: string }

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Provider id used in opencode config + auth store. */
export const PROVIDER_ID = "deveco"

/**
 * Placeholder apiKey. The real access token is injected per-request via the
 * auth.loader's custom `fetch`. opencode requires *some* apiKey to instantiate
 * the provider, so we use this sentinel and strip it before sending.
 */
export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

// ---------------------------------------------------------------------------
// DevEco endpoints
// ---------------------------------------------------------------------------

export const DEVECO_BASE_URL = "https://cn.devecostudio.huawei.com"

/** OpenAI-compatible Chat Completions base. */
export const DEVECO_API_BASE = `${DEVECO_BASE_URL}/sse/codeGenie/maas/v2`

/** Dynamic model list endpoint (Bearer auth). */
export const DEVECO_MODEL_CONFIG_URL = `${DEVECO_BASE_URL}/codeGenie/modelConfig`

/**
 * Releases the server-side queue slot a turn holds. DevEco tracks state per
 * (Session-Id, Chat-Id), so a client that never exits leaks a slot per turn.
 */
export const DEVECO_EXIT_QUEUE_URL = `${DEVECO_BASE_URL}/sse/codeGenie/exitSessionQueue`

/**
 * Vision fallback for text-only models. GLM-5.1 and GLM-5.3 cannot consume
 * images (the upstream request 403s with "Full inference timed out"), so the
 * proxy transparently reroutes a turn whose *new* user message contains an
 * image to this vision-capable model. Override with DEVECO_VISION_MODEL.
 *
 * The previous fallback (Qwen3_VL_235B_A22B_Instruct) now rejects image
 * requests with a 400 content-schema error; the upstream client moved to this
 * model in `c65aa159f`.
 */
export const DEVECO_VISION_FALLBACK_MODEL = "Qwen3_5_397B_A17B_w8a8_single"

/**
 * Models that the proxy treats as text-only for the vision fallback above.
 * Keep in sync with what the upstream model config advertises: both GLM ids
 * declare `input_modalities: ["text"]`. Override with
 * DEVECO_TEXT_ONLY_MODELS (comma-separated).
 */
export const DEVECO_TEXT_ONLY_MODELS = ["GLM-5.1", "GLM-5.3"]

/**
 * How long the upstream may stay *silent* before we give up.
 *
 * This is deliberately not a total-duration budget: a long agentic turn can
 * legitimately stream for minutes, and capping the total would kill healthy
 * conversations as soon as their history grew large enough.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * How long a finished turn waits for DevEco to confirm its server-side queue
 * slot release (exitSessionQueue) before the concurrency slot is handed to the
 * next request. Waiting is the point — the next turn must not start against a
 * slot that is still leased upstream — but a wedged release call must not stall
 * the queue either, so the wait is capped and the retry chain finishes in the
 * background.
 */
export const EXIT_QUEUE_GRACE_MS = 3_000

/**
 * How many upstream requests may be in flight at once. DevEco throttles bursts
 * per account, so the default is one at a time and latecomers queue instead of
 * failing. Override with DEVECO_MAX_CONCURRENCY.
 */
export const DEVECO_MAX_CONCURRENCY = 1

/** Resolve the concurrency cap, ignoring a missing or invalid override. */
export function maxConcurrency(): number {
  const raw = Number(process.env.DEVECO_MAX_CONCURRENCY)
  return Number.isInteger(raw) && raw >= 1 ? raw : DEVECO_MAX_CONCURRENCY
}

/**
 * How many requests may wait for a slot at once. Anything beyond that is
 * refused with HTTP 429 instead of queued: an unbounded queue turns a burst
 * into an ever-growing backlog whose symptom is "the client just hangs",
 * whereas a refusal lets the caller back off and retry. 0 = never queue
 * (a request is refused as soon as no slot is free). Override with
 * DEVECO_MAX_QUEUE.
 */
export const DEVECO_MAX_QUEUE = 3

/** Resolve the queue length cap; a missing or invalid override means default. */
export function maxQueue(): number {
  const raw = process.env.DEVECO_MAX_QUEUE
  if (raw === undefined || raw.trim() === "") return DEVECO_MAX_QUEUE
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEVECO_MAX_QUEUE
}

/**
 * Seconds to pause before admitting a request that had to queue, giving DevEco
 * a breather between burst-adjacent turns. Only queued requests pay it: one
 * that finds a free slot starts immediately. Override with
 * DEVECO_QUEUE_COOLDOWN_SEC (fractions allowed, e.g. 0.5); 0 switches the pause
 * off.
 */
export const DEVECO_QUEUE_COOLDOWN_SEC = 1

/**
 * Resolve the queued-request cooldown in ms. An explicit 0 disables the pause;
 * a missing or unparseable value falls back to the default.
 */
export function queueCooldownMs(): number {
  const raw = process.env.DEVECO_QUEUE_COOLDOWN_SEC
  if (raw === undefined || raw.trim() === "") return DEVECO_QUEUE_COOLDOWN_SEC * 1000
  const sec = Number(raw)
  return Number.isFinite(sec) && sec >= 0
    ? Math.round(sec * 1000)
    : DEVECO_QUEUE_COOLDOWN_SEC * 1000
}

/**
 * Consent for the "improve DevEco tools" telemetry flag, sent as
 * `X-DevEco-Improvement-Enabled` on every inference request. The upstream
 * client treats an account that has not opted in as a refusal; this test flag
 * matches that default and `DEVECO_TOOL_IMPROVEMENT=1` opts in.
 */
export function toolImprovementEnabled(): boolean {
  return process.env.DEVECO_TOOL_IMPROVEMENT === "1"
}

/**
 * Limits the DevEco channel actually declares for the text models. These are
 * per-product caps, lower than the public Zhipu specs (GLM-5.1: 200K/131K,
 * GLM-5.3: 1M/131K). Tools read them from `/v2/models`; the proxy also clamps
 * `max_tokens` to the output cap.
 */
export const DEVECO_GLM_CONTEXT_LIMIT = 170_000
export const DEVECO_GLM_OUTPUT_LIMIT = 32_000

export const DEVECO_MODEL_LIMITS: Record<string, { context: number; output: number }> = {
  "GLM-5.1": { context: DEVECO_GLM_CONTEXT_LIMIT, output: DEVECO_GLM_OUTPUT_LIMIT },
  "GLM-5.3": { context: DEVECO_GLM_CONTEXT_LIMIT, output: DEVECO_GLM_OUTPUT_LIMIT },
}

/**
 * Names shown to clients. DevEco serves Huawei-deployed GLM variants, not the
 * public Zhipu models, so the suffix makes the distinction explicit. The
 * upstream wire protocol still uses the bare ids in `DEVECO_MODEL_LIMITS`;
 * requests are normalized at ingress and the model list is renamed at egress.
 */
export const DEVECO_EXPOSED_MODEL_IDS: Record<string, string> = {
  "GLM-5.1": "GLM-5.1-DevEco",
  "GLM-5.3": "GLM-5.3-DevEco",
}

const DEVECO_UPSTREAM_MODEL_IDS: Record<string, string> = Object.fromEntries(
  Object.entries(DEVECO_EXPOSED_MODEL_IDS).map(([upstream, exposed]) => [exposed, upstream]),
)

/** Public name for an upstream model id (idempotent for unknown models). */
export function exposedModelId(model: string): string {
  return DEVECO_EXPOSED_MODEL_IDS[model] ?? model
}

/** Upstream id for a public model name (idempotent for unknown models). */
export function upstreamModelId(model: string): string {
  return DEVECO_UPSTREAM_MODEL_IDS[model] ?? model
}

/** The channel's output cap for an upstream model id, if it declares one. */
export function channelOutputLimit(model: string): number | undefined {
  return DEVECO_MODEL_LIMITS[model]?.output
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Normalize a client-supplied session/affinity id to the gateway's limit.
 *
 * DevEco rejects a `Session-Id` longer than 32 characters. ZCode sends a
 * canonical 36-character UUID in `x-session-id`, which hit exactly that error;
 * stripping the hyphens yields the same 32-hex value. Short ids are left
 * alone, and anything longer is hashed deterministically so a client that pins
 * a session keeps a stable upstream id.
 */
export function normalizeAffinityId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (UUID_PATTERN.test(trimmed)) return trimmed.replace(/-/g, "").toLowerCase()
  if (trimmed.length <= 32) return trimmed
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 32)
}

/**
 * The official CLI sends a 40-hex project id. A proxy does not know the
 * client's workspace id, so derive a stable one from the proxy's working
 * directory; DEVECO_PROJECT_ID can override it.
 */
export function defaultProjectId(seed: string = process.cwd()): string {
  const configured = process.env.DEVECO_PROJECT_ID?.trim()
  if (configured) return configured
  return createHash("sha1").update(seed).digest("hex")
}

/** Official session ids look like `ses_<base62>`; keep a client-supplied one,
 * otherwise derive a stable value within the gateway's 32-character limit. */
export function upstreamSessionId(value: string): string {
  if (value.startsWith("ses_") && value.length <= 32) return value
  return `ses_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`
}

/** Official task ids look like `msg_<base62>`; 30 characters fits the limit. */
export function newUpstreamTaskId(): string {
  return `msg_${randomBytes(13).toString("hex")}`
}

/** accessToken lifetime in ms (30 min, matching deveco-code). */
export const ACCESS_TOKEN_EXPIRES_MS = 30 * 60 * 1000

/** Callback server port candidates. The first free one is used. */
export const CALLBACK_PORTS = [10101, 34567, 34568, 34569, 34570]

/** Huawei app id used by the login page. */
export const DEVECO_APP_ID = "1008"

// ---------------------------------------------------------------------------
// Login flow config (mirrors deveco.ts LoginConfig + DEFAULT_CONFIG)
// ---------------------------------------------------------------------------

export interface LoginConfig {
  baseUrl: string
  authUrl: string
  tempTokenCheckUrl: string
  jwtTokenCheckUrl: string
  successRedirectUrl: string
  failedRedirectUrl: string
  appId: string
  defaultPort: number
  timeout: number
}

export const DEFAULT_CONFIG: LoginConfig = {
  baseUrl: DEVECO_BASE_URL,
  authUrl: "console/DevEcoIDE/apply",
  tempTokenCheckUrl: "authrouter/auth/api/temptoken/check",
  jwtTokenCheckUrl: "authrouter/auth/api/jwToken/check",
  successRedirectUrl: "console/DevEcoCode/loginSuccess",
  failedRedirectUrl: "console/DevEcoCode/loginFailed",
  appId: DEVECO_APP_ID,
  defaultPort: CALLBACK_PORTS[0],
  timeout: 600_000, // 10 min
}

// ---------------------------------------------------------------------------
// Default (fallback) provider config + models
// ---------------------------------------------------------------------------

/**
 * A subset of opencode's ProviderInfo that we inject via the config hook.
 * Matches the shape consumed by packages/opencode/src/config/provider.ts.
 */
export interface ProviderInfo {
  name?: string
  npm?: string
  api?: string
  env?: string[]
  id?: string
  whitelist?: string[]
  blacklist?: string[]
  options?: Record<string, unknown>
  models?: Record<string, ModelInfo>
}

export interface ModelInfo {
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  limit?: { context?: number; input?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
  cost?: Record<string, unknown>
  /** Cloud-declared effort tiers, keyed by tier: opencode turns each into a
   * switcher variant (`Ctrl+T`). Mirrors the upstream plugin's
   * effortVariants(). */
  variants?: Record<string, Record<string, unknown>>
  /** Request options applied to every call until the user picks a variant —
   * carries the cloud's default effort. Mirrors defaultEffortOption(). */
  options?: Record<string, unknown>
}

/**
 * Local package version, used as modelConfig's pluginVersion and in the
 * `x-deveco-client` header. Read from package.json so a systemd/standalone
 * launch (where npm_package_version is unset) still reports the real version.
 */
export const PLUGIN_VERSION: string =
  process.env.npm_package_version || packageJson.version || "0.0.0"

export const DEVECO_DEFAULTS = {
  provider: {
    name: "DevEco Code",
    npm: "@ai-sdk/openai-compatible",
    api: DEVECO_API_BASE,
    env: [] as string[],
    models: {
      "GLM-5.3": {
        name: "GLM-5.3",
        reasoning: true,
        tool_call: true,
        // The DevEco channel declares a lower per-product limit than the
        // public Zhipu model; use the channel's numbers, not official specs.
        limit: DEVECO_MODEL_LIMITS["GLM-5.3"],
        modalities: { input: ["text"], output: ["text"] },
      },
      "GLM-5.1": {
        name: "GLM-5.1",
        reasoning: true,
        tool_call: true,
        limit: DEVECO_MODEL_LIMITS["GLM-5.1"],
        modalities: { input: ["text"], output: ["text"] },
      },
      "Qwen3_5_397B_A17B_w8a8_single": {
        name: "Qwen3_5_397B_A17B_w8a8_single",
        limit: { context: 32768, output: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    } satisfies Record<string, ModelInfo>,
  } satisfies ProviderInfo,
  taskDefaultModelMap: {
    small_model: "GLM-5.1",
    ui_verification: "Qwen3_5_397B_A17B_w8a8_single",
    blacklist: "Qwen3_5_397B_A17B_w8a8_single",
  } as Record<string, string>,
} as const

/** Static provider fields reused when building a config from dynamic models. */
export const STATIC_PROVIDER_FIELDS: Pick<ProviderInfo, "name" | "npm" | "api" | "env"> = {
  name: "DevEco Code",
  npm: "@ai-sdk/openai-compatible",
  api: DEVECO_API_BASE,
  env: [],
}

/**
 * Minimal logger that prints to the terminal (stdout for info, stderr for
 * warn/error). Level is controlled by the LOG_LEVEL env var
 * (debug|info|warn|error); defaults to "info". Designed to work the same on
 * Windows/Linux/mac — output goes wherever the process's stdout/stderr point,
 * i.e. the terminal when run in the foreground, or a file when redirected.
 */
type LogLevel = "debug" | "info" | "warn" | "error"
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel(): number {
  const env = (process.env.DEVECO_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase()
  return LEVEL_ORDER[env as LogLevel] ?? LEVEL_ORDER.info
}

function fmt(level: LogLevel, args: unknown[]): string {
  const ts = new Date().toISOString()
  const body = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")
  return `[${ts}] [${level.toUpperCase()}] ${body}`
}

export const log = {
  debug(...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.debug) process.stdout.write(fmt("debug", args) + "\n")
  },
  info(...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.info) process.stdout.write(fmt("info", args) + "\n")
  },
  warn(...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.warn) process.stderr.write(fmt("warn", args) + "\n")
  },
  error(...args: unknown[]): void {
    if (currentLevel() <= LEVEL_ORDER.error) process.stderr.write(fmt("error", args) + "\n")
  },
}
