/**
 * `pnpm dev`: start the SQLite-backed sync server and Vite together. Vite
 * proxies `/sync` to the server, so the browser talks to one origin.
 */
import { spawn } from 'node:child_process'
import { startSyncServer } from './server.js'
import { openJournal } from './journal.js'

const documentId = 'todos'
const journal = openJournal(process.env['TODO_DB'] ?? 'todos.dev.db')
const server = await startSyncServer({
  journal,
  authenticate: token =>
    token === null ? undefined : { principal: { actorId: token, documentId, canWrite: true } },
  port: Number(process.env['SYNC_PORT'] ?? 8787),
})
console.log(`sync server on ${server.url}`)

const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const shutdown = async (): Promise<void> => {
  await server.close()
  journal.close()
}

vite.on('close', code => {
  void shutdown().then(() => process.exit(code ?? 0))
})
process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0))
})
