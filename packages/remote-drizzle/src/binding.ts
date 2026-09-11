/**
 * Binding a Remote entity to a Drizzle table.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 */
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { getTableColumns, type AnyColumn } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { Schema } from 'effect'

export interface RelationTarget {
  readonly entity: EntityBinding<any, any>
}

/** A singular relation: the foreign key lives on the owning table. */
export interface OneRelation extends RelationTarget {
  readonly kind: 'one'
  readonly field: AnyColumn
}

/** A collection relation: the foreign key lives on the target table. */
export interface ManyRelation extends RelationTarget {
  readonly kind: 'many'
  readonly foreignKey: AnyColumn
  readonly localKey: AnyColumn
}

export type RelationBinding = OneRelation | ManyRelation

export type RelationConfig =
  | {
      readonly kind?: 'one' | undefined
      readonly entity: EntityBinding<any, any>
      readonly field: AnyColumn
    }
  | {
      readonly kind: 'many'
      readonly entity: EntityBinding<any, any>
      readonly foreignKey: AnyColumn
      readonly localKey: AnyColumn
    }

export const one = (
  entity: EntityBinding<any, any>,
  options: { readonly field: AnyColumn },
): OneRelation => ({ kind: 'one', entity, field: options.field })

export const many = (
  entity: EntityBinding<any, any>,
  options: { readonly foreignKey: AnyColumn; readonly localKey: AnyColumn },
): ManyRelation => ({
  kind: 'many',
  entity,
  foreignKey: options.foreignKey,
  localKey: options.localKey,
})

const normalizeRelation = (config: RelationConfig): RelationBinding =>
  config.kind === 'many'
    ? {
        kind: 'many',
        entity: config.entity,
        foreignKey: config.foreignKey,
        localKey: config.localKey,
      }
    : { kind: 'one', entity: config.entity, field: config.field }

export interface EntityBinding<Name extends string, Table extends PgTable> {
  readonly name: Name
  readonly table: Table
  readonly Schema: Schema.Codec<unknown>
  readonly columns: Readonly<Record<string, AnyColumn>>
  readonly relations: Readonly<Record<string, RelationBinding>>
}

export const entity = <const Name extends string, Table extends PgTable>(
  name: Name,
  table: Table,
  options?: {
    readonly schema?: Schema.Codec<unknown> | undefined
    readonly relations?: Readonly<Record<string, RelationConfig>> | undefined
  },
): EntityBinding<Name, Table> => ({
  name,
  table,
  columns: getTableColumns(table),
  Schema: options?.schema ?? (createSelectSchema(table) as unknown as Schema.Codec<unknown>),
  relations: Object.fromEntries(
    Object.entries(options?.relations ?? {}).map(([field, config]) => [
      field,
      normalizeRelation(config),
    ]),
  ),
})
