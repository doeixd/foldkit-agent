import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createJournal,
  OperationRejectedError,
  type Codec,
  type JournalOptions,
} from '../src/index.js'

interface Operation {
  readonly opId: string
  readonly kind: 'add' | 'remove'
  readonly id: string
}

interface Snapshot {
  readonly ids: ReadonlyArray<string>
}

interface Principal {
  readonly actorId: string
  readonly canWrite: boolean
}

const operation: Codec<Operation> = {
  encode: value => value,
  decode: value => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid operation')
    const { opId, kind, id } = value as Record<string, unknown>
    if (typeof opId !== 'string' || (kind !== 'add' && kind !== 'remove') || typeof id !== 'string')
      throw new Error('invalid operation')
    return { opId, kind, id }
  },
}

const snapshot: Codec<Snapshot> = {
  encode: value => value,
  decode: value => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid snapshot')
    const ids = (value as { ids?: unknown }).ids
    if (!Array.isArray(ids)) throw new Error('invalid snapshot')
    return { ids: ids.map(String) }
  },
}

const add = (sequence: number, id = String(sequence)): Operation => ({
  opId: `a:${sequence}`,
  kind: 'add',
  id,
})

const remove = (sequence: number, id: string): Operation => ({
  opId: `a:${sequence}`,
  kind: 'remove',
  id,
})

const reduce = (state: Snapshot, op: Operation): Snapshot =>
  op.kind === 'add'
    ? { ids: state.ids.includes(op.id) ? state.ids : [...state.ids, op.id] }
    : { ids: state.ids.filter(id => id !== op.id) }

const principal: Principal = { actorId: 'owner', canWrite: true }

type Hooks = Pick<JournalOptions<Operation, Snapshot, Principal>, 'validate' | 'authorize'>

const open = (hooks: Hooks = {}, file = ':memory:') =>
  createJournal<Operation, Snapshot, Principal>({
    file,
    operation,
    snapshot,
    empty: () => ({ ids: [] }),
    reduce,
    opId: value => value.opId,
    actorId: value => value.actorId,
    ...hooks,
  })

describe('a durable journal', () => {
  it('orders appends and reads them after a cursor', () => {
    const journal = open()
    try {
      journal.append('todos', add(1, 'a'), principal)
      journal.append('todos', add(2, 'b'), principal)

      expect(
        journal.read('todos', 0).map(committed => [committed.operation.opId, committed.sequence]),
      ).toEqual([
        ['a:1', 1],
        ['a:2', 2],
      ])
      expect(journal.read('todos', 1).map(committed => committed.operation.opId)).toEqual(['a:2'])
      expect(journal.load('todos')).toEqual({ snapshot: { ids: ['a', 'b'] }, cursor: 2 })
    } finally {
      journal.close()
    }
  })

  it('keeps keys independent', () => {
    const journal = open()
    try {
      journal.append('a', add(1, 'a'), principal)
      journal.append('b', add(1, 'b'), principal)

      expect(journal.load('a').snapshot).toEqual({ ids: ['a'] })
      expect(journal.load('b').snapshot).toEqual({ ids: ['b'] })
    } finally {
      journal.close()
    }
  })

  it('treats an unknown key as empty and reads nothing at the cursor', () => {
    const journal = open()
    try {
      const first = journal.load('missing')
      const second = journal.load('missing')
      expect(first).toEqual({ snapshot: { ids: [] }, cursor: 0 })
      // `empty` runs per read, so callers cannot mutate a shared default.
      expect(first.snapshot).not.toBe(second.snapshot)

      journal.append('todos', add(1, 'a'), principal)
      expect(journal.read('todos', 1)).toEqual([])
    } finally {
      journal.close()
    }
  })

  it('is idempotent by operation identity and rejects a conflicting reuse', () => {
    const journal = open()
    try {
      journal.append('todos', add(1, 'a'), principal)
      expect(journal.append('todos', add(1, 'a'), principal).sequence).toBe(1)
      expect(journal.load('todos')).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })

      expect(() => journal.append('todos', { ...add(1), id: 'different' }, principal)).toThrow(
        'Operation identity conflict',
      )
      expect(() =>
        journal.append('todos', add(1, 'a'), { actorId: 'other', canWrite: true }),
      ).toThrow('Operation identity conflict')
      expect(journal.load('todos')).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
    } finally {
      journal.close()
    }
  })

  it('records the actor from the principal, never the operation', () => {
    const journal = open()
    try {
      const committed = journal.append('todos', add(1), { actorId: 'alice', canWrite: true })
      expect(committed.actorId).toBe('alice')
    } finally {
      journal.close()
    }
  })

  it('rejects invalid input before committing', () => {
    const journal = open()
    try {
      expect(() =>
        journal.append('todos', { opId: 'a:1', kind: 'nope', id: 'a' }, principal),
      ).toThrow('invalid operation')
      expect(journal.load('todos').cursor).toBe(0)
    } finally {
      journal.close()
    }
  })

  it('refuses through validate without committing', () => {
    const journal = open({
      validate: ({ cursor }) => {
        if (cursor > 0) throw new Error('must be empty')
      },
    })
    try {
      journal.append('todos', add(1), principal)
      expect(() => journal.append('todos', add(2), principal)).toThrow('must be empty')
      expect(journal.load('todos')).toEqual({ snapshot: { ids: ['1'] }, cursor: 1 })
    } finally {
      journal.close()
    }
  })

  it('refuses through authorize and consumes no operation identity', () => {
    const journal = open({ authorize: ({ operation }) => operation.kind === 'add' })
    try {
      journal.append('todos', add(1, 'a'), principal)
      expect(() => journal.append('todos', remove(2, 'a'), principal)).toThrow(
        OperationRejectedError,
      )
      expect(journal.load('todos').cursor).toBe(1)

      // The refused identity is reusable.
      journal.append('todos', add(2, 'b'), principal)
      expect(journal.load('todos')).toEqual({ snapshot: { ids: ['a', 'b'] }, cursor: 2 })
    } finally {
      journal.close()
    }
  })

  it('compacts payloads while keeping identity and the snapshot', () => {
    const journal = open()
    try {
      journal.append('todos', add(1, 'a'), principal)
      journal.append('todos', add(2, 'b'), principal)
      journal.append('todos', add(3, 'c'), principal)
      const before = journal.load('todos')
      expect(journal.floor('todos')).toBe(0)

      journal.compact('todos', 2)
      expect(journal.floor('todos')).toBe(2)
      expect(journal.read('todos', 0).map(committed => committed.operation.opId)).toEqual(['a:3'])
      expect(journal.load('todos')).toEqual(before)

      // A retransmission of a compacted operation is still idempotent.
      expect(journal.append('todos', add(1, 'a'), principal).sequence).toBe(1)
      expect(journal.load('todos')).toEqual(before)
    } finally {
      journal.close()
    }
  })

  it('refuses a compaction cursor that moves backwards or past the snapshot', () => {
    const journal = open()
    try {
      journal.append('todos', add(1), principal)
      expect(() => journal.compact('todos', 2)).toThrow('Invalid compaction cursor')
      journal.compact('todos', 1)
      expect(() => journal.compact('todos', 0)).toThrow('Invalid compaction cursor')
    } finally {
      journal.close()
    }
  })

  it('notifies subscribers after a commit and stops after unsubscribe', () => {
    const journal = open()
    try {
      const seen: string[] = []
      const unsubscribe = journal.subscribe(key => {
        seen.push(key)
      })

      journal.append('todos', add(1), principal)
      expect(seen).toEqual(['todos'])

      unsubscribe()
      journal.append('todos', add(2), principal)
      expect(seen).toEqual(['todos'])
    } finally {
      journal.close()
    }
  })

  it('keeps committing when a subscriber throws', () => {
    const journal = open()
    try {
      journal.subscribe(() => {
        throw new Error('subscriber failed')
      })

      expect(() => journal.append('todos', add(1), principal)).not.toThrow()
      expect(journal.load('todos').cursor).toBe(1)
    } finally {
      journal.close()
    }
  })
})

