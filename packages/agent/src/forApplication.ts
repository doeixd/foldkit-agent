import type { Schema } from 'effect'
import type { Application, Projection, WritableProjection } from 'foldkit-surface'
import { type Definition, define } from './define.js'
import {
  type AnyCapabilitiesByName,
  type AnyCapabilitiesByTag,
  type ExposedMessages,
  expose,
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
  'define'
> {
  readonly define: <
    R extends ReadableProjection<Model, any> | undefined = undefined,
    ByName = AnyCapabilitiesByName,
    ByTag = AnyCapabilitiesByTag,
  >(options: {
    readonly context?: R
    readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
    readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
  }) => Definition<Model, ProjectionValue<R>, Principal, ByName, ByTag>
}

/**
 * Binds the agent constructors to a `Surface.application`. The Model is inferred
 * from the application, and a `Surface.pick`/`Surface.compose` projection is
 * accepted directly as `context`.
 *
 * @example
 * ```ts
 * const TodoAgent = Agent.forApplication(App)
 * const AppAgent = TodoAgent.define({
 *   context: Surface.pick(App.fields.todos),
 *   messages: TodoAgent.expose(Message, { RequestedDeleteTodo: 'Delete a todo' }),
 * })
 * ```
 */
export const forApplication = <Model, Principal = unknown>(
  _app: Application<Model, any, any>,
): ApplicationAgent<Model, Principal> => {
  const agentDefine = <
    R extends ReadableProjection<Model, any> | undefined,
    ByName,
    ByTag,
  >(options: {
    readonly context?: R
    readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
    readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
  }): Definition<Model, ProjectionValue<R>, Principal, ByName, ByTag> =>
    define<Model, ProjectionValue<R>, Principal, ByName, ByTag>({
      ...(options.context === undefined
        ? {}
        : { context: toProjection(options.context as ReadableProjection<Model, any>) }),
      messages: options.messages,
      resources: options.resources,
    })

  return {
    expose: expose as ApplicationAgent<Model, Principal>['expose'],
    resource,
    bind,
    define: agentDefine,
  }
}
