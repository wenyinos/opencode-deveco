// Plugin entry. opencode loads plugins via the `./server` export (or `main`)
// and expects either a v1 module `{ id, server }` or a bare Plugin function.
// We export the v1 module shape so the loader detects it deterministically
// (see packages/opencode/src/plugin/shared.ts readV1Plugin "detect" mode).

import type { PluginModule } from "@opencode-ai/plugin"
import { DevEcoPlugin } from "./plugin.js"

const module: PluginModule = {
  id: "opencode-deveco",
  server: DevEcoPlugin,
}

export default module
