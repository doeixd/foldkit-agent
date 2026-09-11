import { Effect } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'
import { describe, expect, it } from 'vitest'
import {
  emptyStore,
  entityKey,
  markStale,
  readField,
  writeEntity,
  type EntityStore,
} from '../src/index.js'
import { RemotePersistence } from '../src/persistence.js'

const run = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>) =>
  Effect.runPromise(Effect.provide(effect, KeyValueStore.layerMemory))

const user = entityKey('User', 'u1')

describe('RemotePersistence', () => {
  it('round-trips values, presence, and staleness', async () => {
    let store: EntityStore = writeEntity(emptyStore, user, { name: 'ada', admin: null }, 5)
    store = markStale(store, user, ['name'])

    const restored = await run(
      Effect.gen(function* () {
        yield* RemotePersistence.save(store, { key: 'cache' })
        return yield* RemotePersistence.restore({ key: 'cache' })
      }),
    )

    expect(restored).toEqual(store)
    expect(readField(restored, user, 'name')).toEqual(readField(store, user, 'name'))
  })

  it('clears and returns an empty store on a version mismatch', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set(
          'cache',
          JSON.stringify({
            version: 99,
            entities: {
              'User:u1': {
                values: { name: 'old' },
                present: ['name'],
                stale: [],
                tombstone: false,
                updatedAt: 0,
              },
            },
          }),
        )
        const restored = yield* RemotePersistence.restore({ key: 'cache' })
        const after = yield* kv.get('cache')
        return { restored, after }
      }),
    )

    expect(result.restored).toEqual(emptyStore)
    expect(result.after).toBeUndefined()
  })

  it('clears a corrupt snapshot', async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set('cache', 'not json')
        const restored = yield* RemotePersistence.restore({ key: 'cache' })
        const after = yield* kv.get('cache')
        return { restored, after }
      }),
    )

    expect(result.restored).toEqual(emptyStore)
    expect(result.after).toBeUndefined()
  })

  it('restores an empty store for a missing key', async () => {
    const restored = await run(RemotePersistence.restore({ key: 'absent' }))
    expect(restored).toEqual(emptyStore)
  })
})
