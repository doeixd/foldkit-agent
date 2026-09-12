import type { Schema } from 'effect'
import type { Application, Projection, WritableProjection } from 'foldkit-surface'
import { type Definition, make } from './make.js'
import {
  type AnyCapabilitiesByName,
  type AnyCapabilitiesByTag,
  type ExposedMessages,
  expose,
  exposeSubset,
} from './expose.js'
import { type BoundAgent } from './forModel.js'
import { type Resource, resource } from './resource.js'
import { bind } from './runtime.js'

/** A projection an agent can read: a read-only `Projection` or a writable pick. */
export type ReadableProjection<Model, Value> =
  Projection<Model, Value> | WritableProjection<Model, any>

/** The value a readable projection produces. */
export type ProjectionValue<R> =
  R extends Projection<any, infer V>
    ? V
    : R extends WritableProjection<any, infer F>
      ? Schema.Struct.Type<F>
      : unknown

/** Adapts the read side of a writable projection to a read-only `Projection`. */
const toProjection = <Model, R extends ReadableProjection<Model, any>>(
  readable: R,
): Projection<Model, ProjectionValue<R>> =>
  ('read' in readable
    ? readable
    : {
        Model: readable.schema,
        dependencies: readable.dependencies,
        requirements: [],
        read: readable.get,
      }) as Projection<Model, ProjectionValue<R>>

/**
 * `Agent.forApplication(App)` fixes the Model from a `Surface.application` and
 * accepts a Surface projection (read-only or writable) as the agent context, so
 * the same `Surface.pick`/`Surface.compose` value an application replicates is
 * also what an agent may see.
 */
export interface ApplicationAgent<Model, Principal> extends Omit<
  BoundAgent<Model, Principal>,
  'make'
> {
  readonly make: <
    R extends ReadableProjection<Model, any> | undefined = undefined,
    ByName = AnyCapabilitiesByName,
    ByTag = AnyCapabilitiesByTag,
  >(options: {
    readonly context?: R
    readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
    readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
  }) => Definition<Model, ProjectionValue<R>, Principal, ByName, ByTag>
  /**
   * Fixes the `Principal` that `authorize` and the host's `principal` see. A
   * `Principal` cannot be a positional type argument beside an inferred Model,
   * so it is supplied here: `Agent.forApplication(App).withPrincipal<Admin>()`.
   * Type-only; the constructors are unchanged.
   */
  readonly withPrincipal: <P>() => ApplicationAgent<Model, P>
}

const buildAgent = <Model, Principal>(
  app: Application<Model, any, any>,
): ApplicationAgent<Model, Principal> => {
  // `Surface.pick`/`Surface.messages` carry a per-application owner token, so a
  // subset from another application is refused even when the types match.
  const appExposeSubset = ((subset: { readonly owner: object }, variants: unknown): unknown => {
    if (subset.owner !== app.owner)
      throw new Error('Agent.exposeSubset: the subset belongs to a different application')
    return (exposeSubset as unknown as (subset: unknown, variants: unknown) => unknown)(
      subset,
      variants,
    )
  }) as ApplicationAgent<Model, Principal>['exposeSubset']

  const agentMake = <R extends ReadableProjection<Model, any> | undefined, ByName, ByTag>(options: {
    readonly context?: R
    readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
    readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
  }): Definition<Model, ProjectionValue<R>, Principal, ByName, ByTag> =>
    make<Model, ProjectionValue<R>, Principal, ByName, ByTag>({
      ...(options.context === undefined
        ? {}
        : { context: toProjection(options.context as ReadableProjection<Model, any>) }),
      messages: options.messages,
      resources: options.resources,
    })

  return {
    expose: expose as ApplicationAgent<Model, Principal>['expose'],
    exposeSubset: appExposeSubset,
    resource,
    bind,
    make: agentMake,
    withPrincipal: <P>() => buildAgent<Model, P>(app),
  }
}

/**
 * Binds the agent constructors to a `Surface.application`. The Model is inferred
 * from the application, and a `Projection.pick`/`Projection.compose` projection
 * is accepted directly as `context`. `withPrincipal<P>()` fixes the principal.
 *
 * @example
 * ```ts
 * const TodoAgent = Agent.forApplication(App) // no principal
 * const AdminAgent = Agent.forApplication(App).withPrincipal<Principal>()
 * const AppAgent = TodoAgent.make({
 *   context: Projection.pick(App.fields.todos),
 *   messages: TodoAgent.expose(Message, { RequestedDeleteTodo: 'Delete a todo' }),
 * })
 * ```
 */
export const forApplication = <
  Model,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
>(
  app: Application<Model, F, Cases>,
): ApplicationAgent<Model, unknown> => buildAgent(app)
