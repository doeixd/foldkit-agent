import { pgTable, text } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import {
  Remote,
  Selection,
  emptyStore,
  type BoundRemote,
  type RemoteModel,
  REMOTE_PROTOCOL_VERSION,
  initialRemoteModel,
} from 'foldkit-remote'
import { RemoteServer } from 'foldkit-remote-server'
import { describe, expect, it } from 'vitest'
import { DrizzleDatabase, entity, many, one, source } from '../src/index.js'
import { fakeDatabaseQueue } from './fakeDatabase.js'

const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
})

const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  projectId: text('project_id').notNull(),
})

const UserBinding = entity('User', users)
const CommentBinding = entity('Comment', comments)
const ProjectBinding = entity('Project', projects, {
  relations: {
    owner: one(UserBinding, { field: projects.ownerId, nullable: true }),
    comments: many(CommentBinding, { foreignKey: comments.projectId, localKey: projects.id }),
  },
})

const selection = Selection.make(ProjectBinding, {
  id: true,
  name: true,
  owner: true,
  comments: true,
})

describe('RemoteDrizzle end to end', () => {
  it('registers the bindings as the Remote entities', () => {
    const data = Remote.make({ entities: [UserBinding, ProjectBinding] })

    expect([...data.registry.entities.keys()]).toEqual(['User', 'Project'])
    expect(data.registry.entities.get('Project')).toBe(ProjectBinding)
  })

  it('serves a normalized read that Remote.select decodes into refs', async () => {
    const { database } = fakeDatabaseQueue([
      [{ id: 'p1', name: 'P', owner: 'u1', comments: 'p1' }],
      [{ child: 'c1', parent: 'p1' }],
    ])
    const server = RemoteServer.make({ entities: [source(ProjectBinding)] })
    const request = { entity: 'Project', id: 'p1', fields: selection.fields }

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests: [request] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    const store = Remote.writeRead(emptyStore, [request], result)
    const bound = {
      store: {
        get: () => ({ ...initialRemoteModel, entities: store }),
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
    const selection = Selection.make(ProjectBinding, {
      id: true,
      name: true,
      comments: Selection.connection(CommentBinding, { first: 1 }),
    })
    const { database } = fakeDatabaseQueue([
      [{ id: 'p1', name: 'P', comments: 'p1' }],
      [
        { child: 'c1', parent: 'p1' },
        { child: 'c2', parent: 'p1' },
      ],
    ])
    const server = RemoteServer.make({ entities: [source(ProjectBinding)] })
    const request = {
      entity: 'Project',
      id: 'p1',
      fields: selection.fields,
      windows: selection.connections,
    }

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests: [request] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    const store = Remote.writeRead(emptyStore, [request], result)
    const bound = {
      store: {
        get: () => ({ ...initialRemoteModel, entities: store }),
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
