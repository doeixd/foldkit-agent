import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Mutation,
  Remote,
  RemoteClient,
  Selection,
  emptyStore,
  entityKey,
  initialRemoteModel,
  items,
  readField,
  terminal,
  updateRemote,
  visibleStore,
  type LiveEvent,
  type RemoteModel,
  type RemoteMessage,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))

const readReceived = (
  model: RemoteModel,
  values: Readonly<Record<string, unknown>>,
  now = 0,
): RemoteModel =>
  updateRemote(model, {
    _tag: 'ReadReceived',
    requests: [{ entity: 'User', id: 'u1', fields: ['name'] }],
    result: { entities: [{ entity: 'User', id: 'u1', values }] },
    now,
  })

describe('Remote.update', () => {
  it('writes a read batch into the store', () => {
    const model = readReceived(initialRemoteModel, { name: 'ada' })
    expect(readField(model.entities, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))
  })

  it('reconciles a mutation once and removes its optimistic layer', () => {
    const withLayer: RemoteModel = updateRemote(initialRemoteModel, {
      _tag: 'OptimisticAdded',
      layer: {
        id: 'req-1',
        patches: [{ entity: 'User', id: 'u1', values: { name: 'optimistic' } }],
      },
    })
    expect(
      readField(
        visibleStore(withLayer.entities, withLayer.optimistic),
        entityKey('User', 'u1'),
        'name',
      ),
    ).toEqual(Option.some('optimistic'))

    const settled = updateRemote(
      updateRemote(withLayer, { _tag: 'MutationStarted', requestId: 'req-1' }),
      {
        _tag: 'MutationSucceeded',
        requestId: 'req-1',
        entities: [{ entity: 'User', id: 'u1', values: { name: 'server' } }],
      },
    )
    expect(settled.optimistic.layers).toHaveLength(0)
    expect(readField(settled.entities, entityKey('User', 'u1'), 'name')).toEqual(
      Option.some('server'),
    )

    const reapplied = updateRemote(settled, {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [{ entity: 'User', id: 'u1', values: { name: 'retry' } }],
    })
    expect(readField(reapplied.entities, entityKey('User', 'u1'), 'name')).toEqual(
      Option.some('server'),
    )
  })

  it('drops a failed mutation layer without touching the base', () => {
    const withLayer = updateRemote(initialRemoteModel, {
      _tag: 'OptimisticAdded',
      layer: {
        id: 'req-1',
        patches: [{ entity: 'User', id: 'u1', values: { name: 'optimistic' } }],
      },
    })
    const failed = updateRemote(withLayer, {
      _tag: 'MutationFailed',
      requestId: 'req-1',
      error: { _tag: 'Boom', message: 'x' },
    })
    expect(failed.optimistic.layers).toHaveLength(0)
    expect(failed.mutations.failed.has('req-1')).toBe(true)
    expect(failed.entities).toEqual(emptyStore)
  })

  it('merges, invalidates, and refreshes a connection', () => {
    const page = {
      edges: [{ key: 'User:u1', ref: { entity: 'User', id: 'u1' } }],
      start: terminal,
      end: terminal,
    }
    const merged = updateRemote(initialRemoteModel, {
      _tag: 'ConnectionMerged',
      connection: 'c1',
      page,
    })
    expect(items(merged.connections.c1!).map(edge => edge.key)).toEqual(['User:u1'])
    expect(merged.connections.c1!.stale).toBe(false)

    const invalidated = updateRemote(merged, { _tag: 'ConnectionInvalidated', connection: 'c1' })
    expect(invalidated.connections.c1!.stale).toBe(true)
    const refreshed = updateRemote(invalidated, { _tag: 'ConnectionRefreshed', connection: 'c1' })
    expect(refreshed.connections.c1!.stale).toBe(false)
  })

  it('applies a live entity event and records a gap for a skipped cursor', () => {
    const applied = updateRemote(initialRemoteModel, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'ada' },
        changed: ['name'],
        cursor: 1,
      },
    })
    expect(applied.live.s1!.cursor).toBe(1)
    expect(readField(applied.entities, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))

    const ahead = updateRemote(applied, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'grace' },
        changed: ['name'],
        cursor: 3,
      },
    })
    expect(ahead.gaps.has('s1')).toBe(true)
    expect(ahead.live.s1!.cursor).toBe(1)
    expect(readField(ahead.entities, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))

    // The next in-order event applies and the gap heals.
    const healed = updateRemote(ahead, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'grace' },
        changed: ['name'],
        cursor: 2,
      },
    })
    expect(healed.gaps.has('s1')).toBe(false)
    expect(healed.live.s1!.cursor).toBe(2)

    // A gap can also be cleared explicitly, for a host that resubscribed.
    const regapped = updateRemote(ahead, { _tag: 'GapCleared', stream: 's1' })
    expect(regapped.gaps.has('s1')).toBe(false)
  })

  it('records a gap for a connection event ahead of its cursor and heals in order', () => {
    const inserted: LiveEvent = {
      _tag: 'ConnectionInsert',
      connection: 'c1',
      position: 'append',
      edge: { key: 'User:u1', ref: { entity: 'User', id: 'u1' } },
      cursor: 1,
    }
    const applied = updateRemote(initialRemoteModel, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: inserted,
    })
    expect(applied.gaps.has('s1')).toBe(false)
    expect(applied.live.s1!.cursor).toBe(1)
    expect(applied.optimistic.overlays).toHaveLength(1)

    const ahead = updateRemote(applied, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: { ...inserted, cursor: 3 },
    })
    expect(ahead.gaps.has('s1')).toBe(true)
    expect(ahead.live.s1!.cursor).toBe(1)
    expect(ahead.optimistic.overlays).toHaveLength(1)

    const healed = updateRemote(ahead, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: { ...inserted, cursor: 2 },
    })
    expect(healed.gaps.has('s1')).toBe(false)
    expect(healed.live.s1!.cursor).toBe(2)
    expect(healed.optimistic.overlays).toHaveLength(2)
  })

  it('inspects the cache purely', () => {
    const model = readReceived(initialRemoteModel, { name: 'ada' })
    const inspection = Remote.inspect(model)
    expect(inspection.entities).toEqual([
      {
        key: 'User:u1',
        present: ['name'],
        stale: [],
        tombstone: false,
        updatedAt: 0,
        windows: {},
      },
    ])
    expect(Remote.inspectEntity(model, 'User:u1')?.present).toEqual(['name'])
    expect(Remote.inspectEntity(model, 'Missing:1')).toBeUndefined()
  })

  it('inspects connections, live streams, gaps, and the mutation ledger', () => {
    let model = updateRemote(initialRemoteModel, {
      _tag: 'ConnectionMerged',
      connection: 'c1',
      page: {
        edges: [{ key: 'User:u1', ref: { entity: 'User', id: 'u1' } }],
        start: terminal,
        end: terminal,
      },
    })
    model = updateRemote(model, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'ada' },
        changed: ['name'],
        cursor: 1,
      },
    })
    model = updateRemote(model, { _tag: 'MutationStarted', requestId: 'req-1' })
    model = updateRemote(model, {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [],
    })
    model = updateRemote(model, {
      _tag: 'MutationFailed',
      requestId: 'req-2',
      error: { _tag: 'Boom', message: 'x' },
    })
    model = updateRemote(model, {
      _tag: 'LiveReceived',
      stream: 's1',
      now: 0,
      event: {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'grace' },
        changed: ['name'],
        cursor: 3,
      },
    })

    const inspection = Remote.inspect(model)
    expect(inspection.connections).toEqual(['c1'])
    expect(inspection.live).toEqual(['s1'])
    expect(inspection.gaps).toEqual(['s1'])
    expect(inspection.mutations).toEqual({ pending: [], failed: ['req-2'], applied: 1 })
  })
})

