/**
 * Selections: the fields a Surface picks of an entity (nested through
 * relations, paged through connections), the requirement graph they imply,
 * and their assembly from the normalized store.
 */
import { Option, Schema } from 'effect'
import type { RelationRequirement } from 'foldkit-surface'
import {
  Entity,
  type AnySchema,
  type EntityDescriptor,
  type EntityRef,
  type RefPage,
} from './entity.js'
import type { QueryWindow } from './query.js'
import { isRefPage, relationShape, targetsOf } from './relation.js'
import { entityKey, isFieldStale, isTombstone, readField, type EntityStore } from './store.js'

/** One page of a paginated relation with each target assembled through a nested selection. */
export interface Page<Item> {
  readonly items: ReadonlyArray<Item>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

/**
 * The fields a projection reads of one entity, plus the slice it reads of each
 * relation's target. `Shape` tells a parent selection whether this one is a
 * paginated relation (`connection`) or a plain entity slice (`entity`).
 */
export interface Selection<
  Value,
  Name extends string = string,
  Shape extends 'entity' | 'connection' = 'entity' | 'connection',
> {
  readonly entity: Name
  readonly fields: readonly string[]
  /** A pure codec: entity fields carry no decoding or encoding services. */
  readonly schema: Schema.Codec<Value, unknown, never, never>
  /** Pagination windows for nested relation fields, keyed by field name. */
  readonly connections?: Readonly<Record<string, QueryWindow>> | undefined
  /** The slice required of each nested relation's target, keyed by field name. */
  readonly relations?: Readonly<Record<string, RelationRequirement>> | undefined
  /** Present when this selection is itself a paginated relation. */
  readonly window?: QueryWindow | undefined
  /** Phantom: see `Shape`. */
  readonly shape?: Shape | undefined
}

/** Flattens a mapped type so hovers show the picked fields, not the machinery. */
type Simplify<T> = T extends infer O ? { readonly [K in keyof O]: O[K] } : never

/** The value a Selection reads: `Selection.Value<typeof ProjectCard>`. */
export type SelectionValueOf<S> = S extends Selection<infer V, any, any> ? V : never

/** The nested selections a relation field admits: of its target entity, in the shapes its value takes. */
type NestedFor<Field> =
  Exclude<Field, null | undefined> extends ReadonlyArray<EntityRef<infer Name, any>>
    ? Selection<unknown, Name, 'entity' | 'connection'>
    : Exclude<Field, null | undefined> extends RefPage<infer Name, any>
      ? Selection<unknown, Name, 'entity' | 'connection'>
      : Exclude<Field, null | undefined> extends EntityRef<infer Name, any>
        ? Selection<unknown, Name, 'entity'>
        : never

type SelectionOf<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: true | NestedFor<Schema.Schema.Type<F[K]>>
}

/** `T | null` when the field admits `null` or `undefined` (both assemble to `null`). */
type Nullable<Field, T> = [Extract<Field, null | undefined>] extends [never] ? T : T | null

/** A nested selection's value takes the shape of the field it selects through. */
type NestedValue<Field, Sel> =
  Sel extends Selection<infer V, string, 'connection'>
    ? Nullable<Field, V>
    : Sel extends Selection<infer V, string, 'entity'>
      ? Nullable<
          Field,
          Exclude<Field, null | undefined> extends ReadonlyArray<EntityRef<any, any>>
            ? ReadonlyArray<V>
            : Exclude<Field, null | undefined> extends RefPage<any, any>
              ? Page<V>
              : V
        >
      : never

type SelectionValue<F extends Schema.Struct.Fields, Sel> = Simplify<{
  readonly [K in keyof Sel & keyof F]: Sel[K] extends true
    ? Schema.Schema.Type<F[K]>
    : NestedValue<Schema.Schema.Type<F[K]>, Sel[K]>
}>

const pageSchema = (item: AnySchema): AnySchema =>
  Schema.Struct({
    items: Schema.Array(item),
    hasNext: Schema.Boolean,
    hasPrevious: Schema.Boolean,
  }) as unknown as AnySchema

/** The requirement a nested selection contributes for its relation's target. */
export const relationOf = (selection: Selection<unknown>): RelationRequirement => ({
  entity: selection.entity,
  fields: selection.fields,
  ...(selection.connections === undefined ? {} : { windows: selection.connections }),
  ...(selection.relations === undefined ? {} : { relations: selection.relations }),
})

