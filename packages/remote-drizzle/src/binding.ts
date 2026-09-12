/**
 * Binding a Remote entity to a Drizzle table.
 *
 * Adapted from fate's Drizzle integration (MIT, Copyright (c) 2025 Nakazawa
 * Tech); see `THIRD_PARTY_NOTICES.md`.
 *
 * A binding **is** a `foldkit-remote` `EntityDescriptor`: `entity(name, table)`
 * derives the Entity's fields from the table, each declared relation adds a ref
 * field (keeping the foreign-key column too), and each computed adds a number.
 * So one declaration serves `Selection.make` and `source`/`query`, and relation
 * and computed fields are typed.
 */
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import type { BuildSchema } from 'drizzle-orm/effect-schema'
import { getTableColumns, type AnyColumn, type SQL, type Table as DrizzleTable } from 'drizzle-orm'
import { Entity, type EntityDescriptor, type EntityRef } from 'foldkit-remote'
import { Schema } from 'effect'
import type { OrderTerm } from './cursor.js'

/** The Effect select schema Drizzle derives for a table. */
type SelectSchema<Table extends DrizzleTable> = BuildSchema<
  'select',
  Table['_']['columns'],
  undefined
>

type SelectFields<Table extends DrizzleTable> =
  SelectSchema<Table> extends Schema.Struct<infer F> ? F : Schema.Struct.Fields

/** The foreign key lives on the owning table. */
export interface OneRelation<Target extends AnyEntityBinding, Nullable extends boolean = false> {
  readonly kind: 'one'
  readonly entity: Target
  readonly field: AnyColumn
  /** Whether the foreign key may be null; the ref field is then nullable too. */
  readonly nullable: Nullable
}

/** The foreign key lives on the target table. */
export interface ManyRelation<Target extends AnyEntityBinding> {
  readonly kind: 'many'
  readonly entity: Target
  readonly foreignKey: AnyColumn
  readonly localKey: AnyColumn
  /** Natural order of the loaded refs; defaults to the target id. */
  readonly orderBy?: readonly OrderTerm[] | undefined
  /** Appended to the child query, e.g. to exclude soft-deleted rows. */
  readonly where?: SQL | undefined
}

/** Joined through a table: `localColumn` references the owner's `id`. */
export interface ManyToManyRelation<Target extends AnyEntityBinding> {
  readonly kind: 'manyToMany'
  readonly entity: Target
  readonly through: DrizzleTable
  readonly localColumn: AnyColumn
  readonly foreignColumn: AnyColumn
  /** Natural order of the loaded refs; defaults to the target id. */
  readonly orderBy?: readonly OrderTerm[] | undefined
  /** Appended to the joined query; may reference the target table. */
  readonly where?: SQL | undefined
}

export type RelationBinding = OneRelation<any, any> | ManyRelation<any> | ManyToManyRelation<any>

/** The Entity field a relation contributes: a ref, or an array of refs. */
type RelationField<Relation> =
  Relation extends OneRelation<infer Target, infer Nullable>
    ? true extends Nullable
      ? Schema.Codec<EntityRef<Target['name'], Target['fields']> | null, string | null>
      : Schema.Codec<EntityRef<Target['name'], Target['fields']>, string>
    : Relation extends ManyRelation<infer Target> | ManyToManyRelation<infer Target>
      ? Schema.Codec<
          ReadonlyArray<EntityRef<Target['name'], Target['fields']>>,
          ReadonlyArray<string>
        >
      : never

type RelationFields<Relations extends Record<string, RelationBinding>> = {
  readonly [Field in keyof Relations]: RelationField<Relations[Field]>
}

type ComputedFields<Computed extends Record<string, ComputedConfig>> = {
  readonly [Field in keyof Computed]: Schema.Codec<number, number>
}

/** An aggregate over a collection relation, attached to each owning row. */
export interface ComputedConfig {
  /** The collection relation whose target rows are counted. */
  readonly relation: string
  /** An optional filter on the counted rows. */
  readonly where?: SQL | undefined
}

export interface EntityBinding<
  Name extends string,
  Table extends DrizzleTable,
  F extends Schema.Struct.Fields = Schema.Struct.Fields,
  Relations extends Record<string, RelationBinding> = Record<string, RelationBinding>,
> extends EntityDescriptor<Name, F> {
  readonly table: Table
  readonly columns: Readonly<Record<string, AnyColumn>>
  readonly relations: Relations
  readonly computed: Readonly<Record<string, ComputedConfig>>
}

/**
 * A binding with its derived field map erased. The field map is invariant
 * through `EntityDescriptor.ref`, so a concrete binding is not assignable to
 * `EntityBinding<any, any>`; parameters take this instead. `relations` and
 * `computed` stay typed.
 */
export type AnyEntityBinding = EntityBinding<any, any, any>

// Overloads rather than `Nullable extends boolean = false`: with `nullable`
// omitted, inference widens the parameter to `boolean` instead of taking the
// default, which would make every ref nullable.
interface One {
  <Target extends AnyEntityBinding>(
    entity: Target,
    options: { readonly field: AnyColumn; readonly nullable: true },
  ): OneRelation<Target, true>
  <Target extends AnyEntityBinding>(
    entity: Target,
    options: { readonly field: AnyColumn; readonly nullable?: false | undefined },
  ): OneRelation<Target, false>
}

