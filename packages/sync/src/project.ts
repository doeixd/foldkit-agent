/**
 * A writable projection of an application Model built from Surface `ModelRef`s:
 * the shared Schema, how to read the shared fields, and how to write them back
 * leaving local fields untouched. This is the Surface-based replacement for the
 * removed `pick` spike; `Sync.define` compiles it to `defineSync`'s `shared`/`empty`.
 */
import { Schema } from 'effect'
import type { ModelRef } from 'foldkit-surface'

type EntrySchema<E> = E extends { readonly Schema: infer S } ? S : never
type EntryModel<E> = E extends ModelRef<infer M, any> ? M : never

/** `ModelRef` is invariant in its focus, so the runtime uses an erased shape. */
interface ErasedRef {
  readonly Schema: Schema.Schema<unknown>
  readonly get: (model: never) => unknown
  readonly set: (model: never, value: never) => never
}

export interface WritableProjection<Model, Fields extends Schema.Struct.Fields> {
  readonly schema: Schema.Struct<Fields>
  readonly get: (model: Model) => Schema.Struct.Type<Fields>
  readonly set: (model: Model, shared: Schema.Struct.Type<Fields>) => Model
}

export const project = <const Entries extends Record<string, ModelRef<any, any>>>(
  entries: Entries,
): WritableProjection<
  EntryModel<Entries[keyof Entries]>,
  { readonly [K in keyof Entries]: EntrySchema<Entries[K]> }
> => {
  const keys = Object.keys(entries)
  const erased = (key: string): ErasedRef => entries[key] as unknown as ErasedRef

  const fields: Record<string, Schema.Schema<unknown>> = {}
  for (const key of keys) fields[key] = erased(key).Schema

  return {
    schema: Schema.Struct(fields) as never,
    get: model => {
      const shared: Record<string, unknown> = {}
      for (const key of keys) shared[key] = erased(key).get(model as never)
      return shared as never
    },
    set: (model, shared) => {
      let next = model
      for (const key of keys) {
        next = erased(key).set(next as never, (shared as Record<string, unknown>)[key] as never)
      }
      return next
    },
  }
}
