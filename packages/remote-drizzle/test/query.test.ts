import { eq, type SQL } from 'drizzle-orm'
import { pgTable, PgDialect, text, uuid } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import { Query } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import {
  DrizzleDatabase,
  entity,
  query,
  type DrizzleDatabaseService,
  type DrizzleStatement,
} from '../src/index.js'

const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  createdAt: text('created_at').notNull(),
})

const ProjectBinding = entity('Project', projects)

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
})

const source = query(ProjectsByOwner, {
  entity: ProjectBinding,
  orderBy: [
    { column: projects.createdAt, direction: 'desc' },
    { column: projects.id, direction: 'desc' },
  ],
  where: input => eq(projects.ownerId, input.ownerId),
})

const fakeDatabase = (batches: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) => {
  const calls: Array<{
    selection: Record<string, unknown>
    where: unknown
    orderBy: ReadonlyArray<unknown> | undefined
    limit: number | undefined
  }> = []
  let index = 0
  const database: DrizzleDatabaseService = {
    select: selection => {
      const rows = batches[index] ?? []
      index += 1
      const call = {
        selection,
        where: undefined as unknown,
        orderBy: undefined as ReadonlyArray<unknown> | undefined,
        limit: undefined as number | undefined,
      }
      calls.push(call)
      const promise = Promise.resolve(rows)
      const statement = {
        where: (condition: unknown) => {
          call.where = condition
          return statement
        },
        orderBy: (...order: ReadonlyArray<unknown>) => {
          call.orderBy = order
          return statement
        },
        limit: (count: number) => {
          call.limit = count
          return statement
        },
        then: promise.then.bind(promise),
      } as unknown as DrizzleStatement
      return { from: () => statement }
    },
  }
  return { database, calls }
}

const run = (
  database: DrizzleDatabaseService,
  window: Parameters<typeof source.run>[0]['window'],
) =>
  Effect.runPromise(
    source
      .run({ input: { ownerId: 'u1' }, window, principal: null })
      .pipe(Effect.provideService(DrizzleDatabase, database)),
  )

describe('RemoteDrizzle.query', () => {
  it('returns a page and a cursor boundary, limiting to pageSize + 1', async () => {
    const { database, calls } = fakeDatabase([
      [
        { id: 'p1', created_at: 't1' },
        { id: 'p2', created_at: 't2' },
        { id: 'p3', created_at: 't3' },
      ],
    ])

    const page = await run(database, { first: 2 })

    expect(page.edges).toEqual([
      { entity: 'Project', id: 'p1', key: 'Project:p1' },
      { entity: 'Project', id: 'p2', key: 'Project:p2' },
    ])
    expect(page.start).toEqual({ _tag: 'Terminal' })
    expect(page.end).toEqual({ _tag: 'Cursor', cursor: 'p2' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.limit).toBe(3)
    expect(Object.keys(calls[0]!.selection)).toEqual(['id', 'created_at'])

    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(calls[0]!.where as SQL).sql).toContain('"projects"."owner_id" =')
    expect(dialect.sqlToQuery(calls[0]!.orderBy![0] as SQL).sql).toContain('desc')
  })

  it('re-reads the cursor tuple and applies the keyset predicate', async () => {
    const { database, calls } = fakeDatabase([
      [{ id: 'p2', created_at: 't2' }],
      [
        { id: 'p3', created_at: 't3' },
        { id: 'p4', created_at: 't4' },
      ],
    ])

    const page = await run(database, { first: 2, after: 'p2' })

    expect(page.edges.map(edge => edge.id)).toEqual(['p3', 'p4'])
    expect(page.start).toEqual({ _tag: 'Cursor', cursor: 'p2' })
    expect(page.end).toEqual({ _tag: 'Terminal' })
    expect(calls).toHaveLength(2)
    expect(Object.keys(calls[0]!.selection)).toEqual(['created_at', 'id'])
    expect(calls[0]!.limit).toBe(1)
    expect(calls[1]!.limit).toBe(3)

    const dialect = new PgDialect()
    const where = dialect.sqlToQuery(calls[1]!.where as SQL).sql
    expect(where).toContain(' or ')
    expect(where).toContain('"projects"."created_at" <')
    expect(where).toContain('"projects"."owner_id" =')
  })

  it('reverses the order for a backward window', async () => {
    const { database, calls } = fakeDatabase([
      [
        { id: 'p5', created_at: 't5' },
        { id: 'p6', created_at: 't6' },
      ],
    ])

    const page = await run(database, { last: 2 })

    expect(page.edges.map(edge => edge.id)).toEqual(['p5', 'p6'])
    expect(page.start).toEqual({ _tag: 'Terminal' })
    expect(page.end).toEqual({ _tag: 'Terminal' })

    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(calls[0]!.orderBy![0] as SQL).sql).toContain('asc')
  })
})
