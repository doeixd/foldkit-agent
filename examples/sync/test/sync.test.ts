import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Message, replay, update } from '../src/app.js'
import { indexedDb, type Storage } from '../src/indexedDb.js'
import { openJournal } from '../src/journal.js'
import { openReplica, type Replica } from '../src/replica.js'
import type { Exchange, Operation } from '../src/protocol.js'

const principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const created = (id: string, title = id) => Message.CreatedTodo({ id, title })
const operation = (
  replicaId: string,
  localSequence: number,
  message = created(replicaId),
): Operation => ({
  protocolVersion: 1,
  schemaVersion: 1,
  documentId: 'todos',
  replicaId,
  localSequence,
  opId: `${replicaId}:${localSequence}`,
  baseCursor: 0,
  message,
})
let factory: IDBFactory
let server: ReturnType<typeof openJournal>
let replicas: Replica[]
const open = async (id: string, storage?: Storage): Promise<Replica> => {
  const replica = await openReplica('todos', id, storage ?? (await indexedDb(id, factory)))
  replicas.push(replica)
  return replica
}
beforeEach(() => {
  factory = new IDBFactory()
  server = openJournal(':memory:')
  replicas = []
})
afterEach(async () => {
  await Promise.all(replicas.map(replica => replica.close()))
  server.close()
})

describe('the journal', () => {
  it('atomically persists ordering, idempotency, and its snapshot across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-journal-'))
    const path = join(directory, 'journal.sqlite')
    const journal = openJournal(path)
    try {
      const first = journal.append(operation('a', 1), principal)
      expect(journal.append(operation('a', 1), principal)).toEqual(first)
      expect(
        journal.append(
          {
            ...Object.fromEntries(Object.entries(operation('a', 1)).reverse()),
            message: { title: 'a', id: 'a', _tag: 'CreatedTodo' },
          },
          principal,
        ),
      ).toEqual(first)
      journal.append(operation('b', 1), principal)
    } finally {
      journal.close()
    }
    const reopened = openJournal(path)
    try {
      expect(reopened.read('todos', 1).map(op => op.opId)).toEqual(['b:1'])
      expect(reopened.snapshot('todos')).toEqual({
        cursor: 2,
        model: {
          todos: [
            { id: 'a', title: 'a' },
            { id: 'b', title: 'b' },
          ],
        },
      })
      expect(reopened.append(operation('a', 1), principal).serverSequence).toBe(1)
      expect(reopened.snapshot('other').cursor).toBe(0)
    } finally {
      reopened.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects reuse of an operation identity with different data or actor', () => {
    server.append(operation('a', 1), principal)
    expect(() => server.append(operation('a', 1, created('a', 'different')), principal)).toThrow(
      'identity conflict',
    )
    expect(() => server.append(operation('a', 1), { ...principal, actorId: 'another' })).toThrow(
      'identity conflict',
    )
    expect(server.snapshot('todos')).toEqual({
      cursor: 1,
      model: { todos: [{ id: 'a', title: 'a' }] },
    })
  })

  it.each([
    ['schema version', { ...operation('a', 1), schemaVersion: 2 }],
    ['protocol version', { ...operation('a', 1), protocolVersion: 2 }],
    ['forged actor', { ...operation('a', 1), actorId: 'admin' }],
    ['document', { ...operation('a', 1), documentId: 'other' }],
    ['identity', { ...operation('a', 1), opId: 'b:9' }],
    ['payload', { ...operation('a', 1), message: { _tag: 'CreatedTodo', id: 'a', title: 42 } }],
    ['local Message', { ...operation('a', 1), message: Message.SelectedTodo({ id: 'a' }) }],
    ['future cursor', { ...operation('a', 1), baseCursor: 1 }],
  ])('refuses invalid %s before committing', (_, input) => {
    expect(() => server.append(input, principal)).toThrow()
    expect(server.snapshot('todos').cursor).toBe(0)
    expect(server.read('todos', 0)).toEqual([])
  })

  it('refuses unauthorized writes and unauthenticated reads', async () => {
    expect(() => server.append(operation('a', 1), { ...principal, canWrite: false })).toThrow(
      'Unauthorized',
    )
    await expect(server.transport({ ...principal, actorId: '' }).exchange(0, [])).rejects.toThrow(
      'Unauthenticated',
    )
    expect(server.snapshot('todos').cursor).toBe(0)
  })
})

