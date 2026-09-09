import type { Agent } from 'foldkit-agent'
import { type Message, type Model, initialModel, update } from './app.js'

/**
 * The seam between the agent contract and a running application.
 *
 * Foldkit `0.158.2` accepts no `agent` option on `makeApplication` and exposes
 * no Model or dispatch handle, so the application provides this. In a real app
 * `dispatch` would push a Message into the live Foldkit Runtime and `model`
 * would read the Model it holds; here it is a tiny loop over the same `update`.
 */
export interface Store {
  readonly host: Agent.AgentHost<Model, Message>
  readonly model: () => Model
  /** Dispatch from the UI side, to show both surfaces driving one state machine. */
  readonly dispatch: (message: Message) => void
}

export const makeStore = (initial: Model = initialModel): Store => {
  let model = initial
  const listeners = new Set<() => void>()

  const dispatch = (message: Message): void => {
    model = update(model, message)
    for (const listener of listeners) listener()
  }

  return {
    model: () => model,
    dispatch,
    host: {
      model: () => model,
      dispatch,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}
