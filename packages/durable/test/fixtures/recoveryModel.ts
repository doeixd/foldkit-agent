import { Schema } from 'effect'
import { actorId, documentId, opId, type JournalOptions } from '../../src/index.js'

export const document = documentId('orders')
export const operation = 'order:1'
export const effectKey = (id: string) => JSON.stringify([document, id, 'send-confirmation:v1'])

export const journalOptions = (
  file: string,
): JournalOptions<string, ReadonlyArray<string>, string> => ({
  file,
  operation: { encode: value => value, decode: Schema.decodeUnknownSync(Schema.String) },
  snapshot: {
    encode: value => value,
    decode: Schema.decodeUnknownSync(Schema.Array(Schema.String)),
  },
  empty: () => [],
  reduce: (snapshot, value) => [...snapshot, value],
  opId,
  actorId,
})
