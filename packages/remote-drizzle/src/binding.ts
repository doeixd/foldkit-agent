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

/**
 * A collection relation joined through a table. `localColumn` references the
 * owning entity's `id`; `foreignColumn` references the target entity's `id`.
 */
export interface ManyToManyRelation extends RelationTarget {
  readonly kind: 'manyToMany'
  readonly through: PgTable
  readonly localColumn: AnyColumn
  readonly foreignColumn: AnyColumn
}

export type RelationBinding = OneRelation | ManyRelation | ManyToManyRelation

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
  | {
      readonly kind: 'manyToMany'
      readonly entity: EntityBinding<any, any>
      readonly through: PgTable
      readonly localColumn: AnyColumn
      readonly foreignColumn: AnyColumn
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

export const manyToMany = (
  entity: EntityBinding<any, any>,
  options: {
    readonly through: PgTable
    readonly localColumn: AnyColumn
    readonly foreignColumn: AnyColumn
  },
): ManyToManyRelation => ({
  kind: 'manyToMany',
  entity,
  through: options.through,
  localColumn: options.localColumn,
  foreignColumn: options.foreignColumn,
})

const normalizeRelation = (config: RelationConfig): RelationBinding => {
  switch (config.kind) {
    case 'many':
      return {
        kind: 'many',
        entity: config.entity,
        foreignKey: config.foreignKey,
        localKey: config.localKey,
      }
    case 'manyToMany':
      return {
        kind: 'manyToMany',
        entity: config.entity,
        through: config.through,
        localColumn: config.localColumn,
        foreignColumn: config.foreignColumn,
      }
    default:
      return { kind: 'one', entity: config.entity, field: config.field }
  }
}

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
