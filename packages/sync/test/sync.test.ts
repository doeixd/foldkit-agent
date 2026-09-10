import { readFileSync } from 'node:fs'
import { Deferred, Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
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
  type ReplicaStatus,
  type Storage,
  type SyncDefinition,
  type TransportClient,
} from '../src/index.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const Shared = Schema.Struct({ todos: Schema.Array(Todo) })
type Shared = typeof Shared.Type

const Message = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('CreatedTodo'), id: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('RenamedTodo'), id: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('SelectedTodo'), id: Schema.String }),
])
type Message = typeof Message.Type

const definition: SyncDefinition<Message, Shared, unknown, unknown> = {
  documentId: documentId('todos'),
  message: Message,
  shared: Shared,
  empty: { todos: [] },
  durable: message => message._tag !== 'SelectedTodo',
  replay: (shared, message) => {
    switch (message._tag) {
      case 'CreatedTodo':
        return {
          todos: shared.todos.some(todo => todo.id === message.id)
            ? shared.todos
            : [...shared.todos, { id: message.id, title: message.title }],
        }
      case 'RenamedTodo':
        return {
          todos: shared.todos.map(todo =>
            todo.id === message.id ? { ...todo, title: message.title } : todo,
          ),
        }
      case 'SelectedTodo':
        return shared
    }
  },
}

const Sync = defineSync(definition)

const created = (id: string, title = id): Message => ({ _tag: 'CreatedTodo', id, title })

const operation = (replica: string, localSequence: number, message: Message): Operation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: documentId('todos'),
  replicaId: replicaId(replica),
  localSequence,
  opId: opId(`${replica}:${localSequence}`),
  baseCursor: 0,
  message,
})

const committed = (
  replica: string,
  localSequence: number,
  serverSequence: number,
  message: Message,
): Committed => ({
  ...operation(replica, localSequence, message),
  serverSequence,
  actorId: 'owner',
})

const memoryStorage = (initial?: unknown): Storage<ReplicaState<Shared>> => {
  let state = initial
  return {
    load: () => Effect.sync(() => state),
    save: next =>
      Effect.sync(() => {
        state = structuredClone(next)
      }),
    close: Effect.void,
  }
}

const open = (id: string, storage = memoryStorage()): Promise<Replica<Message, Shared>> =>
  Effect.runPromise(Sync.openReplica(replicaId(id), storage))
const submit = (replica: Replica<Message, Shared>, message: Message): Promise<void> =>
  Effect.runPromise(replica.submit(message))
const sync = (replica: Replica<Message, Shared>, transport: TransportClient): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport)))
const shared = (replica: Replica<Message, Shared>): Shared => Effect.runSync(replica.shared)
const pending = (replica: Replica<Message, Shared>): ReadonlyArray<Operation> =>
  Effect.runSync(replica.pending)
const cursor = (replica: Replica<Message, Shared>): number => Effect.runSync(replica.cursor)
const status = (replica: Replica<Message, Shared>): Promise<ReplicaStatus> =>
  Effect.runPromise(replica.status)
const close = (replica: Replica<Message, Shared>): Promise<void> => Effect.runPromise(replica.close)

describe('the operation codec', () => {
  it('normalizes a valid operation and refuses a broken identity', () => {
    const valid = operation('a', 1, created('t'))
    expect(Sync.normalizeOperation(valid)).toEqual(valid)
    expect(() => Sync.normalizeOperation({ ...valid, opId: 'b:1' })).toThrow(
      'Invalid operation identity',
    )
    expect(() => Sync.normalizeOperation({ ...valid, localSequence: 0 })).toThrow(
      'Invalid operation identity',
    )
  })

  it('refuses a Message the contract does not call durable', () => {
    expect(() =>
      Sync.normalizeOperation(operation('a', 1, { _tag: 'SelectedTodo', id: 't' })),
    ).toThrow('Message is local-only')
  })

  it('checks the document only when the caller supplies one', () => {
    const foreign = { ...operation('a', 1, created('t')), documentId: 'other' }
    expect(Sync.normalizeOperation(foreign)).toMatchObject({ documentId: 'other' })
    expect(() => Sync.operationFrom(foreign, documentId('todos'))).toThrow('Wrong document')
  })

  it('refuses a committed operation without a positive server sequence', () => {
    expect(() =>
      Sync.committedFrom(
        { ...operation('a', 1, created('t')), serverSequence: 0, actorId: 'owner' },
        documentId('todos'),
      ),
    ).toThrow()
  })
})

