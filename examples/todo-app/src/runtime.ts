/**
 * Mounting the app, honestly.
 *
 * Foldkit 0.158.2 has no asynchronous admission hook, so a durable Message
 * cannot be admitted before `update` runs. The wrapper is explicit about it: a
 * durable Message becomes a Command that submits to the replica, and the shared
 * projection is merged back when the submit (and later the server) settles.
 * Every other Message runs through the app's own `update` untouched.
 *
 * This is the seam `docs/sync-runtime-binding.md` proposes removing upstream.
 */
import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import * as Port from 'foldkit/port'
import * as Runtime from 'foldkit/runtime'
import * as Subscription from 'foldkit/subscription'
import type * as Update from 'foldkit/update'
import type { Replica } from 'foldkit-sync'
import { Message, Model, durableTags, initialModel, update, type Shared } from './app.js'
import { view } from './view.js'

const RuntimeMessage = defineMessageUnion({
  ApplicationMessage: { message: Message },
  RefreshShared: {},
  PersistenceFailed: {},
})
type RuntimeMessage = typeof RuntimeMessage.Type

export interface MountedApp {
  readonly send: (message: Message) => void
  /** The live Model, for the agent host. */
  readonly model: () => Model
  readonly subscribe: (listener: () => void) => () => void
  /** Re-reads the shared projection, e.g. after an exchange. */
  readonly refresh: () => void
  readonly dispose: () => void
}

export const mountApp = (replica: Replica<Message, Shared>, container: HTMLElement): MountedApp => {
  const ports = {
    inbound: {
      message: Port.inbound(Message),
      refresh: Port.inbound(Schema.Boolean),
    },
  }

  let current: Model = { ...initialModel, ...Effect.runSync(replica.shared) }
  const listeners = new Set<() => void>()

  const wrappedUpdate = (
    model: Model,
    message: RuntimeMessage,
  ): Update.Return<Model, RuntimeMessage> => {
    const result = RuntimeMessage.match<Update.Return<Model, RuntimeMessage>>(message, {
      ApplicationMessage: ({ message }) => {
        if (durableTags.has(message._tag))
          return {
            model,
            commands: [
              {
                name: 'PersistOperation',
                effect: replica.submit(message).pipe(
                  Effect.map(() => RuntimeMessage.RefreshShared()),
                  Effect.catch(() => Effect.succeed(RuntimeMessage.PersistenceFailed())),
                ),
              },
            ],
          }

        const applied = update(model, message)
        return {
          model: applied.model,
          ...(applied.commands === undefined
            ? {}
            : {
                commands: applied.commands.map(command => ({
                  ...command,
                  effect: Effect.map(command.effect, message =>
                    RuntimeMessage.ApplicationMessage({ message }),
                  ),
                })),
              }),
        }
      },
      RefreshShared: () => ({ model: { ...model, ...Effect.runSync(replica.shared) } }),
      PersistenceFailed: () => ({
        model: { ...model, lastError: 'Could not save this change. It will retry.' },
      }),
    })

    current = result.model
    for (const listener of listeners) listener()
    return result
  }

  const program = Runtime.makeApplication({
    Model,
    container,
    ports,
    init: () => ({ model: current }),
    update: wrappedUpdate,
    subscriptions: Subscription.make<Model, RuntimeMessage>()(() => ({
      message: Port.subscription(ports.inbound.message, message =>
        RuntimeMessage.ApplicationMessage({ message }),
      ),
      refresh: Port.subscription(ports.inbound.refresh, () => RuntimeMessage.RefreshShared()),
    })),
    view: (model, h) => view(model, h, message => RuntimeMessage.ApplicationMessage({ message })),
  })

  const handle = Runtime.embed(program)

  return {
    send: message => {
      void handle.ports.message.send(message)
    },
    model: () => current,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: () => {
      void handle.ports.refresh.send(true)
    },
    dispose: handle.dispose,
  }
}
