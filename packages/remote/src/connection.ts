/**
 * The pure connection model: an ordered normalized structure of edges with
 * explicit known boundaries. Pages, live events, and optimistic inserts are all
 * evidence about one connection; `merge` is the single deterministic reducer and
 * performs no I/O.
 *
 * Optimistic overlays and live state arrive in later phases.
 */
import { entityKey } from './store.js'

export interface EdgeRef {
  readonly entity: string
  readonly id: string
}

/** `key` is the edge identity used for de-duplication. */
export interface Edge {
  readonly key: string
  readonly ref: EdgeRef
}

export const edge = (ref: EdgeRef, key: string = entityKey(ref.entity, ref.id)): Edge => ({
  key,
  ref,
})

export type Cursor = string

export type Boundary =
  | { readonly _tag: 'Terminal' }
  | { readonly _tag: 'Cursor'; readonly cursor: Cursor }
  | { readonly _tag: 'Unknown' }

export const terminal: Boundary = { _tag: 'Terminal' }
export const unknown: Boundary = { _tag: 'Unknown' }
export const cursor = (value: Cursor): Boundary => ({ _tag: 'Cursor', cursor: value })

export interface Segment {
  readonly edges: readonly Edge[]
  readonly start: Boundary
  readonly end: Boundary
}

export interface Connection {
  readonly segments: readonly Segment[]
  readonly stale: boolean
}

export const emptyConnection: Connection = { segments: [], stale: false }

export const segment = (edges: readonly Edge[], start: Boundary, end: Boundary): Segment => ({
  edges,
  start,
  end,
})

const dedupeEdges = (edges: readonly Edge[]): Edge[] => {
  const seen = new Set<string>()
  const out: Edge[] = []
  for (const value of edges) {
    if (seen.has(value.key)) continue
    seen.add(value.key)
    out.push(value)
  }
  return out
}

const normalize = (segment: Segment): Segment => ({ ...segment, edges: dedupeEdges(segment.edges) })

/** Longest suffix of `a` that is a prefix of `b`, matched by edge identity. */
const overlapLength = (a: readonly Edge[], b: readonly Edge[]): number => {
  const most = Math.min(a.length, b.length)
  for (let length = most; length > 0; length--) {
    let matches = true
    for (let i = 0; i < length; i++) {
      if (a[a.length - length + i]!.key !== b[i]!.key) {
        matches = false
        break
      }
    }
    if (matches) return length
  }
  return 0
}

const cursorJoinable = (a: Boundary, b: Boundary): boolean =>
  a._tag === 'Cursor' && b._tag === 'Cursor' && a.cursor === b.cursor

/** Joins `a` immediately before `b`, or returns `undefined` when they are not contiguous. */
const join = (a: Segment, b: Segment): Segment | undefined => {
  if (cursorJoinable(a.end, b.start)) {
    return { edges: dedupeEdges([...a.edges, ...b.edges]), start: a.start, end: b.end }
  }
  const overlap = overlapLength(a.edges, b.edges)
  if (overlap > 0) {
    return {
      edges: dedupeEdges([...a.edges, ...b.edges.slice(overlap)]),
      start: a.start,
      end: b.end,
    }
  }
  return undefined
}

/**
 * Global by edge identity: an edge appears once per connection. Dropping a
 * shared edge from the middle of a segment would otherwise imply that its
 * surviving neighbours are adjacent, so a segment with holes is split at each
 * hole and the new inner boundaries are `Unknown`.
 */
const dedupeConnection = (segments: readonly Segment[]): Segment[] => {
  const seen = new Set<string>()
  const out: Segment[] = []
  for (const segmentValue of segments) {
    const runs: Edge[][] = []
    let run: Edge[] = []
    for (const edgeValue of segmentValue.edges) {
      if (seen.has(edgeValue.key)) {
        if (run.length > 0) {
          runs.push(run)
          run = []
        }
        continue
      }
      seen.add(edgeValue.key)
      run.push(edgeValue)
    }
    if (run.length > 0) runs.push(run)
    if (runs.length === 0) continue
    if (runs.length === 1) {
      out.push({ ...segmentValue, edges: runs[0]! })
      continue
    }
    runs.forEach((edges, index) => {
      out.push({
        edges,
        start: index === 0 ? segmentValue.start : unknown,
        end: index === runs.length - 1 ? segmentValue.end : unknown,
      })
    })
  }
  return out
}

/** Adds a page to the connection, joining contiguous or overlapping segments. */
export const merge = (current: Connection, page: Segment): Connection => {
  // A zero-edge page carries no ordering evidence; joining it would let its
  // boundary overwrite a real segment's end. Ignore it.
  const incoming = normalize(page)
  if (incoming.edges.length === 0) return current

  const segments = [...current.segments.map(normalize), incoming]
  let joined = true
  while (joined) {
    joined = false
    outer: for (let i = 0; i < segments.length; i++) {
      for (let j = 0; j < segments.length; j++) {
        if (i === j) continue
        const result = join(segments[i]!, segments[j]!)
        if (result === undefined) continue
        segments[i] = result
        segments.splice(j, 1)
        joined = true
        break outer
      }
    }
  }
  return { ...current, segments: dedupeConnection(segments) }
}

/** Visible edges, segment by segment. */
export const items = (connection: Connection): ReadonlyArray<Edge> =>
  connection.segments.flatMap(value => value.edges)

/** There is more before the known region. Derived from boundaries, never row count. */
export const hasPrevious = (connection: Connection): boolean => {
  const first = connection.segments[0]
  return first !== undefined && first.start._tag !== 'Terminal'
}

/** There is more after the known region. Derived from boundaries, never row count. */
export const hasNext = (connection: Connection): boolean => {
  const last = connection.segments[connection.segments.length - 1]
  return last !== undefined && last.end._tag !== 'Terminal'
}

/** A connection with more than one segment has an explicit unknown gap. */
export const isGapped = (connection: Connection): boolean => connection.segments.length > 1
