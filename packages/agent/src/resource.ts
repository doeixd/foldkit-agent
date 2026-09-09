import type { Schema } from 'effect'

/** Read-only Model state that can be requested separately from the default context. */
export interface Resource<Model, Value> {
  readonly name: string
  readonly description: string
  readonly schema: Schema.Codec<Value, any, never, never>
  readonly read: (model: Model) => Value
}

export type ResourceOptions<Model, Value> = Omit<Resource<Model, Value>, 'name'>

/**
 * Defines a named read-only projection of Model state.
 *
 * External MCP maps this onto a resource such as `app://todos`. WebMCP's
 * producer API is tool-oriented, so a WebMCP adapter may leave resources out or
 * project them as read-only tools.
 *
 * @example
 * ```ts
 * const TodosResource = Agent.resource('todos', {
 *   description: "The user's current todos",
 *   schema: Schema.Array(Todo),
 *   read: model => model.todos,
 * })
 * ```
 */
export const resource = <Model, Value>(
  name: string,
  options: ResourceOptions<Model, Value>,
): Resource<Model, Value> => ({
  name,
  description: options.description,
  schema: options.schema,
  read: options.read,
})
