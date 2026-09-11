/**
 * `foldkit-remote-drizzle` — **provisional** compiler from Remote
 * `Entity`/`Selection` to Drizzle's typed query graph.
 *
 * It captures no connection and re-plans nothing: `Remote.plan` already produces
 * entity + id + field batches, so this maps a Selection's fields to Drizzle
 * columns and derives the Entity Schema from the table via
 * `drizzle-orm/effect-schema`.
 */
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { and, gt, inArray, lt, type Column, getTableColumns, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Effect, Schema } from 'effect'
import type { Selection } from 'foldkit-remote'

export interface RelationBinding {
  readonly entity: EntityBinding<any, any>
  /** The foreign-key column on the owning table. */
  readonly field: Column
}

export interface EntityBinding<Name extends string, Table extends PgTable> {
  readonly name: Name
  readonly table: Table
  readonly Schema: Schema.Schema<unknown>
  readonly columns: Readonly<Record<string, Column>>
  readonly relations: Readonly<Record<string, RelationBinding>>
}

export const entity = <const Name extends string, Table extends PgTable>(
  name: Name,
  table: Table,
  options?: {
    readonly schema?: Schema.Schema<unknown> | undefined
    readonly relations?: Readonly<Record<string, RelationBinding>> | undefined
  },
): EntityBinding<Name, Table> => ({
  name,
  table,
  columns: getTableColumns(table),
  Schema: options?.schema ?? (createSelectSchema(table) as unknown as Schema.Schema<unknown>),
  relations: options?.relations ?? {},
})

/** The scalar columns a Selection reads; relation fields are excluded. */
export const columnsFor = (
  binding: EntityBinding<any, any>,
  selection: Selection<unknown>,
): ReadonlyArray<Column> => {
  const columns: Column[] = []
  for (const field of selection.fields) {
    const column = binding.columns[field]
    if (column !== undefined) columns.push(column)
  }
  return columns
}

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
export const whereIds = (binding: EntityBinding<any, any>, ids: ReadonlyArray<string>): SQL => {
  const id = binding.columns.id
  if (id === undefined) {
    throw new Error(
      `[foldkit-remote-drizzle] entity "${binding.name}" has no "id" column; a Remote entity must expose one`,
    )
  }
  return inArray(id, ids as ReadonlyArray<string>)
}

/** Cursor pagination follows a stable total order (`orderBy` + tie-breaker). */
export const cursorCondition = (column: Column, direction: 'asc' | 'desc', cursor: unknown): SQL =>
  direction === 'asc' ? gt(column, cursor) : lt(column, cursor)

export interface QueryPlan {
  readonly columns: ReadonlyArray<Column>
  readonly where: SQL | undefined
  readonly limit: number | undefined
}

/** Compiles a Query's Selection + window into pruned columns and a `where`. */
export const queryPlan = (
  binding: EntityBinding<any, any>,
  selection: Selection<unknown>,
  options: {
    readonly where?: SQL | undefined
    readonly cursor?: SQL | undefined
    readonly limit?: number | undefined
  } = {},
): QueryPlan => ({
  columns: columnsFor(binding, selection),
  where:
    options.where === undefined
      ? options.cursor
      : options.cursor === undefined
        ? options.where
        : and(options.where, options.cursor),
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
  readonly columns: Readonly<Record<string, Column>>
  readonly where: SQL
}

/** The pruned column map for the allowed/requested scalar fields. */
export const selectColumns = (
  binding: EntityBinding<any, any>,
  fields: readonly string[],
): Readonly<Record<string, Column>> => {
  const columns: Record<string, Column> = {}
  for (const field of fields) {
    const column = binding.columns[field]
    if (column !== undefined) columns[field] = column
  }
  return columns
}

/**
 * Builds a `RemoteServer.entity` reader from a binding and a Drizzle executor.
 * The executor is the one Drizzle-specific line,
 * `(query) => db.select(query.columns).from(table).where(query.where)`.
 *
 * Field authorization still holds: only `context.fields` (already intersected
 * with the principal's allowed fields by `RemoteServer`) become columns.
 */
export const source =
  <E>(
    binding: EntityBinding<any, any>,
    run: (query: SourceQuery) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, E>,
  ) =>
  (context: ReadContext): Effect.Effect<ReadonlyArray<EntityRecord>, E> =>
    Effect.gen(function* () {
      if (context.ids.length === 0) return []
      const columns = selectColumns(binding, context.fields)
      if (Object.keys(columns).length === 0) return []
      const rows = yield* run({ columns, where: whereIds(binding, context.ids) })
      return rows.map(row => ({ id: String(row.id), values: row }))
    })
