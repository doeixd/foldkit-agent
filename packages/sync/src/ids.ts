import { Schema } from 'effect'

/** Identifies the replicated document a replica or operation belongs to. */
export const DocumentId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-sync/DocumentId'))
export type DocumentId = typeof DocumentId.Type

/** Identifies one replica (writer identity) within a document. */
export const ReplicaId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-sync/ReplicaId'))
export type ReplicaId = typeof ReplicaId.Type

/** The stable identity of one operation within a document. */
export const OpId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-sync/OpId'))
export type OpId = typeof OpId.Type

/**
 * A position in the committed document order. `0` is the start; a committed
 * operation's `serverSequence` and a replica's `cursor` are the same family.
 */
export const Sequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand('@foldkit-sync/Sequence'))
export type Sequence = typeof Sequence.Type

/** A replica's own operation counter within a document; 1-based. */
export const LocalSequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand('@foldkit-sync/LocalSequence'))
export type LocalSequence = typeof LocalSequence.Type

export const documentId = (value: string): DocumentId => Schema.decodeUnknownSync(DocumentId)(value)
export const replicaId = (value: string): ReplicaId => Schema.decodeUnknownSync(ReplicaId)(value)
export const opId = (value: string): OpId => Schema.decodeUnknownSync(OpId)(value)
export const sequence = (value: number): Sequence => Schema.decodeUnknownSync(Sequence)(value)
export const localSequence = (value: number): LocalSequence =>
  Schema.decodeUnknownSync(LocalSequence)(value)
