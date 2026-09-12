import { createRequire } from 'node:module'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect } from 'effect'
import {
  REMOTE_PROTOCOL_VERSION,
  Remote,
  Selection,
  emptyStore,
  type BoundRemote,
  type RemoteModel,
} from 'foldkit-remote'
import { RemoteServer } from 'foldkit-remote-server'
import { describe, expect, it } from 'vitest'
import { databaseLayer, entity, many, one, source } from '../src/index.js'

const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite')

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})
const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
})
const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  projectId: text('project_id').notNull(),
  authorId: text('author_id').notNull(),
})

const User = entity('User', users)
const Comment = entity('Comment', comments, {
  relations: { author: one(User, { field: comments.authorId }) },
})
const Project = entity('Project', projects, {
  relations: {
    owner: one(User, { field: projects.ownerId }),
    comments: many(Comment, { foreignKey: comments.projectId, localKey: projects.id }),
  },
})

const UserName = Selection.make(User, { name: true })
const ProjectCard = Selection.make(Project, {
  name: true,
  owner: UserName,
  comments: Selection.make(Comment, { body: true, author: UserName }),
})

/** Seeds `count` projects, each with two comments by different authors. */
const setup = (count: number) => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    create table users (id text primary key, name text not null);
    create table projects (id text primary key, name text not null, owner_id text not null);
    create table comments (id text primary key, body text not null, project_id text not null, author_id text not null);
    insert into users values ('u1', 'Ada'), ('u2', 'Grace'), ('u3', 'Linus');
  `)
  for (let i = 1; i <= count; i++) {
    sqlite.exec(`
      insert into projects values ('p${i}', 'Project ${i}', 'u1');
      insert into comments values ('c${i}a', 'a', 'p${i}', 'u2'), ('c${i}b', 'b', 'p${i}', 'u3');
    `)
  }
  const statements: string[] = []
  const database = drizzle({
    client: sqlite,
    logger: { logQuery: query => void statements.push(query) },
  })
  return { sqlite, database, statements }
}

const readCards = async (count: number) => {
  const { sqlite, database, statements } = setup(count)
  try {
    const server = RemoteServer.make({
      entities: [source(Project), source(Comment), source(User)],
    })
    const projections = Array.from({ length: count }, (_, i) =>
      Remote.select({} as BoundRemote<unknown, RemoteModel>, ProjectCard)(`p${i + 1}`),
    )
    const requests = projections.flatMap(projection => projection.requirements)
    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
        .pipe(Effect.provide(databaseLayer(database))),
    )
    const store = Remote.writeRead(emptyStore, requests, result)
    const bound = {
      store: { get: () => ({ ...store, entities: store }) },
    } as unknown as BoundRemote<unknown, RemoteModel>
    return {
      statements: statements.length,
      entities: result.entities.length,
      cards: projections.map((_, i) =>
        Remote.select(bound, ProjectCard)(`p${i + 1}`).read(undefined),
      ),
    }
  } finally {
    sqlite.close()
  }
}

const PagedCard = Selection.make(Project, {
  name: true,
  comments: Selection.connection(Comment, { first: 1 }, Selection.make(Comment, { body: true })),
})

const readPaged = async (count: number) => {
  const { sqlite, database, statements } = setup(count)
  try {
    const server = RemoteServer.make({ entities: [source(Project), source(Comment)] })
    const requests = Array.from({ length: count }, (_, i) =>
      Remote.select({} as BoundRemote<unknown, RemoteModel>, PagedCard)(`p${i + 1}`),
    ).flatMap(projection => projection.requirements)
    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
        .pipe(Effect.provide(databaseLayer(database))),
    )
    const store = Remote.writeRead(emptyStore, requests, result)
    const bound = {
      store: { get: () => ({ ...store, entities: store }) },
    } as unknown as BoundRemote<unknown, RemoteModel>
    return {
      statements: statements.length,
      cards: Array.from({ length: count }, (_, i) =>
        Remote.select(bound, PagedCard)(`p${i + 1}`).read(undefined),
      ),
    }
  } finally {
    sqlite.close()
  }
}

describe('RemoteDrizzle nested graph over SQLite', () => {
  it('resolves a nested selection through real SQL and Remote.select reads it', async () => {
    const { cards, entities } = await readCards(1)
    expect(entities).toBe(1 + 1 + 2 + 2)
    expect(cards[0]).toEqual({
      _tag: 'Ready',
      value: {
        name: 'Project 1',
        owner: { name: 'Ada' },
        comments: [
          { body: 'a', author: { name: 'Grace' } },
          { body: 'b', author: { name: 'Linus' } },
        ],
      },
    })
  })

  it('runs one statement per level and entity, however many parents', async () => {
    const one = await readCards(1)
    const five = await readCards(5)
    // projects, comments-by-project, owners, comments-by-id, authors
    expect(one.statements).toBe(5)
    expect(five.statements).toBe(one.statements)
    expect(five.cards.every(card => card._tag === 'Ready')).toBe(true)
  })
})

describe('RemoteDrizzle windowed nested relation over SQLite', () => {
  it('pages every parent in one ranked statement, however many parents', async () => {
    const one = await readPaged(1)
    const five = await readPaged(5)
    // projects, one ranked comments statement, comment bodies
    expect(one.statements).toBe(3)
    expect(five.statements).toBe(one.statements)
    expect(five.cards.map(card => card._tag)).toEqual(Array(5).fill('Ready'))
    expect(five.cards[4]).toEqual({
      _tag: 'Ready',
      value: {
        name: 'Project 5',
        comments: { items: [{ body: 'a' }], hasNext: true, hasPrevious: false },
      },
    })
  })
})
