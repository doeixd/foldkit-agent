import { integer, pgTable, PgDialect, text } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { cursorSelection, keysetWhere, type OrderTerm } from '../src/index.js'

const events = pgTable('events', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  rank: integer('rank').notNull(),
})

const render = (
  terms: readonly OrderTerm[],
  values: readonly unknown[],
  traversal: 'forward' | 'backward',
) => {
  const dialect = new PgDialect()
  return dialect.sqlToQuery(
    keysetWhere(terms, values, traversal) as NonNullable<ReturnType<typeof keysetWhere>>,
  )
}

const normalized = (predicate: ReturnType<typeof render>) => predicate.sql.replace(/\s+/g, ' ')

describe('keysetWhere', () => {
  it.each([
    ['asc', 'forward', '>'],
    ['desc', 'forward', '<'],
    ['asc', 'backward', '<'],
    ['desc', 'backward', '>'],
  ] as const)('single %s %s compares with %s', (direction, traversal, comparator) => {
    const predicate = render([{ column: events.id, direction }], ['e1'], traversal)

    expect(normalized(predicate)).toContain(`"events"."id" ${comparator} $1`)
    expect(predicate.params).toEqual(['e1'])
  })

  it('builds lexicographic branches for a multi-column order', () => {
    const terms: ReadonlyArray<OrderTerm> = [
      { column: events.createdAt, direction: 'desc' },
      { column: events.id, direction: 'desc' },
      { column: events.rank, direction: 'asc' },
    ]
    const predicate = render(terms, ['t1', 'e1', 7], 'forward')
    const sql = normalized(predicate)

    expect(sql).toContain('"events"."created_at" < $1')
    expect(sql).toContain('"events"."created_at" = $2')
    expect(sql).toContain('"events"."id" < $3')
    expect(sql).toContain('"events"."created_at" = $4')
    expect(sql).toContain('"events"."id" = $5')
    expect(sql).toContain('"events"."rank" > $6')
    expect(predicate.params).toEqual(['t1', 't1', 'e1', 't1', 'e1', 7])
  })

  it('flips every comparator for a backward traversal', () => {
    const terms: ReadonlyArray<OrderTerm> = [
      { column: events.createdAt, direction: 'desc' },
      { column: events.id, direction: 'asc' },
    ]
    const predicate = render(terms, ['t1', 'e1'], 'backward')
    const sql = normalized(predicate)

    expect(sql).toContain('"events"."created_at" > $1')
    expect(sql).toContain('"events"."created_at" = $2')
    expect(sql).toContain('"events"."id" < $3')
  })

  it('has no predicate without an ordering', () => {
    expect(keysetWhere([], [], 'forward')).toBeUndefined()
  })

  it('reads the ordering columns to reconstruct a cursor tuple', () => {
    expect(
      cursorSelection([
        { column: events.createdAt, direction: 'desc' },
        { column: events.id, direction: 'asc' },
      ]),
    ).toEqual({ created_at: events.createdAt, id: events.id })
  })
})
