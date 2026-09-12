import { Effect, Layer, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  REMOTE_PROTOCOL_VERSION,
  ReadBatch,
  Remote,
  RemoteClient,
  Selection,
  emptyStore,
  entityKey,
  initialRemoteModel,
  markStale,
  plan,
  refsIn,
  relationShape,
  tombstone,
  writeEntity,
  type EntityStore,
  type RemoteMessage,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Comment = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, body: Schema.String, author: Entity.ref(User) }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    owner: Entity.ref(User),
    reviewer: Schema.NullOr(Entity.ref(User)),
    members: Schema.Array(Entity.ref(User)),
    comments: Entity.refPage(Comment),
    parent: Entity.refTo('Project'),
  }),
)

const UserSummary = Selection.make(User, { id: true, name: true })
const CommentSummary = Selection.make(Comment, { body: true, author: UserSummary })
const ProjectCard = Selection.make(Project, {
  name: true,
  owner: UserSummary,
  reviewer: UserSummary,
  members: UserSummary,
  comments: Selection.connection(Comment, { first: 2 }, CommentSummary),
})

const Data = Remote.make({ entities: [User, Comment, Project] })
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)
const root = (store: EntityStore) => ({ remote: { ...initialRemoteModel, entities: store } })

const cardRequirement = {
  entity: 'Project',
  id: 'p1',
  fields: ['name', 'owner', 'reviewer', 'members', 'comments'],
  windows: { comments: { first: 2 } },
  relations: {
    owner: { entity: 'User', fields: ['id', 'name'] },
    reviewer: { entity: 'User', fields: ['id', 'name'] },
    members: { entity: 'User', fields: ['id', 'name'] },
    comments: {
      entity: 'Comment',
      fields: ['body', 'author'],
      relations: { author: { entity: 'User', fields: ['id', 'name'] } },
    },
  },
}

const user = (store: EntityStore, id: string, name: string) =>
  writeEntity(store, entityKey('User', id), { id, name })

/** The whole card's graph, as a read would leave it in the store. */
const fullStore = (): EntityStore => {
  let store = writeEntity(emptyStore, entityKey('Project', 'p1'), {
    name: 'Apollo',
    owner: 'User:u1',
    reviewer: null,
    members: ['User:u1', 'User:u2'],
    comments: { refs: ['Comment:c1'], hasNext: true, hasPrevious: false },
  })
  store = user(store, 'u1', 'ada')
  store = user(store, 'u2', 'grace')
  return writeEntity(store, entityKey('Comment', 'c1'), { body: 'hi', author: 'User:u2' })
}

describe('relation helpers', () => {
  it('reads refs out of a key, a list, a page, and nothing else', () => {
    expect(refsIn('User:u1')).toEqual([{ entity: 'User', id: 'u1' }])
    expect(refsIn(['User:u1', 'User:u2'])).toEqual([
      { entity: 'User', id: 'u1' },
      { entity: 'User', id: 'u2' },
    ])
    expect(refsIn({ refs: ['Comment:c1'], hasNext: false, hasPrevious: false })).toEqual([
      { entity: 'Comment', id: 'c1' },
    ])
    expect(refsIn(null)).toEqual([])
    expect(refsIn(42)).toEqual([])
    expect(refsIn({ items: ['User:u1'] })).toEqual([])
  })

  it('tells a field schema’s relation shape', () => {
    expect(relationShape(Project.fields.owner)).toEqual({ kind: 'one', nullable: false })
    expect(relationShape(Project.fields.reviewer)).toEqual({ kind: 'one', nullable: true })
    expect(relationShape(Project.fields.members)).toEqual({ kind: 'many', nullable: false })
    expect(relationShape(Project.fields.comments)).toEqual({ kind: 'page', nullable: false })
    expect(relationShape(Project.fields.parent)).toEqual({ kind: 'one', nullable: false })
    expect(relationShape(Project.fields.name)).toBeUndefined()
    expect(relationShape(Schema.Array(Schema.String))).toBeUndefined()
  })
})

