import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The client connects to `/sync` on its own origin; proxy the WebSocket to
    // the journal server so the browser and the database share one address.
    proxy: {
      '/sync': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
})
