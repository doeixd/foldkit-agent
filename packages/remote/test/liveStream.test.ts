import { Effect, Layer, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  RemoteClient,
  RemoteLiveError,
  Selection,
  emptyLiveState,
  emptyStore,
  entityKey,
  initialRemoteModel,
  type LiveEvent,
  type RemoteMessage,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Data = Remote.make({ entities: [User] })
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const LiveMessage = defineMessageUnion({
  Patched: { cursor: Schema.Number },
  ResumeUnavailable: { message: Schema.String },
})
type LiveMessageType = Schema.Schema.Type<typeof LiveMessage>

const UserPage = Surface.make(App, 'UserPage', {
  Params: Schema.Struct({ userId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({
      user: Remote.select(AppRemote, Selection.make(User, { id: true, name: true }))(params.userId),
    }),
  messages: [Message.Ping],
})

const root = {
  remote: { ...initialRemoteModel, entities: emptyStore },
}

const patched: LiveEvent = {
  _tag: 'EntityPatched',
  ref: { entity: 'User', id: 'u1' },
  values: { name: 'ada' },
  changed: ['name'],
  cursor: 1,
}

const toMessage = (message: RemoteMessage): LiveMessageType => {
  switch (message._tag) {
    case 'LiveReceived':
      return LiveMessage.Patched({ cursor: message.event.cursor })
    case 'ReadFailed':
    case 'MutationFailed':
      return LiveMessage.ResumeUnavailable({ message: message.error.message })
    default:
      throw new Error(`unexpected remote message: ${message._tag}`)
  }
}

const entry = Remote.live(AppRemote, UserPage, { userId: 'u1' }, toMessage)

const dependencies = entry.modelToDependencies(root)

describe('Remote live subscription', () => {
  it('reads the resume cursor from the model', () => {
    const stream = dependencies.requirements
      .map(
        requirement =>
          `${entityKey(requirement.entity, requirement.id)}:${[...requirement.fields].sort().join(',')}`,
      )
      .sort()
      .join('|')
    const advanced = {
      remote: { ...initialRemoteModel, live: { [stream]: { ...emptyLiveState, cursor: 7 } } },
    }
    expect(entry.modelToDependencies(advanced).cursor).toBe(7)
  })

  it('streams live events for a Surface', async () => {
    const client = Layer.succeed(RemoteClient, {
      read: () => Effect.die('unused'),
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.make(patched),
    })

    expect(dependencies.requirements).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])
    expect(dependencies.cursor).toBe(0)

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(client)),
    )
    expect([...messages]).toEqual([{ _tag: 'Patched', cursor: 1 }])
  })

  it('emits a ResumeUnavailable message instead of failing the stream', async () => {
    const client = Layer.succeed(RemoteClient, {
      read: () => Effect.die('unused'),
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.fail(new RemoteLiveError({ message: 'ResumeUnavailable' })),
    })

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(client)),
    )
    expect([...messages]).toEqual([{ _tag: 'ResumeUnavailable', message: 'ResumeUnavailable' }])
  })
})
