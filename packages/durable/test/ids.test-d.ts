/**
 * Compile-time expectations for the branded identities. This file is
 * type-checked, not executed; every `@ts-expect-error` must stay an error.
 */
import { actorId, documentId, opId } from '../src/index.js'

const document = documentId('todos')
const operation = opId('todos:1')
const actor = actorId('owner')

// A branded id is still usable as its base type.
const asString: string = document
const alsoString: string = operation
const actorAsString: string = actor

// @ts-expect-error an operation id is not a document id
const swappedDocument: ReturnType<typeof documentId> = operation
// @ts-expect-error an actor id is not an operation id
const swappedOperation: ReturnType<typeof opId> = actor
// @ts-expect-error a plain string does not carry the actor brand
const plainActor: ReturnType<typeof actorId> = 'owner'
