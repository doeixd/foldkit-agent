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
import { and, inArray, type AnyColumn, type SQL } from 'drizzle-orm'
import { Effect } from 'effect'
import type { Selection } from 'foldkit-remote'
import type { EntityBinding, RelationBinding } from './binding.js'
import { idColumn, projectsAny, requiredColumns } from './columns.js'
import type { OrderTerm } from './cursor.js'

export * from './binding.js'
export * from './columns.js'
export * from './cursor.js'
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
  readonly columns: Readonly<Record<string, AnyColumn>>
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
): Readonly<Record<string, AnyColumn>> => {
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
      if (!projectsAny(binding, context.fields)) return []
      const columns = selectColumns(binding, context.fields)
      const rows = yield* run({ columns, where: whereIds(binding, context.ids) })
      return rows.map(row => ({ id: String(row.id), values: row }))
    })
