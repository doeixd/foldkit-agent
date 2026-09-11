import { eq, type SQL } from 'drizzle-orm'
import { pgTable, PgDialect, text, uuid } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import { Entity, Selection } from 'foldkit-remote'
import { RemoteServer } from 'foldkit-remote-server'
import { describe, expect, it } from 'vitest'
import {
  DrizzleDatabase,
  entity,
  many,
  manyToMany,
  normalize,
  source,
  type DrizzleDatabaseService,
  type DrizzleStatement,
} from '../src/index.js'
import { fakeDatabase, fakeDatabaseQueue } from './fakeDatabase.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
)

const UserBinding = entity('User', users)

const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id'),
})

const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, name: Schema.String, owner: Schema.NullOr(Entity.ref(User)) }),
)

const ProjectBinding = entity('Project', projects, {
  relations: { owner: { entity: UserBinding, field: projects.ownerId } },
})

const posts = pgTable('posts', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
})

const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  body: text('body').notNull(),
  postId: uuid('post_id').notNull(),
})

const CommentEntity = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, body: Schema.String }),
)

const CommentBinding = entity('Comment', comments)

const tags = pgTable('tags', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
})

const postTags = pgTable('post_tags', {
  postId: uuid('post_id').notNull(),
  tagId: uuid('tag_id').notNull(),
})

const TagEntity = Entity.make('Tag', Schema.Struct({ id: Schema.String, name: Schema.String }))

const TagBinding = entity('Tag', tags)

const PostEntity = Entity.make(
  'Post',
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    comments: Schema.Array(Entity.ref(CommentEntity)),
    tags: Schema.Array(Entity.ref(TagEntity)),
  }),
)

const PostBinding = entity('Post', posts, {
  relations: {
    comments: many(CommentBinding, {
      foreignKey: comments.postId,
      localKey: posts.id,
      orderBy: [{ column: comments.body, direction: 'desc' }],
    }),
    tags: manyToMany(TagBinding, {
      through: postTags,
      localColumn: postTags.postId,
      foreignColumn: postTags.tagId,
    }),
  },
})

