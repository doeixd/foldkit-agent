/**
 * Runnable adapter demo: real SQL in, normalized Remote values out. No external
 * service — it seeds an in-memory `node:sqlite` database.
 *
 * One `entity` declaration serves both the Drizzle source and the Remote
 * `Selection`; the read returns ref keys on the wire, and the same Selection
 * schema decodes them into refs, exactly as `Remote.select` does in an app.
 *
 *   pnpm exec tsx packages/remote-drizzle/example/nested.ts
 */
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Schema } from 'effect'
import { Query, Remote, Selection } from 'foldkit-remote'
import { databaseLayer, entity, many, one, query, source } from '../src/index.js'

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

// One declaration per entity: the binding is also the Remote EntityDescriptor.
const User = entity('User', users)
const Comment = entity('Comment', comments)
const Project = entity('Project', projects, {
  relations: {
    owner: one(User, { field: projects.ownerId, nullable: true }),
    comments: many(Comment, {
      foreignKey: comments.projectId,
      localKey: projects.id,
      orderBy: [{ column: comments.createdAt, direction: 'asc' }],
    }),
  },
  computed: { commentCount: { relation: 'comments' } },
})

const Data = Remote.make({ entities: [User, Comment, Project] })

// A Selection selects columns, a ref, an array of refs, and a computed count.
const ProjectView = Selection.make(Project, {
  id: true,
  name: true,
  owner: true,
  comments: true,
  commentCount: true,
})

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  create table users (id text primary key, name text not null);
  create table projects (id text primary key, name text not null, owner_id text, created_at text not null);
  create table comments (id text primary key, body text not null, project_id text not null, created_at text not null);
  insert into users values ('u1', 'Ada'), ('u2', 'Grace');
  insert into projects values ('p1', 'Alpha', 'u1', '2020-01-01'), ('p2', 'Beta', 'u1', '2020-01-02'), ('p3', 'Gamma', null, '2020-01-03'), ('p4', 'Delta', 'u1', '2020-01-04');
  insert into comments values ('c1', 'first', 'p1', '2020-01-01'), ('c2', 'second', 'p1', '2020-01-02'), ('c3', 'third', 'p2', '2020-01-01');
`)

const Projects = Query.make('Projects', {
  Input: Schema.Struct({ owner: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
})
const ProjectsByOwner = query(Projects, {
  entity: Project,
  orderBy: [{ column: projects.createdAt, direction: 'asc' }],
  where: input => eq(projects.ownerId, input.owner),
})

const projectSource = source(Project)

const program = Effect.gen(function* () {
  console.log('registered     ', [...Data.registry.entities.keys()].join(', '))

  // A read: a ref, a child list, and a computed count in one round trip. The
  // wire carries ref keys; the Selection schema decodes them to refs.
  const read = yield* projectSource.read({
    ids: ['p1'],
    fields: ProjectView.fields,
    principal: null,
  })
  const wire = read[0]?.values ?? {}
  console.log('wire           ', JSON.stringify(wire))
  console.log('decoded        ', JSON.stringify(Schema.decodeUnknownSync(ProjectView.schema)(wire)))

  // A nested page: one bounded query, with a continuation signal.
  const page = yield* projectSource.read({
    ids: ['p1'],
    fields: ['id', 'comments'],
    principal: null,
    windows: { comments: { first: 1 } },
  })
  console.log('relation page  ', JSON.stringify(page[0]?.values))

  // A keyset query: the second page after a cursor.
  const connection = yield* ProjectsByOwner.run({
    input: { owner: 'u1' },
    window: { first: 2 },
    principal: null,
  })
  console.log('query page 1   ', connection.edges.map(edge => edge.id).join(', '))

  const next = yield* ProjectsByOwner.run({
    input: { owner: 'u1' },
    window: { first: 2, after: connection.edges[1]?.id },
    principal: null,
  })
  console.log('query page 2   ', next.edges.map(edge => edge.id).join(', '))
})

await Effect.runPromise(Effect.provide(program, databaseLayer(drizzle({ client: sqlite }))))
sqlite.close()
