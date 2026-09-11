import { Schema } from 'effect'

/**
 * A synchronized projection of an application Model: the shared fields, how to
 * read them out of the Model, and how to write them back leaving local fields
 * untouched. The high-level Foldkit Sync declaration derives its `shared` codec
 * and `empty` from one of these.
 */
export interface Projection<Model, Fields extends Schema.Struct.Fields> {
  readonly schema: Schema.Struct<Fields>
  readonly get: (model: Model) => Schema.Struct.Type<Fields>
  readonly set: (model: Model, shared: Schema.Struct.Type<Fields>) => Model
}

/**
 * Picks the shared fields of a Model struct, inferring the shared type and its
 * encoded form. `pick(Model, ['todos'])` is the projection the low-level
 * `defineSync` would otherwise take three hand-written pieces for.
 */
export const pick = <
  Fields extends Schema.Struct.Fields,
  const Keys extends ReadonlyArray<keyof Fields & string>,
>(
  model: Schema.Struct<Fields>,
  keys: Keys,
): Projection<Schema.Struct.Type<Fields>, Pick<Fields, Keys[number]>> => {
  const fields = Object.fromEntries(keys.map(key => [key, model.fields[key]])) as Pick<
    Fields,
    Keys[number]
  >
  return {
    schema: Schema.Struct(fields),
    get: model =>
      Object.fromEntries(
        keys.map(key => [key, (model as Record<string, unknown>)[key]]),
      ) as Schema.Struct.Type<Pick<Fields, Keys[number]>>,
    set: (model, shared) => ({ ...model, ...shared }),
  }
}
