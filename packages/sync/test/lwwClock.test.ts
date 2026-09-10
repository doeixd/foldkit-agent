import { describe, expect, it } from 'vitest'
import { openLwwClock, type LwwClockState, type Storage } from '../src/index.js'

const initial: LwwClockState = {
  schemaVersion: 1,
  documentId: 'todos',
  replicaId: 'a',
  revision: 0,
}
const memory = (saved: unknown = undefined) => {
  let state = saved
  let closes = 0
  const storage: Storage<LwwClockState> = {
    load: async () => structuredClone(state),
    save: async (next, expectedRevision) => {
      const revision = (state as LwwClockState | undefined)?.revision ?? null
      if (revision !== expectedRevision) throw new Error('Stale writer')
      state = structuredClone(next)
    },
    close: () => {
      closes++
    },
  }
  return { storage, closes: () => closes }
}
const open = (storage: Storage<LwwClockState>) =>
  openLwwClock({ documentId: 'todos', replicaId: 'a', storage })
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

describe('a durable LWW clock', () => {
  it('persists before issuing a stamp and serializes overlapping allocations', async () => {
    const saved = memory(initial)
    const entered = gate()
    const blocked = gate()
    const clock = await open({
      ...saved.storage,
      save: async (next, revision) => {
        if (next.revision === 1) {
          entered.release()
          await blocked.promise
        }
        await saved.storage.save(next, revision)
      },
    })
    const issued: number[] = []
    const first = clock.next().then(stamp => {
      issued.push(stamp.counter)
      return stamp
    })
    const second = clock.next(7).then(stamp => {
      issued.push(stamp.counter)
      return stamp
    })
    await entered.promise
    expect(issued).toEqual([])
    expect(await saved.storage.load()).toEqual(initial)
    blocked.release()
    expect(await Promise.all([first, second])).toEqual([
      { counter: 1, replicaId: 'a' },
      { counter: 8, replicaId: 'a' },
    ])
    expect(await saved.storage.load()).toEqual({ ...initial, revision: 8 })
    await clock.close()
  })

  it('retains issued and observed counters across reload even without a submitted operation', async () => {
    const saved = memory()
    let clock = await open(saved.storage)
    expect(await clock.next(40)).toEqual({ counter: 41, replicaId: 'a' })
    await clock.close()
    clock = await open(saved.storage)
    expect(await clock.next(2)).toEqual({ counter: 42, replicaId: 'a' })
    await clock.close()
  })

  it('rejects a stale writer without returning a duplicate stamp', async () => {
    const saved = memory(initial)
    const first = await open(saved.storage)
    const second = await open(saved.storage)
    expect(await first.next()).toEqual({ counter: 1, replicaId: 'a' })
    await expect(second.next()).rejects.toThrow('Stale writer')
    await first.close()
    await second.close()
  })

  it('does not issue a stamp on save failure and permits a later allocation', async () => {
    const saved = memory(initial)
    let fail = true
    const clock = await open({
      ...saved.storage,
      save: async (next, revision) => {
        if (fail) {
          fail = false
          throw new Error('Disk full')
        }
        await saved.storage.save(next, revision)
      },
    })
    await expect(clock.next(10)).rejects.toThrow('Disk full')
    expect(await saved.storage.load()).toEqual(initial)
    expect(await clock.next()).toEqual({ counter: 1, replicaId: 'a' })
    await clock.close()
  })

  it('drains accepted work once on close and refuses allocations after close starts', async () => {
    const saved = memory(initial)
    const entered = gate()
    const blocked = gate()
    const clock = await open({
      ...saved.storage,
      save: async (next, revision) => {
        entered.release()
        await blocked.promise
        await saved.storage.save(next, revision)
      },
    })
    const allocation = clock.next()
    await entered.promise
    const closing = clock.close()
    expect(clock.close()).toBe(closing)
    expect(saved.closes()).toBe(0)
    await expect(clock.next()).rejects.toThrow('Clock is closed')
    blocked.release()
    expect(await allocation).toEqual({ counter: 1, replicaId: 'a' })
    await closing
    expect(saved.closes()).toBe(1)
  })

  it('does not reuse a timestamp when a save commits but its acknowledgement fails', async () => {
    const saved = memory(initial)
    const clock = await open({
      ...saved.storage,
      save: async (next, revision) => {
        await saved.storage.save(next, revision)
        throw new Error('Lost acknowledgement')
      },
    })
    await expect(clock.next()).rejects.toThrow('Lost acknowledgement')
    await expect(clock.next()).rejects.toThrow('Stale writer')
    await clock.close()
    const reopened = await open(saved.storage)
    expect(await reopened.next()).toEqual({ counter: 2, replicaId: 'a' })
    await reopened.close()
  })

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an invalid observed counter: %s', async (_, counter) => {
    const saved = memory(initial)
    const clock = await open(saved.storage)
    await expect(clock.next(counter)).rejects.toThrow()
    expect(await saved.storage.load()).toEqual(initial)
    await clock.close()
  })

  it('refuses counter exhaustion without corrupting the last valid state', async () => {
    const saved = memory(initial)
    const clock = await open(saved.storage)
    const counter = Number.MAX_SAFE_INTEGER
    expect(await clock.next(counter - 1)).toEqual({ counter, replicaId: 'a' })
    await expect(clock.next()).rejects.toThrow()
    expect(await saved.storage.load()).toEqual({ ...initial, revision: counter })
    await clock.close()
  })

  it.each([
    ['document', { ...initial, documentId: 'other' }],
    ['replica', { ...initial, replicaId: 'b' }],
    ['version', { ...initial, schemaVersion: 2 }],
    ['counter', { ...initial, revision: 0.5 }],
    ['extra field', { ...initial, extra: true }],
  ])('closes storage when saved state has invalid %s', async (_, state) => {
    const saved = memory(state)
    await expect(open(saved.storage)).rejects.toThrow()
    expect(saved.closes()).toBe(1)
  })

  it('closes storage when initialization cannot persist its identity', async () => {
    const saved = memory()
    await expect(
      open({
        ...saved.storage,
        save: async () => {
          throw new Error('Disk full')
        },
      }),
    ).rejects.toThrow('Disk full')
    expect(saved.closes()).toBe(1)
  })
})
