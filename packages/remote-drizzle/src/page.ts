/**
 * Mapping a page of rows to a Remote `QueryPage`.
 *
 * The cursor is the row identity. Boundaries advertise the known region so
 * `Connection.merge` can join pages: a forward page starts at the cursor it was
 * requested after and ends at its last row when another page exists; a backward
 * page is the mirror image. A boundary is never inferred from a row count.
 */
import { cursor as cursorBoundary, entityKey, terminal, type Boundary } from 'foldkit-remote'
import type { Traversal } from './cursor.js'
import { buildPage } from './pagination.js'

export interface QueryEdge {
  readonly entity: string
  readonly id: string
  readonly key: string
}

export interface QueryPage {
  readonly edges: ReadonlyArray<QueryEdge>
  readonly start: Boundary
  readonly end: Boundary
}

export const toQueryPage = <Row>({
  entity,
  rows,
  pageSize,
  traversal,
  cursor,
  cursorOf,
}: {
  readonly entity: string
  readonly rows: ReadonlyArray<Row>
  readonly pageSize: number
  readonly traversal: Traversal
  readonly cursor: string | undefined
  readonly cursorOf: (row: Row) => string
}): QueryPage => {
  const page = buildPage({ rows, pageSize, traversal, cursor, cursorOf })
  const edges = page.rows.map(row => {
    const id = cursorOf(row)
    return { entity, id, key: entityKey(entity, id) }
  })
  const first = page.rows[0]
  const last = page.rows.at(-1)

  const start: Boundary =
    traversal === 'forward'
      ? cursor === undefined
        ? terminal
        : cursorBoundary(cursor)
      : page.hasPrevious && first !== undefined
        ? cursorBoundary(cursorOf(first))
        : terminal
  const end: Boundary =
    traversal === 'forward'
      ? page.hasNext && last !== undefined
        ? cursorBoundary(cursorOf(last))
        : terminal
      : cursor === undefined
        ? terminal
        : cursorBoundary(cursor)

  return { edges, start, end }
}
