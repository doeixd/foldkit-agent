import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import { documentId, make, project, replicaId } from '../src/index.js'
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

const App = Surface.make({ Model: ModelSchema, Message })
const initial: Model = { todos: [], selectedTodoId: null }

const TodoSync = make(App, 'TodoSync', {
  documentId: documentId('todos'),
  initial,
  model: project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo, Message.RenamedTodo],
  replay: (shared, message) =>
    message._tag === 'CreatedTodo'
      ? { todos: [...shared.todos, { id: message.id, title: message.title }] }
      : {
          todos: shared.todos.map(todo =>
            todo.id === message.id ? { ...todo, title: message.title } : todo,
          ),
        },
})

const open = () => Effect.runPromise(TodoSync.openReplica(replicaId('a'), memoryStorage()))
type Replica = Awaited<ReturnType<typeof open>>
type AppMessage = Schema.Schema.Type<typeof Message>
const submit = (replica: Replica, message: AppMessage) => Effect.runPromise(replica.submit(message))
const shared = (replica: Replica) => Effect.runSync(replica.shared)
const pending = (replica: Replica) => Effect.runSync(replica.pending)

describe('Sync.make', () => {
  it('exposes a read-only surface over the projection', () => {
    const inspection = Surface.inspect(TodoSync.surface, undefined)

    expect(inspection.dependencies).toEqual([['todos']])
    expect(inspection.emits).toEqual([Message.CreatedTodo, Message.RenamedTodo])
  })

  it('derives the projected schema, get, and set from the ModelRefs', () => {
    expect(TodoSync.projection.get(initial)).toEqual({ todos: [] })
    expect(
      TodoSync.projection.set(
        { todos: [], selectedTodoId: 'a' },
        {
          todos: [{ id: 'x', title: 'X' }],
        },
      ),
    ).toEqual({ todos: [{ id: 'x', title: 'X' }], selectedTodoId: 'a' })
  })

  it('replays only the declared durable Messages', async () => {
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

    expect(pending(replica)).toHaveLength(2)
  })

  it('compiles the journal contract over the shared snapshot', () => {
    const contract = TodoSync.journalContract()
    expect(contract.empty()).toEqual({ todos: [] })

    const operation = TodoSync.normalizeOperation({
      protocolVersion: 1,
      schemaVersion: 1,
      documentId: documentId('todos'),
      replicaId: 'a',
      localSequence: 1,
      opId: 'a:1',
      baseCursor: 0,
      message: Message.CreatedTodo({ id: 'a', title: 'A' }),
    })

    const snapshot = contract.reduce(contract.empty(), operation)
    expect(snapshot).toEqual({ todos: [{ id: 'a', title: 'A' }] })
    expect(contract.snapshot.decode(contract.snapshot.encode(snapshot))).toEqual(snapshot)
    expect(contract.operation.decode(contract.operation.encode(operation))).toEqual(operation)
  })
})