describe('the effect ledger', () => {
  it('runs an effect once per key and returns the recorded result', async () => {
    const journal = open()
    try {
      let runs = 0
      const first = await journal.runEffect('a:1/command/0', async () => {
        runs += 1
        return { sent: true }
      })
      expect(first).toEqual({ sent: true })

      const second = await journal.runEffect('a:1/command/0', async () => {
        runs += 1
        return { sent: false }
      })
      expect(second).toEqual({ sent: true })
      expect(runs).toBe(1)
      expect(journal.effect('a:1/command/0')).toEqual({
        key: 'a:1/command/0',
        status: 'succeeded',
        result: { sent: true },
      })
    } finally {
      journal.close()
    }
  })

  it('shares one run between concurrent calls', async () => {
    const journal = open()
    try {
      let runs = 0
      const [a, b] = await Promise.all([
        journal.runEffect('k', async () => {
          runs += 1
          return 1
        }),
        journal.runEffect('k', async () => {
          runs += 1
          return 2
        }),
      ])
      expect(runs).toBe(1)
      expect([a, b]).toEqual([1, 1])
    } finally {
      journal.close()
    }
  })

  it('records a failure and allows a retry', async () => {
    const journal = open()
    try {
      await expect(
        journal.runEffect('k', async () => {
          throw new Error('service down')
        }),
      ).rejects.toThrow('service down')
      expect(journal.effect('k')).toMatchObject({ status: 'failed', error: 'service down' })

      expect(await journal.runEffect('k', async () => 'recovered')).toBe('recovered')
      expect(journal.effect('k')).toEqual({ key: 'k', status: 'succeeded', result: 'recovered' })
    } finally {
      journal.close()
    }
  })

  it('reports no record for an unrun key and keeps keys independent', async () => {
    const journal = open()
    try {
      expect(journal.effect('missing')).toBeUndefined()
      await journal.runEffect('a', async () => 'a')
      await journal.runEffect('b', async () => 'b')
      expect(journal.effect('a')).toMatchObject({ result: 'a' })
      expect(journal.effect('b')).toMatchObject({ result: 'b' })
    } finally {
      journal.close()
    }
  })

  it('shares one failure between concurrent calls', async () => {
    const journal = open()
    try {
      let runs = 0
      const failing = () =>
        journal.runEffect('k', async () => {
          runs += 1
          throw new Error('down')
        })

      const settled = await Promise.allSettled([failing(), failing()])
      expect(runs).toBe(1)
      expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected'])
      expect(journal.effect('k')).toMatchObject({ status: 'failed', error: 'down' })
    } finally {
      journal.close()
    }
  })

  it('keeps a recorded effect across a reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-effects-'))
    const path = join(directory, 'journal.sqlite')
    let runs = 0
    try {
      const first = open({}, path)
      await first.runEffect('k', async () => {
        runs += 1
        return 'recorded'
      })
      first.close()

      const reopened = open({}, path)
      try {
        const result = await reopened.runEffect('k', async () => {
          runs += 1
          return 'again'
        })
        expect(result).toBe('recorded')
        expect(runs).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
