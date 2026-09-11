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
import { and, asc, eq, inArray, type AnyColumn, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import type { QueryDescriptor, Selection } from 'foldkit-remote'
import { Entity } from 'foldkit-remote'
import { RemoteServerError, type EntitySource, type QuerySource } from 'foldkit-remote-server'
import type { EntityBinding, RelationBinding } from './binding.js'
import { idColumn, projectsAny } from './columns.js'
import { cursorSelection, keysetWhere, orderByTerms, type OrderTerm } from './cursor.js'
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
 * for an `id` field. A relation field selects its foreign key under the
 * relation's own name, which `reader` rewrites to a ref.
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
    if (relation !== undefined) {
      columns[field] = relation.kind === 'one' ? relation.field : relation.localKey
    }
  }
  return columns
}

/** Replaces each selected relation's foreign key with the ref wire key it encodes. */
const relationRefs = (
  binding: EntityBinding<any, any>,
  fields: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const values = { ...row }
  for (const field of fields) {
    const relation = binding.relations[field]
    if (relation === undefined) continue
    if (relation.kind === 'many') {
      // The injected-executor path cannot load children. Leave the raw key: the
      // client's array schema rejects it instead of reporting a false absence,
      // which would refetch forever. Use `source` for relations.
      continue
    }
    const id = row[field]
    values[field] =
      id === null || id === undefined
        ? null
        : Entity.refKey({ entity: relation.entity.name, id: String(id) })
  }
  return values
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
      return rows.map(row => ({
        id: String(row.id),
        values: relationRefs(binding, context.fields, row),
      }))
    })

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
  return Effect.tryPromise({
    try: () => Promise.resolve(statement),
    catch: (error: unknown) => error,
  }).pipe(
    // The driver detail is for operators; the client gets no schema or SQL.
    Effect.tapError(error =>
      Effect.logError('[foldkit-remote-drizzle] database query failed', error),
    ),
    Effect.mapError(() => new RemoteServerError({ message: 'Database query failed' })),
  )
}

/**
 * A `RemoteServer.entity` source backed by the `DrizzleDatabase` service. It
 * selects the requested columns in one batch, then resolves each selected
 * relation: a `one` relation becomes a ref key, and a `many` relation loads the
 * target ids in one `IN (...)` and emits an array of ref keys.
 */
export const source = <P = unknown>(
  binding: EntityBinding<any, any>,
  options?: { readonly authorize?: EntitySource<P, DrizzleDatabase>['authorize'] | undefined },
): EntitySource<P, DrizzleDatabase> => ({
  entity: binding.name,
  read: context =>
    Effect.gen(function* () {
      if (context.ids.length === 0) return []
      if (!projectsAny(binding, context.fields)) return []
      const database = yield* DrizzleDatabase
      const rows = yield* selectRows(
        database,
        binding.table,
        selectColumns(binding, context.fields),
        { where: whereIds(binding, context.ids) },
      )

      for (const field of context.fields) {
        const relation = binding.relations[field]
        if (relation === undefined) continue

        if (relation.kind === 'one') {
          for (const row of rows) {
            const id = row[field]
            row[field] =
              id === null || id === undefined
                ? null
                : Entity.refKey({ entity: relation.entity.name, id: String(id) })
          }
          continue
        }

        const parentKeys = [
          ...new Set(rows.map(row => row[field]).filter(key => key !== null && key !== undefined)),
        ]
        const byParent = new Map<string, string[]>()
        if (parentKeys.length > 0) {
          const childColumns: Record<string, AnyColumn> = {
            id: idColumn(relation.entity),
            [relation.foreignKey.name]: relation.foreignKey,
          }
          const childRows = yield* selectRows(database, relation.entity.table, childColumns, {
            where: inArray(relation.foreignKey, parentKeys),
            orderBy: [asc(idColumn(relation.entity))],
          })
          for (const child of childRows) {
            const key = String(child[relation.foreignKey.name])
            const refs = byParent.get(key) ?? []
            refs.push(Entity.refKey({ entity: relation.entity.name, id: String(child.id) }))
            byParent.set(key, refs)
          }
        }
        for (const row of rows) {
          const key = row[field]
          row[field] = key === null || key === undefined ? [] : (byParent.get(String(key)) ?? [])
        }
      }

      return rows.map(row => ({ id: String(row.id), values: row }))
    }),
  ...(options?.authorize === undefined ? {} : { authorize: options.authorize }),
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
    readonly maxPageSize?: number | undefined
  },
): QuerySource<P, DrizzleDatabase> => {
  if (options.orderBy.length === 0) {
    throw new Error(
      `[foldkit-remote-drizzle] query "${descriptor.name}" needs a non-empty, stable orderBy; add a unique tie-breaker column`,
    )
  }
  return {
    query: descriptor.name,
    Input: descriptor.Input,
    run: ({ input, window, principal }) =>
      Effect.gen(function* () {
        if (
          (window.after !== undefined && window.before !== undefined) ||
          (window.first !== undefined && window.last !== undefined)
        ) {
          return yield* new RemoteServerError({
            message: 'A query window cannot combine after with before, or first with last',
          })
        }

        const binding = options.entity
        const shape = shapeWindow(window, {
          defaultSize: options.defaultPageSize,
          maxSize: options.maxPageSize,
        })
        const database = yield* DrizzleDatabase
        const id = idColumn(binding)
        const baseWhere = options.where?.(input as Input, principal)
        let where = baseWhere

        if (shape.cursor !== undefined) {
          const cursorColumns = cursorSelection(options.orderBy)
          const cursorRows = yield* selectRows(database, binding.table, cursorColumns, {
            where:
              baseWhere === undefined ? eq(id, shape.cursor) : and(baseWhere, eq(id, shape.cursor)),
            limit: 1,
          })
          const cursorRow = cursorRows[0]
          if (cursorRow === undefined) {
            return yield* new RemoteServerError({
              message: 'The query cursor no longer resolves to a row',
            })
          }
          const values = options.orderBy.map(term => cursorRow[term.column.name])
          const predicate = keysetWhere(options.orderBy, values, shape.traversal)
          where =
            where === undefined
              ? predicate
              : predicate === undefined
                ? where
                : and(where, predicate)
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
  }
}
