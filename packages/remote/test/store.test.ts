import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  emptyStore,
  entry,
  hasField,
  isTombstone,
  markStale,
  missingFields,
  readField,
  remove,
  tombstone,
  writeEntity,
} from '../src/index.js'

const key = 'User:u1'

describe('EntityStore', () => {
  it('distinguishes missing, present-undefined, present-null, stale, and tombstone', () => {
    let store = emptyStore
    expect(Option.isNone(entry(store, key))).toBe(true)

    store = writeEntity(store, key, { name: undefined, manager: null })
    const written = Option.getOrThrow(entry(store, key))
    expect(written.present.has('name')).toBe(true)
    expect(hasField(store, key, 'name')).toBe(true)
    expect(Option.getOrThrow(readField(store, key, 'name'))).toBeUndefined()
    expect(Option.getOrThrow(readField(store, key, 'manager'))).toBeNull()

    // Stale is still present and readable, but not "known".
    store = markStale(store, key, ['name'])
    expect(hasField(store, key, 'name')).toBe(false)
    expect(Option.getOrThrow(readField(store, key, 'name'))).toBeUndefined()

    store = tombstone(store, key)
    expect(isTombstone(store, key)).toBe(true)
    expect(hasField(store, key, 'manager')).toBe(false)
    expect(missingFields(store, key, ['name', 'manager'])).toEqual([])
  })

  it('does not infer presence from value === undefined', () => {
    const store = writeEntity(emptyStore, key, { name: 'ada' })
    expect(hasField(store, key, 'missing')).toBe(false)
    expect(missingFields(store, key, ['name', 'missing'])).toEqual(['missing'])
  })

  it('marks a field missing only for a known, different window', () => {
    const store = writeEntity(emptyStore, key, { comments: [] }, 0, { comments: 'A' })
    expect(missingFields(store, key, ['comments'], { comments: 'A' })).toEqual([])
    expect(missingFields(store, key, ['comments'], { comments: 'B' })).toEqual(['comments'])

    // A writer that records no window must not cause a refetch loop...
    const plain = writeEntity(emptyStore, key, { comments: [] })
    expect(missingFields(plain, key, ['comments'], { comments: 'B' })).toEqual([])

    // ...and a later write clears a remembered window.
    const rewritten = writeEntity(store, key, { comments: [] })
    expect(missingFields(rewritten, key, ['comments'], { comments: 'B' })).toEqual([])
  })

  it('clears a tombstone when a later write arrives', () => {
    let store = tombstone(emptyStore, key)
    expect(isTombstone(store, key)).toBe(true)

    store = writeEntity(store, key, { name: 'ada' })
    expect(isTombstone(store, key)).toBe(false)
    expect(readField(store, key, 'name')).toEqual(Option.some('ada'))
  })

  it('remove forgets everything known', () => {
    const store = remove(writeEntity(emptyStore, key, { name: 'ada' }), key)
    expect(Option.isNone(entry(store, key))).toBe(true)
    expect(missingFields(store, key, ['name'])).toEqual(['name'])
  })

  it('markStale only affects present fields', () => {
    const store = markStale(writeEntity(emptyStore, key, { name: 'ada' }), key, ['name', 'absent'])
    const marked = Option.getOrThrow(entry(store, key))
    expect(marked.stale.has('name')).toBe(true)
    expect(marked.stale.has('absent')).toBe(false)
  })

  it('marks stale fields as missing for the planner but keeps their value', () => {
    const store = markStale(writeEntity(emptyStore, key, { name: 'ada' }), key, ['name'])
    expect(missingFields(store, key, ['name'])).toEqual(['name'])
    expect(readField(store, key, 'name')).toEqual(Option.some('ada'))
  })

  it('markStale is a no-op for an absent entity or a tombstone', () => {
    expect(markStale(emptyStore, key, ['name'])).toBe(emptyStore)
    const gone = tombstone(emptyStore, key)
    expect(markStale(gone, key, ['name'])).toEqual(gone)
  })

  it('remove of an absent key returns the same store', () => {
    expect(remove(emptyStore, key)).toBe(emptyStore)
  })

  it('writeEntity merges a partial patch and bumps updatedAt', () => {
    const store = writeEntity(emptyStore, key, { name: 'ada', email: 'a@b.c' }, 1)
    const patched = writeEntity(store, key, { name: 'grace' }, 2)

    expect(entry(patched, key)).toEqual(
      Option.some({
        values: { name: 'grace', email: 'a@b.c' },
        present: new Set(['name', 'email']),
        stale: new Set(),
        tombstone: false,
        updatedAt: 2,
        windows: {},
      }),
    )
  })

  it('a tombstone discards values and presence', () => {
    const store = tombstone(writeEntity(emptyStore, key, { name: 'ada' }, 5), key)

    expect(entry(store, key)).toEqual(
      Option.some({
        values: {},
        present: new Set(),
        stale: new Set(),
        tombstone: true,
        updatedAt: 0,
        windows: {},
      }),
    )
    expect(readField(store, key, 'name')).toEqual(Option.none())
  })
})
