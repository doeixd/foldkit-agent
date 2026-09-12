/**
 * `foldkit-remote-drizzle` — **provisional** compiler from Remote
 * `Entity`/`Selection`/`Query` to Drizzle's typed query graph.
 *
 * It captures no connection and re-plans nothing: `Remote.plan` already produces
 * entity + id + field batches, so this maps a Selection's fields to Drizzle
 * columns. Each entity is declared once with `entity(name, table)`, which is
 * both the Drizzle binding and the Remote `EntityDescriptor`.
 *
 * Keyset pagination and required-column projection are adapted from fate's
 * Drizzle integration (MIT); see `THIRD_PARTY_NOTICES.md`.
 */
import { and, eq, inArray, sql, type AnyColumn, type SQL, type Table } from 'drizzle-orm'
import { Effect } from 'effect'
import type { NormalizedPatch, QueryDescriptor } from 'foldkit-remote'
import { Entity } from 'foldkit-remote'
import {
  RemoteServerError,
  type EntityRecord,
  type EntitySource,
  type EntitySourceContext,
  type QuerySource,
} from 'foldkit-remote-server'
import type { AnyEntityBinding, ManyRelation, ManyToManyRelation } from './binding.js'
import { idColumn, projectsAny } from './columns.js'
import { cursorSelection, keysetWhere, orderByTerms, type OrderTerm } from './cursor.js'
import { DrizzleDatabase, type DrizzleDatabaseService } from './database.js'
import { toQueryPage } from './page.js'
import { buildPage } from './pagination.js'
import { shapeWindow } from './window.js'

export * from './binding.js'
export * from './columns.js'
export * from './cursor.js'
export * from './database.js'
export * from './page.js'
export * from './pagination.js'
export * from './window.js'

/**
 * An own-property lookup. Request field names are client-supplied and relation
 * names are developer-supplied, so an inherited member like `toString` must not
 * satisfy the lookup.
 */
const pick = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

/**
 * Where a collection relation's children are read from: the table holding the
 * parent key (the target itself for `many`, the join table for `manyToMany`),
 * the join to the target when there is one, and the parent-side column the
 * children are grouped under.
 */
const childSide = (
  binding: AnyEntityBinding,
  relation: ManyRelation<AnyEntityBinding> | ManyToManyRelation<AnyEntityBinding>,
): {
  readonly table: Table
  readonly parent: AnyColumn
  readonly child: AnyColumn
  readonly join: { readonly table: Table; readonly on: SQL } | undefined
  readonly parentKey: AnyColumn
} => {
  const child = idColumn(relation.entity)
  return relation.kind === 'many'
    ? {
        table: relation.entity.table,
        parent: relation.foreignKey,
        child,
        join: undefined,
        parentKey: relation.localKey,
      }
    : {
        table: relation.through,
        parent: relation.localColumn,
        child,
        join: { table: relation.entity.table, on: eq(relation.foreignColumn, child) },
        parentKey: idColumn(binding),
      }
}

/** A whole id batch as one `IN (...)` — the normalized-store advantage. */
export const whereIds = (binding: AnyEntityBinding, ids: ReadonlyArray<string>): SQL =>
  inArray(idColumn(binding), ids)

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
  binding: AnyEntityBinding,
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
      columns[field] =
        relation.kind === 'one'
          ? relation.field
          : relation.kind === 'many'
            ? relation.localKey
            : idColumn(binding)
    }
  }
  return columns
}

