/**
 * Deriving a page shape from a Remote `QueryWindow`.
 *
 * A window is declarative (`first`/`after` forward, `last`/`before` backward);
 * the adapter needs a traversal, a cursor, and a page size. `before` or `last`
 * selects backward, matching fate's connection semantics (MIT; see
 * `THIRD_PARTY_NOTICES.md`).
 *
 * The window is client-supplied, so the size is clamped: a non-integer or
 * negative request falls back to the default, `0` is honored (a page of
 * boundaries only), and no request may exceed `maxSize` (a huge page would
 * otherwise reach the database as a huge LIMIT).
 */
import type { QueryWindow } from 'foldkit-remote'
import type { Traversal } from './cursor.js'

export interface WindowShape {
  readonly traversal: Traversal
  readonly cursor: string | undefined
  readonly pageSize: number
}

export interface WindowOptions {
  readonly defaultSize?: number | undefined
  readonly maxSize?: number | undefined
}

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_MAX_PAGE_SIZE = 100

export const shapeWindow = (window: QueryWindow, options: WindowOptions = {}): WindowShape => {
  const fallback = options.defaultSize ?? DEFAULT_PAGE_SIZE
  const max = options.maxSize ?? DEFAULT_MAX_PAGE_SIZE
  const requested = window.first ?? window.last
  const pageSize =
    typeof requested === 'number' && Number.isInteger(requested) && requested >= 0
      ? requested
      : fallback

  const backward = window.before !== undefined || window.last !== undefined
  return {
    traversal: backward ? 'backward' : 'forward',
    cursor: backward ? window.before : window.after,
    pageSize: Math.min(pageSize, max),
  }
}
