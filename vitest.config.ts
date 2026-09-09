import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package from source, so tests never depend on a
      // prior build of packages/agent.
      '@foldkit/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
