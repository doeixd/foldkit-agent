import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Schema } from 'effect'
import { Query } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import {
  databaseLayer,
  entity,
  many,
  manyToMany,
  one,
  query,
  source,
  type AnyEntityBinding,
} from '../src/index.js'

// Vite rewrites a static `node:sqlite` import to `sqlite`; load it at the boundary.
const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite')

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  createdAt: text('created_at').notNull(),
})

const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  projectId: text('project_id').notNull(),
  createdAt: text('created_at').notNull(),
})

const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const postTags = sqliteTable('post_tags', {
  postId: text('post_id').notNull(),
  tagId: text('tag_id').notNull(),
})

const UserBinding = entity('User', users)
const CommentBinding = entity('Comment', comments)
const ProjectBinding = entity('Project', projects, {
  relations: {
    owner: one(UserBinding, { field: projects.ownerId, nullable: true }),
    comments: many(CommentBinding, {
      foreignKey: comments.projectId,
      localKey: projects.id,
      orderBy: [{ column: comments.createdAt, direction: 'asc' }],
    }),
  },
  computed: { commentCount: { relation: 'comments' } },
})

const TagBinding = entity('Tag', tags)
const TaggedProject = entity('Project', projects, {
  relations: {
    tags: manyToMany(TagBinding, {
      through: postTags,
      localColumn: postTags.postId,
      foreignColumn: postTags.tagId,
    }),
  },
})

const Projects = Query.make('Projects', {
  Input: Schema.Struct({}),
  Result: Query.connection({ name: 'Project' }),
})

const setup = () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    create table users (id text primary key, name text not null);
    create table projects (id text primary key, name text not null, owner_id text, created_at text not null);
    create table comments (id text primary key, body text not null, project_id text not null, created_at text not null);
    create table tags (id text primary key, name text not null);
    create table post_tags (post_id text not null, tag_id text not null);
    insert into users values ('u1', 'Ada'), ('u2', 'Grace');
    insert into projects values ('p1', 'Alpha', 'u1', '2020-01-01'), ('p2', 'Beta', 'u1', '2020-01-02'), ('p3', 'Gamma', null, '2020-01-03');
    insert into comments values ('c1', 'a', 'p1', '2020-01-01'), ('c2', 'b', 'p1', '2020-01-02'), ('c3', 'c', 'p2', '2020-01-01');
    insert into tags values ('t1', 'TypeScript'), ('t2', 'Databases');
    insert into post_tags values ('p1', 't1'), ('p1', 't2'), ('p2', 't1');
  `)
  return { sqlite, database: drizzle({ client: sqlite }) }
}

const read = (
  binding: AnyEntityBinding,
  database: unknown,
  context: Parameters<ReturnType<typeof source>['read']>[0],
) =>
  Effect.runPromise(
    source(binding)
      .read(context)
      .pipe(Effect.provide(databaseLayer(database))),
  )

describe('RemoteDrizzle against in-process SQLite', () => {
  it('reads refs, a child list, and a computed count from real SQL', async () => {
    const { sqlite, database } = setup()
    try {
      const records = await read(ProjectBinding, database, {
        ids: ['p1'],
        fields: ['id', 'name', 'owner', 'comments', 'commentCount'],
        principal: null,
      })

      expect(records).toEqual([
        {
          id: 'p1',
          values: {
            id: 'p1',
            name: 'Alpha',
            owner: 'User:u1',
            comments: ['Comment:c1', 'Comment:c2'],
            commentCount: 2,
          },
        },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('emits null for a null one relation', async () => {
    const { sqlite, database } = setup()
    try {
      const records = await read(ProjectBinding, database, {
        ids: ['p3'],
        fields: ['id', 'owner'],
        principal: null,
      })
      expect(records[0]!.values.owner).toBeNull()
    } finally {
      sqlite.close()
    }
  })

  it('loads a many-to-many relation from real SQL', async () => {
    const { sqlite, database } = setup()
    try {
      const records = await read(TaggedProject, database, {
        ids: ['p1'],
        fields: ['id', 'tags'],
        principal: null,
      })
      expect(records[0]!.values.tags).toEqual(['Tag:t1', 'Tag:t2'])
    } finally {
      sqlite.close()
    }
  })

  it('counts with a where against real SQL', async () => {
    const counted = entity('Project', projects, {
      relations: {
        comments: many(CommentBinding, { foreignKey: comments.projectId, localKey: projects.id }),
      },
      computed: { aCount: { relation: 'comments', where: eq(comments.body, 'a') } },
    })
    const { sqlite, database } = setup()
    try {
      const records = await read(counted, database, {
        ids: ['p1'],
        fields: ['id', 'aCount'],
        principal: null,
      })
      expect(records[0]!.values.aCount).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('applies a principal-scoped relation filter against real SQL', async () => {
    const { sqlite, database } = setup()
    try {
      const records = await Effect.runPromise(
        source(ProjectBinding, {
          policies: { comments: (principal: string) => eq(comments.body, principal) },
        })
          .read({ ids: ['p1'], fields: ['id', 'comments'], principal: 'a' })
          .pipe(Effect.provide(databaseLayer(database))),
      )
      expect(records[0]!.values.comments).toEqual(['Comment:c1'])
    } finally {
      sqlite.close()
    }
  })

  it('pages a windowed relation with a first window and an after cursor', async () => {
    const { sqlite, database } = setup()
    try {
      const first = await read(ProjectBinding, database, {
        ids: ['p1'],
        fields: ['id', 'comments'],
        principal: null,
        windows: { comments: { first: 1 } },
      })
      expect(first[0]!.values.comments).toEqual({
        refs: ['Comment:c1'],
        hasNext: true,
        hasPrevious: false,
      })

      const second = await read(ProjectBinding, database, {
        ids: ['p1'],
        fields: ['id', 'comments'],
        principal: null,
        windows: { comments: { first: 1, after: 'Comment:c1' } },
      })
      expect(second[0]!.values.comments).toEqual({
        refs: ['Comment:c2'],
        hasNext: false,
        hasPrevious: true,
      })
    } finally {
      sqlite.close()
    }
  })

  it('pages a keyset query forward and backward over real rows', async () => {
    const { sqlite, database } = setup()
    try {
      const source_ = query(Projects, {
        entity: ProjectBinding,
        orderBy: [{ column: projects.createdAt, direction: 'asc' }],
      })
      const run = (window: Parameters<typeof source_.run>[0]['window']) =>
        Effect.runPromise(
          source_
            .run({ input: {}, window, principal: null })
            .pipe(Effect.provide(databaseLayer(database))),
        )

      expect((await run({ first: 2 })).edges.map(edge => edge.id)).toEqual(['p1', 'p2'])
      expect((await run({ first: 2, after: 'p2' })).edges.map(edge => edge.id)).toEqual(['p3'])
      expect((await run({ last: 2 })).edges.map(edge => edge.id)).toEqual(['p2', 'p3'])
    } finally {
      sqlite.close()
    }
  })
})
