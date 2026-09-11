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

  it.each([
    ['asc', 'forward', null, ['false'], [], []],
    ['asc', 'forward', 'v', ['> $1', 'is null'], [], ['v']],
    ['asc', 'backward', null, ['is not null'], [], []],
    ['asc', 'backward', 'v', ['< $1'], ['is null'], ['v']],
    ['desc', 'forward', null, ['is not null'], [], []],
    ['desc', 'forward', 'v', ['< $1'], ['is null'], ['v']],
    ['desc', 'backward', null, ['false'], [], []],
    ['desc', 'backward', 'v', ['> $1', 'is null'], [], ['v']],
  ] as const)('handles nulls: %s %s %s', (direction, traversal, value, present, absent, params) => {
    const predicate = render([{ column: events.id, direction }], [value], traversal)
    const sql = normalized(predicate)
    for (const part of present) expect(sql).toContain(part)
    for (const part of absent) expect(sql).not.toContain(part)
    expect(predicate.params).toEqual([...params])
  })

  it('uses IS NULL for a null equality in a multi-column order', () => {
    const predicate = render(
      [
        { column: events.createdAt, direction: 'desc' },
        { column: events.id, direction: 'asc' },
      ],
      [null, 'e1'],
      'forward',
    )
    const sql = normalized(predicate)

    expect(sql).toContain('"events"."created_at" is not null')
    expect(sql).toContain('"events"."created_at" is null')
    expect(sql).toContain('"events"."id" > $1')
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
