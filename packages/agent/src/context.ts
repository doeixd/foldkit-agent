import type { Schema } from 'effect'

/**
 * The safe projection of Model state available to agent surfaces.
 *
 * The projection is an information boundary: it is what an agent may see, and
 * it is deliberately not the whole Model.
 */
export interface Context<Model, Value> {
  readonly schema: Schema.Codec<Value, any, never, never>
  readonly select: (model: Model) => Value
}

export type ContextOptions<Model, Value> = Context<Model, Value>

/**
 * Defines what an agent may see.
 *
 * `select` must be a pure projection from the current Foldkit Model; it should
 * not perform effects. Do not expose the entire Model by default.
 *
 * @example
 * ```ts
 * const context = Agent.context({
 *   schema: AgentContext,
 *   select: (model: Model) => ({ selectedTodoId: model.selectedTodoId }),
 * })
 * ```
 */
export const context = <Model, Value>(
  options: ContextOptions<Model, Value>,
): Context<Model, Value> => ({
  schema: options.schema,
  select: options.select,
})
