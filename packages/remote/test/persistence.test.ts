import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  REMOTE_CACHE_VERSION,
  Remote,
  RemoteClient,
  Selection,
  emptyStore,
  entityKey,
  initialRemoteModel,
  isTombstone,
  markStale,
  readField,
  tombstone,
  updateRemote,
  writeEntity,
  type EntityStore,
  type RemoteModel,
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
            scope: null,
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

  it('clears a valid-JSON snapshot of the wrong shape', async () => {
    for (const bad of [
      'null',
      '[]',
      '{"version":2}',
      '{"version":3,"scope":null,"entities":null}',
    ]) {
      const result = await run(
        Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore
          yield* kv.set('cache', bad)
          return yield* RemotePersistence.restore({ key: 'cache' })
        }),
      )
      expect(result).toEqual(emptyStore)
    }
  })

  it('clears a snapshot with a malformed entry', async () => {
    const cases = [
      // `present` is a string, not a string array.
      '{"version":3,"scope":null,"entities":{"User:u1":{"values":{"name":"x"},"present":"name","stale":[],"tombstone":false,"updatedAt":0,"windows":{}}}}',
      // An entry that is not an object.
      '{"version":3,"scope":null,"entities":{"User:u1":null}}',
      // `values` is not a record.
      '{"version":3,"scope":null,"entities":{"User:u1":{"values":5,"present":[],"stale":[],"tombstone":false,"updatedAt":0,"windows":{}}}}',
      // `entities` is an array, not a record.
      '{"version":3,"scope":null,"entities":[]}',
      // `windows` is not a string record.
      '{"version":3,"scope":null,"entities":{"User:u1":{"values":{},"present":[],"stale":[],"tombstone":false,"updatedAt":0,"windows":{"x":1}}}}',
    ]

    for (const bad of cases) {
      const result = await run(
        Effect.gen(function* () {
          const kv = yield* KeyValueStore.KeyValueStore
          yield* kv.set('cache', bad)
          const restored = yield* RemotePersistence.restore({ key: 'cache' })
          const after = yield* kv.get('cache')
          return { restored, after }
        }),
      )
      expect(result.restored).toEqual(emptyStore)
      expect(result.after).toBeUndefined()
    }
  })

  it('restores an empty store for a missing key', async () => {
    const restored = await run(RemotePersistence.restore({ key: 'absent' }))
    expect(restored).toEqual(emptyStore)
  })

  it('round-trips a tombstone', async () => {
    const store = tombstone(emptyStore, user)
    const restored = await run(
      Effect.gen(function* () {
        yield* RemotePersistence.save(store, { key: 'cache' })
        return yield* RemotePersistence.restore({ key: 'cache' })
      }),
    )

    expect(restored).toEqual(store)
    expect(isTombstone(restored, user)).toBe(true)
  })

  it('round-trips a field window', async () => {
    const store = writeEntity(emptyStore, user, { comments: [] }, 0, { comments: 'W' })
    const restored = await run(
      Effect.gen(function* () {
        yield* RemotePersistence.save(store, { key: 'cache' })
        return yield* RemotePersistence.restore({ key: 'cache' })
      }),
    )

    expect(restored).toEqual(store)
  })
})