const RenameUser = Mutation.make('RenameUser', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

const Data = Remote.make({ entities: [User], mutations: [RenameUser] })
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.make({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const FakeClient = Layer.succeed(RemoteClient, {
  read: () => Effect.die('unused'),
  query: () => Effect.die('unused'),
  mutate: request =>
    Effect.succeed({
      output: { id: (request.input as { readonly id: string }).id },
      entities: [{ entity: 'User', id: 'u1', values: { name: 'server' } }],
    }),
  live: () => Stream.empty,
})

describe('Remote domain submodel', () => {
  it('Remote.make exposes Model, initial, Message, update, and rpc', () => {
    expect(Data.initial).toEqual(initialRemoteModel)
    expect(Data.update).toBe(updateRemote)
    expect(Data.rpc).toBeDefined()
    expect(Data.entities).toHaveLength(1)
    expect(Data.registry.entities.get('User')?.name).toBe('User')
    expect(Data.registry.mutations.get('RenameUser')?.name).toBe('RenameUser')
    expect(Data.registry.queries.size).toBe(0)
  })

  it('mutateInto reconciles patches and returns the typed output', async () => {
    const result = await Effect.runPromise(
      Remote.mutateInto(
        AppRemote,
        { remote: Data.initial },
        RenameUser,
        { id: 'u1', name: 'ada' },
        'req-1',
      ).pipe(Effect.provide(FakeClient)),
    )
    expect(result.output).toEqual({ id: 'u1' })
    expect(readField(result.model.remote.entities, entityKey('User', 'u1'), 'name')).toEqual(
      Option.some('server'),
    )
  })

  it('rejects a selection for an entity the domain did not register', () => {
    const Project = Entity.make(
      'Project',
      Schema.Struct({ id: Schema.String, name: Schema.String }),
    )
    const projectSelection = Selection.make(Project, { name: true })
    // @ts-expect-error "Project" is not one of Data's registered entities
    Remote.select(AppRemote, projectSelection)
  })
})

// A `RemoteMessage` must remain assignable to the union the reducer accepts.
const _message: RemoteMessage = { _tag: 'MutationStarted', requestId: 'r' }
void _message
