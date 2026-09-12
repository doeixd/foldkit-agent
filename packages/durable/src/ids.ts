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

/** A committed operation's position in a document; 1-based and gap-free. */
export const Sequence = Schema.Number.pipe(Schema.brand('@foldkit-durable/Sequence'))
export type Sequence = typeof Sequence.Type

/** A read position in a document; `0` is the start. */
export const Cursor = Schema.Number.pipe(Schema.brand('@foldkit-durable/Cursor'))
export type Cursor = typeof Cursor.Type

export const documentId = (value: string): DocumentId => Schema.decodeUnknownSync(DocumentId)(value)
export const opId = (value: string): OpId => Schema.decodeUnknownSync(OpId)(value)
export const actorId = (value: string): ActorId => Schema.decodeUnknownSync(ActorId)(value)
export const sequence = (value: number): Sequence => Schema.decodeUnknownSync(Sequence)(value)
export const cursor = (value: number): Cursor => Schema.decodeUnknownSync(Cursor)(value)
