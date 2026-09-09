import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package from source, so tests never depend on a
      // prior build of packages/agent.
      '@foldkit/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
      '@foldkit/agent-native': fileURLToPath(
        new URL('./packages/agent-native/src/index.ts', import.meta.url),
      ),
      '@foldkit/agent-a2a': fileURLToPath(
        new URL('./packages/agent-a2a/src/index.ts', import.meta.url),
      ),
      '@foldkit/agent-mcp': fileURLToPath(
        new URL('./packages/agent-mcp/src/index.ts', import.meta.url),
      ),
      '@foldkit/agent-webmcp': fileURLToPath(
        new URL('./packages/agent-webmcp/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
  },
})
