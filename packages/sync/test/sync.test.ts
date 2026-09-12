import { readFileSync } from 'node:fs'
import { Deferred, Effect, Fiber, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  defineSync,
  documentId,
  layerFromPromise,
  localSequence as toLocalSequence,
  opId,
  replicaId,
  sequence as toSequence,
  StorageError,
  type Committed,
  type Exchange,
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

const replayCalls = { count: 0 }
const CountingSync = defineSync({
  ...definition,
  replay: (shared, message) => {
    replayCalls.count += 1
    return definition.replay(shared, message)
  },
})

const created = (id: string, title = id): Message => ({ _tag: 'CreatedTodo', id, title })

const operation = (replica: string, local: number, message: Message): Operation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: documentId('todos'),
  replicaId: replicaId(replica),
  localSequence: toLocalSequence(local),
  opId: opId(`${replica}:${local}`),
  baseCursor: toSequence(0),
  message,
})

const committed = (
  replica: string,
  localSequence: number,
  serverSequence: number,
  message: Message,
): Committed => ({
  ...operation(replica, localSequence, message),
  serverSequence: toSequence(serverSequence),
  actorId: 'owner',
})

const memoryStorage = (initial?: unknown): Storage => {
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
    // A 1-based local sequence is refused by the codec before the identity check.
    expect(() => Sync.normalizeOperation({ ...valid, localSequence: 0 })).toThrow()
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

  it('reflects a write that happens after a shared read', async () => {
    const replica = await open('a')
    expect(shared(replica)).toEqual({ todos: [] })

    await submit(replica, created('t', 'first'))
    expect(shared(replica).todos).toEqual([{ id: 't', title: 'first' }])

    await sync(replica, { exchange: async () => ({ operations: [], rejected: ['a:1'] }) })
    expect(shared(replica)).toEqual({ todos: [] })
  })

  it('reuses the projection across reads until the state changes', async () => {
    const replica = await Effect.runPromise(
      CountingSync.openReplica(replicaId('a'), memoryStorage()),
    )
    await Effect.runPromise(replica.submit(created('t1')))

    replayCalls.count = 0
    Effect.runSync(replica.shared)
    const afterFirstRead = replayCalls.count
    expect(afterFirstRead).toBeGreaterThan(0)

    Effect.runSync(replica.shared)
    expect(replayCalls.count).toBe(afterFirstRead)

    // A write replaces the state object, so the next read must rebuild.
    await Effect.runPromise(replica.submit(created('t2')))
    Effect.runSync(replica.shared)
    expect(replayCalls.count).toBeGreaterThan(afterFirstRead)

    await Effect.runPromise(replica.close)
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

  it('recovers a long offline outbox and converges on the committed order', async () => {
    const replica = await open('a')
    const count = 500
    for (let localSequence = 1; localSequence <= count; localSequence += 1)
      await submit(replica, created(`t${localSequence}`))
    expect(pending(replica)).toHaveLength(count)

    // The server commits the whole outbox in the order it was sent.
    const operations = Array.from({ length: count }, (_, index) =>
      committed('a', index + 1, index + 1, created(`t${index + 1}`)),
    )
    await sync(replica, { exchange: async () => ({ operations, rejected: [] }) })

    expect(pending(replica)).toEqual([])
    expect(cursor(replica)).toBe(count)
    expect(shared(replica).todos).toHaveLength(count)
    await close(replica)
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

  it('closes storage when the open fails', async () => {
    let closes = 0
    const storage: Storage = {
      load: () => Effect.succeed(undefined),
      save: () => Effect.fail(new StorageError({ message: 'disk full' })),
      close: Effect.sync(() => {
        closes += 1
      }),
    }

    await expect(open('a', storage)).rejects.toThrow('disk full')
    expect(closes).toBe(1)
  })

  it('refuses an acknowledgement for an operation the request never sent', async () => {
    const replica = await open('a')
    await submit(replica, created('first'))

    let release!: (value: Exchange<Shared>) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    const response = new Promise<Exchange<Shared>>(resolve => {
      release = resolve
    })
    const running = sync(replica, {
      exchange: () => {
        started()
        return response
      },
    })
    await ready
    // A second edit lands while the first exchange is in flight.
    await submit(replica, created('second'))
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1', 'a:2'])

    // The server claims to have acknowledged a:2, which it was never sent. If
    // the replica trusted it, a:2 would vanish without ever being committed.
    release({ operations: [], acknowledged: [opId('a:1'), opId('a:2')], rejected: [] })
    await expect(running).rejects.toThrow('acknowledged an operation that was not sent')
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1', 'a:2'])
  })

  it('refuses a response that both acknowledges and rejects one operation', async () => {
    const replica = await open('a')
    await submit(replica, created('first'))

    await expect(
      sync(replica, {
        exchange: async () => ({
          operations: [],
          acknowledged: [opId('a:1')],
          rejected: [opId('a:1')],
        }),
      }),
    ).rejects.toThrow('both acknowledged and rejected')
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1'])
  })

  it.each([
    ['missing fields', {}],
    ['wrong rejected shape', { operations: [], rejected: 'a:1' }],
    [
      'invalid checkpoint cursor',
      { operations: [], rejected: [], checkpoint: { cursor: -1, model: { todos: [] } } },
    ],
    ['excess property', { operations: [], rejected: [], extra: true }],
  ])('fails a malformed exchange response as a typed error: %s', async (_, raw) => {
    const replica = await open('a')
    await submit(replica, created('local'))

    const failed = await Effect.runPromise(
      Effect.result(
        Effect.provide(replica.synchronize, layerFromPromise({ exchange: async () => raw })),
      ),
    )
    expect(failed).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidExchangeError' },
    })
    expect(cursor(replica)).toBe(0)
    expect(pending(replica).map(op => op.opId)).toEqual(['a:1'])
    expect((await status(replica)).lastError).toBe('Invalid sync exchange response')

    // A malformed response does not poison the replica: a valid one still works.
    await sync(replica, { exchange: async () => ({ operations: [], rejected: [] }) })
    expect((await status(replica)).lastError).toBeUndefined()
    await close(replica)
  })
})

describe('a transforming shared codec', () => {
  const Counter = defineSync({
    documentId: documentId('counter'),
    message: Schema.Struct({ _tag: Schema.Literal('Incremented') }),
    // Decoded `count` is a number; encoded it is a string, so a save that skips
    // encoding cannot be read back.
    shared: Schema.Struct({ count: Schema.NumberFromString }),
    empty: { count: 0 },
    durable: () => true,
    replay: shared => ({ count: shared.count + 1 }),
  })

  it('round-trips through storage and reload', async () => {
    const storage = memoryStorage()
    const first = await Effect.runPromise(Counter.openReplica(replicaId('a'), storage))
    await Effect.runPromise(
      Effect.provide(
        first.synchronize,
        layerFromPromise({
          exchange: async () => ({
            operations: [
              {
                protocolVersion: 1,
                schemaVersion: 1,
                documentId: documentId('counter'),
                replicaId: replicaId('a'),
                localSequence: 1,
                opId: opId('a:1'),
                baseCursor: 0,
                message: { _tag: 'Incremented' },
                serverSequence: 1,
                actorId: 'owner',
              },
            ],
            rejected: [],
          }),
        }),
      ),
    )
    expect(Effect.runSync(first.shared)).toEqual({ count: 1 })
    await Effect.runPromise(first.close)

    // Reopening decodes the stored encoded form; a save that wrote the decoded
    // `count` would fail here with InvalidReplicaHistoryError.
    const stored = await Effect.runPromise(storage.load())
    expect(stored).toMatchObject({ committed: { count: '1' } })

    const second = await Effect.runPromise(Counter.openReplica(replicaId('a'), storage))
    expect(Effect.runSync(second.shared)).toEqual({ count: 1 })
    await Effect.runPromise(second.close)
  })

  it('adopts a checkpoint through the encoded wire form', async () => {
    const replica = await Effect.runPromise(Counter.openReplica(replicaId('a'), memoryStorage()))
    await Effect.runPromise(
      Effect.provide(
        replica.synchronize,
        layerFromPromise({
          // The wire carries the encoded `count` (a string); the decoder turns it
          // back into the decoded number, so callers only see `Shared`.
          exchange: async () => ({
            operations: [],
            rejected: [],
            checkpoint: { cursor: 5, model: { count: '5' } },
          }),
        }),
      ),
    )

    expect(Effect.runSync(replica.cursor)).toBe(5)
    expect(Effect.runSync(replica.shared)).toEqual({ count: 5 })
    await Effect.runPromise(replica.close)
  })
})

describe('Replica.start', () => {
  it('exchanges after a submit until the fiber is interrupted', async () => {
    const replica = await open('a')
    const exchange = layerFromPromise({
      exchange: async (cursor, pending) => ({
        operations: pending.map((operation, index) => ({
          ...operation,
          serverSequence: cursor + index + 1,
          actorId: 'server',
        })),
        rejected: [],
      }),
    })

    const applied = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(replica.start)
          yield* replica.submit(created('a'))
          let current = yield* replica.cursor
          for (let attempt = 0; attempt < 200 && current === 0; attempt += 1) {
            yield* Effect.sleep('2 millis')
            current = yield* replica.cursor
          }
          yield* Fiber.interrupt(fiber)
          return current
        }).pipe(Effect.provide(exchange)),
      ),
    )

    expect(applied).toBe(1)
    expect(shared(replica)).toEqual({ todos: [{ id: 'a', title: 'a' }] })
    await close(replica)
  })
})