describe('Selection.make with nested selections', () => {
  it('builds the relation requirement graph and a codec per field shape', () => {
    expect(ProjectCard.fields).toEqual(['name', 'owner', 'reviewer', 'members', 'comments'])
    expect(ProjectCard.connections).toEqual({ comments: { first: 2 } })
    expect(ProjectCard.relations).toEqual(cardRequirement.relations)

    const decode = Schema.decodeUnknownSync(
      ProjectCard.schema as unknown as Schema.ConstraintDecoder<unknown>,
    )
    const value = {
      name: 'Apollo',
      owner: { id: 'u1', name: 'ada' },
      reviewer: null,
      members: [{ id: 'u1', name: 'ada' }],
      comments: {
        items: [{ body: 'hi', author: { id: 'u2', name: 'grace' } }],
        hasNext: true,
        hasPrevious: false,
      },
    }
    expect(decode(value)).toEqual(value)
    expect(() => decode({ ...value, owner: null })).toThrow()
    expect(() => decode({ ...value, members: { id: 'u1', name: 'ada' } })).toThrow()
  })

  it('a refs-only connection contributes a window but no relation', () => {
    const selection = Selection.make(Project, {
      comments: Selection.connection(Comment, { first: 5 }),
    })
    expect(selection.connections).toEqual({ comments: { first: 5 } })
    expect(selection.relations).toBeUndefined()
  })

  it('refuses a nested selection on a scalar field', () => {
    expect(() =>
      Selection.make(Project, {
        name: UserSummary as unknown as true,
      }),
    ).toThrow(/"name" on "Project" is not a relation field/)
  })

  it('a recursive relation stays finite because the selection is', () => {
    const Parent = Selection.make(Project, { name: true })
    const selection = Selection.make(Project, { name: true, parent: Parent })
    expect(selection.relations).toEqual({ parent: { entity: 'Project', fields: ['name'] } })
  })
})

describe('Remote.select over a nested selection', () => {
  const projection = Remote.select(AppRemote, ProjectCard)('p1')

  it('puts the whole graph on one requirement', () => {
    expect(projection.requirements).toEqual([cardRequirement])
  })

  it('assembles every level once the store holds it', () => {
    expect(projection.read(root(fullStore()))).toEqual({
      _tag: 'Ready',
      value: {
        name: 'Apollo',
        owner: { id: 'u1', name: 'ada' },
        reviewer: null,
        members: [
          { id: 'u1', name: 'ada' },
          { id: 'u2', name: 'grace' },
        ],
        comments: {
          items: [{ body: 'hi', author: { id: 'u2', name: 'grace' } }],
          hasNext: true,
          hasPrevious: false,
        },
      },
    })
  })

  it('reads Initial while any level is missing, never Failed', () => {
    const withoutOwner = (() => {
      let store = fullStore()
      const key = entityKey('User', 'u1')
      store = { ...store, [key]: { ...store[key]!, present: new Set(['id']) } }
      return store
    })()
    expect(projection.read(root(withoutOwner))).toEqual({ _tag: 'Initial' })

    const withoutAuthor = { ...fullStore() }
    delete (withoutAuthor as Record<string, unknown>)[entityKey('User', 'u2')]
    expect(projection.read(root(withoutAuthor))).toEqual({ _tag: 'Initial' })
  })

  it('a tombstoned target reads as null or is dropped, and the codec judges it', () => {
    const noOwner = tombstone(fullStore(), entityKey('User', 'u1'))
    const read = projection.read(root(noOwner))
    expect(read._tag).toBe('Failed')

    const Members = Selection.make(Project, { members: UserSummary })
    expect(Remote.select(AppRemote, Members)('p1').read(root(noOwner))).toEqual({
      _tag: 'Ready',
      value: { members: [{ id: 'u2', name: 'grace' }] },
    })
  })

  it('a stale nested field reads the whole value as Refreshing', () => {
    const store = markStale(fullStore(), entityKey('User', 'u2'), ['name'])
    expect(projection.read(root(store))._tag).toBe('Refreshing')
  })
})

describe('plan with relations', () => {
  it('keeps a relation on a field being fetched', () => {
    expect(plan(emptyStore, [cardRequirement])).toEqual([cardRequirement])
  })

  it('follows a known relation into concrete requirements for its targets', () => {
    let store = writeEntity(emptyStore, entityKey('Project', 'p1'), {
      name: 'Apollo',
      owner: 'User:u1',
      reviewer: null,
      members: ['User:u1', 'User:u2'],
      comments: { refs: ['Comment:c1'], hasNext: false, hasPrevious: false },
    })
    store = user(store, 'u1', 'ada')
    expect(plan(store, [cardRequirement])).toEqual([
      {
        entity: 'Comment',
        id: 'c1',
        fields: ['body', 'author'],
        relations: { author: { entity: 'User', fields: ['id', 'name'] } },
      },
      { entity: 'User', id: 'u2', fields: ['id', 'name'] },
    ])
  })

  it('follows through several levels and merges a target reached twice', () => {
    let store = writeEntity(emptyStore, entityKey('Project', 'p1'), {
      name: 'Apollo',
      owner: 'User:u2',
      reviewer: null,
      members: [],
      comments: { refs: ['Comment:c1'], hasNext: false, hasPrevious: false },
    })
    store = writeEntity(store, entityKey('Comment', 'c1'), { body: 'hi', author: 'User:u2' })
    expect(plan(store, [cardRequirement])).toEqual([
      { entity: 'User', id: 'u2', fields: ['id', 'name'] },
    ])
  })

  it('plans nothing for a fully known graph', () => {
    expect(plan(fullStore(), [cardRequirement])).toEqual([])
  })

  it('drops a relation whose field is known but only refetches the missing ones', () => {
    const store = writeEntity(emptyStore, entityKey('Project', 'p1'), {
      name: 'Apollo',
      owner: 'User:u1',
      reviewer: null,
      members: ['User:u1'],
    })
    const planned = plan(store, [cardRequirement])
    expect(planned.find(requirement => requirement.entity === 'Project')).toEqual({
      entity: 'Project',
      id: 'p1',
      fields: ['comments'],
      windows: { comments: { first: 2 } },
      relations: { comments: cardRequirement.relations.comments },
    })
    expect(planned.find(requirement => requirement.entity === 'User')).toEqual({
      entity: 'User',
      id: 'u1',
      fields: ['id', 'name'],
    })
  })
})

