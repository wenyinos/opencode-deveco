import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    // Keep the suite away from the developer's real config dir: model fetches
    // persist their catalog there, and a test's mock payload would otherwise
    // overwrite the live one. Files that need their own directory still call
    // mkdtemp and override this.
    env: {
      OPENCODE_CONFIG_DIR: "/tmp/opencode-deveco-vitest-config",
    },
  },
})
