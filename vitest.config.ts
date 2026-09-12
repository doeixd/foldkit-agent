import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Vite 5's builtin list predates `node:sqlite` (it resolves to a bare
      // `sqlite` and fails to load), so under Vitest a static import resolves to
      // this shim. Node and tsx still resolve the real builtin.
      'node:sqlite': fileURLToPath(new URL('./test-support/sqlite.ts', import.meta.url)),
      // Resolve the workspace package from source, so tests never depend on a
      // prior build of packages/agent.
      'foldkit-agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
      'foldkit-agent-native': fileURLToPath(
        new URL('./packages/agent-native/src/index.ts', import.meta.url),
      ),
      'foldkit-agent-a2a': fileURLToPath(
        new URL('./packages/agent-a2a/src/index.ts', import.meta.url),
      ),
      'foldkit-agent-mcp': fileURLToPath(
        new URL('./packages/agent-mcp/src/index.ts', import.meta.url),
      ),
      'foldkit-agent-webmcp': fileURLToPath(
        new URL('./packages/agent-webmcp/src/index.ts', import.meta.url),
      ),
      'foldkit-durable': fileURLToPath(new URL('./packages/durable/src/index.ts', import.meta.url)),
      'foldkit-sync': fileURLToPath(new URL('./packages/sync/src/index.ts', import.meta.url)),
      'foldkit-surface': fileURLToPath(new URL('./packages/surface/src/index.ts', import.meta.url)),
      'foldkit-remote': fileURLToPath(new URL('./packages/remote/src/index.ts', import.meta.url)),
      'foldkit-remote-server': fileURLToPath(
        new URL('./packages/remote-server/src/index.ts', import.meta.url),
      ),
      'foldkit-remote-drizzle': fileURLToPath(
        new URL('./packages/remote-drizzle/src/index.ts', import.meta.url),
      ),
      'foldkit-mixins': fileURLToPath(new URL('./packages/mixins/src/index.ts', import.meta.url)),
      'foldkit-mixins-surface': fileURLToPath(
        new URL('./packages/mixins-surface/src/index.ts', import.meta.url),
      ),
      'foldkit-mixins-ui': fileURLToPath(
        new URL('./packages/mixins-ui/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
  },
})
