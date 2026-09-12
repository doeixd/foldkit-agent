/**
 * A writable projection of an application Model built from Surface `ModelRef`s:
 * the shared Schema, how to read the shared fields, and how to write them back
 * leaving local fields untouched. This is the Surface-based replacement for the
 * removed `pick` spike; `Sync.forApplication(App).define` compiles it to `defineSync`'s
 * `shared`/`empty`.
 */
import { Schema } from 'effect'
import type { DependencyTree, ModelRef, WritableProjection } from 'foldkit-surface'

export type { WritableProjection }

type EntrySchema<E> = E extends { readonly Schema: infer S } ? S : never
// Tuple-wrapped so an empty entry map (E = never) yields `unknown` rather than
// making every projection method uncallable.
type EntryModel<E> = [E] extends [never] ? unknown : E extends ModelRef<infer M, any> ? M : never

/** `ModelRef` is invariant in its focus, so the runtime uses an erased shape. */
interface ErasedRef {
  readonly Schema: Schema.Schema<unknown>
  readonly dependency: readonly string[]
  readonly get: (model: never) => unknown
  readonly set: (model: never, value: never) => never
}

/** Unions dependency paths, dropping duplicates. */
const mergeDependencies = (paths: readonly (readonly string[])[]): DependencyTree => {
  const seen = new Set<string>()
  const merged: (readonly string[])[] = []
  for (const path of paths) {
    const key = path.join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(path)
  }
  return merged
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
    dependencies: mergeDependencies(keys.map(key => erased(key).dependency)),
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
