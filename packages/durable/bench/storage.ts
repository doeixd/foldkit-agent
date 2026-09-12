import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { actorId, documentId, makeJournal, opId, sequence } from '../src/index.js'

interface Operation {
  readonly opId: string
  readonly id: string
}
interface Snapshot {
  readonly count: number
}
interface Principal {
  readonly actorId: string
}

const codec = <T>(): { encode: (value: T) => T; decode: (value: unknown) => T } => ({
  encode: value => value,
  decode: value => value as T,
})
const principal: Principal = { actorId: 'owner' }
const operations = 5_000

const directory = mkdtempSync(join(tmpdir(), 'foldkit-storage-'))
const path = join(directory, 'journal.sqlite')
const scope = Effect.runSync(Scope.make())
const journal = Effect.runSync(
  makeJournal<Operation, Snapshot, Principal>({
    file: path,
    operation: codec<Operation>(),
    snapshot: codec<Snapshot>(),
    empty: () => ({ count: 0 }),
    reduce: state => ({ count: state.count + 1 }),
    opId: operation => opId(operation.opId),
    actorId: value => actorId(value.actorId),
  }).pipe(Effect.provideService(Scope.Scope, scope)),
)

const size = (): number => statSync(path).size
const started = performance.now()
for (let index = 1; index <= operations; index += 1)
  Effect.runSync(
    journal.append(documentId('bench'), { opId: `op:${index}`, id: String(index) }, principal),
  )
const appended = size()
const elapsed = performance.now() - started

// Compaction drops payloads but keeps one identity row per operation, so the
// file does not shrink; this separates "payload bytes" from "identity bytes".
Effect.runSync(journal.compact(documentId('bench'), sequence(operations)))
const compacted = size()
const heap = process.memoryUsage()

console.log(
  [
    `operations: ${operations}`,
    `append: ${elapsed.toFixed(0)} ms (${(elapsed / operations).toFixed(2)} ms/op)`,
    `bytes appended: ${appended} (${(appended / operations).toFixed(1)} B/op)`,
    `bytes after compacting all payloads: ${compacted}`,
    `heap: ${(heap.heapUsed / 1_000_000).toFixed(1)} MB, rss: ${(heap.rss / 1_000_000).toFixed(1)} MB`,
  ].join('\n'),
)

Effect.runSync(Scope.close(scope, Exit.void))
rmSync(directory, { recursive: true, force: true })