/** A ref field; with `nullable: true` the ref may be `null`, as the column may. */
export const one: One = <Target extends AnyEntityBinding>(
  entity: Target,
  options: { readonly field: AnyColumn; readonly nullable?: boolean | undefined },
): OneRelation<Target, any> => ({
  kind: 'one',
  entity,
  field: options.field,
  nullable: options.nullable ?? false,
})

export const many = <Target extends AnyEntityBinding>(
  entity: Target,
  options: {
    readonly foreignKey: AnyColumn
    readonly localKey: AnyColumn
    readonly orderBy?: readonly OrderTerm[] | undefined
    readonly where?: SQL | undefined
  },
): ManyRelation<Target> => ({
  kind: 'many',
  entity,
  foreignKey: options.foreignKey,
  localKey: options.localKey,
  ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy }),
  ...(options.where === undefined ? {} : { where: options.where }),
})

export const manyToMany = <Target extends AnyEntityBinding>(
  entity: Target,
  options: {
    readonly through: DrizzleTable
    readonly localColumn: AnyColumn
    readonly foreignColumn: AnyColumn
    readonly orderBy?: readonly OrderTerm[] | undefined
    readonly where?: SQL | undefined
  },
): ManyToManyRelation<Target> => ({
  kind: 'manyToMany',
  entity,
  through: options.through,
  localColumn: options.localColumn,
  foreignColumn: options.foreignColumn,
  ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy }),
  ...(options.where === undefined ? {} : { where: options.where }),
})

export const entity = <
  const Name extends string,
  Table extends DrizzleTable,
  const Relations extends Record<string, RelationBinding> = {},
  const Computed extends Record<string, ComputedConfig> = {},
  F extends Schema.Struct.Fields = SelectFields<Table>,
>(
  name: Name,
  table: Table,
  options?: {
    readonly fields?: F | undefined
    readonly relations?: Relations | undefined
    readonly computed?: Computed | undefined
  },
): EntityBinding<
  Name,
  Table,
  F & RelationFields<Relations> & ComputedFields<Computed>,
  Relations
> => {
  // Field names arrive from the client, so the lookup maps have no prototype:
  // a plain object would resolve `__proto__`/`constructor` to inherited members
  // and misread them as a column or relation.
  const columns = Object.assign(
    Object.create(null) as Record<string, AnyColumn>,
    getTableColumns(table),
  )
  const relations = Object.assign(Object.create(null) as Relations, options?.relations ?? {})
  const baseFields = (options?.fields ?? createSelectSchema(table).fields) as Record<
    string,
    Schema.Schema<unknown>
  >

  for (const [field, relation] of Object.entries(relations)) {
    // A relation field would overwrite a same-named field in the schema, and
    // `selectColumns` would read a same-named column instead of the relation.
    // A collision is silently wrong either way, so refuse it up front.
    if (Object.hasOwn(baseFields, field)) {
      throw new Error(
        `[foldkit-remote-drizzle] relation "${field}" on entity "${name}" collides with a field of the same name`,
      )
    }
    // A null foreign key has no ref, so the client must decode a null. Without
    // the flag the derived field is non-nullable and would reject it silently.
    if (relation.kind === 'one' && relation.field.notNull === false && relation.nullable !== true) {
      throw new Error(
        `[foldkit-remote-drizzle] relation "${field}" on entity "${name}" points at a nullable column; pass { nullable: true }`,
      )
    }
  }
  const computed = Object.assign(
    Object.create(null) as Record<string, ComputedConfig>,
    options?.computed ?? {},
  )
  for (const [field, config] of Object.entries(computed)) {
    if (Object.hasOwn(baseFields, field) || relations[field] !== undefined) {
      throw new Error(
        `[foldkit-remote-drizzle] computed field "${field}" on entity "${name}" collides with a field or relation`,
      )
    }
    const relation = relations[config.relation]
    if (relation === undefined || relation.kind === 'one') {
      throw new Error(
        `[foldkit-remote-drizzle] computed field "${field}" on entity "${name}" needs a collection relation named "${config.relation}"`,
      )
    }
  }

  const fields: Record<string, Schema.Schema<unknown>> = { ...baseFields }
  for (const [field, relation] of Object.entries(relations)) {
    const target = relation.entity
    if (relation.kind === 'one') {
      const ref = Entity.ref(target) as Schema.Schema<unknown>
      fields[field] = relation.nullable === true ? Schema.NullOr(ref) : ref
    } else {
      fields[field] = Schema.Array(Entity.ref(target) as Schema.Schema<unknown>)
    }
  }
  for (const field of Object.keys(computed)) {
    fields[field] = Schema.Number
  }

  const descriptor = Entity.make(
    name,
    Schema.Struct(fields) as unknown as Schema.Struct<
      Schema.Struct.Fields & { readonly id: Schema.Schema<unknown> }
    >,
  )
  return {
    ...descriptor,
    table,
    columns,
    relations,
    computed,
  } as unknown as EntityBinding<
    Name,
    Table,
    F & RelationFields<Relations> & ComputedFields<Computed>,
    Relations
  >
}
