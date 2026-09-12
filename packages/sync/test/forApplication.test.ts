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
const TodoSync = forApplication(App).define({
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
})

const open = () => Effect.runPromise(TodoSync.openReplica(replicaId('a'), memoryStorage()))
type Replica = Awaited<ReturnType<typeof open>>
type AppMessage = Schema.Schema.Type<typeof Message>
const submit = (replica: Replica, message: AppMessage) => Effect.runPromise(replica.submit(message))
const shared = (replica: Replica) => Effect.runSync(replica.shared)
const pending = (replica: Replica) => Effect.runSync(replica.pending)
const refuse = (replica: Replica, message: AppMessage) =>
  Effect.runPromise(Effect.result(replica.submit(message)))

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

  /**
   * An application whose `CreatedTodo` transition breaks the durable contract in
   * one way: it returns a Command, or it also writes the local `selectedTodoId`.
   * `commands: []` is the control: an empty collection is still state-only.
   */
  let ran = false
  const faultyApp = (fault: 'command' | 'local' | 'none') => {
    const faultyUpdate = (model: Model, message: Message): Update.Return<Model, Message> =>
      Message.match<Update.Return<Model, Message>>(message, {
        CreatedTodo: ({ id, title }) => {
          const todos = [...model.todos, { id, title }]
          switch (fault) {
            case 'command':
              return {
                model: { ...model, todos },
                commands: [
                  {
                    name: 'select',
                    effect: Effect.sync(() => {
                      ran = true
                      return Message.SelectedTodo({ id })
                    }),
                  },
                ],
              }
            case 'local':
              return { model: { ...model, todos, selectedTodoId: id } }
            case 'none':
              return { model: { ...model, todos }, commands: [] }
          }
        },
        RenamedTodo: () => ({ model }),
        SelectedTodo: ({ id }) => ({ model: { ...model, selectedTodoId: id } }),
      })
    const Faulty = Surface.application({
      Model: ModelSchema,
      Message,
      initial,
      update: faultyUpdate,
    })
    const sync = forApplication(Faulty).define({
      documentId: documentId('todos'),
      shared: Surface.pick(Faulty.fields.todos),
      durable: Surface.messages(Faulty, [Message.CreatedTodo, Message.RenamedTodo]),
    })
    return Effect.runPromise(sync.openReplica(replicaId('a'), memoryStorage()))
  }

  it('accepts a durable transition that returns no Commands', async () => {
    const replica = await faultyApp('none')
    await submit(replica, Message.CreatedTodo({ id: 'a', title: 'A' }))
    expect(shared(replica)).toEqual({ todos: [{ id: 'a', title: 'A' }] })
  })

  it('refuses a durable transition that returns a Command before it reaches the outbox', async () => {
    const replica = await faultyApp('command')
    const refused = await refuse(replica, Message.CreatedTodo({ id: 'a', title: 'A' }))
    expect(refused._tag).toBe('Failure')
    if (refused._tag === 'Failure') {
      expect(refused.failure._tag).toBe('ReplayError')
      expect(refused.failure.message).toBe(
        'Sync.forApplication: durable "CreatedTodo" returned 1 Command(s); a durable transition is state-only',
      )
    }
    expect(ran).toBe(false)
    expect(pending(replica)).toEqual([])
    expect(shared(replica)).toEqual({ todos: [] })
  })

  it('refuses a durable transition that changes a field outside the shared projection', async () => {
    const replica = await faultyApp('local')
    const refused = await refuse(replica, Message.CreatedTodo({ id: 'a', title: 'A' }))
    expect(refused._tag).toBe('Failure')
    if (refused._tag === 'Failure') {
      expect(refused.failure._tag).toBe('ReplayError')
      expect(refused.failure.message).toBe(
        'Sync.forApplication: durable "CreatedTodo" changed Model fields outside the shared projection: selectedTodoId',
      )
    }
    expect(pending(replica)).toEqual([])
    expect(shared(replica)).toEqual({ todos: [] })
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
      forApplication(App).define({
        documentId: documentId('todos'),
        shared: Todos,
        // Structurally similar, but the owner token is a different application.
        durable: OtherChanges as never,
      }),
    ).toThrow(/different application/)
  })

  describe('with a custom replay', () => {
    const Custom = forApplication(App).define({
      documentId: documentId('todos'),
      name: 'CustomTodos',
      shared: Todos,
      durable: Changes,
      // Deliberately differs from `update` (upper-cases the title) so a test can
      // tell which reducer ran.
      replay: (value, message) =>
        message._tag === 'CreatedTodo'
          ? { todos: [...value.todos, { id: message.id, title: message.title.toUpperCase() }] }
          : {
              todos: value.todos.map(todo =>
                todo.id === message.id ? { ...todo, title: message.title.toUpperCase() } : todo,
              ),
            },
    })

    it('replays through the custom reducer, not update', async () => {
      const replica = await Effect.runPromise(Custom.openReplica(replicaId('a'), memoryStorage()))
      await submit(replica, Message.CreatedTodo({ id: 'a', title: 'a' }))
      expect(shared(replica)).toEqual({ todos: [{ id: 'a', title: 'A' }] })
      expect(Surface.inspect(Custom.surface, undefined).name).toBe('CustomTodos')
    })

    it('compiles the journal contract over the shared snapshot', () => {
      const contract = Custom.journalContract()
      expect(contract.empty()).toEqual({ todos: [] })

      const operation = Custom.codec.normalizeOperation({
        protocolVersion: 1,
        schemaVersion: 1,
        documentId: documentId('todos'),
        replicaId: 'a',
        localSequence: 1,
        opId: 'a:1',
        baseCursor: 0,
        message: Message.CreatedTodo({ id: 'a', title: 'a' }),
      })

      const snapshot = contract.reduce(contract.empty(), operation)
      expect(snapshot).toEqual({ todos: [{ id: 'a', title: 'A' }] })
      expect(contract.snapshot.decode(contract.snapshot.encode(snapshot))).toEqual(snapshot)
      expect(contract.operation.decode(contract.operation.encode(operation))).toEqual(operation)
    })
  })
})