/** Replaces each selected relation's foreign key with the ref wire key it encodes. */
const relationRefs = (
  binding: AnyEntityBinding,
  fields: readonly string[],
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const values = { ...row }
  for (const field of fields) {
    const relation = binding.relations[field]
    if (relation === undefined) continue
    if (relation.kind !== 'one') {
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
 * Maps rows a mutation returned (e.g. Drizzle `returning`) to entity patches,
 * rewriting a `one` relation's foreign key to its ref key. `fields` is the set
 * of columns the query selected (see `selectColumns`). A collection relation is
 * left as its raw key; load it with `source`.
 */
export const normalize = (
  binding: AnyEntityBinding,
  rows: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[],
): ReadonlyArray<NormalizedPatch> =>
  rows.map(row => ({
    entity: binding.name,
    id: String(row.id),
    values: relationRefs(binding, fields, row),
  }))

/**
 * The `returning` columns for `fields` and the normalization of the rows they
 * yield, paired so a mutation cannot select one set of columns and normalize
 * another.
 */
export const returning = (
  binding: AnyEntityBinding,
  fields: readonly string[],
): {
  readonly columns: Record<string, AnyColumn>
  readonly patches: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<NormalizedPatch>
} => ({
  columns: selectColumns(binding, fields),
  patches: rows => normalize(binding, rows, fields),
})

/**
 * A pruned reader backed by an injected executor. Use it when the database is
 * not an Effect service, or to test the projection without one.
 *
 * Field authorization still holds: only `context.fields` (already intersected
 * with the principal's allowed fields by `RemoteServer`) become columns.
 */
export const reader =
  <E, R = never, P = unknown>(
    binding: AnyEntityBinding,
    run: (query: SourceQuery) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, E, R>,
  ) =>
  (context: EntitySourceContext<P>): Effect.Effect<ReadonlyArray<EntityRecord>, E, R> =>
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
  table: Table,
  columns: Record<string, AnyColumn | SQL>,
  options: {
    readonly where?: SQL | undefined
    readonly innerJoin?: { readonly table: Table; readonly on: SQL } | undefined
    readonly groupBy?: readonly AnyColumn[] | undefined
    readonly orderBy?: readonly SQL[] | undefined
    readonly limit?: number | undefined
  } = {},
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, RemoteServerError> => {
  let statement = database.select(columns).from(table)
  if (options.where !== undefined) statement = statement.where(options.where)
  if (options.innerJoin !== undefined) {
    statement = statement.innerJoin(options.innerJoin.table, options.innerJoin.on)
  }
  if (options.groupBy !== undefined) statement = statement.groupBy(...options.groupBy)
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

const withFilters = (base: SQL, ...filters: ReadonlyArray<SQL | undefined>): SQL => {
  const conditions: SQL[] = [base]
  for (const filter of filters) if (filter !== undefined) conditions.push(filter)
  return conditions.length === 1 ? base : and(...conditions)!
}

/** A relation cursor is the last ref's key (`"Entity:id"`); the row key is the id. */
const cursorId = (cursor: string): string => {
  const parts = Entity.refParts(cursor)
  return parts.id === '' ? cursor : parts.id
}

/**
 * A `RemoteServer.entity` source backed by the `DrizzleDatabase` service. It
 * selects the requested columns in one batch, then resolves each selected
 * relation: a `one` relation becomes a ref key, and a `many` relation loads the
 * target ids in one `IN (...)`. `options.policies` adds a principal-scoped filter
 * to a collection relation (e.g. only rows this principal may see).
 */
export const source = <P = unknown>(
  binding: AnyEntityBinding,
  options?: {
    readonly authorize?: EntitySource<P, DrizzleDatabase>['authorize'] | undefined
    readonly policies?:
      Readonly<Record<string, ((principal: P) => SQL | undefined) | undefined>> | undefined
  },
): EntitySource<P, DrizzleDatabase> => {
  for (const field of Object.keys(options?.policies ?? {})) {
    const relation = binding.relations[field]
    if (relation === undefined || relation.kind === 'one') {
      throw new Error(
        `[foldkit-remote-drizzle] policy "${field}" on entity "${binding.name}" needs a collection relation`,
      )
    }
  }
  return {
    entity: binding.name,
    fields: new Set(Object.keys(binding.fields)),
    read: context =>
      Effect.gen(function* () {
        if (context.ids.length === 0) return []
        if (!projectsAny(binding, context.fields)) return []
        const database = yield* DrizzleDatabase
        const columns = selectColumns(binding, context.fields)
        for (const field of context.fields) {
          const computed = binding.computed[field]
          if (computed === undefined) continue
          const relation = binding.relations[computed.relation]
          if (relation === undefined || relation.kind === 'one') continue
          const { parentKey } = childSide(binding, relation)
          columns[parentKey.name] = parentKey
        }
        const rows = yield* selectRows(database, binding.table, columns, {
          where: whereIds(binding, context.ids),
        })

        for (const field of context.fields) {
          const relation = binding.relations[field]
          if (relation === undefined) continue

          // A principal-scoped filter applies only to collection relations.
          const policyWhere = pick(options?.policies, field)?.(context.principal)
          const window = pick(context.windows, field)
          if (relation.kind === 'one') {
            if (window !== undefined) {
              return yield* new RemoteServerError({
                message: `Relation "${field}" is singular and cannot be windowed`,
              })
            }
            for (const row of rows) {
              const id = row[field]
              row[field] =
                id === null || id === undefined
                  ? null
                  : Entity.refKey({ entity: relation.entity.name, id: String(id) })
            }
            continue
          }

          const side = childSide(binding, relation)
          const targetId = side.child
          // The target id is the final tie-breaker, so ranking and ordering
          // agree and a page never drops a row that ties on the order columns.
          const declared = relation.orderBy ?? []
          const order: ReadonlyArray<OrderTerm> = declared.some(term => term.column === targetId)
            ? declared
            : [...declared, { column: targetId, direction: 'asc' }]
          const naturalOrder = orderByTerms(order, 'forward')
          const parentKeys = [
            ...new Set(
              rows.map(row => row[field]).filter(key => key !== null && key !== undefined),
            ),
          ]

          if (window !== undefined) {
            const shape = shapeWindow(window, { defaultSize: 20 })
            if (shape.cursor !== undefined && context.ids.length !== 1) {
              return yield* new RemoteServerError({
                message: `Relation "${field}" cursor needs a single parent`,
              })
            }
            const empty = { refs: [] as ReadonlyArray<string>, hasNext: false, hasPrevious: false }
            const traversalOrder = orderByTerms(order, shape.traversal)

            let keyset: SQL | undefined
            if (shape.cursor !== undefined) {
              const cursorRows = yield* selectRows(
                database,
                relation.entity.table,
                cursorSelection(order),
                { where: eq(targetId, cursorId(shape.cursor)), limit: 1 },
              )
              const cursorRow = cursorRows[0]
              if (cursorRow === undefined) {
                return yield* new RemoteServerError({
                  message: `Relation "${field}" cursor no longer resolves`,
                })
              }
              keyset = keysetWhere(
                order,
                order.map(term => cursorRow[term.column.name]),
                shape.traversal,
              )
            }

            const byParent = new Map<string, Array<Record<string, unknown>>>()
            if (parentKeys.length > 0) {
              const where = withFilters(
                inArray(side.parent, parentKeys),
                relation.where,
                policyWhere,
                keyset,
              )
              // One statement for every parent: rank each parent's children in
              // a window and keep the first `pageSize + 1` of each, so the
              // statement count does not grow with the number of parents.
              const ranking = sql`row_number() over (partition by ${side.parent} order by ${sql.join([...traversalOrder], sql`, `)})`
              const joined =
                side.join === undefined
                  ? sql`${side.table}`
                  : sql`${side.table} inner join ${side.join.table} on ${side.join.on}`
              const ranked = sql`(select p, k from (select ${side.parent} as p, ${targetId} as k, ${ranking} as rn from ${joined} where ${where}) as ranked where rn <= ${shape.pageSize + 1})`
              const childRows = yield* selectRows(
                database,
                side.table,
                { child: targetId, parent: side.parent },
                {
                  where: sql`(${side.parent}, ${targetId}) in ${ranked}`,
                  innerJoin: side.join,
                  orderBy: traversalOrder,
                },
              )
              for (const child of childRows) {
                const rows_ = byParent.get(String(child.parent)) ?? []
                rows_.push(child)
                byParent.set(String(child.parent), rows_)
              }
            }

            for (const row of rows) {
              const key = row[field]
              if (key === null || key === undefined) {
                row[field] = empty
                continue
              }
              // An empty page under a cursor still has its cursor-side boundary.
              const childRows = byParent.get(String(key)) ?? []
              const natural = shape.traversal === 'backward' ? [...childRows].reverse() : childRows
              const page = buildPage({
                rows: natural,
                pageSize: shape.pageSize,
                traversal: shape.traversal,
                cursor: shape.cursor,
                cursorOf: child => String(child.child),
              })
              row[field] = {
                refs: page.rows.map(child =>
                  Entity.refKey({ entity: relation.entity.name, id: String(child.child) }),
                ),
                hasNext: page.hasNext,
                hasPrevious: page.hasPrevious,
              }
            }
            continue
          }

          const byParent = new Map<string, string[]>()
          if (parentKeys.length > 0) {
            const childRows = yield* selectRows(
              database,
              side.table,
              { child: targetId, parent: side.parent },
              {
                where: withFilters(inArray(side.parent, parentKeys), relation.where, policyWhere),
                innerJoin: side.join,
                orderBy: naturalOrder,
              },
            )
            for (const child of childRows) {
              const refs = byParent.get(String(child.parent)) ?? []
              refs.push(Entity.refKey({ entity: relation.entity.name, id: String(child.child) }))
              byParent.set(String(child.parent), refs)
            }
          }
          for (const row of rows) {
            const key = row[field]
            row[field] = key === null || key === undefined ? [] : (byParent.get(String(key)) ?? [])
          }
        }

        for (const field of context.fields) {
          const computed = binding.computed[field]
          if (computed === undefined) continue
          const relation = binding.relations[computed.relation]
          if (relation === undefined || relation.kind === 'one') {
            return yield* new RemoteServerError({
              message: `Computed field "${field}" needs collection relation "${computed.relation}"`,
            })
          }
          const side = childSide(binding, relation)
          const parentKeys = [
            ...new Set(
              rows
                .map(row => row[side.parentKey.name])
                .filter(key => key !== null && key !== undefined),
            ),
          ]
          const counts = new Map<string, number>()
          const countPolicy = pick(options?.policies, computed.relation)?.(context.principal)
          if (parentKeys.length > 0) {
            const count = sql<number>`count(*)`.mapWith(Number)
            const countRows = yield* selectRows(
              database,
              side.table,
              { count, parent: side.parent },
              {
                where: withFilters(inArray(side.parent, parentKeys), computed.where, countPolicy),
                innerJoin: side.join,
                groupBy: [side.parent],
              },
            )
            for (const countRow of countRows) {
              counts.set(String(countRow.parent), Number(countRow.count))
            }
          }
          for (const row of rows) {
            const key = row[side.parentKey.name]
            row[field] = key === null || key === undefined ? 0 : (counts.get(String(key)) ?? 0)
          }
        }

        return rows.map(row => ({ id: String(row.id), values: row }))
      }),
    ...(options?.authorize === undefined ? {} : { authorize: options.authorize }),
  }
}

/**
 * A `RemoteServer.query` source over a keyset-paginated table. The connection's
 * cursor is the row identity; a requested cursor's ordering tuple is re-read
 * before the page query, so the wire cursor stays a string.
 */
export const query = <P = unknown, Input = unknown>(
  descriptor: QueryDescriptor<string, Input, unknown>,
  options: {
    readonly entity: AnyEntityBinding
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
        const natural = shape.traversal === 'backward' ? [...rows].reverse() : rows
        return toQueryPage({
          entity: binding.name,
          rows: natural,
          pageSize: shape.pageSize,
          traversal: shape.traversal,
          cursor: shape.cursor,
          cursorOf: row => String(row.id),
        })
      }),
  }
}
