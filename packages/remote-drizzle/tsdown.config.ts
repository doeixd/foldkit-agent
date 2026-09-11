import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  deps: {
    neverBundle: [
      'effect',
      'foldkit-remote',
      'foldkit-remote-server',
      'foldkit-surface',
      'drizzle-orm',
    ],
  },
})
