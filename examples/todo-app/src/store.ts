import type { Agent } from 'foldkit-agent'
import { type Message, type Model, initialModel, update } from './app.js'

/**
 * The seam between the agent contract and a running application.
 *
 * Foldkit `0.158.2` exposes no Model or dispatch handle, so the application
 * provides this. In the browser build the same shape is backed by the live
 * Foldkit runtime and the sync replica; here it is a tiny loop over `update`.
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
    model = update(model, message).model
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
