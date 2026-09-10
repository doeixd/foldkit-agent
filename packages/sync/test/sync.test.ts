import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  defineSync,
  type Committed,
  type Operation,
  type ReplicaState,
  type Storage,
  type SyncDefinition,
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
  documentId: 'todos',
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

const operation = (replicaId: string, localSequence: number, message: Message): Operation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: 'todos',
  replicaId,
  localSequence,
  opId: `${replicaId}:${localSequence}`,
  baseCursor: 0,
  message,
})

const committed = (
  replicaId: string,
  localSequence: number,
  serverSequence: number,
  message: Message,
): Committed => ({
  ...operation(replicaId, localSequence, message),
  serverSequence,
  actorId: 'owner',
})

const memoryStorage = (initial?: unknown): Storage<ReplicaState<Shared>> => {
  let state = initial
  return {
    load: async () => state,
    save: async next => {
      state = structuredClone(next)
    },
    close: () => {},
  }
}

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
    expect(() => Sync.operationFrom(foreign, 'todos')).toThrow('Wrong document')
  })

  it('refuses a committed operation without a positive server sequence', () => {
    expect(() =>
      Sync.committedFrom(
        { ...operation('a', 1, created('t')), serverSequence: 0, actorId: 'owner' },
        'todos',
      ),
    ).toThrow()
  })
})

describe('the replica', () => {
  it('projects a submit optimistically and converges on the committed order', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.submit(created('t', 'first'))

    expect(replica.shared().todos).toEqual([{ id: 't', title: 'first' }])
    expect(replica.pending().map(op => op.opId)).toEqual(['a:1'])

    await replica.synchronize({
      exchange: async () => ({
        operations: [committed('a', 1, 1, created('t', 'first'))],
        rejected: [],
      }),
    })

    expect(replica.cursor()).toBe(1)
    expect(replica.pending()).toEqual([])
  })

  it('drops a rejected operation and reverts its optimistic effect', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.submit(created('t'))

    await replica.synchronize({ exchange: async () => ({ operations: [], rejected: ['a:1'] }) })

    expect(replica.pending()).toEqual([])
    expect(replica.shared()).toEqual({ todos: [] })
  })

  it('adopts a checkpoint in place of the log', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.synchronize({
      exchange: async () => ({
        operations: [],
        rejected: [],
        checkpoint: { cursor: 2, model: { todos: [{ id: 'x', title: 'x' }] } },
      }),
    })

    expect(replica.cursor()).toBe(2)
    expect(replica.shared()).toEqual({ todos: [{ id: 'x', title: 'x' }] })
  })

  it('refuses a checkpoint older than its own cursor', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.synchronize({
      exchange: async () => ({ operations: [committed('b', 1, 1, created('t'))], rejected: [] }),
    })
    expect(replica.cursor()).toBe(1)

    await expect(
      replica.synchronize({
        exchange: async () => ({
          operations: [],
          rejected: [],
          checkpoint: { cursor: 0, model: { todos: [] } },
        }),
      }),
    ).rejects.toThrow('Checkpoint is behind the replica')
    expect(replica.cursor()).toBe(1)
  })

  it('refuses a gap in the committed order', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await expect(
      replica.synchronize({
        exchange: async () => ({ operations: [committed('b', 1, 2, created('t'))], rejected: [] }),
      }),
    ).rejects.toThrow('Invalid committed order')
    expect(replica.cursor()).toBe(0)
  })

  it('refuses a rejection it did not send', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.submit(created('t'))

    await expect(
      replica.synchronize({ exchange: async () => ({ operations: [], rejected: ['other:1'] }) }),
    ).rejects.toThrow('Server rejected an operation that was not sent')
    expect(replica.pending().map(op => op.opId)).toEqual(['a:1'])
  })

  it('persists the outbox across reopen and projects it optimistically', async () => {
    const storage = memoryStorage()
    const first = await Sync.openReplica('a', storage)
    await first.submit(created('t', 'offline'))
    await first.close()

    const reopened = await Sync.openReplica('a', storage)
    expect(reopened.pending().map(op => op.opId)).toEqual(['a:1'])
    expect(reopened.shared().todos).toEqual([{ id: 't', title: 'offline' }])
  })

  it('refuses storage written for another replica', async () => {
    const storage = memoryStorage()
    await Sync.openReplica('a', storage)
    await expect(Sync.openReplica('b', storage)).rejects.toThrow('Wrong replica storage')
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

    await expect(Sync.openReplica(replicaId, storage)).rejects.toThrow('Invalid outbox')
  })

  it('refuses work after close and tolerates a second close', async () => {
    const replica = await Sync.openReplica('a', memoryStorage())
    await replica.close()
    await replica.close()

    await expect(replica.submit(created('t'))).rejects.toThrow('Replica is closed')
  })
})
