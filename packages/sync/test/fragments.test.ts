import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import { documentId, forApplication, replicaId } from '../src/index.js'
import { memoryStorage } from './memoryStorage.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const ModelSchema = Schema.Struct({
  todos: Schema.Array(Todo),
  members: Schema.Array(Schema.String),
  selectedTodoId: Schema.NullOr(Schema.String),
})
type Model = typeof ModelSchema.Type
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  Invited: { name: Schema.String },
  SelectedTodo: { id: Schema.String },
})
type Message = typeof Message.Type
const initial: Model = { todos: [], members: [], selectedTodoId: null }
const update = (model: Model, message: Message): Update.Return<Model, Message> => ({
  model: Message.match<Model>(message, {
    CreatedTodo: ({ id, title }) => ({ ...model, todos: [...model.todos, { id, title }] }),
    RenamedTodo: ({ id, title }) => ({
      ...model,
      todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
    }),
    Invited: ({ name }) => ({ ...model, members: [...model.members, name] }),
    SelectedTodo: ({ id }) => ({ ...model, selectedTodoId: id }),
  }),
})
const App = Surface.application({ Model: ModelSchema, Message, initial, update })
type Principal = { readonly role: 'admin' | 'guest' }
const Sync = forApplication(App).withPrincipal<Principal>()

const Todos = Sync.fragment({
  shared: Projection.pick(App.fields.todos),
  durable: MessageSet.make(App, [Message.CreatedTodo, Message.RenamedTodo]),
})
const Members = Sync.fragment({
  shared: Projection.pick(App.fields.members),
  durable: MessageSet.make(App, [Message.Invited]),
})

const operation = (message: Message, local = 1) => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: documentId('board'),
  replicaId: 'a',
  localSequence: local,
  opId: `a:${local}`,
  baseCursor: 0,
  message,
})

describe('Sync fragments', () => {
  const Board = Sync.make({ documentId: documentId('board'), ...Sync.compose(Todos, Members) })

  it('composes shared fields and durable Messages into one contract', async () => {
    expect(Board.projection.get({ ...initial, selectedTodoId: 'x' })).toEqual({
      todos: [],
      members: [],
    })
    expect(Board.contract.owns).toEqual([['todos'], ['members']])
    expect(Board.contract.messages).toEqual(['CreatedTodo', 'RenamedTodo', 'Invited'])

    const replica = await Effect.runPromise(Board.openReplica(replicaId('a'), memoryStorage()))
    await Effect.runPromise(replica.submit(Message.CreatedTodo({ id: 'a', title: 'A' })))
    await Effect.runPromise(replica.submit(Message.Invited({ name: 'bo' })))
    expect(Effect.runSync(replica.shared)).toEqual({
      todos: [{ id: 'a', title: 'A' }],
      members: ['bo'],
    })
    const local = await Effect.runPromise(
      Effect.result(replica.submit(Message.SelectedTodo({ id: 'a' }))),
    )
    expect(local._tag).toBe('Failure')
  })

  it('deduplicates an identical field and rejects a conflicting one', () => {
    const TodosAgain = Sync.fragment({
      shared: Projection.pick(App.fields.todos),
      durable: MessageSet.make(App, [Message.RenamedTodo]),
    })
    // The same field reference twice is one field; the duplicate tag is what fails.
    expect(() => Sync.compose(Todos, TodosAgain)).toThrow(
      'MessageSet.union: duplicate "RenamedTodo"',
    )

    const Other = Surface.application({
      Model: Schema.Struct({ todos: Schema.Array(Schema.String) }),
      Message,
      initial: { todos: [] },
      update: (model: { readonly todos: ReadonlyArray<string> }) => ({ model }),
    })
    const Conflicting = {
      shared: Projection.pick(Other.fields.todos),
      durable: MessageSet.make(App, [Message.Invited]),
    }
    expect(() => Sync.compose(Todos, Conflicting as never)).toThrow(
      'Projection.compose: conflicting definitions for "todos"',
    )
  })

  it('refuses a fragment from another application', () => {
    const Other = Surface.application({ Model: ModelSchema, Message, initial, update })
    const Foreign = forApplication(Other).fragment({
      shared: Projection.pick(Other.fields.members),
      durable: MessageSet.make(Other, [Message.Invited]),
    })
    expect(() => Sync.compose(Todos, Foreign as never)).toThrow('different application')
    expect(() =>
      Sync.fragment({
        shared: Projection.pick(App.fields.members),
        durable: MessageSet.make(Other, [Message.Invited]) as never,
      }),
    ).toThrow('different application')
  })
})

describe('Sync authorization policy', () => {
  const Guarded = Sync.make({
    documentId: documentId('board'),
    ...Sync.compose(Todos, Members),
    authorize: {
      RenamedTodo: ({ principal, message, shared }) =>
        principal.role === 'admin' && shared.todos.some(todo => todo.id === message.id),
    },
  })
  const authorize = Guarded.journalContract().authorize!
  const snapshot = { todos: [{ id: 'a', title: 'A' }], members: [] }
  const admin: Principal = { role: 'admin' }
  const guest: Principal = { role: 'guest' }

  it('compiles per-variant rules into the journal contract', () => {
    const rename = Guarded.codec.normalizeOperation(
      operation(Message.RenamedTodo({ id: 'a', title: 'B' })),
    )
    expect(authorize({ principal: admin, operation: rename, snapshot })).toBe(true)
    expect(authorize({ principal: guest, operation: rename, snapshot })).toBe(false)

    const missing = Guarded.codec.normalizeOperation(
      operation(Message.RenamedTodo({ id: 'zzz', title: 'B' })),
    )
    expect(authorize({ principal: admin, operation: missing, snapshot })).toBe(false)
  })

  it('allows a durable variant without a rule', () => {
    const create = Guarded.codec.normalizeOperation(
      operation(Message.CreatedTodo({ id: 'b', title: 'B' })),
    )
    expect(authorize({ principal: guest, operation: create, snapshot })).toBe(true)
  })

  it('declares no policy when none was given', () => {
    const Open = Sync.make({ documentId: documentId('board'), ...Sync.compose(Todos) })
    expect(Open.journalContract().authorize).toBeUndefined()
  })
})
