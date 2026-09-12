import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { cursor, makeJournal } from '../../src/index.js'
import { document, effectKey, journalOptions, operation } from './recoveryModel.js'

const [journalFile, providerFile, phase, policy] = process.argv.slice(2)
if (!journalFile || !providerFile || !phase || !policy) throw new Error('Missing worker arguments')

// The provider commits independently of the journal. Receipts and deliveries
// share a transaction, emulating a provider's durable idempotency contract.
const provider = new DatabaseSync(providerFile)
provider.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deliveries (receipt INTEGER PRIMARY KEY, key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, receipt INTEGER NOT NULL);
`)

const send = (key: string) => {
  provider.exec('BEGIN IMMEDIATE')
  provider.prepare('INSERT INTO attempts (key) VALUES (?)').run(key)
  const prior =
    policy === 'idempotent'
      ? provider.prepare('SELECT receipt FROM receipts WHERE key = ?').get(key)
      : undefined
  const receipt =
    prior?.receipt ??
    provider.prepare('INSERT INTO deliveries (key) VALUES (?)').run(key).lastInsertRowid
  if (policy === 'idempotent' && prior === undefined)
    provider.prepare('INSERT INTO receipts (key, receipt) VALUES (?, ?)').run(key, receipt)
  provider.exec('COMMIT')
  return { receipt: Number(receipt) }
}

const crashAt = (boundary: string) => {
  // Exit without unwinding Effect scopes or recording a failure. This is a
  // process crash, not a caught exception or an interrupted fiber.
  if (phase === boundary) process.exit(73)
}

const results = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const journal = yield* makeJournal(journalOptions(journalFile))
      if (phase !== 'recover') yield* journal.append(document, operation, 'owner')
      crashAt('after-append')
      const results = []
      // Startup discovers even an intent whose runEffect call never started.
      for (const committed of yield* journal.read(document, cursor(0))) {
        const key = effectKey(committed.operation)
        results.push(
          yield* journal.runEffect(
            key,
            Effect.sync(() => {
              crashAt('before-provider')
              const result = send(key)
              crashAt('after-provider')
              return result
            }),
          ),
        )
        crashAt('after-record')
      }
      return results
    }),
  ),
)
provider.close()
process.stdout.write(JSON.stringify(results))
