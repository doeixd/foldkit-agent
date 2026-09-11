import { describe, expect, it } from 'vitest'
import {
  emptyStore,
  entityKey,
  plan,
  tombstone,
  writeEntity,
  type Requirement,
} from '../src/index.js'

describe('Remote.plan', () => {
  it('returns only missing fields, grouped and ordered', () => {
    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { name: 'ada' })
    const planned = plan(store, [
      { entity: 'User', id: 'u1', fields: ['name', 'email'] },
      { entity: 'User', id: 'u1', fields: ['email', 'avatarUrl'] },
      { entity: 'Project', id: 'p1', fields: ['title'] },
    ])

    expect(planned).toEqual([
      { entity: 'Project', id: 'p1', fields: ['title'] },
      { entity: 'User', id: 'u1', fields: ['email', 'avatarUrl'] },
    ])
  })

  it('never plans a tombstoned entity', () => {
    const store = tombstone(emptyStore, entityKey('User', 'u1'))
    expect(plan(store, [{ entity: 'User', id: 'u1', fields: ['name'] }])).toEqual([])
  })

  it('refreshes a whole entry older than the injected freshness', () => {
    const key = entityKey('User', 'u1')
    const store = writeEntity(emptyStore, key, { name: 'ada', email: 'a@b.c' }, 0)

    expect(
      plan(store, [{ entity: 'User', id: 'u1', fields: ['name', 'email'] }], {
        now: 10,
        freshness: 50,
      }),
    ).toEqual([])
    expect(
      plan(store, [{ entity: 'User', id: 'u1', fields: ['name', 'email'] }], {
        now: 100,
        freshness: 50,
      }),
    ).toEqual([{ entity: 'User', id: 'u1', fields: ['name', 'email'] }])
  })

  it('is deterministic and never plans a field it was not asked for', () => {
    const fields = ['a', 'b', 'c', 'd'] as const
    let seed = 123456789
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!

    for (let i = 0; i < 200; i++) {
      let store = emptyStore
      for (let write = 0; write < 3; write++) {
        if (random() < 0.5) {
          store = writeEntity(
            store,
            entityKey('E', pick(['1', '2', '3'])),
            { [pick(fields)]: i },
            i,
          )
        }
      }

      const requirements: Requirement[] = []
      const requested = new Map<string, Set<string>>()
      for (let r = 0; r < 3; r++) {
        const id = pick(['1', '2', '3'])
        const selected = [pick(fields), pick(fields)]
        requirements.push({ entity: 'E', id, fields: selected })
        const set = requested.get(`E:${id}`) ?? new Set<string>()
        for (const field of selected) set.add(field)
        requested.set(`E:${id}`, set)
      }

      const freshness = random() < 0.5 ? { now: i, freshness: 5 } : undefined
      const first = plan(store, requirements, freshness)
      expect(plan(store, requirements, freshness)).toEqual(first)

      for (const requirement of first) {
        const asked = requested.get(`${requirement.entity}:${requirement.id}`)
        expect(asked).toBeDefined()
        for (const field of requirement.fields) expect(asked!.has(field)).toBe(true)
      }
    }
  })
})
