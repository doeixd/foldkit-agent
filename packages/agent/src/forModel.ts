import { type Context, type ContextOptions, context } from './context.js'
import { type DefineOptions, type Definition, define } from './define.js'
import {
  type AnyCapabilitiesByName,
  type AnyCapabilitiesByTag,
  type CapabilitiesByName,
  type CapabilitiesByTag,
  type Cases,
  type ExposedMessages,
  type ValidateVariants,
  expose,
} from './expose.js'
import { type Resource, type ResourceOptions, resource } from './resource.js'
import { type AgentRuntime, type BindOptions, bind } from './runtime.js'
import type { AnyMessage } from './types.js'
import type { MessageUnion } from 'foldkit/message'

/**
 * The `@foldkit/agent` constructors with `Model` and `Principal` already fixed.
 *
 * Each signature mirrors the free function of the same name; only the Model is
 * no longer inferred.
 */
export interface BoundAgent<Model, Principal> {
  readonly context: <Value>(options: ContextOptions<Model, Value>) => Context<Model, Value>

  readonly expose: <
    const C extends Cases,
    const V extends Record<string, unknown>,
    Ext extends Record<string, unknown> = {},
  >(
    message: MessageUnion<C>,
    variants: V & ValidateVariants<C, Ext, Model, Principal>,
  ) => ExposedMessages<Model, Principal, CapabilitiesByName<C, V>, CapabilitiesByTag<C, V>>

  readonly resource: <Value>(
    name: string,
    options: ResourceOptions<Model, Value>,
  ) => Resource<Model, Value>

  readonly define: <Context_, ByName = AnyCapabilitiesByName, ByTag = AnyCapabilitiesByTag>(
    options: DefineOptions<Model, Context_, Principal, ByName, ByTag>,
  ) => Definition<Model, Context_, Principal, ByName, ByTag>

  readonly bind: <
    Context_,
    Message extends AnyMessage = AnyMessage,
    ByName = AnyCapabilitiesByName,
    ByTag = AnyCapabilitiesByTag,
  >(
    options: BindOptions<Model, Context_, Principal, Message, ByName, ByTag>,
  ) => AgentRuntime<Model, Context_, Principal, ByName, ByTag>
}

/**
 * Binds the agent constructors to one application's Model.
 *
 * TypeScript cannot infer `Model` from an `available` or `select` callback
 * alone, so `available: model => Option.isSome(model.selectedTodoId)` only
 * type-checks when the Model is known up front. Fixing it once removes the
 * annotation from every call site.
 *
 * @example
 * ```ts
 * const TodoAgent = Agent.forModel<Model>()
 *
 * const AppAgent = TodoAgent.define({
 *   messages: TodoAgent.expose(Message, {
 *     RequestedDeleteTodo: {
 *       description: 'Delete a todo',
 *       available: model => Option.isSome(model.selectedTodoId),
 *     },
 *   }),
 * })
 * ```
 */
export const forModel = <Model, Principal = unknown>(): BoundAgent<Model, Principal> => ({
  context,
  expose: expose as BoundAgent<Model, Principal>['expose'],
  resource,
  define,
  bind,
})
