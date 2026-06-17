// Centralised constants and default config for the opencode-deveco plugin.
//
// Values are ported from deveco-code:
//   packages/opencode/src/plugin/deveco.ts (LoginConfig, constants)
//   packages/opencode/src/plugin/deveco-models.ts (DEVECO_DEFAULTS)
// and stripped of fork-internal dependencies (Global.Path, Log, etc.).

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
}

/** Local plugin version, used in the modelConfig request as pluginVersion. */
export const PLUGIN_VERSION: string =
  process.env.npm_package_version ||
  // read from import.meta.url is unreliable after bundling; fall back to a literal
  "0.1.0"

export const DEVECO_DEFAULTS = {
  provider: {
    name: "DevEco Code",
    npm: "@ai-sdk/openai-compatible",
    api: DEVECO_API_BASE,
    env: [] as string[],
    models: {
      "GLM-5.1": {
        name: "GLM-5.1",
        reasoning: true,
        tool_call: true,
        limit: { context: 202752, output: 131072 },
        modalities: { input: ["text"], output: ["text"] },
      },
      "Qwen2.5-VL-72B": {
        name: "Qwen2.5-VL-72B",
        limit: { context: 32768, output: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    } satisfies Record<string, ModelInfo>,
  } satisfies ProviderInfo,
  taskDefaultModelMap: {
    small_model: "GLM-5.1",
    ui_verification: "Qwen2.5-VL-72B",
    blacklist: "Qwen2.5-VL-72B",
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
