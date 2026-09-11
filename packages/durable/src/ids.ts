import { Schema } from 'effect'

/** A journal's partition key: one authoritative document per key. */
export const DocumentId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-durable/DocumentId'))
export type DocumentId = typeof DocumentId.Type

/** The stable identity of one operation within its document. */
export const OpId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-durable/OpId'))
export type OpId = typeof OpId.Type

/** The trusted actor a principal commits as. */
export const ActorId = Schema.NonEmptyString.pipe(Schema.brand('@foldkit-durable/ActorId'))
export type ActorId = typeof ActorId.Type

export const documentId = (value: string): DocumentId => Schema.decodeUnknownSync(DocumentId)(value)
export const opId = (value: string): OpId => Schema.decodeUnknownSync(OpId)(value)
export const actorId = (value: string): ActorId => Schema.decodeUnknownSync(ActorId)(value)