describe('the replica', () => {
  it('projects a submit optimistically and converges on the committed order', async () => {
    const replica = await open('a')
    await submit(replica, created('t', 'first'))

    expect(shared(replica).todos).toEqual([{ id: 't', title: 'first' }])
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1'])

    await sync(replica, {
      exchange: async () => ({
        operations: [committed('a', 1, 1, created('t', 'first'))],
        rejected: [],
      }),
    })

    expect(cursor(replica)).toBe(1)
    expect(pending(replica)).toEqual([])
  })

  it('drops a rejected operation and reverts its optimistic effect', async () => {
    const replica = await open('a')
    await submit(replica, created('t'))

    await sync(replica, { exchange: async () => ({ operations: [], rejected: ['a:1'] }) })

    expect(pending(replica)).toEqual([])
    expect(shared(replica)).toEqual({ todos: [] })
  })

  it('adopts a checkpoint in place of the log', async () => {
    const replica = await open('a')
    await sync(replica, {
      exchange: async () => ({
        operations: [],
        rejected: [],
        checkpoint: { cursor: 2, model: { todos: [{ id: 'x', title: 'x' }] } },
      }),
    })

    expect(cursor(replica)).toBe(2)
    expect(shared(replica)).toEqual({ todos: [{ id: 'x', title: 'x' }] })
  })

  it('rebases a pending operation onto an adopted checkpoint', async () => {
    const replica = await open('a')
    await submit(replica, created('t', 'mine'))

    await sync(replica, {
      exchange: async () => ({
        operations: [],
        rejected: [],
        checkpoint: { cursor: 2, model: { todos: [{ id: 'x', title: 'theirs' }] } },
      }),
    })

    expect(cursor(replica)).toBe(2)
    expect(shared(replica).todos).toEqual([
      { id: 'x', title: 'theirs' },
      { id: 't', title: 'mine' },
    ])
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1'])
  })

  it('applies committed operations that follow an adopted checkpoint', async () => {
    const replica = await open('a')

    await sync(replica, {
      exchange: async () => ({
        operations: [committed('b', 1, 2, created('tail'))],
        rejected: [],
        checkpoint: { cursor: 1, model: { todos: [{ id: 'base', title: 'base' }] } },
      }),
    })

    expect(cursor(replica)).toBe(2)
    expect(shared(replica).todos.map(todo => todo.id)).toEqual(['base', 'tail'])
  })

  it('refuses a checkpoint older than its own cursor', async () => {
    const replica = await open('a')
    await sync(replica, {
      exchange: async () => ({ operations: [committed('b', 1, 1, created('t'))], rejected: [] }),
    })
    expect(cursor(replica)).toBe(1)

    await expect(
      sync(replica, {
        exchange: async () => ({
          operations: [],
          rejected: [],
          checkpoint: { cursor: 0, model: { todos: [] } },
        }),
      }),
    ).rejects.toThrow('Checkpoint is behind the replica')
    expect(cursor(replica)).toBe(1)
  })

  it('refuses a gap in the committed order', async () => {
    const replica = await open('a')
    await expect(
      sync(replica, {
        exchange: async () => ({ operations: [committed('b', 1, 2, created('t'))], rejected: [] }),
      }),
    ).rejects.toThrow('Invalid committed order')
    expect(cursor(replica)).toBe(0)
  })

  it('refuses a rejection it did not send', async () => {
    const replica = await open('a')
    await submit(replica, created('t'))

    await expect(
      sync(replica, { exchange: async () => ({ operations: [], rejected: ['other:1'] }) }),
    ).rejects.toThrow('Server rejected an operation that was not sent')
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1'])
  })

  it('persists the outbox across reopen and projects it optimistically', async () => {
    const storage = memoryStorage()
    const first = await open('a', storage)
    await submit(first, created('t', 'offline'))
    await close(first)

    const reopened = await open('a', storage)
    expect(pending(reopened).map(op => op.opId)).toEqual(['a:1'])
    expect(shared(reopened).todos).toEqual([{ id: 't', title: 'offline' }])
  })

  it('refuses storage written for another replica', async () => {
    const storage = memoryStorage()
    await open('a', storage)
    await expect(open('b', storage)).rejects.toThrow('different document or replica')
  })

  it('refuses an outbox the replica could not have produced', async () => {
    const replicaId = 'a'
    const storage = memoryStorage({
      protocolVersion: 1,
      schemaVersion: 1,
      documentId: 'todos',
      replicaId,
      revision: 1,
      nextLocalSequence: 1,
      cursor: 0,
      committed: { todos: [] },
      committedIds: [],
      pending: [operation(replicaId, 1, created('t'))],
    })

    await expect(open(replicaId, storage)).rejects.toThrow('Invalid outbox')
  })

  it('refuses work after close and tolerates a second close', async () => {
    const replica = await open('a')
    await close(replica)
    await close(replica)

    await expect(submit(replica, created('t'))).rejects.toThrow('Replica is closed')
  })

  it('refuses a submit that was queued when the replica closed', async () => {
    const reached = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    let saves = 0
    const storage = memoryStorage()
    const replica = await open('a', {
      ...storage,
      save: (state, revision) =>
        Effect.gen(function* () {
          saves += 1
          if (saves === 2) {
            yield* Deferred.succeed(reached, undefined)
            yield* Deferred.await(release)
          }
          yield* storage.save(state, revision)
        }),
    })

    // The first submit holds the state lock inside its save; the second queues
    // behind it, then sees the close when it finally acquires the lock.
    const first = submit(replica, created('first'))
    await Effect.runPromise(Deferred.await(reached))
    const queued = submit(replica, created('second'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await close(replica)
    Effect.runSync(Deferred.succeed(release, undefined))
    await first
    await expect(queued).rejects.toThrow('Replica is closed')
  })

  it('bounds the retained committed-id set while applying every commit', async () => {
    const storage = memoryStorage()
    const replica = await open('a', storage)
    const operations = Array.from({ length: 1100 }, (_, index) =>
      committed('seed', index + 1, index + 1, created(`t${index}`)),
    )

    await sync(replica, { exchange: async () => ({ operations, rejected: [] }) })

    // Every commit applied, but the persisted id set did not grow with the log.
    expect(cursor(replica)).toBe(1100)
    const saved = (await Effect.runPromise(storage.load())) as ReplicaState<Shared>
    expect(saved.committedIds.length).toBeLessThan(1100)
  })

  it('reports a refusal without exposing internals', async () => {
    const replica = await open('a')
    await submit(replica, created('t'))

    expect((await status(replica)).rejected).toEqual([])

    await sync(replica, { exchange: async () => ({ operations: [], rejected: ['a:1'] }) })

    expect(await status(replica)).toEqual({
      pending: 0,
      cursor: 0,
      lastError: undefined,
      rejected: ['a:1'],
    })
  })

  it('records the last exchange failure and clears it after a success', async () => {
    const replica = await open('a')

    await expect(
      sync(replica, {
        exchange: async () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow('offline')
    expect((await status(replica)).lastError).toBe('offline')

    await sync(replica, { exchange: async () => ({ operations: [], rejected: [] }) })
    expect((await status(replica)).lastError).toBeUndefined()
  })

  it('reports an unsupported newer version without overwriting the stored state', async () => {
    const saved = {
      protocolVersion: 1,
      schemaVersion: 2,
      documentId: 'todos',
      replicaId: 'a',
      revision: 0,
      nextLocalSequence: 1,
      cursor: 0,
      committed: { todos: [] },
      committedIds: [],
      pending: [],
    }
    const storage = memoryStorage(saved)

    const result = await Effect.runPromise(Effect.result(Sync.openReplica(replicaId('a'), storage)))

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'UnsupportedReplicaVersionError', protocolVersion: 1, schemaVersion: 2 },
    })
    expect(await Effect.runPromise(storage.load())).toEqual(saved)
  })

  it('opens a checked-in state persisted by a previous release with its outbox intact', async () => {
    const state = JSON.parse(
      readFileSync(new URL('./fixtures/previousReplicaState.json', import.meta.url), 'utf8'),
    )
    const replica = await open('a', memoryStorage(state))

    expect(pending(replica).map(op => op.opId)).toEqual(['a:1', 'a:2'])
    expect(shared(replica).todos.map(todo => todo.id)).toEqual(['milk', 'bread'])

    // A new edit continues the stored outbox instead of colliding with it.
    await submit(replica, created('eggs'))
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1', 'a:2', 'a:3'])
    await close(replica)
  })
})
