/**
 * Deriving a page shape from a Remote `QueryWindow`.
 *
 * A window is declarative (`first`/`after` forward, `last`/`before` backward);
 * the adapter needs a traversal, a cursor, and a page size. `before` or `last`
 * selects backward, matching fate's connection semantics (MIT; see
 * `THIRD_PARTY_NOTICES.md`).
 */
import type { QueryWindow } from 'foldkit-remote'
import type { Traversal } from './cursor.js'

export interface WindowShape {
  readonly traversal: Traversal
  readonly cursor: string | undefined
  readonly pageSize: number
}

export const shapeWindow = (window: QueryWindow, defaultSize = 20): WindowShape => {
  const backward = window.before !== undefined || window.last !== undefined
  return {
    traversal: backward ? 'backward' : 'forward',
    cursor: backward ? window.before : window.after,
    pageSize: window.first ?? window.last ?? defaultSize,
  }
}
