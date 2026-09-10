/**
 * Compile-time expectations for the branded sync identities. This file is
 * type-checked, not executed; every `@ts-expect-error` must stay an error.
 */
import { documentId, opId, replicaId } from '../src/index.js'

const document = documentId('todos')
const replica = replicaId('a')
const operation = opId('a:1')

// A branded id is still usable as its base type.
const asString: string = document
const alsoString: string = replica
const operationAsString: string = operation

// @ts-expect-error a replica id is not a document id
const swappedDocument: ReturnType<typeof documentId> = replica
// @ts-expect-error an operation id is not a replica id
const swappedReplica: ReturnType<typeof replicaId> = operation
// @ts-expect-error a plain string does not carry the document brand
const plainDocument: ReturnType<typeof documentId> = 'todos'
