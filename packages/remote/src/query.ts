/**
 * Queries and connections. A connection's identity is its descriptor plus the
 * canonical encoded filter/sort input — **never** the pagination window, so
 * `first(25)` and `after(cursor).first(25)` address the same logical connection.
 */
import { Schema } from 'effect'
import type { Cursor } from './connection.js'

export type LiveInsertion = 'visible' | 'boundary' | 'invalidate' | 'ignore'

export interface LivePolicy {
  readonly prepend?: LiveInsertion
  readonly append?: LiveInsertion
}

export interface ConnectionSpec {
  readonly entity: string
  readonly edgeKey?: Schema.Schema<unknown>
  readonly live?: LivePolicy
}

export interface QueryWindow {
  readonly first?: number
  readonly last?: number
  readonly after?: Cursor
  readonly before?: Cursor
}

export interface QueryRef<Name extends string, Input> {
  readonly query: Name
  readonly input: Input
  readonly window: QueryWindow
  /** Connection identity: descriptor + canonical input, excluding the window. */
  readonly identity: string
}

export interface QueryDescriptor<Name extends string, Input, Result> {
  readonly name: Name
  readonly Input: Schema.Codec<Input>
  readonly Result: Result
  readonly ref: (input: Input) => QueryRef<Name, Input>
}

/** Stable stringify: object keys sorted, so equal inputs encode equally. */
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`
}

export const Query = {
  /** Declares the entity and options a query's result is a connection over. */
  connection: (
    entity: { readonly name: string },
    options?: { readonly edgeKey?: Schema.Schema<unknown>; readonly live?: LivePolicy },
  ): ConnectionSpec => ({
    entity: entity.name,
    ...(options?.edgeKey === undefined ? {} : { edgeKey: options.edgeKey }),
    ...(options?.live === undefined ? {} : { live: options.live }),
  }),

  make: <const Name extends string, Input, Result>(
    name: Name,
    config: { readonly Input: Schema.Codec<Input>; readonly Result: Result },
  ): QueryDescriptor<Name, Input, Result> => {
    const encode = Schema.encodeSync(config.Input)
    return {
      name,
      Input: config.Input,
      Result: config.Result,
      ref: input => ({
        query: name,
        input,
        window: {},
        identity: `${name}\u0000${stable(encode(input))}`,
      }),
    }
  },

  first:
    (count: number) =>
    <R extends QueryRef<string, unknown>>(ref: R): R => ({
      ...ref,
      window: { ...ref.window, first: count },
    }),

  last:
    (count: number) =>
    <R extends QueryRef<string, unknown>>(ref: R): R => ({
      ...ref,
      window: { ...ref.window, last: count },
    }),

  after:
    (cursor: Cursor) =>
    <R extends QueryRef<string, unknown>>(ref: R): R => ({
      ...ref,
      window: { ...ref.window, after: cursor },
    }),

  before:
    (cursor: Cursor) =>
    <R extends QueryRef<string, unknown>>(ref: R): R => ({
      ...ref,
      window: { ...ref.window, before: cursor },
    }),
}
