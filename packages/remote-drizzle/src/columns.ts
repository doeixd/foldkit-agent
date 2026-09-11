/**
 * Entity identity and projection helpers.
 *
 * A Remote entity must expose an `id`; every read needs it even when the client
 * did not ask for it, so `idColumn` is the single place that enforces it.
 */
import type { AnyColumn } from 'drizzle-orm'
import type { EntityBinding } from './binding.js'

const missingId = (name: string): never => {
  throw new Error(
    `[foldkit-remote-drizzle] entity "${name}" has no "id" column; a Remote entity must expose one`,
  )
}

export const idColumn = (binding: EntityBinding<any, any>): AnyColumn =>
  binding.columns.id ?? missingId(binding.name)

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
