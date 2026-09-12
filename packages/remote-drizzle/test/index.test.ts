import { sql } from 'drizzle-orm'
import { text, uuid, pgTable, PgDialect } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import { Selection } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import {
  entity,
  one,
  orderByTerms,
  reader,
  selectColumns,
  whereIds,
  type SourceQuery,
} from '../src/index.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})
const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  ownerId: uuid('owner_id').notNull(),
})

const UserBinding = entity('User', users)
const ProjectBinding = entity('Project', projects, {
  relations: { owner: one(UserBinding, { field: projects.ownerId }) },
})

describe('RemoteDrizzle', () => {
  it('derives an Entity Schema from the table', () => {
    const row = { id: '123e4567-e89b-42d3-a456-426614174000', name: 'Ada', email: 'a@b.c' }

    expect(Schema.decodeUnknownSync(UserBinding.schema)(row)).toEqual(row)
  })

  it('always projects the primary key, selected fields, and relation keys', () => {
    expect(Object.keys(selectColumns(UserBinding, ['name']))).toEqual(['id', 'name'])
    expect(Object.keys(selectColumns(ProjectBinding, ['id', 'owner']))).toEqual(['id', 'owner'])
    expect(Object.keys(selectColumns(UserBinding, ['id', 'name']))).toEqual(['id', 'name'])
  })

  it('separates relation fields from scalar columns', () => {
    const selection = Selection.make(ProjectBinding, { id: true, name: true, owner: true })

    expect(Object.keys(selectColumns(ProjectBinding, selection.fields))).toEqual([
      'id',
      'name',
      'owner',
    ])
    expect(ProjectBinding.relations.owner.entity.name).toBe('User')
  })

  it('batches ids into one IN and prunes the column list', () => {
    const dialect = new PgDialect()
    const predicate = dialect.sqlToQuery(whereIds(UserBinding, ['a', 'b']))

    expect(predicate.sql).toContain('"users"."id" in')
    expect(predicate.params).toEqual(['a', 'b'])
    expect(Object.keys(selectColumns(UserBinding, ['id', 'name']))).toEqual(['id', 'name'])
  })

  it('prunes to allowed fields, batches ids, and normalizes records', async () => {
    const calls: SourceQuery[] = []
    const read = reader(UserBinding, query => {
      calls.push(query)
      return Effect.succeed([{ id: 'a', name: 'A' }])
    })

    const records = await Effect.runPromise(
      read({ ids: ['a', 'b'], fields: ['id', 'name'], principal: null }),
    )
    expect(records).toEqual([{ id: 'a', values: { id: 'a', name: 'A' } }])
    expect(Object.keys(calls[0]!.columns)).toEqual(['id', 'name'])
  })

  it('selects the primary key even when it is not a requested field', async () => {
    const calls: SourceQuery[] = []
    const read = reader(UserBinding, query => {
      calls.push(query)
      return Effect.succeed([{ id: 'a', name: 'A' }])
    })

    const records = await Effect.runPromise(read({ ids: ['a'], fields: ['name'], principal: null }))
    expect(records[0]!.id).toBe('a')
    expect(Object.keys(calls[0]!.columns)).toEqual(['id', 'name'])
  })

  it('does no work for empty ids or a selection with nothing to project', async () => {
    let called = false
    const read = reader(UserBinding, () => {
      called = true
      return Effect.succeed([])
    })

    expect(await Effect.runPromise(read({ ids: [], fields: ['id'], principal: null }))).toEqual([])
    expect(
      await Effect.runPromise(read({ ids: ['a'], fields: ['owner'], principal: null })),
    ).toEqual([])
    expect(called).toBe(false)
  })

  it('throws a clear error when the table has no id column', () => {
    const legs = pgTable('legs', { key: text('key').primaryKey() })
    const Leg = entity('Leg', legs)

    expect(() => selectColumns(Leg, ['key'])).toThrow(/no "id" column/)
    expect(() => whereIds(Leg, ['a'])).toThrow(/no "id" column/)
  })

  it('reverses the order for a backward traversal', () => {
    const dialect = new PgDialect()
    const order = [
      { column: projects.createdAt, direction: 'desc' as const },
      { column: projects.id, direction: 'asc' as const },
    ]
    const render = (traversal: 'forward' | 'backward') =>
      dialect.sqlToQuery(
        sql`select * from projects order by ${sql.join(
          [...orderByTerms(order, traversal)],
          sql`, `,
        )}`,
      ).sql

    expect(render('forward')).toContain('"created_at" desc')
    expect(render('forward')).toContain('"id" asc')
    expect(render('backward')).toContain('"created_at" asc')
    expect(render('backward')).toContain('"id" desc')
  })

  it('rejects a relation whose name collides with a column', () => {
    expect(() =>
      entity('Project', projects, {
        relations: { name: one(UserBinding, { field: projects.ownerId }) },
      }),
    ).toThrow(/collides with a column/)
  })

  it('rejects a nullable relation not declared nullable', () => {
    const articles = pgTable('articles', {
      id: text('id').primaryKey(),
      authorId: text('author_id'),
    })

    expect(() =>
      entity('Article', articles, {
        relations: { author: one(UserBinding, { field: articles.authorId }) },
      }),
    ).toThrow(/points at a nullable column/)

    expect(() =>
      entity('Article', articles, {
        relations: { author: one(UserBinding, { field: articles.authorId, nullable: true }) },
      }),
    ).not.toThrow()
  })

  it('rejects a computed field that collides or names a non-collection relation', () => {
    expect(() =>
      entity('Project', projects, {
        relations: { owner: one(UserBinding, { field: projects.ownerId }) },
        computed: { name: { relation: 'owner' } },
      }),
    ).toThrow(/collides with a column or relation/)

    expect(() =>
      entity('Project', projects, {
        computed: { ownerCount: { relation: 'missing' } },
      }),
    ).toThrow(/needs a collection relation/)

    expect(() =>
      entity('Project', projects, {
        relations: { owner: one(UserBinding, { field: projects.ownerId }) },
        computed: { ownerCount: { relation: 'owner' } },
      }),
    ).toThrow(/needs a collection relation/)
  })
})
