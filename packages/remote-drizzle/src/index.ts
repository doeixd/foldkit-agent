/**
 * `foldkit-remote-drizzle` — **provisional** compiler from Remote
 * `Entity`/`Selection`/`Query` to Drizzle's typed query graph.
 *
 * It captures no connection and re-plans nothing: `Remote.plan` already produces
 * entity + id + field batches, so this maps a Selection's fields to Drizzle
 * columns and derives the Entity Schema from the table via
 * `drizzle-orm/effect-schema`.
 *
 * Keyset pagination and required-column projection are adapted from fate's
 * Drizzle integration (MIT); see `THIRD_PARTY_NOTICES.md`.
 */
import { and, eq, inArray, type AnyColumn, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import type { QueryDescriptor, Selection } from 'foldkit-remote'
import { RemoteServerError, type EntitySource, type QuerySource } from 'foldkit-remote-server'
import type { EntityBinding, RelationBinding } from './binding.js'
import { idColumn, projectsAny, requiredColumns } from './columns.js'
import { keysetWhere, orderByTerms, type OrderTerm } from './cursor.js'
import { DrizzleDatabase, type DrizzleDatabaseService } from './database.js'
import { toQueryPage } from './page.js'
import { shapeWindow } from './window.js'

export * from './binding.js'
export * from './columns.js'
export * from './cursor.js'
export * from './database.js'
export * from './page.js'
export * from './pagination.js'
export * from './window.js'

/** The relations a Selection reads, for batched (two-stage) loading. */
export const relationsFor = (
  binding: EntityBinding<any, any>,
  selection: Selection<unknown>,
): ReadonlyArray<RelationBinding> => {
  const relations: RelationBinding[] = []
  for (const field of selection.fields) {
    const relation = binding.relations[field]
    if (relation !== undefined) relations.push(relation)
  }
  return relations
}

/** A whole id batch as one `IN (...)` — the normalized-store advantage. */
export const whereIds = (binding: EntityBinding<any, any>, ids: ReadonlyArray<string>): SQL =>
  inArray(idColumn(binding), ids)

export interface QueryPlan {
  readonly columns: ReadonlyArray<AnyColumn>
  readonly where: SQL | undefined
  readonly limit: number | undefined
}

const combineWhere = (where?: SQL, cursor?: SQL): SQL | undefined =>
  where === undefined ? cursor : cursor === undefined ? where : and(where, cursor)

/** Compiles a Query's Selection + window into pruned columns and a `where`. */
export const queryPlan = (
  binding: EntityBinding<any, any>,
  selection: Selection<unknown>,
  options: {
    readonly where?: SQL | undefined
    readonly cursor?: SQL | undefined
    readonly order?: readonly OrderTerm[] | undefined
    readonly limit?: number | undefined
  } = {},
): QueryPlan => ({
  columns: requiredColumns(binding, selection.fields, { order: options.order }),
  where: combineWhere(options.where, options.cursor),
  limit: options.limit,
})

export interface EntityRecord {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface ReadContext {
  readonly ids: readonly string[]
  readonly fields: readonly string[]
  readonly principal: unknown
}

export interface SourceQuery {
  readonly columns: Record<string, AnyColumn>
  readonly where: SQL
}

/**
 * The column map for the requested scalar and relation fields. The primary key
 * is always selected: normalization needs it even when the client did not ask
 * for an `id` field.
 */
export const selectColumns = (
  binding: EntityBinding<any, any>,
  fields: readonly string[],
): Record<string, AnyColumn> => {
  const columns: Record<string, AnyColumn> = { id: idColumn(binding) }
  for (const field of fields) {
    const column = binding.columns[field]
    if (column !== undefined) {
      columns[field] = column
      continue
    }
    const relation = binding.relations[field]
    if (relation !== undefined) columns[relation.field.name] = relation.field
  }
  return columns
}

/**
 * A pruned reader backed by an injected executor. Use it when the database is
 * not an Effect service, or to test the projection without one.
 *
 * Field authorization still holds: only `context.fields` (already intersected
 * with the principal's allowed fields by `RemoteServer`) become columns.
 */
export const reader =
  <E, R = never>(
    binding: EntityBinding<any, any>,
    run: (query: SourceQuery) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, E, R>,
  ) =>
  (context: ReadContext): Effect.Effect<ReadonlyArray<EntityRecord>, E, R> =>
    Effect.gen(function* () {
      if (context.ids.length === 0) return []
      if (!projectsAny(binding, context.fields)) return []
      const columns = selectColumns(binding, context.fields)
      const rows = yield* run({ columns, where: whereIds(binding, context.ids) })
      return rows.map(row => ({ id: String(row.id), values: row }))
    })

const failDrizzle = (error: unknown): RemoteServerError =>
  new RemoteServerError({ message: error instanceof Error ? error.message : String(error) })

const selectRows = (
  database: DrizzleDatabaseService,
  table: PgTable,
  columns: Record<string, AnyColumn>,
  options: {
    readonly where?: SQL | undefined
    readonly orderBy?: readonly SQL[] | undefined
    readonly limit?: number | undefined
  } = {},
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, RemoteServerError> => {
  let statement = database.select(columns).from(table)
  if (options.where !== undefined) statement = statement.where(options.where)
  if (options.orderBy !== undefined) statement = statement.orderBy(...options.orderBy)
  if (options.limit !== undefined) statement = statement.limit(options.limit)
  return Effect.tryPromise({ try: () => Promise.resolve(statement), catch: failDrizzle })
}

const runDrizzle =
  (binding: EntityBinding<any, any>) =>
  (
    query: SourceQuery,
  ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, RemoteServerError, DrizzleDatabase> =>
    Effect.gen(function* () {
      const database = yield* DrizzleDatabase
      return yield* selectRows(database, binding.table, query.columns, { where: query.where })
    })

/** A `RemoteServer.entity` source backed by the `DrizzleDatabase` service. */
export const source = <P = unknown>(
  binding: EntityBinding<any, any>,
): EntitySource<P, DrizzleDatabase> => ({
  entity: binding.name,
  read: reader(binding, runDrizzle(binding)),
})

/**
 * A `RemoteServer.query` source over a keyset-paginated table. The connection's
 * cursor is the row identity; a requested cursor's ordering tuple is re-read
 * before the page query, so the wire cursor stays a string.
 */
export const query = <P = unknown, Input = unknown>(
  descriptor: QueryDescriptor<string, Input, unknown>,
  options: {
    readonly entity: EntityBinding<any, any>
    readonly orderBy: readonly OrderTerm[]
    readonly where?: ((input: Input, principal: P) => SQL | undefined) | undefined
    readonly defaultPageSize?: number | undefined
  },
): QuerySource<P, DrizzleDatabase> => ({
  query: descriptor.name,
  Input: descriptor.Input,
  run: ({ input, window, principal }) =>
    Effect.gen(function* () {
      const binding = options.entity
      const shape = shapeWindow(window, options.defaultPageSize ?? 20)
      const database = yield* DrizzleDatabase
      const id = idColumn(binding)
      const baseWhere = options.where?.(input as Input, principal)
      let where = baseWhere

      if (shape.cursor !== undefined) {
        const cursorSelection = Object.fromEntries(
          options.orderBy.map(term => [term.column.name, term.column]),
        )
        const cursorRows = yield* selectRows(database, binding.table, cursorSelection, {
          where:
            baseWhere === undefined ? eq(id, shape.cursor) : and(baseWhere, eq(id, shape.cursor)),
          limit: 1,
        })
        const cursorRow = cursorRows[0]
        if (cursorRow !== undefined) {
          const values = options.orderBy.map(term => cursorRow[term.column.name])
          const predicate = keysetWhere(options.orderBy, values, shape.traversal)
          where =
            where === undefined
              ? predicate
              : predicate === undefined
                ? where
                : and(where, predicate)
        }
      }

      const columns: Record<string, AnyColumn> = { id }
      for (const term of options.orderBy) {
        if (!Object.values(columns).includes(term.column)) columns[term.column.name] = term.column
      }
      const rows = yield* selectRows(database, binding.table, columns, {
        where,
        orderBy: orderByTerms(options.orderBy, shape.traversal),
        limit: shape.pageSize + 1,
      })
      return toQueryPage({
        entity: binding.name,
        rows,
        pageSize: shape.pageSize,
        traversal: shape.traversal,
        cursor: shape.cursor,
        cursorOf: row => String(row.id),
      })
    }),
})
