import { actorId, documentId, opId, type Journal, type JournalOptions } from '../src/index.js'

interface Operation {
  readonly id: string
}
interface Snapshot {
  readonly ids: ReadonlyArray<string>
}
interface Principal {
  readonly actorId: string
}

const key = documentId('orders')
const principal: Principal = { actorId: 'owner' }

// The append input is the codec's encoded side, not `unknown`.
declare const journal: Journal<Operation, Snapshot, Principal, string>
journal.append(key, 'order:1', principal)
// @ts-expect-error a decoded Operation is not the encoded input
journal.append(key, { id: 'order:1' }, principal)

// The encoded type is inferred from a transforming codec.
const options: JournalOptions<Operation, Snapshot, Principal, string> = {
  file: ':memory:',
  operation: { encode: value => value.id, decode: value => ({ id: value }) },
  snapshot: { encode: value => value, decode: value => value as Snapshot },
  empty: () => ({ ids: [] }),
  reduce: (snapshot, operation) => ({ ids: [...snapshot.ids, operation.id] }),
  opId: value => opId(value.id),
  actorId: value => actorId(value.actorId),
}
void options
