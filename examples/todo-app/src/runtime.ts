/**
 * Mounting the app in a browser.
 *
 * `Sync.mount` (through `mountTodos`) runs the application with one reducer: a
 * durable Message applies through `update` at once and is persisted afterwards
 * in a Command; a failed persist reverts it and reports through
 * `onPersistenceFailure`; the shared slice is re-installed when an exchange or
 * a rejection moves the replica. The returned `Mounted` is also the host an
 * agent binds to: `model`, `dispatch`, `subscribe`, and `observe`.
 */
import type { Mounted, Replica } from 'foldkit-sync'
import type { Message, Model, Shared } from './app.js'
import { mountTodos } from './sync.js'
import { view } from './view.js'

export const mountApp = (
  replica: Replica<Message, Shared>,
  container: HTMLElement,
): Mounted<Model, Message> =>
  mountTodos(replica, {
    container,
    view,
    onPersistenceFailure: (model, error) => ({
      ...model,
      lastError:
        error._tag === 'ReplayError'
          ? `Refused: ${error.message}`
          : 'Could not save this change; it was reverted.',
    }),
  })