describe('RemoteDrizzle execution', () => {
  it('reads through the DrizzleDatabase service with a pruned projection', async () => {
    const { database, calls } = fakeDatabase([{ id: 'a', name: 'A', email: 'a@b.c' }])
    const read = source(UserBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: ['a'], fields: ['name'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([{ id: 'a', values: { id: 'a', name: 'A' } }])
    expect(Object.keys(calls[0]!.selection)).toEqual(['id', 'name'])
    expect(calls[0]!.where).toBeDefined()
  })

  it('serves through RemoteServer with a provided database service', async () => {
    const { database } = fakeDatabase([{ id: 'a', name: 'A', email: 'a@b.c' }])
    const server = RemoteServer.make({}, { entities: [source(UserBinding)] })

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ requests: [{ entity: 'User', id: 'a', fields: ['name'] }] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'a', values: { name: 'A' } }])
  })

  it('is inert for an empty id batch', async () => {
    const { database, calls } = fakeDatabase([])
    const read = source(UserBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: [], fields: ['name'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([])
    expect(calls).toEqual([])
  })

  it('does not leak a database error to the client', async () => {
    const failing: DrizzleDatabaseService = {
      select: () => {
        const statement = {
          where: () => statement,
          orderBy: () => statement,
          limit: () => statement,
          then: (
            resolve: (value: ReadonlyArray<Record<string, unknown>>) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            Promise.reject(new Error('relation "secret_table" does not exist')).then(
              resolve,
              reject,
            ),
        } as unknown as DrizzleStatement
        return { from: () => statement }
      },
    }
    const server = RemoteServer.make({}, { entities: [source(UserBinding)] })

    const result = await Effect.runPromise(
      Effect.result(
        RemoteServer.handlers(server, null)
          .FoldkitRemoteRead({ requests: [{ entity: 'User', id: 'a', fields: ['name'] }] })
          .pipe(Effect.provideService(DrizzleDatabase, failing)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteReadError')
    expect(result.failure.message).toBe('Database query failed')
  })

  it('rewrites a selected relation to the ref key the client decodes', async () => {
    const { database } = fakeDatabase([{ id: 'p1', name: 'P', owner: 'u1' }])
    const read = source(ProjectBinding)
    const selection = Selection.make(Project, { id: true, name: true, owner: true })

    const records = await Effect.runPromise(
      read
        .read({ ids: ['p1'], fields: selection.fields, principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([{ id: 'p1', values: { id: 'p1', name: 'P', owner: 'User:u1' } }])
    expect(
      Schema.decodeUnknownSync(selection.schema as unknown as Schema.ConstraintDecoder<unknown>)(
        records[0]!.values,
      ),
    ).toEqual({ id: 'p1', name: 'P', owner: { entity: 'User', id: 'u1' } })
  })

  it('emits null for an absent relation instead of a dangling ref', async () => {
    const { database } = fakeDatabase([{ id: 'p1', name: 'P', owner: null }])
    const read = source(ProjectBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: ['p1'], fields: ['id', 'owner'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records[0]!.values.owner).toBeNull()
  })

  it('loads a many relation as an array of ref keys', async () => {
    const { database, calls } = fakeDatabaseQueue([
      [{ id: 'p1', comments: 'p1' }],
      [
        { child: 'c1', parent: 'p1' },
        { child: 'c2', parent: 'p1' },
      ],
    ])
    const read = source(PostBinding)
    const selection = Selection.make(PostEntity, { id: true, comments: true })

    const records = await Effect.runPromise(
      read
        .read({ ids: ['p1'], fields: selection.fields, principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([
      { id: 'p1', values: { id: 'p1', comments: ['Comment:c1', 'Comment:c2'] } },
    ])
    expect(
      Schema.decodeUnknownSync(selection.schema as unknown as Schema.ConstraintDecoder<unknown>)(
        records[0]!.values,
      ),
    ).toEqual({
      id: 'p1',
      comments: [
        { entity: 'Comment', id: 'c1' },
        { entity: 'Comment', id: 'c2' },
      ],
    })
    expect(calls).toHaveLength(2)
    expect(Object.keys(calls[1]!.selection)).toEqual(['child', 'parent'])

    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(calls[1]!.orderBy![0] as SQL).sql).toContain('"comments"."body" desc')
  })

  it('emits an empty array when a many relation has no children', async () => {
    const { database } = fakeDatabaseQueue([[{ id: 'p1', comments: 'p1' }], []])
    const read = source(PostBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: ['p1'], fields: ['id', 'comments'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records[0]!.values.comments).toEqual([])
  })

  it('loads a bounded page per parent when a first window is given', async () => {
    const { database, calls } = fakeDatabaseQueue([
      [
        { id: 'p1', comments: 'p1' },
        { id: 'p2', comments: 'p2' },
      ],
      [
        { child: 'c1', parent: 'p1' },
        { child: 'c2', parent: 'p1' },
      ],
      [{ child: 'c3', parent: 'p2' }],
    ])

    const records = await Effect.runPromise(
      source(PostBinding)
        .read({
          ids: ['p1', 'p2'],
          fields: ['id', 'comments'],
          principal: null,
          windows: { comments: { first: 1 } },
        })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([
      {
        id: 'p1',
        values: {
          id: 'p1',
          comments: { refs: ['Comment:c1'], hasNext: true, hasPrevious: false },
        },
      },
      {
        id: 'p2',
        values: {
          id: 'p2',
          comments: { refs: ['Comment:c3'], hasNext: false, hasPrevious: false },
        },
      },
    ])
    expect(calls).toHaveLength(3)
    expect(Object.keys(calls[1]!.selection)).toEqual(['child', 'parent'])
    expect(calls[1]!.limit).toBe(2)
  })

  it('loads the last page per parent for a last window', async () => {
    // Backward: the query returns reversed rows; the adapter reverses them back.
    const { database } = fakeDatabaseQueue([
      [{ id: 'p1', comments: 'p1' }],
      [
        { child: 'c2', parent: 'p1' },
        { child: 'c1', parent: 'p1' },
      ],
    ])

    const records = await Effect.runPromise(
      source(PostBinding)
        .read({
          ids: ['p1'],
          fields: ['id', 'comments'],
          principal: null,
          windows: { comments: { last: 1 } },
        })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records[0]!.values.comments).toEqual({
      refs: ['Comment:c2'],
      hasNext: false,
      hasPrevious: true,
    })
  })

  it('supports an after cursor for a single parent', async () => {
    const { database, calls } = fakeDatabaseQueue([
      [{ id: 'p1', comments: 'p1' }],
      [{ body: 'zzz' }],
      [
        { child: 'c1', parent: 'p1' },
        { child: 'c2', parent: 'p1' },
      ],
    ])

    const records = await Effect.runPromise(
      source(PostBinding)
        .read({
          ids: ['p1'],
          fields: ['id', 'comments'],
          principal: null,
          windows: { comments: { first: 1, after: 'c0' } },
        })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records[0]!.values.comments).toEqual({
      refs: ['Comment:c1'],
      hasNext: true,
      hasPrevious: true,
    })
    expect(calls).toHaveLength(3)
    expect(Object.keys(calls[1]!.selection)).toEqual(['body'])

    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(calls[2]!.where as SQL).sql).toContain('"comments"."body" <')
  })

  it('rejects a relation cursor across multiple parents', async () => {
    const { database } = fakeDatabaseQueue([
      [
        { id: 'p1', comments: 'p1' },
        { id: 'p2', comments: 'p2' },
      ],
    ])

    const result = await Effect.runPromise(
      Effect.result(
        source(PostBinding)
          .read({
            ids: ['p1', 'p2'],
            fields: ['id', 'comments'],
            principal: null,
            windows: { comments: { first: 1, after: 'c0' } },
          })
          .pipe(Effect.provideService(DrizzleDatabase, database)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(result.failure.message).toMatch(/cursor needs a single parent/)
  })

  it('rejects a window on a singular relation', async () => {
    const { database } = fakeDatabaseQueue([[{ id: 'p1', name: 'P', owner: 'u1' }]])

    const result = await Effect.runPromise(
      Effect.result(
        source(ProjectBinding)
          .read({
            ids: ['p1'],
            fields: ['id', 'owner'],
            principal: null,
            windows: { owner: { first: 1 } },
          })
          .pipe(Effect.provideService(DrizzleDatabase, database)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.message).toMatch(/singular/)
  })

  it('loads a many-to-many relation through the join table', async () => {
    const { database, calls } = fakeDatabaseQueue([
      [{ id: 'p1', tags: 'p1' }],
      [
        { parent: 'p1', child: 't1' },
        { parent: 'p1', child: 't2' },
      ],
    ])
    const read = source(PostBinding)
    const selection = Selection.make(PostEntity, { id: true, tags: true })

    const records = await Effect.runPromise(
      read
        .read({ ids: ['p1'], fields: selection.fields, principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([{ id: 'p1', values: { id: 'p1', tags: ['Tag:t1', 'Tag:t2'] } }])
    expect(
      Schema.decodeUnknownSync(selection.schema as unknown as Schema.ConstraintDecoder<unknown>)(
        records[0]!.values,
      ),
    ).toEqual({
      id: 'p1',
      tags: [
        { entity: 'Tag', id: 't1' },
        { entity: 'Tag', id: 't2' },
      ],
    })
    expect(calls).toHaveLength(2)
    expect(Object.keys(calls[1]!.selection)).toEqual(['child', 'parent'])
    expect(calls[1]!.innerJoin).toBeDefined()
  })

  it('normalizes mutation returning rows into patches with ref keys', () => {
    const patches = normalize(
      ProjectBinding,
      [{ id: 'p1', name: 'P', owner: 'u1' }],
      ['id', 'name', 'owner'],
    )

    expect(patches).toEqual([
      { entity: 'Project', id: 'p1', values: { id: 'p1', name: 'P', owner: 'User:u1' } },
    ])
  })

  it('applies a relation where filter to the child query', async () => {
    const filtered = entity('Post', posts, {
      relations: {
        comments: many(CommentBinding, {
          foreignKey: comments.postId,
          localKey: posts.id,
          where: eq(comments.body, 'keep'),
        }),
      },
    })
    const { database, calls } = fakeDatabaseQueue([
      [{ id: 'p1', comments: 'p1' }],
      [{ child: 'c1', parent: 'p1' }],
    ])

    await Effect.runPromise(
      source(filtered)
        .read({ ids: ['p1'], fields: ['id', 'comments'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(calls[1]!.where as SQL).sql).toContain('"comments"."body" =')
  })
})
