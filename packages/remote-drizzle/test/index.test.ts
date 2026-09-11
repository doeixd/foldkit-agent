import { eq, sql } from 'drizzle-orm'
import { text, uuid, pgTable, PgDialect } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import { Entity, Selection } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import {
  entity,
  keysetWhere,
  orderByTerms,
  queryPlan,
  reader,
  relationsFor,
  requiredColumns,
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

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, name: Schema.String, owner: User.schema }),
)

const UserBinding = entity('User', users)
const ProjectBinding = entity('Project', projects, {
  relations: { owner: { entity: UserBinding, field: projects.ownerId } },
})

describe('RemoteDrizzle', () => {
  it('derives an Entity Schema from the table', () => {
    const row = { id: '123e4567-e89b-42d3-a456-426614174000', name: 'Ada', email: 'a@b.c' }

    expect(Schema.decodeUnknownSync(UserBinding.Schema)(row)).toEqual(row)
  })

  it('always projects the primary key, selected fields, and relation keys', () => {
    expect(requiredColumns(UserBinding, ['name']).map(column => column.name)).toEqual([
      'id',
      'name',
    ])
    expect(requiredColumns(ProjectBinding, ['id', 'owner']).map(column => column.name)).toEqual([
      'id',
      'owner_id',
    ])
    expect(requiredColumns(UserBinding, ['id', 'name']).map(column => column.name)).toEqual([
      'id',
      'name',
    ])
  })

  it('folds ordering columns into the projection', () => {
    const columns = requiredColumns(ProjectBinding, ['id'], {
      order: [{ column: projects.createdAt, direction: 'desc' }],
    }).map(column => column.name)

    expect(columns).toEqual(['id', 'created_at'])
  })

  it('separates relation fields from scalar columns', () => {
    const selection = Selection.make(Project, {
      id: true,
      owner: Selection.make(User, { id: true, name: true }),
    })

    expect(requiredColumns(ProjectBinding, selection.fields).map(column => column.name)).toEqual([
      'id',
      'owner_id',
    ])
    expect(relationsFor(ProjectBinding, selection).map(relation => relation.entity.name)).toEqual([
      'User',
    ])
  })

  it('batches ids into one IN and prunes the column list', () => {
    const dialect = new PgDialect()
    const predicate = dialect.sqlToQuery(whereIds(UserBinding, ['a', 'b']))

    expect(predicate.sql).toContain('"users"."id" in')
    expect(predicate.params).toEqual(['a', 'b'])
    expect(
      queryPlan(UserBinding, Selection.make(User, { id: true, name: true })).columns.map(
        column => column.name,
      ),
    ).toEqual(['id', 'name'])
  })

  it('combines a filter, a keyset cursor, and the ordering columns', () => {
    const dialect = new PgDialect()
    const order = [
      { column: projects.createdAt, direction: 'desc' as const },
      { column: projects.id, direction: 'desc' as const },
    ]
    const plan = queryPlan(ProjectBinding, Selection.make(Project, { id: true }), {
      where: eq(projects.name, 'x'),
      cursor: keysetWhere(order, ['t1', 'p1'], 'forward'),
      order,
      limit: 25,
    })

    expect(plan.limit).toBe(25)
    expect(plan.columns.map(column => column.name)).toEqual(['id', 'created_at'])
    expect(dialect.sqlToQuery(plan.where as NonNullable<typeof plan.where>).sql).toContain('and')
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

  it('queryPlan with no options has no where and no limit', () => {
    const plan = queryPlan(UserBinding, Selection.make(User, { id: true }))
    expect(plan.where).toBeUndefined()
    expect(plan.limit).toBeUndefined()
    expect(plan.columns.map(column => column.name)).toEqual(['id'])
  })

  it('throws a clear error when the table has no id column', () => {
    const legs = pgTable('legs', { key: text('key').primaryKey() })
    const Leg = entity('Leg', legs)

    expect(() => requiredColumns(Leg, ['key'])).toThrow(/no "id" column/)
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
})
