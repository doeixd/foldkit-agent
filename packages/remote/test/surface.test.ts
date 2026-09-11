import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  Selection,
  emptyStore,
  entityKey,
  initialRemoteModel,
  plan,
  tombstone,
  writeEntity,
} from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, avatarUrl: Schema.String }),
)

const Data = Remote.make({ entities: [User] })
const Model = Schema.Struct({ remote: Data.Model, route: Schema.String })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.make({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)
const UserSummary = Selection.make(User, { id: true, name: true })
const selectUser = Remote.select(AppRemote, UserSummary)

const root = (store = emptyStore) => ({
  remote: { ...initialRemoteModel, entities: store },
  route: '/users/u1',
})

describe('Remote and Surface', () => {
  it('reads Initial, then Ready, then NotFound from a tombstone', () => {
    expect(selectUser('u1').read(root())).toEqual({ _tag: 'Initial' })

    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 'ada' })
    expect(selectUser('u1').read(root(store))).toEqual({
      _tag: 'Ready',
      value: { id: 'u1', name: 'ada' },
    })

    const gone = tombstone(emptyStore, entityKey('User', 'u1'))
    expect(selectUser('u1').read(root(gone))).toEqual({ _tag: 'NotFound' })
  })

  it('reports Failed when a stored field does not match the Selection schema', () => {
    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 42 })
    const data = selectUser('u1').read(root(store))

    expect(data._tag).toBe('Failed')
    if (data._tag !== 'Failed') return
    expect(data.error._tag).toBe('DecodeError')
  })

  it('exposes requirements the planner turns into a minimal fetch plan', () => {
    const requirements = selectUser('u1').requirements
    expect(requirements).toEqual([{ entity: 'User', id: 'u1', fields: ['id', 'name'] }])
    expect(plan(emptyStore, requirements)).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])

    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 'ada' })
    expect(plan(store, requirements)).toEqual([])
  })

  it('a mixed local + remote Surface extracts the combined requirement tree', () => {
    const UserPage = Surface.define(App, 'UserPage', {
      Params: Schema.Struct({ userId: Schema.String }),
      model: ({ model, params }) =>
        Projection.struct({
          route: model.route,
          user: Remote.select(AppRemote, UserSummary)(params.userId),
        }),
      messages: [Message.Ping],
    })

    const projection = UserPage.projection({ userId: 'u1' })
    expect(projection.requirements).toEqual([{ entity: 'User', id: 'u1', fields: ['id', 'name'] }])

    const store = emptyStore
    expect(projection.read(root(store))).toEqual({
      route: '/users/u1',
      user: { _tag: 'Initial' },
    })
    // `Surface.read`/`projection.read` is pure: no fetch, no store mutation.
    expect(store).toEqual(emptyStore)
  })
})
