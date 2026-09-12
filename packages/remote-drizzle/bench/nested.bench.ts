import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import { bench, describe } from 'vitest'
import { databaseLayer, entity, many, source } from '../src/index.js'

const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite')

const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  createdAt: text('created_at').notNull(),
})

const CommentBinding = entity('Comment', comments)
const ProjectBinding = entity('Project', projects, {
  relations: {
    comments: many(CommentBinding, {
      foreignKey: comments.projectId,
      localKey: projects.id,
      orderBy: [{ column: comments.createdAt, direction: 'asc' }],
    }),
  },
})

const PARENTS = 50
const CHILDREN = 20

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  create table projects (id text primary key, name text not null);
  create table comments (id text primary key, project_id text not null, created_at text not null);
`)
const insertProject = sqlite.prepare('insert into projects values (?, ?)')
const insertComment = sqlite.prepare('insert into comments values (?, ?, ?)')
for (let parent = 0; parent < PARENTS; parent++) {
  insertProject.run(`p${parent}`, `Project ${parent}`)
  for (let child = 0; child < CHILDREN; child++) {
    insertComment.run(`p${parent}-c${child}`, `p${parent}`, String(child).padStart(4, '0'))
  }
}

const database = drizzle({ client: sqlite })
const ids = Array.from({ length: PARENTS }, (_, parent) => `p${parent}`)
const read = source(ProjectBinding)

const run = (fields: ReadonlyArray<string>, windows?: Parameters<typeof read.read>[0]['windows']) =>
  Effect.runPromise(
    read
      .read({ ids, fields, principal: null, ...(windows === undefined ? {} : { windows }) })
      .pipe(Effect.provide(databaseLayer(database))),
  )

describe(`remote-drizzle reads (${PARENTS} parents x ${CHILDREN} children)`, () => {
  bench('flat: 2 scalar fields', async () => {
    await run(['id', 'name'])
  })

  bench('batched many: all children in one IN (...)', async () => {
    await run(['id', 'comments'])
  })

  bench('nested pagination: first 5 children per parent', async () => {
    await run(['id', 'comments'], { comments: { first: 5 } })
  })
})