describe('snapshot hardening', () => {
  const store = writeEntity(
    writeEntity(emptyStore, entityKey('User', 'u2'), { name: 'grace', id: 'u2' }, 2),
    user,
    { id: 'u1', name: 'ada' },
    1,
  )

  it('is deterministic whatever order the store was built in', () => {
    const reversed = writeEntity(
      writeEntity(emptyStore, user, { name: 'ada', id: 'u1' }, 1),
      entityKey('User', 'u2'),
      { id: 'u2', name: 'grace' },
      2,
    )
    expect(RemotePersistence.dehydrate(store)).toBe(RemotePersistence.dehydrate(reversed))
    expect(JSON.parse(RemotePersistence.dehydrate(store)!)).toEqual({
      version: REMOTE_CACHE_VERSION,
      scope: null,
      entities: expect.any(Object),
    })
  })

  it('hydrating the same text twice gives equal stores', () => {
    const text = RemotePersistence.dehydrate(store)!
    expect(RemotePersistence.hydrate(text)).toEqual(RemotePersistence.hydrate(text))
    expect(RemotePersistence.hydrate(text)).toEqual(store)
  })

  it('a snapshot for another scope is discarded, and the key removed', async () => {
    expect(
      RemotePersistence.hydrate(RemotePersistence.dehydrate(store, { scope: 'u1' }), {
        scope: 'u1',
      }),
    ).toEqual(store)
    expect(
      RemotePersistence.hydrate(RemotePersistence.dehydrate(store, { scope: 'u1' }), {
        scope: 'u2',
      }),
    ).toBeUndefined()
    expect(
      RemotePersistence.hydrate(RemotePersistence.dehydrate(store, { scope: 'u1' })),
    ).toBeUndefined()
    expect(
      RemotePersistence.hydrate(RemotePersistence.dehydrate(store), { scope: 'u1' }),
    ).toBeUndefined()

    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* RemotePersistence.save(store, { key: 'cache', scope: 'u1' })
        const restored = yield* RemotePersistence.restore({ key: 'cache', scope: 'u2' })
        return { restored, after: yield* kv.get('cache') }
      }),
    )
    expect(result).toEqual({ restored: emptyStore, after: undefined })
  })

  it('an oversized snapshot is neither written nor read', async () => {
    const size = new TextEncoder().encode(RemotePersistence.dehydrate(store)!).length
    expect(RemotePersistence.dehydrate(store, { maxBytes: size })).toBeDefined()
    expect(RemotePersistence.dehydrate(store, { maxBytes: size - 1 })).toBeUndefined()
    expect(
      RemotePersistence.hydrate(RemotePersistence.dehydrate(store), { maxBytes: size - 1 }),
    ).toBeUndefined()

    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set('cache', 'stale')
        yield* RemotePersistence.save(store, { key: 'cache', maxBytes: size - 1 })
        const afterSave = yield* kv.get('cache')
        yield* RemotePersistence.save(store, { key: 'cache' })
        const restored = yield* RemotePersistence.restore({ key: 'cache', maxBytes: size - 1 })
        return { afterSave, restored, afterRestore: yield* kv.get('cache') }
      }),
    )
    expect(result).toEqual({ afterSave: undefined, restored: emptyStore, afterRestore: undefined })
  })

  it('merges by policy: replace takes the snapshot, preserve-existing keeps the current', () => {
    const current = writeEntity(
      writeEntity(emptyStore, user, { id: 'u1', name: 'newer' }, 9),
      entityKey('User', 'u3'),
      { id: 'u3' },
      9,
    )
    const replaced = RemotePersistence.mergeStores(current, store, 'replace')
    expect(readField(replaced, user, 'name')).toEqual(Option.some('ada'))
    expect(Object.keys(replaced).sort()).toEqual(['User:u1', 'User:u2', 'User:u3'])

    const preserved = RemotePersistence.mergeStores(current, store, 'preserve-existing')
    expect(readField(preserved, user, 'name')).toEqual(Option.some('newer'))
    expect(readField(preserved, entityKey('User', 'u2'), 'name')).toEqual(Option.some('grace'))
    expect(Object.keys(preserved).sort()).toEqual(['User:u1', 'User:u2', 'User:u3'])
  })

  it('Hydrated is a Message that touches only the entities', () => {
    const model: RemoteModel = {
      ...initialRemoteModel,
      entities: writeEntity(emptyStore, user, { id: 'u1', name: 'newer' }, 9),
      gaps: new Set(['s']),
      mutations: { ...initialRemoteModel.mutations, pending: new Set(['r1']) },
    }
    const hydrated = updateRemote(model, {
      _tag: 'Hydrated',
      entities: store,
      merge: 'preserve-existing',
    })
    expect(readField(hydrated.entities, user, 'name')).toEqual(Option.some('newer'))
    expect(readField(hydrated.entities, entityKey('User', 'u2'), 'name')).toEqual(
      Option.some('grace'),
    )
    expect(hydrated.gaps).toBe(model.gaps)
    expect(hydrated.mutations).toBe(model.mutations)
    expect(hydrated.optimistic).toBe(model.optimistic)
    expect(
      updateRemote(hydrated, { _tag: 'Hydrated', entities: store, merge: 'preserve-existing' }),
    ).toEqual(hydrated)
  })

  it('server-prefetched data hydrates on the client without a refetch under cache-first', async () => {
    const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
    const Data = Remote.make({ entities: [User] })
    const App = Surface.application({
      Model: Schema.Struct({ remote: Data.Model }),
      Message: defineMessageUnion({ Ping: {} }),
    })
    const AppRemote = Remote.at(Data, App.model.remote)
    const projection = Remote.select(
      AppRemote,
      Selection.make(User, { id: true, name: true }),
    )('u1')
    const calls: unknown[] = []
    const Client = Layer.succeed(RemoteClient, {
      read: batch =>
        Effect.sync(() => {
          calls.push(batch)
          return {
            entities: batch.requests.map(request => ({
              entity: request.entity,
              id: request.id,
              values: { id: request.id, name: 'ada' },
            })),
          }
        }),
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.empty,
    })

    // Server: prefetch and dehydrate for the page.
    const serverStore = await Effect.runPromise(
      Remote.prefetch(AppRemote, { remote: initialRemoteModel }, projection).pipe(
        Effect.provide(Client),
      ),
    )
    const html = RemotePersistence.dehydrate(serverStore, { scope: 'u1' })!

    // Client: hydrate into a fresh model; the plan is empty and the read is Ready.
    const client = updateRemote(initialRemoteModel, {
      _tag: 'Hydrated',
      entities: RemotePersistence.hydrate(html, { scope: 'u1' })!,
      merge: 'replace',
    })
    expect(Remote.plan(AppRemote, { remote: client }, projection)).toEqual([])
    expect(projection.read({ remote: client })).toEqual({
      _tag: 'Ready',
      value: { id: 'u1', name: 'ada' },
    })
    expect(calls).toHaveLength(1)
  })
})
