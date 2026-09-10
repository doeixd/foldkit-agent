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

export const documentId = (value: string): DocumentId => Schema.decodeUnknownSync(DocumentId)(value)
export const replicaId = (value: string): ReplicaId => Schema.decodeUnknownSync(ReplicaId)(value)
export const opId = (value: string): OpId => Schema.decodeUnknownSync(OpId)(value)
