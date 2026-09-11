/**
 * Required-column projection.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 *
 * A Selection is the single source of the projection, but it is not sufficient:
 * normalization also needs the primary key, a relation load needs the local
 * foreign key, and keyset pagination needs the ordering columns. Those hidden
 * dependencies are folded in here rather than at each call site.
 */
import type { AnyColumn } from 'drizzle-orm'
import type { EntityBinding } from './binding.js'
import type { OrderTerm } from './cursor.js'

const missingId = (name: string): never => {
  throw new Error(
    `[foldkit-remote-drizzle] entity "${name}" has no "id" column; a Remote entity must expose one`,
  )
}

export const idColumn = (binding: EntityBinding<any, any>): AnyColumn =>
  binding.columns.id ?? missingId(binding.name)

export interface RequiredColumnsOptions {
  /** Ordering columns keyset pagination must read to represent a cursor. */
  readonly order?: readonly OrderTerm[] | undefined
  /** Additional field names, e.g. a relation's local key. */
  readonly extra?: readonly string[] | undefined
}

/** Selected columns, relation keys, the primary key, and ordering columns. */
export const requiredColumns = (
  binding: EntityBinding<any, any>,
  fields: Iterable<string>,
  options: RequiredColumnsOptions = {},
): ReadonlyArray<AnyColumn> => {
  const seen = new Set<AnyColumn>()
  const columns: AnyColumn[] = []
  const add = (column: AnyColumn | undefined) => {
    if (column === undefined || seen.has(column)) return
    seen.add(column)
    columns.push(column)
  }

  add(idColumn(binding))
  for (const field of fields) {
    const column = binding.columns[field]
    if (column !== undefined) {
      add(column)
      continue
    }
    add(binding.relations[field]?.field)
  }
  for (const term of options.order ?? []) add(term.column)
  for (const field of options.extra ?? []) add(binding.columns[field])
  return columns
}

/** Whether at least one requested field maps to a column or a relation. */
export const projectsAny = (
  binding: EntityBinding<any, any>,
  fields: Iterable<string>,
): boolean => {
  for (const field of fields) {
    if (binding.columns[field] !== undefined || binding.relations[field] !== undefined) return true
  }
  return false
}