describe('local durability and reconciliation', () => {
  it('restores the offline outbox and sequence without persisting local Model fields', async () => {
    const a = await open('a')
    await a.submit(created('first'))
    await a.close()
    const restored = await open('a')
    expect(restored.shared().todos).toEqual([{ id: 'first', title: 'first' }])
    await restored.submit(created('second'))
    expect(restored.pending().map(op => op.opId)).toEqual(['a:1', 'a:2'])
    const store = await indexedDb('a', factory)
    const saved = await store.load()
    store.close()
    expect(saved).toMatchObject({ protocolVersion: 1, schemaVersion: 1, nextLocalSequence: 3 })
    expect(JSON.stringify(saved)).not.toMatch(/selectedTodoId|lastError/)
  })

  it('publishes nothing on failed persistence and can retry without losing its sequence', async () => {
    const store = await indexedDb('a', factory)
    let fail = false
    const a = await open('a', {
      ...store,
      save: (state, revision) => {
        if (fail) return Promise.reject(new Error('disk full'))
        return store.save(state, revision)
      },
    })
    fail = true
    await expect(a.submit(created('a'))).rejects.toThrow('disk full')
    expect(a.shared()).toEqual({ todos: [] })
    expect(a.pending()).toEqual([])
    fail = false
    await a.submit(created('a'))
    expect(a.pending().map(op => op.opId)).toEqual(['a:1'])
  })

  it('prevents simultaneous handles from overwriting one replica identity', async () => {
    const first = await open('a')
    const second = await open('a')
    await first.submit(created('first'))
    await expect(second.submit(created('second'))).rejects.toThrow('another writer')
    expect(second.shared()).toEqual({ todos: [] })
    const restored = await open('a')
    expect(restored.pending().map(op => op.message)).toEqual([created('first')])
  })

  it('converges conflicting offline renames by authoritative order and clears acknowledgements', async () => {
    server.append(operation('seed', 1, created('todo')), principal)
    const a = await open('a')
    const b = await open('b')
    const transport = server.transport(principal)
    await Promise.all([a.synchronize(transport), b.synchronize(transport)])
    await a.submit(Message.RenamedTodo({ id: 'todo', title: 'Alice' }))
    await b.submit(Message.RenamedTodo({ id: 'todo', title: 'Bob' }))
    await b.synchronize(transport)
    await a.synchronize(transport)
    await b.synchronize(transport)
    expect(a.shared()).toEqual({ todos: [{ id: 'todo', title: 'Alice' }] })
    expect(b.shared()).toEqual(a.shared())
    expect(server.snapshot('todos').model).toEqual(a.shared())
    expect([a.cursor(), b.cursor()]).toEqual([3, 3])
    expect([a.pending(), b.pending()]).toEqual([[], []])
  })

  it('resends after a lost acknowledgement without duplicating a commit', async () => {
    const a = await open('a')
    await a.submit(created('todo'))
    await expect(
      a.synchronize({
        exchange: async (cursor, pending) => {
          await server.transport(principal).exchange(cursor, pending)
          throw new Error('connection lost')
        },
      }),
    ).rejects.toThrow('connection lost')
    expect(a.pending()).toHaveLength(1)
    await a.synchronize(server.transport(principal))
    expect(server.read('todos', 0).map(op => op.opId)).toEqual(['a:1'])
    expect(a.pending()).toEqual([])
  })

  it('keeps edits made during a pull and rebases them onto remote changes', async () => {
    const a = await open('a')
    let release!: (value: Exchange) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => {
      started = resolve
    })
    const response = new Promise<Exchange>(resolve => {
      release = resolve
    })
    const running = a.synchronize({
      exchange: () => {
        started()
        return response
      },
    })
    await ready
    await a.submit(created('local'))
    const remote = server.append(operation('remote', 1), principal)
    release({ operations: [remote], rejected: [] })
    await running
    expect(a.shared().todos.map(todo => todo.id)).toEqual(['remote', 'local'])
    expect(a.pending().map(op => op.opId)).toEqual(['a:1'])
  })

  it('removes a refused optimistic operation without committing it', async () => {
    const a = await open('a')
    await a.submit(created('a'))
    await a.synchronize(server.transport({ ...principal, canWrite: false }))
    expect(a.pending()).toEqual([])
    expect(a.shared()).toEqual({ todos: [] })
    expect(server.snapshot('todos').cursor).toBe(0)
  })

  it('refuses a gap in committed history atomically', async () => {
    const a = await open('a')
    const first = server.append(operation('a', 1), principal)
    await expect(
      a.synchronize({
        exchange: async () => ({ operations: [{ ...first, serverSequence: 2 }], rejected: [] }),
      }),
    ).rejects.toThrow('committed order')
    expect(a.cursor()).toBe(0)
    expect(a.shared()).toEqual({ todos: [] })
  })

  it('ignores retransmitted committed operations and refuses work after close', async () => {
    const a = await open('a')
    const committed = server.append(operation('a', 1), principal)
    const transport = { exchange: async () => ({ operations: [committed], rejected: [] }) }
    await a.synchronize(transport)
    await a.synchronize(transport)
    expect(a.cursor()).toBe(1)
    expect(a.shared().todos).toEqual([{ id: 'a', title: 'a' }])
    await a.close()
    await a.close()
    await expect(a.submit(created('b'))).rejects.toThrow('closed')
  })

  it.each([
    [
      'zero sequence',
      {
        operations: [{ ...operation('remote', 1), serverSequence: 0, actorId: 'owner' }],
        rejected: [],
      },
    ],
    ['foreign rejection', { operations: [], rejected: ['other:1'] }],
    ['malformed rejection', { operations: [], rejected: 'a:1' }],
  ])('refuses a response with %s without changing durable state', async (_, response) => {
    const a = await open('a')
    await a.submit(created('local'))
    await expect(a.synchronize({ exchange: async () => response })).rejects.toThrow()
    expect(a.cursor()).toBe(0)
    expect(a.shared().todos).toEqual([{ id: 'local', title: 'local' }])
    expect(a.pending().map(op => op.opId)).toEqual(['a:1'])
  })
})

describe('replay safety', () => {
  it('refuses Commands without executing them', () => {
    let ran = false
    expect(() =>
      replay({ todos: [] }, created('a'), (model, message) => ({
        ...update(model, message),
        commands: [
          {
            name: 'ExternalEffect',
            effect: Effect.sync(() => {
              ran = true
              return message
            }),
          },
        ],
      })),
    ).toThrow('must not produce Commands')
    expect(ran).toBe(false)
  })

  it('refuses durable updates that modify local Model fields', () => {
    expect(() =>
      replay({ todos: [] }, created('a'), (model, message) => ({
        model: { ...update(model, message).model, selectedTodoId: 'a' },
      })),
    ).toThrow('local Model fields')
  })
})
