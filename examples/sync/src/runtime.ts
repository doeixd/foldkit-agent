import { Effect } from 'effect'
import { layerFromPromise, type Replica, type TransportClient } from 'foldkit-sync'
import type { Message, Shared } from './app.js'
import { mountTodos } from './sync.js'

/** The browser application: the example's view over `Sync.mount`. */
export const mountReplica = (replica: Replica<Message, Shared>, container: HTMLElement) => {
  const mounted = mountTodos(replica, {
    container,
    view: (model, h) => ({
      title: 'Foldkit sync spike',
      body: h.div(
        [],
        [
          h.ul(
            [],
            model.todos.map(todo => h.li([], [todo.title])),
          ),
          h.p([], [`Selection: ${model.selectedTodoId ?? 'none'}`]),
          h.p([], [model.lastError ?? '']),
        ],
      ),
    }),
    onPersistenceFailure: model => ({ ...model, lastError: 'Could not persist this change' }),
  })
  return {
    send: mounted.dispatch,
    // The mount re-installs the shared slice itself when the exchange moves the cursor.
    synchronize: (transport: TransportClient) =>
      Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport))),
    dispose: mounted.dispose,
  }
}
