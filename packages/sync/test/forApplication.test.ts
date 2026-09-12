import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import type * as Update from 'foldkit/update'
import { describe, expect, it } from 'vitest'
import { documentId, forApplication, replicaId } from '../src/index.js'
import { memoryStorage } from './memoryStorage.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const ModelSchema = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.NullOr(Schema.String),
})
type Model = typeof ModelSchema.Type
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  SelectedTodo: { id: Schema.String },
})
type Message = typeof Message.Type
const initial: Model = { todos: [], selectedTodoId: null }
const update = (model: Model, message: Message): Update.Return<Model, Message> => ({
  model: Message.match<Model>(message, {
    CreatedTodo: ({ id, title }) => ({ ...model, todos: [...model.todos, { id, title }] }),
    RenamedTodo: ({ id, title }) => ({
      ...model,
      todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
    }),
    SelectedTodo: ({ id }) => ({ ...model, selectedTodoId: id }),
  }),
})

const App = Surface.application({ Model: ModelSchema, Message, initial, update })
const Todos = Surface.pick(App.fields.todos)
const Changes = Surface.messages(App, [Message.CreatedTodo, Message.RenamedTodo])
const TodoSync = forApplication(App, {
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
})

const open = () => Effect.runPromise(TodoSync.openReplica(replicaId('a'), memoryStorage()))
type Replica = Awaited<ReturnType<typeof open>>
type AppMessage = Schema.Schema.Type<typeof Message>
const submit = (replica: Replica, message: AppMessage) => Effect.runPromise(replica.submit(message))
const shared = (replica: Replica) => Effect.runSync(replica.shared)

describe('Sync.forApplication', () => {
  it('derives the projection, surface, and shape from one application', () => {
    expect(TodoSync.projection.get(initial)).toEqual({ todos: [] })

    const inspection = Surface.inspect(TodoSync.surface, undefined)
    expect(inspection.name).toBe('todos')
    expect(inspection.dependencies).toEqual([['todos']])
    expect(inspection.emits).toEqual([Message.CreatedTodo, Message.RenamedTodo])
  })

  it('replays durable Messages through update and refuses local ones', async () => {
    const replica = await open()

    await submit(replica, Message.CreatedTodo({ id: 'a', title: 'A' }))
    expect(shared(replica)).toEqual({ todos: [{ id: 'a', title: 'A' }] })

    await submit(replica, Message.RenamedTodo({ id: 'a', title: 'B' }))
    expect(shared(replica)).toEqual({ todos: [{ id: 'a', title: 'B' }] })

    const refused = await Effect.runPromise(
      Effect.result(replica.submit(Message.SelectedTodo({ id: 'a' }))),
    )
    expect(refused._tag).toBe('Failure')
    if (refused._tag === 'Failure') expect(refused.failure._tag).toBe('InvalidOutboxError')
  })

  it('refuses a durable subset from another application', () => {
    const OtherModel = Schema.Struct({ todos: Schema.Array(Schema.String) })
    const OtherMessage = defineMessageUnion({ Ping: {} })
    const OtherApp = Surface.application({
      Model: OtherModel,
      Message: OtherMessage,
      initial: { todos: [] },
      update: (model: typeof OtherModel.Type) => ({ model }),
    })
    const OtherChanges = Surface.messages(OtherApp, [OtherMessage.Ping])

    expect(() =>
      forApplication(App, {
        documentId: documentId('todos'),
        shared: Todos,
        // Structurally similar, but the owner token is a different application.
        durable: OtherChanges as never,
      }),
    ).toThrow(/different application/)
  })
})
