// @vitest-environment jsdom
import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentId,
  forApplication,
  layerFromPromise,
  localSequence,
  mount,
  opId,
  replicaId,
  sequence,
  StorageError,
  type CommittedOperation,
  type Mounted,
  type Replica,
  type Storage,
} from '../src/index.js'
import { memoryStorage } from './memoryStorage.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const ModelSchema = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
})
type Model = typeof ModelSchema.Type
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  SelectedTodo: { id: Schema.String },
  RequestedRename: { id: Schema.String, title: Schema.String },
})
type Message = typeof Message.Type
const initial: Model = { todos: [], selectedTodoId: null, lastError: null }
const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    CreatedTodo: ({ id, title }) => ({
      model: { ...model, todos: [...model.todos, { id, title }] },
    }),
    RenamedTodo: ({ id, title }) => ({
      model: {
        ...model,
        todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
      },
    }),
    SelectedTodo: ({ id }) => ({ model: { ...model, selectedTodoId: id } }),
    // A local Message whose Command settles into a durable fact.
    RequestedRename: ({ id, title }) => ({
      model,
      commands: [{ name: 'rename', effect: Effect.succeed(Message.RenamedTodo({ id, title })) }],
    }),
  })

const App = Surface.application({ Model: ModelSchema, Message, initial, update })
const TodoSync = forApplication(App).make({
  documentId: documentId('todos'),
  shared: Projection.pick(App.fields.todos),
  durable: MessageSet.make(App, [Message.CreatedTodo, Message.RenamedTodo]),
})
type Shared = { readonly todos: ReadonlyArray<{ readonly id: string; readonly title: string }> }

const committed = (id: string, title: string, serverSequence: number): CommittedOperation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: documentId('todos'),
  replicaId: replicaId('b'),
  localSequence: localSequence(serverSequence),
  opId: opId(`b:${serverSequence}`),
  baseCursor: sequence(0),
  message: { _tag: 'CreatedTodo', id, title },
  serverSequence: sequence(serverSequence),
  actorId: 'owner',
})

const text = () => document.body.textContent ?? ''
const pending = (replica: Replica<Message, Shared>) => Effect.runSync(replica.pending)
const exchange = (
  replica: Replica<Message, Shared>,
  response: { operations: CommittedOperation[]; rejected: string[] },
) =>
  Effect.runPromise(
    Effect.provide(replica.synchronize, layerFromPromise({ exchange: async () => response })),
  )

describe('Sync.mount', () => {
  let container: HTMLElement
  let replica: Replica<Message, Shared>
  let mounted: Mounted<Model, Message> | undefined
  const open = async (storage: Storage = memoryStorage()) => {
    replica = await Effect.runPromise(TodoSync.openReplica(replicaId('a'), storage))
    mounted = mount(App, TodoSync, {
      replica,
      container,
      view: (model, h) => ({
        title: 'todos',
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
      onPersistenceFailure: (model, error) => ({ ...model, lastError: error._tag }),
    })
    return mounted
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
    container = document.createElement('div')
    container.id = 'app'
    document.body.appendChild(container)
  })
  afterEach(async () => {
    await mounted?.dispose()
    mounted = undefined
    await Effect.runPromise(replica.close)
    container.remove()
    vi.unstubAllGlobals()
  })

  it('applies a durable Message at once through update and persists it after', async () => {
    const app = await open()
    app.dispatch(Message.CreatedTodo({ id: 'a', title: 'Milk' }))
    await vi.waitFor(() => expect(text()).toContain('Milk'))
    await vi.waitFor(() => expect(pending(replica)).toHaveLength(1))
    expect(app.model().todos).toEqual([{ id: 'a', title: 'Milk' }])

    app.dispatch(Message.SelectedTodo({ id: 'a' }))
    await vi.waitFor(() => expect(text()).toContain('Selection: a'))
    expect(pending(replica)).toHaveLength(1)
    expect(app.model().selectedTodoId).toBe('a')
  })

  it('lets a Command from update settle into a durable fact without wrapping', async () => {
    const app = await open()
    app.dispatch(Message.CreatedTodo({ id: 'a', title: 'Milk' }))
    app.dispatch(Message.RequestedRename({ id: 'a', title: 'Oat milk' }))
    await vi.waitFor(() => expect(text()).toContain('Oat milk'))
    await vi.waitFor(() => expect(pending(replica)).toHaveLength(2))
  })

  it('reverts a durable edit whose persist fails and reports the failure', async () => {
    const base = memoryStorage()
    const app = await open({
      ...base,
      save: (state, revision) =>
        revision === null
          ? base.save(state, revision)
          : Effect.fail(new StorageError({ message: 'disk full' })),
    })
    app.dispatch(Message.SelectedTodo({ id: 'a' }))
    app.dispatch(Message.CreatedTodo({ id: 'a', title: 'Milk' }))
    await vi.waitFor(() => expect(text()).toContain('StorageError'))
    expect(text()).not.toContain('Milk')
    // Local state survives the revert; only the shared slice is re-installed.
    expect(text()).toContain('Selection: a')
    expect(pending(replica)).toEqual([])
    expect(app.model().lastError).toBe('StorageError')
  })

  it('installs the shared slice after an exchange commits a remote change', async () => {
    const app = await open()
    await exchange(replica, { operations: [committed('r', 'Remote', 1)], rejected: [] })
    await vi.waitFor(() => expect(text()).toContain('Remote'))
    expect(app.model().todos).toEqual([{ id: 'r', title: 'Remote' }])
  })

  it('reverts an operation the server rejects', async () => {
    const app = await open()
    app.dispatch(Message.CreatedTodo({ id: 'a', title: 'Milk' }))
    await vi.waitFor(() => expect(pending(replica)).toHaveLength(1))
    await exchange(replica, { operations: [], rejected: ['a:1'] })
    await vi.waitFor(() => expect(text()).not.toContain('Milk'))
    expect(app.model().todos).toEqual([])
  })

  it('waits for an in-flight persist before disposing', async () => {
    const base = memoryStorage()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const app = await open({
      ...base,
      save: (state, revision) =>
        revision === null
          ? base.save(state, revision)
          : Effect.promise(() => held).pipe(Effect.andThen(base.save(state, revision))),
    })
    app.dispatch(Message.CreatedTodo({ id: 'a', title: 'Milk' }))
    await vi.waitFor(() => expect(text()).toContain('Milk'))

    let disposed = false
    const disposing = app.dispose().then(() => {
      disposed = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    expect(pending(replica)).toEqual([])

    release()
    await disposing
    expect(pending(replica)).toHaveLength(1)
  })
})
