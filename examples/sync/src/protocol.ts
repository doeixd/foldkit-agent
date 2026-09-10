import { Schema } from 'effect'
import { Shared, decodeMessage, encodeMessage, durableTags } from './app.js'

const Sequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Operation = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  schemaVersion: Schema.Literal(1),
  documentId: Schema.NonEmptyString,
  replicaId: Schema.NonEmptyString,
  localSequence: Sequence,
  opId: Schema.NonEmptyString,
  baseCursor: Sequence,
  message: Schema.Unknown,
})
export type Operation = typeof Operation.Type
const Committed = Schema.Struct({
  ...Operation.fields,
  serverSequence: Sequence.check(Schema.isGreaterThanOrEqualTo(1)),
  actorId: Schema.NonEmptyString,
})
export type Committed = typeof Committed.Type
const ReplicaState = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  schemaVersion: Schema.Literal(1),
  documentId: Schema.NonEmptyString,
  replicaId: Schema.NonEmptyString,
  revision: Sequence,
  nextLocalSequence: Sequence,
  cursor: Sequence,
  committed: Shared,
  committedIds: Schema.Array(Schema.String),
  pending: Schema.Array(Operation),
})
export type ReplicaState = typeof ReplicaState.Type

const decodeOperation = Schema.decodeUnknownSync(Operation, { onExcessProperty: 'error' })
const decodeCommitted = Schema.decodeUnknownSync(Committed, { onExcessProperty: 'error' })
export const decodeState = Schema.decodeUnknownSync(ReplicaState, { onExcessProperty: 'error' })

const shape = <O extends Operation>(operation: O): O => {
  if (
    operation.localSequence < 1 ||
    operation.opId !== `${operation.replicaId}:${operation.localSequence}`
  ) {
    throw new Error('Invalid operation identity')
  }
  const message = decodeMessage(operation.message)
  if (!durableTags.has(message._tag)) throw new Error('Message is local-only')
  return { ...operation, message: encodeMessage(message) }
}

const assertDocument = <O extends Operation>(operation: O, documentId: string): O => {
  if (operation.documentId !== documentId) throw new Error('Wrong document')
  return operation
}

/**
 * Decodes and normalizes an operation envelope without checking its document.
 *
 * The durable journal keys by document, so the document check is the adapter's,
 * not the codec's: a codec sees only the value.
 */
export const normalizeOperation = (input: unknown): Operation => shape(decodeOperation(input))

export const operationFrom = (input: unknown, documentId: string): Operation =>
  assertDocument(normalizeOperation(input), documentId)

export const committedFrom = (input: unknown, documentId: string): Committed =>
  assertDocument(shape(decodeCommitted(input)), documentId)

const Checkpoint = Schema.Struct({
  cursor: Sequence,
  model: Shared,
})
export type Checkpoint = typeof Checkpoint.Type
const Exchange = Schema.Struct({
  operations: Schema.Array(Schema.Unknown),
  rejected: Schema.Array(Schema.NonEmptyString),
  /** Sends from the request that are durably committed, so the replica can drop them. */
  acknowledged: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** The snapshot a replica predating compaction adopts in place of the log. */
  checkpoint: Schema.optional(Checkpoint),
})
export type Exchange = typeof Exchange.Type
export const decodeExchange = Schema.decodeUnknownSync(Exchange, { onExcessProperty: 'error' })
export interface Transport {
  exchange(cursor: number, pending: ReadonlyArray<Operation>): Promise<unknown>
}
