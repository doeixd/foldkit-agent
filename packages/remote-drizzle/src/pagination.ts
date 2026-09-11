/**
 * Page boundaries for keyset pagination.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 *
 * The executor queries `pageSize + 1` rows. The extra row proves another page
 * exists and is discarded; a boundary is never inferred from row count alone.
 * `rows` must already be in natural order — the executor reverses a backward
 * query before handing rows here.
 */
import type { Traversal } from './cursor.js'

export interface Page<Row> {
  readonly rows: ReadonlyArray<Row>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
  readonly nextCursor: string | undefined
  readonly previousCursor: string | undefined
}

export const buildPage = <Row>({
  rows,
  pageSize,
  traversal,
  cursor,
  cursorOf,
}: {
  readonly rows: ReadonlyArray<Row>
  readonly pageSize: number
  readonly traversal: Traversal
  /** The cursor this page was requested after/before, if any. */
  readonly cursor: string | undefined
  readonly cursorOf: (row: Row) => string
}): Page<Row> => {
  const hasMore = rows.length > pageSize
  const limited =
    traversal === 'backward'
      ? rows.slice(Math.max(0, rows.length - pageSize))
      : rows.slice(0, pageSize)
  const first = limited[0]
  const last = limited.at(-1)
  const afterCursor = cursor !== undefined
  const moreBefore = traversal === 'backward' ? hasMore : afterCursor
  return {
    rows: limited,
    hasNext: traversal === 'backward' ? afterCursor : hasMore,
    hasPrevious: traversal === 'backward' ? hasMore : afterCursor,
    nextCursor: last === undefined ? undefined : cursorOf(last),
    previousCursor: moreBefore && first !== undefined ? cursorOf(first) : undefined,
  }
}
