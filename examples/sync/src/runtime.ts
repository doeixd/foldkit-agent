import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import * as Port from 'foldkit/port'
import * as Runtime from 'foldkit/runtime'
import * as Subscription from 'foldkit/subscription'
import type * as Update from 'foldkit/update'
import type { Replica, TransportClient } from 'foldkit-sync'
import { Message, Model, durableTags, initialModel, update, type Shared } from './app.js'

const RuntimeMessage = defineMessageUnion({
  ApplicationMessage: { message: Message },
  RefreshShared: {},
  PersistenceFailed: {},
})
type RuntimeMessage = typeof RuntimeMessage.Type

/** The wrapper delays durable updates until their IndexedDB transaction commits. */
export const mountReplica = (replica: Replica<Message, Shared>, container: HTMLElement) => {
  const ports = {
    inbound: {
      message: Port.inbound(Message),
      refresh: Port.inbound(Schema.Boolean),
    },
  }
  const wrappedUpdate = (
    model: Model,
    message: RuntimeMessage,
  ): Update.Return<Model, RuntimeMessage> =>
    RuntimeMessage.match(message, {
      ApplicationMessage: ({ message }) => {
        if (durableTags.has(message._tag))
          return {
            model,
            commands: [
              {
                name: 'PersistOperation',
                effect: Effect.tryPromise(() => replica.submit(message)).pipe(
                  Effect.map(() => RuntimeMessage.RefreshShared()),
                  Effect.catch(() => Effect.succeed(RuntimeMessage.PersistenceFailed())),
                ),
              },
            ],
          }
        const result = update(model, message)
        return {
          model: result.model,
          ...(result.commands === undefined
            ? {}
            : {
                commands: result.commands.map(command => ({
                  ...command,
                  effect: Effect.map(command.effect, message =>
                    RuntimeMessage.ApplicationMessage({ message }),
                  ),
                })),
              }),
        }
      },
      RefreshShared: () => ({ model: { ...model, ...replica.shared() } }),
      PersistenceFailed: () => ({
        model: { ...model, lastError: 'Could not persist this change' },
      }),
    })
  const program = Runtime.makeApplication({
    Model,
    container,
    ports,
    init: () => ({ model: { ...initialModel, ...replica.shared() } }),
    update: wrappedUpdate,
    subscriptions: Subscription.make<Model, RuntimeMessage>()(() => ({
      message: Port.subscription(ports.inbound.message, message =>
        RuntimeMessage.ApplicationMessage({ message }),
      ),
      refresh: Port.subscription(ports.inbound.refresh, () => RuntimeMessage.RefreshShared()),
    })),
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
  })
  const handle = Runtime.embed(program)
  return {
    send: handle.ports.message.send,
    synchronize: async (transport: TransportClient) => {
      await replica.synchronize(transport)
      handle.ports.refresh.send(true)
    },
    dispose: handle.dispose,
  }
}
