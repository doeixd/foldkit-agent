/**
 * The development server: a SQLite file the journal owns, fronted by the sync
 * WebSocket. `pnpm dev` starts this and Vite together.
 */
import { startSyncServer } from './server.js'
import { openJournal } from './journal.js'

const port = Number(process.env['PORT'] ?? 8787)
const file = process.env['TODO_DB'] ?? 'todos.dev.db'
const documentId = 'todos'

const journal = openJournal(file)
const server = await startSyncServer({
  journal,
  // Dev auth: the token names the actor. A real deployment validates a session.
  authenticate: token =>
    token === null ? undefined : { principal: { actorId: token, documentId, canWrite: true } },
  port,
})

console.log(`foldkit todo-app sync server on ${server.url} (db: ${file})`)

const shutdown = async (): Promise<void> => {
  await server.close()
  journal.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
