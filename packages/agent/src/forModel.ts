import type { Schema } from 'effect'
import { type Context, context } from './context.js'
import { type Definition, define } from './define.js'
import { type ExposedMessages, expose } from './expose.js'
import { type Resource, resource } from './resource.js'
import { type AgentHost, type AgentRuntime, bind } from './runtime.js'
import type { AnyMessage } from './types.js'

type Cases = Record<string, Schema.Struct.Fields>

/** The `@foldkit/agent` surface with `Model` (and optionally `Principal`) already fixed. */
export interface BoundAgent<Model, Principal> {
  readonly context: <Value>(options: {
    readonly schema: Schema.Codec<Value, any, never, never>
    readonly select: (model: Model) => Value
  }) => Context<Model, Value>

  readonly expose: <const C extends Cases, const V extends Record<string, unknown>>(
    message: Parameters<typeof expose<C, V, Model, Principal>>[0],
    variants: Parameters<typeof expose<C, V, Model, Principal>>[1],
  ) => ExposedMessages<Model, Principal>

  readonly resource: <Value>(
    name: string,
    options: {
      readonly description: string
      readonly schema: Schema.Codec<Value, any, never, never>
      readonly read: (model: Model) => Value
    },
  ) => Resource<Model, Value>

  readonly define: <Context_>(options: {
    readonly context?: Context<Model, Context_> | undefined
    readonly messages: ExposedMessages<Model, Principal>
    readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
  }) => Definition<Model, Context_, Principal>

  readonly bind: <Context_, Message extends AnyMessage = AnyMessage>(options: {
    readonly definition: Definition<Model, Context_, Principal>
    readonly host: AgentHost<Model, Message>
  }) => AgentRuntime<Model, Context_, Principal>
}

/**
 * Binds the agent constructors to one application's Model.
 *
 * TypeScript cannot infer `Model` from an `available` or `select` callback
 * alone, so unannotated callbacks such as
 * `available: model => Option.isSome(model.selectedTodoId)` only type-check
 * when the Model is known up front. Fixing it once removes the annotation from
 * every call site.
 *
 * @example
 * ```ts
 * const Agent_ = Agent.forModel<Model>()
 *
 * const AppAgent = Agent_.define({
 *   context: Agent_.context({ schema: AgentContext, select: model => ({ ... }) }),
 *   messages: Agent_.expose(Message, {
 *     RequestedDeleteTodo: {
 *       description: 'Delete a todo',
 *       available: model => Option.isSome(model.selectedTodoId),
 *     },
 *   }),
 * })
 * ```
 */
export const forModel = <Model, Principal = unknown>(): BoundAgent<Model, Principal> => ({
  context: context as BoundAgent<Model, Principal>['context'],
  expose: expose as unknown as BoundAgent<Model, Principal>['expose'],
  resource: resource as BoundAgent<Model, Principal>['resource'],
  define: define as BoundAgent<Model, Principal>['define'],
  bind: bind as BoundAgent<Model, Principal>['bind'],
})
