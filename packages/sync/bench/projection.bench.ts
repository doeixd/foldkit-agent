import { Effect, Schema } from 'effect'
import { bench, describe } from 'vitest'
import {
  defineSync,
  documentId,
  layerFromPromise,
  opId,
  replicaId,
  type Committed,
  type Operation,
  type Replica,
  type ReplicaState,
  type Storage,
} from '../src/index.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const Shared = Schema.Struct({ todos: Schema.Array(Todo) })
type Shared = typeof Shared.Type

const Message = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('CreatedTodo'), id: Schema.String, title: Schema.String }),
])
type Message = typeof Message.Type

const Sync = defineSync({
  documentId: documentId('todos'),
  message: Message,
  shared: Shared,
  empty: { todos: [] },
  durable: () => true,
  replay: (shared, message) =>
    shared.todos.some(todo => todo.id === message.id)
      ? shared
      : { todos: [...shared.todos, { id: message.id, title: message.title }] },
})

const operation = (localSequence: number, id: string): Operation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: documentId('todos'),
  replicaId: replicaId('a'),
  localSequence,
  opId: opId(`a:${localSequence}`),
  baseCursor: 0,
  message: { _tag: 'CreatedTodo', id, title: id },
})

const stateWith = (pending: number, committed: number): ReplicaState<Shared> => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: 'todos',
  replicaId: 'a',
  revision: pending,
  nextLocalSequence: pending + 1,
  cursor: 0,
  committed: {
    todos: Array.from({ length: committed }, (_, index) => ({
      id: `c${index}`,
      title: `c${index}`,
    })),
  },
  committedIds: [],
  pending: Array.from({ length: pending }, (_, index) => operation(index + 1, `p${index}`)),
})

const storageWith = (state: ReplicaState<Shared>): Storage<ReplicaState<Shared>> => ({
  load: () => Effect.succeed(state),
  save: () => Effect.void,
  close: Effect.void,
})

const committed = (serverSequence: number, id: string): Committed => ({
  ...operation(serverSequence, id),
  serverSequence,
  actorId: 'owner',
})

const open = (state: ReplicaState<Shared>): Replica<Message, Shared> =>
  Effect.runSync(Sync.openReplica(replicaId('a'), storageWith(state)))

describe('openReplica with a committed model of 100', () => {
  for (const pending of [0, 100, 1000, 5000])
    bench(`startup, outbox ${pending}`, () => {
      open(stateWith(pending, 100))
    })
})

describe('shared read with a committed model of 100', () => {
  for (const pending of [0, 100, 1000, 5000]) {
    const replica = open(stateWith(pending, 100))
    bench(`read, outbox ${pending}`, () => {
      Effect.runSync(replica.shared)
    })
  }
})

describe('reconnect: reconcile a committed batch onto a 100-op outbox', () => {
  for (const batch of [100, 1000]) {
    const operations = Array.from({ length: batch }, (_, index) =>
      committed(index + 1, `s${index}`),
    )
    bench(`reconcile ${batch} commits`, async () => {
      const replica = open(stateWith(100, 100))
      await Effect.runPromise(
        Effect.provide(
          replica.synchronize,
          layerFromPromise({ exchange: async () => ({ operations, rejected: [] }) }),
        ),
      )
    })
  }
})
