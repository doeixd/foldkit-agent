/**
 * Keyset (cursor) pagination over Drizzle.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 *
 * The cursor is opaque and is the row's identity: the executor re-reads the
 * ordering columns for that row and builds the predicate from those values, so
 * the wire cursor stays a string regardless of the ordered column types.
 *
 * NULL handling follows Postgres' default ordering (ASC: nulls last, DESC:
 * nulls first), so a nullable ordering column sorts and pages correctly rather
 * than emitting `col > NULL`.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm'

export interface OrderTerm {
  readonly column: AnyColumn
  readonly direction: 'asc' | 'desc'
}

export type Traversal = 'forward' | 'backward'

/** Equality that treats a null cursor value as `IS NULL`, not `= NULL`. */
const cursorEquality = (column: AnyColumn, value: unknown): SQL =>
  value === null ? isNull(column) : eq(column, value)

/**
 * Rows after (forward) or before (backward) the cursor on one column. `false`
 * means no row qualifies: with nulls last (ASC), nothing follows a null cursor;
 * with nulls first (DESC), nothing precedes one.
 */
const cursorCompare = (
  column: AnyColumn,
  direction: OrderTerm['direction'],
  value: unknown,
  traversal: Traversal,
): SQL => {
  const ascending = direction === 'asc'
  const forward = traversal === 'forward'
  if (value === null) {
    return (forward ? !ascending : ascending) ? isNotNull(column) : sql`false`
  }
  if (forward) {
    return ascending ? or(gt(column, value), isNull(column))! : lt(column, value)
  }
  return ascending ? lt(column, value) : or(gt(column, value), isNull(column))!
}

/**
 * `(a CMP A) OR (a = A AND b CMP B) OR ...` — the lexicographic predicate that
 * keeps a page contiguous under a multi-column order. `forward` selects rows
 * after the cursor; `backward` before it.
 */
export const keysetWhere = (
  terms: readonly OrderTerm[],
  values: readonly unknown[],
  traversal: Traversal,
): SQL | undefined => {
  if (terms.length === 0) return undefined
  const branches = terms.map((term, index) => {
    const equalities = terms
      .slice(0, index)
      .map((previous, previousIndex) => cursorEquality(previous.column, values[previousIndex]))
    const branch = cursorCompare(term.column, term.direction, values[index], traversal)
    return equalities.length === 0 ? branch : and(...equalities, branch)!
  })
  return branches.length === 1 ? branches[0] : or(...branches)
}

/** The `ORDER BY` for a traversal: backward reverses each term. */
export const orderByTerms = (
  terms: readonly OrderTerm[],
  traversal: Traversal,
): ReadonlyArray<SQL> =>
  terms.map(term =>
    (term.direction === 'asc') === (traversal === 'forward') ? asc(term.column) : desc(term.column),
  )

/** The tuple columns to re-read for a cursor, keyed as Drizzle select aliases. */
export const cursorSelection = (terms: readonly OrderTerm[]): Record<string, AnyColumn> =>
  Object.fromEntries(terms.map(term => [term.column.name, term.column]))