export const Selection = {
  /**
   * The fields to read of `entity`. A nested `Selection` on a relation field
   * reads through the ref (or refs, or page of refs) the field holds into the
   * target's fields; a scalar field cannot take one.
   */
  make: <Name extends string, F extends Schema.Struct.Fields, const Sel extends SelectionOf<F>>(
    entity: EntityDescriptor<Name, F>,
    selection: Sel,
  ): Selection<SelectionValue<F, Sel>, Name, 'entity'> => {
    if (Object.keys(selection).length === 0) {
      throw new Error(`Selection.make: a selection of "${entity.name}" picks at least one field`)
    }
    const picked: Record<string, AnySchema> = {}
    const connections: Record<string, QueryWindow> = {}
    const relations: Record<string, RelationRequirement> = {}
    for (const key of Object.keys(selection)) {
      const choice = (selection as Record<string, unknown>)[key]
      if (choice === true) {
        picked[key] = entity.fields[key] as AnySchema
        continue
      }
      const nested = choice as Selection<unknown>
      const shape = relationShape(entity.fields[key] as Schema.Top)
      if (shape === undefined) {
        throw new Error(
          `Selection.make: "${key}" on "${entity.name}" is not a relation field, so it cannot take a nested selection`,
        )
      }
      if (nested.entity !== shape.entity) {
        throw new Error(
          `Selection.make: "${key}" on "${entity.name}" refers to "${shape.entity}", not "${nested.entity}"`,
        )
      }
      const nullable = (codec: AnySchema): AnySchema =>
        shape.nullable ? (Schema.NullOr(codec) as unknown as AnySchema) : codec
      if (nested.window !== undefined) {
        // A connection: the nested selection already carries its page codec.
        connections[key] = nested.window
        picked[key] = nullable(nested.schema as AnySchema)
        if (nested.fields.length > 0) relations[key] = relationOf(nested)
        continue
      }
      const item = nested.schema as AnySchema
      picked[key] = nullable(
        shape.kind === 'many'
          ? (Schema.Array(item) as unknown as AnySchema)
          : shape.kind === 'page'
            ? pageSchema(item)
            : item,
      )
      relations[key] = relationOf(nested)
    }
    return {
      entity: entity.name,
      fields: Object.keys(selection),
      schema: Schema.Struct(picked) as unknown as Schema.Codec<
        SelectionValue<F, Sel>,
        unknown,
        never,
        never
      >,
      ...(Object.keys(connections).length === 0 ? {} : { connections }),
      ...(Object.keys(relations).length === 0 ? {} : { relations }),
    }
  },

  /**
   * A paginated relation: one page of refs to `entity` with a window, or, with
   * a nested selection, one page of targets assembled through it.
   */
  connection: (<Name extends string, F extends Schema.Struct.Fields, Item = never>(
    entity: EntityDescriptor<Name, F>,
    window: QueryWindow,
    selection?: Selection<Item, Name, 'entity'>,
  ): Selection<RefPage<Name, F> | Page<Item>, Name, 'connection'> => {
    if (selection !== undefined && selection.entity !== entity.name) {
      throw new Error(
        `Selection.connection: a page of "${entity.name}" cannot select "${selection.entity}"`,
      )
    }
    return {
      entity: entity.name,
      fields: selection?.fields ?? [],
      schema: (selection === undefined
        ? Entity.refPage(entity)
        : pageSchema(selection.schema as AnySchema)) as unknown as Schema.Codec<
        RefPage<Name, F> | Page<Item>,
        unknown,
        never,
        never
      >,
      window,
      ...(selection?.connections === undefined ? {} : { connections: selection.connections }),
      ...(selection?.relations === undefined ? {} : { relations: selection.relations }),
    }
  }) as {
    <Name extends string, F extends Schema.Struct.Fields>(
      entity: EntityDescriptor<Name, F>,
      window: QueryWindow,
    ): Selection<RefPage<Name, F>, Name, 'connection'>
    <Name extends string, F extends Schema.Struct.Fields, Item>(
      entity: EntityDescriptor<Name, F>,
      window: QueryWindow,
      selection: Selection<Item, NoInfer<Name>, 'entity'>,
    ): Selection<Page<Item>, Name, 'connection'>
  },
}

interface Assembled {
  readonly values: unknown
  readonly refreshing: boolean
}

/**
 * Reads an entity's selected fields out of the store, following each nested
 * relation into its targets. `undefined` means some field, at any depth, is
 * not present yet. A tombstoned target reads as `null` (or is dropped from a
 * list), so the Selection's codec decides whether that is a failure.
 */
export const assemble = (
  store: EntityStore,
  key: string,
  requirement: RelationRequirement,
): Assembled | undefined => {
  const values: Record<string, unknown> = {}
  let refreshing = false
  for (const field of requirement.fields) {
    const value = readField(store, key, field)
    if (Option.isNone(value)) return undefined
    refreshing ||= isFieldStale(store, key, field)
    const relation = requirement.relations?.[field]
    if (relation === undefined) {
      values[field] = value.value
      continue
    }
    const nested = assembleRelation(store, value.value, relation)
    if (nested === undefined) return undefined
    values[field] = nested.values
    refreshing ||= nested.refreshing
  }
  return { values, refreshing }
}

const assembleTarget = (
  store: EntityStore,
  ref: { readonly entity: string; readonly id: string },
  relation: RelationRequirement,
): Assembled | 'absent' | undefined => {
  const key = entityKey(ref.entity, ref.id)
  return isTombstone(store, key) ? 'absent' : assemble(store, key, relation)
}

/** Assembles the targets a relation value refers to, in the value's own shape. */
const assembleRelation = (
  store: EntityStore,
  value: unknown,
  relation: RelationRequirement,
): Assembled | undefined => {
  if (value === null || value === undefined) return { values: null, refreshing: false }
  const targets: unknown[] = []
  let refreshing = false
  for (const ref of targetsOf(value, relation)) {
    const target = assembleTarget(store, ref, relation)
    if (target === undefined) return undefined
    if (target === 'absent') continue
    targets.push(target.values)
    refreshing ||= target.refreshing
  }
  if (typeof value === 'string') {
    return { values: targets.length === 0 ? null : targets[0], refreshing }
  }
  if (isRefPage(value)) {
    return {
      values: { items: targets, hasNext: value.hasNext, hasPrevious: value.hasPrevious },
      refreshing,
    }
  }
  return { values: targets, refreshing }
}
