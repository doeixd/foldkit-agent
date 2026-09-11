import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import {
  Entity,
  Remote,
  Selection,
  emptyStore,
  type BoundRemote,
  type RemoteModel,
} from 'foldkit-remote'
import { RemoteServer } from 'foldkit-remote-server'
import { describe, expect, it } from 'vitest'
import { DrizzleDatabase, entity, many, source } from '../src/index.js'
import { fakeDatabaseQueue } from './fakeDatabase.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
})

const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id'),
})

const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  body: text('body').notNull(),
  projectId: uuid('project_id').notNull(),
})

const UserEntity = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const CommentEntity = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, body: Schema.String }),
)
const ProjectEntity = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    owner: Schema.NullOr(Entity.ref(UserEntity)),
    comments: Schema.Array(Entity.ref(CommentEntity)),
  }),
)

const UserBinding = entity('User', users)
const CommentBinding = entity('Comment', comments)
const ProjectBinding = entity('Project', projects, {
  relations: {
    owner: { entity: UserBinding, field: projects.ownerId },
    comments: many(CommentBinding, { foreignKey: comments.projectId, localKey: projects.id }),
  },
})

const selection = Selection.make(ProjectEntity, {
  id: true,
  name: true,
  owner: true,
  comments: true,
})

describe('RemoteDrizzle end to end', () => {
  it('serves a normalized read that Remote.select decodes into refs', async () => {
    const { database } = fakeDatabaseQueue([
      [{ id: 'p1', name: 'P', owner: 'u1', comments: 'p1' }],
      [{ child: 'c1', parent: 'p1' }],
    ])
    const server = RemoteServer.make({}, { entities: [source(ProjectBinding)] })
    const request = { entity: 'Project', id: 'p1', fields: selection.fields }

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ requests: [request] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    const store = Remote.writeRead(emptyStore, [request], result)
    const bound = {
      store: {
        get: () => ({ entities: store, connections: {}, requests: {}, mutations: {} }),
      },
    } as unknown as BoundRemote<unknown, RemoteModel>

    expect(Remote.select(bound, selection)('p1').read(undefined)).toEqual({
      _tag: 'Ready',
      value: {
        id: 'p1',
        name: 'P',
        owner: { entity: 'User', id: 'u1' },
        comments: [{ entity: 'Comment', id: 'c1' }],
      },
    })
  })

  it('serves a windowed relation page that Remote.select decodes', async () => {
    const PageProject = Entity.make(
      'Project',
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        comments: Entity.refPage(CommentEntity),
      }),
    )
    const selection = Selection.make(PageProject, {
      id: true,
      name: true,
      comments: Selection.connection(CommentEntity, { first: 1 }),
    })
    const { database } = fakeDatabaseQueue([
      [{ id: 'p1', name: 'P', comments: 'p1' }],
      [
        { child: 'c1', parent: 'p1' },
        { child: 'c2', parent: 'p1' },
      ],
    ])
    const server = RemoteServer.make({}, { entities: [source(ProjectBinding)] })
    const request = {
      entity: 'Project',
      id: 'p1',
      fields: selection.fields,
      windows: selection.connections,
    }

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ requests: [request] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    const store = Remote.writeRead(emptyStore, [request], result)
    const bound = {
      store: {
        get: () => ({ entities: store, connections: {}, requests: {}, mutations: {} }),
      },
    } as unknown as BoundRemote<unknown, RemoteModel>

    expect(Remote.select(bound, selection)('p1').read(undefined)).toEqual({
      _tag: 'Ready',
      value: {
        id: 'p1',
        name: 'P',
        comments: {
          refs: [{ entity: 'Comment', id: 'c1' }],
          hasNext: true,
          hasPrevious: false,
        },
      },
    })
  })
})
