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

export interface RelationBinding {
  readonly entity: EntityBinding<any, any>
  /** The foreign-key column on the owning table. */
  readonly field: AnyColumn
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
    readonly relations?: Readonly<Record<string, RelationBinding>> | undefined
  },
): EntityBinding<Name, Table> => ({
  name,
  table,
  columns: getTableColumns(table),
  Schema: options?.schema ?? (createSelectSchema(table) as unknown as Schema.Codec<unknown>),
  relations: options?.relations ?? {},
})
