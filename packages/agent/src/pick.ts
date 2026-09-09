import { Schema } from 'effect'
import type { Context } from './context.js'

type Fields = Schema.Struct.Fields

/**
 * Projects named Model fields as the agent context.
 *
 * `Agent.context` takes a schema and a `select` that must agree; writing the
 * field list twice invites them to drift, and a mismatch only surfaces when the
 * context is read. `pick` derives both from one list.
 *
 * @example
 * ```ts
 * const context = Agent.pick(Model, ['todos', 'selectedTodoId'])
 * ```
 */
export const pick = <F extends Fields, const Keys extends ReadonlyArray<keyof F & string>>(
  model: { readonly fields: F },
  keys: Keys,
): Context<Schema.Struct.Type<F>, Schema.Struct.Type<Pick<F, Keys[number]>>> => {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (!(key in model.fields)) {
      throw new Error(`Cannot pick "${key}": the Model has no such field`)
    }
    picked[key] = model.fields[key]
  }

  return {
    schema: Schema.Struct(picked as Pick<F, Keys[number]>) as never,
    select: source => {
      const projected: Record<string, unknown> = {}
      for (const key of keys) {
        projected[key] = (source as Record<string, unknown>)[key]
      }
      return projected as Schema.Struct.Type<Pick<F, Keys[number]>>
    },
  }
}
