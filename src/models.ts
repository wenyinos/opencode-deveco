// Dynamic model list fetch + fallback.
//
// Ported from deveco-code packages/opencode/src/plugin/deveco-models.ts,
// replacing effect Schema with hand-written type guards (no effect runtime dep).
// Behaviour is otherwise equivalent: GET modelConfig with the access token,
// map to opencode's ModelInfo shape, apply blacklist, fall back to defaults
// on any failure.

import {
  DEVECO_DEFAULTS,
  DEVECO_MODEL_CONFIG_URL,
  PLUGIN_VERSION,
  STATIC_PROVIDER_FIELDS,
  type ModelInfo,
  type ProviderInfo,
  log,
} from "./config.js"

// ---------------------------------------------------------------------------
// Raw API shapes (subset of the fields we actually consume)
// ---------------------------------------------------------------------------

interface RawModelConfig {
  id?: number
  model_id?: string
  thinking_mode?: string
  input_modalities?: string[]
  context_window?: number
  output?: string | number
  tool_choice?: string
  tool_call_mode?: string
}

interface RawInnerModel {
  protocol?: string
  group_name?: string
  model_configs?: RawModelConfig[]
  task_default_model_map?: Record<string, string>
}

interface RawApiResponse {
  code?: number
  body?: {
    version?: number
    inner_models?: RawInnerModel[]
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function parseOutputLimit(output: string | number | undefined): number | undefined {
  if (output == null) return undefined
  if (typeof output === "number") return output
  const num = parseInt(output, 10)
  return isNaN(num) ? undefined : num
}

function mapModelConfigToInternal(config: RawModelConfig): ModelInfo {
  const limit: { context?: number; output?: number } = {}
  if (config.context_window) limit.context = config.context_window
  const outputLimit = parseOutputLimit(config.output)
  if (outputLimit) limit.output = outputLimit

  const info: ModelInfo = { name: config.model_id }
  if (config.thinking_mode === "on") info.reasoning = true
  if (config.tool_call_mode === "tool_calls") info.tool_call = true
  if (Object.keys(limit).length > 0) info.limit = limit
  if (config.input_modalities && config.input_modalities.length > 0) {
    info.modalities = { input: config.input_modalities, output: ["text"] }
  }
  return info
}

function filterBlacklist(models: Record<string, ModelInfo>, blacklist: string[]): ProviderInfo {
  const filteredModels = Object.fromEntries(
    Object.entries(models).filter(([id]) => !blacklist.includes(id)),
  )
  return { ...STATIC_PROVIDER_FIELDS, models: filteredModels }
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

function modelConfigUrl(): string {
  return `${DEVECO_MODEL_CONFIG_URL}?localVersion=0&pluginVersion=CLI.${PLUGIN_VERSION}`
}

interface FetchedModels {
  models: Record<string, ModelInfo>
  taskDefaultModelMap?: Record<string, string>
}

async function fetchModelsFromAPI(accessToken: string): Promise<FetchedModels> {
  const response = await fetch(modelConfigUrl(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Model config API returned ${response.status}: ${body}`)
  }

  const raw = (await response.json()) as RawApiResponse
  if (raw.code !== 200) {
    throw new Error(`Model config API returned code ${raw.code}`)
  }

  // extract task_default_model_map directly from raw (not modelled above)
  let taskDefaultModelMap: Record<string, string> | undefined
  const innerModels = raw.body?.inner_models
  if (Array.isArray(innerModels)) {
    for (const group of innerModels) {
      if (group?.task_default_model_map && typeof group.task_default_model_map === "object") {
        taskDefaultModelMap = group.task_default_model_map
      }
    }
  }

  const models: Record<string, ModelInfo> = {}
  for (const group of innerModels ?? []) {
    for (const config of group.model_configs ?? []) {
      if (typeof config.model_id === "string" && config.model_id) {
        models[config.model_id] = mapModelConfigToInternal(config)
      }
    }
  }

  log.debug("fetched models config", { count: Object.keys(models).length })
  return { models, taskDefaultModelMap }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cachedConfig: ProviderInfo | null = null
let cachedConfigAt = 0
let cachedTaskDefaultModelMap: Record<string, string> | null = null

/** Cache TTL in ms — after this, the next request re-fetches from the API. */
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Returns the DevEco provider config. Tries the dynamic API first (cached on
 * success), and falls back to the static defaults on any failure.
 */
export async function getDevecoProviderConfig(accessToken: string): Promise<ProviderInfo> {
  if (cachedConfig && Date.now() - cachedConfigAt < CACHE_TTL_MS) return cachedConfig
  // Expired or missing — clear so a failed fetch doesn't return stale data forever.
  cachedConfig = null

  const defaultBlacklist =
    DEVECO_DEFAULTS.taskDefaultModelMap.blacklist?.split(",") ?? []

  try {
    const { models, taskDefaultModelMap } = await fetchModelsFromAPI(accessToken)

    if (!models || Object.keys(models).length === 0) {
      log.warn("API returned empty models, using defaults")
      return filterBlacklist({ ...DEVECO_DEFAULTS.provider.models }, defaultBlacklist)
    }

    cachedConfig = filterBlacklist(
      models,
      taskDefaultModelMap?.blacklist?.split(",") ?? [],
    )
    cachedConfigAt = Date.now()
    cachedTaskDefaultModelMap = taskDefaultModelMap ?? DEVECO_DEFAULTS.taskDefaultModelMap
    return cachedConfig
  } catch (err) {
    log.warn("failed to fetch models, using defaults", { error: String(err) })
    return filterBlacklist({ ...DEVECO_DEFAULTS.provider.models }, defaultBlacklist)
  }
}

/** Returns the cached task→model map (defaults until dynamic config is fetched). */
export function getTaskDefaultModelMap(): Record<string, string> {
  return cachedTaskDefaultModelMap ?? DEVECO_DEFAULTS.taskDefaultModelMap
}

/** Reset caches (used when the user re-logs in). */
export function resetModelCache(): void {
  cachedConfig = null
  cachedConfigAt = 0
  cachedTaskDefaultModelMap = null
}
