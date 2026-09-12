import { type MakeOptions, type Definition, make } from './make.js'
import {
  type AnyCapabilitiesByName,
  type AnyCapabilitiesByTag,
  type CapabilitiesByName,
  type CapabilitiesByTag,
  type Cases,
  type ExposedMessages,
  type SubsetCases,
  type ValidateVariants,
  expose,
  exposeSubset,
} from './expose.js'
import { type Resource, type ResourceOptions, resource } from './resource.js'
import { type AgentRuntime, type BindOptions, bind } from './runtime.js'
import type { AnyMessage } from './types.js'
import type { MessageUnion } from 'foldkit/message'
import type { MessageSubset } from 'foldkit-surface'

/**
 * The `foldkit-agent` constructors with `Model` and `Principal` already fixed.
 *
 * Each signature mirrors the free function of the same name; only the Model is
 * no longer inferred.
 */
export interface BoundAgent<Model, Principal> {
  readonly expose: <
    const C extends Cases,
    const V extends Record<string, unknown>,
    Ext extends Record<string, unknown> = {},
  >(
    message: MessageUnion<C>,
    variants: V & ValidateVariants<C, Ext, Model, Principal>,
  ) => ExposedMessages<Model, Principal, CapabilitiesByName<C, V>, CapabilitiesByTag<C, V>>

  readonly exposeSubset: <
    Root,
    Message,
    Subset extends Message,
    Ms extends readonly ((...args: never[]) => Message)[],
    AllCases extends Cases,
    const V extends Record<string, unknown>,
    Ext extends Record<string, unknown> = {},
  >(
    subset: MessageSubset<Root, Message, Subset, Ms, AllCases>,
    variants: V & ValidateVariants<SubsetCases<AllCases, Ms>, Ext, Model, Principal>,
  ) => ExposedMessages<
    Model,
    Principal,
    CapabilitiesByName<SubsetCases<AllCases, Ms>, V>,
    CapabilitiesByTag<SubsetCases<AllCases, Ms>, V>
  >

  readonly resource: <Value>(
    name: string,
    options: ResourceOptions<Model, Value>,
  ) => Resource<Model, Value>

  readonly make: <Context_, ByName = AnyCapabilitiesByName, ByTag = AnyCapabilitiesByTag>(
    options: MakeOptions<Model, Context_, Principal, ByName, ByTag>,
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
 * const AppAgent = TodoAgent.make({
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
  expose: expose as BoundAgent<Model, Principal>['expose'],
  exposeSubset: exposeSubset as BoundAgent<Model, Principal>['exposeSubset'],
  resource,
  make,
  bind,
})
