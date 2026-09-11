/**
 * Keyset (cursor) pagination over Drizzle.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 *
 * The cursor is opaque and is the row's identity: the executor re-reads the
 * ordering columns for that row and builds the predicate from those values, so
 * the wire cursor stays a string regardless of the ordered column types.
 */
import { and, asc, desc, eq, gt, lt, or, type AnyColumn, type SQL } from 'drizzle-orm'

export interface OrderTerm {
  readonly column: AnyColumn
  readonly direction: 'asc' | 'desc'
}

export type Traversal = 'forward' | 'backward'

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
  const forward = traversal === 'forward'
  const branches = terms.map((term, index) => {
    const ascending = term.direction === 'asc'
    const compare = ascending === forward ? gt : lt
    const equalities = terms
      .slice(0, index)
      .map((previous, previousIndex) => eq(previous.column, values[previousIndex]))
    const branch = compare(term.column, values[index])
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

/** The columns the executor reads to reconstruct a cursor's ordering tuple. */
export const cursorColumns = (terms: readonly OrderTerm[]): ReadonlyArray<AnyColumn> =>
  terms.map(term => term.column)