describe('the wire carries the graph', () => {
  it('round-trips relations and the protocol version', () => {
    const batch = { version: REMOTE_PROTOCOL_VERSION, requests: [cardRequirement] }
    expect(Schema.decodeUnknownSync(ReadBatch)(batch)).toEqual(batch)
    expect(Schema.encodeSync(ReadBatch)(batch)).toEqual(batch)
  })

  it('refuses a batch without a version', () => {
    expect(() => Schema.decodeUnknownSync(ReadBatch)({ requests: [] })).toThrow()
  })
})

describe('observe resolves a graph in one read', () => {
  const Page = Surface.make(App, 'ProjectPage', {
    Params: Schema.Struct({ projectId: Schema.String }),
    model: ({ params }) =>
      Projection.struct({ project: Remote.select(AppRemote, ProjectCard)(params.projectId) }),
    messages: [Message.Ping],
  })

  const graph: Record<string, Record<string, unknown>> = {
    'Project:p1': {
      name: 'Apollo',
      owner: 'User:u1',
      reviewer: null,
      members: ['User:u1', 'User:u2'],
      comments: { refs: ['Comment:c1'], hasNext: true, hasPrevious: false },
    },
    'User:u1': { id: 'u1', name: 'ada' },
    'User:u2': { id: 'u2', name: 'grace' },
    'Comment:c1': { body: 'hi', author: 'User:u2' },
  }

  /** A server that resolves relations itself, as `RemoteServer` does. */
  const resolve = (
    requests: ReadonlyArray<{
      readonly entity: string
      readonly id: string
      readonly relations?: Readonly<Record<string, { readonly entity: string }>> | undefined
    }>,
  ): Array<{ entity: string; id: string; values: Record<string, unknown> }> =>
    requests.flatMap(request => {
      const values = graph[entityKey(request.entity, request.id)]!
      const nested = Object.entries(request.relations ?? {}).flatMap(([field, relation]) =>
        resolve(
          refsIn(values[field]).map(ref => ({
            entity: ref.entity,
            id: ref.id,
            relations: (relation as { relations?: Record<string, { entity: string }> })
              .relations,
          })),
        ),
      )
      return [{ entity: request.entity, id: request.id, values }, ...nested]
    })

  const calls: Array<unknown> = []
  const Client = Layer.succeed(RemoteClient, {
    read: batch =>
      Effect.sync(() => {
        calls.push(batch.requests)
        return { entities: resolve(batch.requests) }
      }),
    query: () => Effect.die('unused'),
    mutate: () => Effect.die('unused'),
    live: () => Stream.empty,
  })

  it('one read, one ReadReceived, and the Surface reads Ready', async () => {
    calls.length = 0
    const entry = Remote.observe(AppRemote, Page, { projectId: 'p1' }, message => message)
    const dependencies = entry.modelToDependencies(root(emptyStore))
    expect(dependencies.requirements).toEqual([cardRequirement])

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(Client)),
    )
    const received = [...messages][0] as RemoteMessage
    expect(received._tag).toBe('ReadReceived')
    const model = Data.update(initialRemoteModel, received)
    expect(calls).toHaveLength(1)
    expect(Object.keys(model.entities).sort()).toEqual([
      'Comment:c1',
      'Project:p1',
      'User:u1',
      'User:u2',
    ])
    const read = Remote.select(AppRemote, ProjectCard)('p1').read({ remote: model })
    expect(read._tag).toBe('Ready')
    expect(entry.modelToDependencies({ remote: model }).requirements).toEqual([])
  })
})
