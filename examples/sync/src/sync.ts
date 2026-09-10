import { defineSync, documentId } from 'foldkit-sync'
import { Message, Shared, durableTags, replay } from './app.js'

/** The replicated-state contract for the todo document. */
export const Sync = defineSync({
  documentId: documentId('todos'),
  message: Message,
  shared: Shared,
  empty: { todos: [] },
  durable: message => durableTags.has(message._tag),
  replay: (shared, message) => replay(shared, message),
})
