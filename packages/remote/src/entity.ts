/**
 * Entities: the descriptor an application declares, refs, ref pages, and
 * patches, with the codecs that carry refs on the wire.
 */
import { Schema, SchemaGetter } from 'effect'
import { RelationAnnotation, RelationEntityAnnotation, refParts } from './relation.js'
import { entityKey } from './store.js'

export type AnySchema = Schema.Schema<unknown>

declare const entityRefFields: unique symbol

/**
 * A normalized reference to an entity. `F` is a phantom carrying the entity's
 * fields so `Entity.patch` can type its patch; it is absent at runtime.
 */
export interface EntityRef<
  Name extends string,
  F extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly entity: Name
  readonly id: string
  readonly [entityRefFields]?: F
}

export interface EntityDescriptor<Name extends string, F extends Schema.Struct.Fields> {
  readonly name: Name
  readonly schema: Schema.Struct<F>
  readonly fields: F
  // A method, not a property: method signatures are bivariant, so a concrete
  // descriptor stays assignable to `EntityDescriptor<any, any>` (which appears
  // in every heterogeneous collection, e.g. `Remote.make`'s entities).
  ref(id: Schema.Schema.Type<F['id']>): EntityRef<Name, F>
}

/**
 * Relations are **references**, never inline target schemas: a ref cannot
 * reconstruct a full entity, and dereferencing is a store concern. Because the
 * target schema is not inlined, recursive relations cannot arise through the
 * schema graph.
 */
const refCodec = <Name extends string, F extends Schema.Struct.Fields>(
  entity: Name,
): Schema.Codec<EntityRef<Name, F>, string> =>
  Schema.Struct({ entity: Schema.String, id: Schema.String })
    .pipe(
      Schema.encodeTo(Schema.String, {
        decode: SchemaGetter.transform(refParts),
        encode: SchemaGetter.transform((ref: EntityRef<string>) => entityKey(ref.entity, ref.id)),
      }),
    )
    .annotate({
      [RelationAnnotation]: 'one',
      [RelationEntityAnnotation]: entity,
    }) as unknown as Schema.Codec<EntityRef<Name, F>, string>

/**
 * A patch in wire shape: the values the store holds, so a relation is its ref
 * key (`Entity.refKey`), not an `EntityRef`.
 */
export interface EntityPatch<Name extends string, F extends Schema.Struct.Fields> {
  readonly entity: Name
  readonly id: string
  readonly values: Partial<Schema.Struct.Encoded<F>>
}

/**
 * One authoritative page of a paginated relation: refs (never inline entities)
 * plus whether more exist. The adapter does not hold segmentation state; the
 * client merges pages.
 */
export interface RefPage<
  Name extends string,
  F extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly refs: ReadonlyArray<EntityRef<Name, F>>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

const refPageCodec = <Name extends string, F extends Schema.Struct.Fields>(
  entity: Name,
): Schema.Codec<
  RefPage<Name, F>,
  {
    readonly refs: ReadonlyArray<string>
    readonly hasNext: boolean
    readonly hasPrevious: boolean
  }
> =>
  Schema.Struct({
    refs: Schema.Array(refCodec<Name, F>(entity)),
    hasNext: Schema.Boolean,
    hasPrevious: Schema.Boolean,
  }).annotate({
    [RelationAnnotation]: 'page',
    [RelationEntityAnnotation]: entity,
  }) as unknown as Schema.Codec<
    RefPage<Name, F>,
    {
      readonly refs: ReadonlyArray<string>
      readonly hasNext: boolean
      readonly hasPrevious: boolean
    }
  >

export const Entity = {
  make: <
    const Name extends string,
    const F extends Schema.Struct.Fields & { readonly id: Schema.Schema<unknown> },
  >(
    name: Name,
    schema: Schema.Struct<F>,
  ): EntityDescriptor<Name, F> => ({
    name,
    schema,
    fields: schema.fields,
    ref: id => ({ entity: name, id: String(id) }) as EntityRef<Name, F>,
  }),

  /** A relation to a known entity, decoded as a reference. */
  ref: <Name extends string, F extends Schema.Struct.Fields>(
    entity: EntityDescriptor<Name, F>,
  ): Schema.Codec<EntityRef<Name, F>, string> => refCodec<Name, F>(entity.name),

  /** A relation by name, for recursive or forward references. */
  refTo: <Name extends string>(name: Name): Schema.Codec<EntityRef<Name>, string> =>
    refCodec<Name, Schema.Struct.Fields>(name),

  /**
   * The wire key a relation field carries (`"Entity:id"`). Adapters that read a
   * foreign key emit this so the ref codec can decode it on the client.
   */
  refKey: (ref: { readonly entity: string; readonly id: string }): string =>
    entityKey(ref.entity, ref.id),

  /** Splits a ref key back into its entity and id. */
  refParts,

  /** A relation value of one authoritative page of refs. */
  refPage: <Name extends string, F extends Schema.Struct.Fields>(
    entity: EntityDescriptor<Name, F>,
  ): Schema.Codec<
    RefPage<Name, F>,
    {
      readonly refs: ReadonlyArray<string>
      readonly hasNext: boolean
      readonly hasPrevious: boolean
    }
  > => refPageCodec<Name, F>(entity.name),

  /**
   * A normalized patch for an entity, typed against its fields' wire shape:
   * write a relation as its ref key (`Entity.refKey`), as the server does.
   */
  patch: <Name extends string, F extends Schema.Struct.Fields>(
    ref: EntityRef<Name, F>,
    patch: Partial<Schema.Struct.Encoded<F>>,
  ): EntityPatch<Name, F> => ({ entity: ref.entity, id: ref.id, values: patch }),
}
