import { Effect, Schema } from 'effect'
import type { Definition } from './define.js'
import {
  AuthorizationError,
  CapabilityUnavailableError,
  type DispatchError,
  InvalidInputError,
  ResourceError,
  UnknownCapabilityError,
} from './errors.js'
import type { ExposedVariant } from './expose.js'
import type {
  AnyMessage,
  DispatchResult,
  Invocation,
  InvocationContext,
  MessageDescriptor,
} from './types.js'
import { messages as describeMessages } from './introspect.js'

/**
 * The application-supplied binding between an agent contract and a live
 * Foldkit Runtime.
 *
 * Foldkit `0.158.2` does not yet accept an `agent` option in
 * `Runtime.makeApplication`, and its runtime handle exposes no Model or
 * dispatch surface. Until it does, the application provides that seam: `model`
 * reads the current Model and `dispatch` sends a Message into the Runtime, for
 * example through a Foldkit port or the same reference `update` runs on.
 */
export interface AgentHost<Model, Message extends AnyMessage = AnyMessage> {
  /** Reads the current Model. Called once per invocation, before validation. */
  readonly model: () => Model
  /** Sends a Message into the Foldkit Runtime. */
  readonly dispatch: (message: Message) => void | Promise<void> | Effect.Effect<void>
  /** Resolves the caller's identity for `authorize`. Defaults to `undefined`. */
  readonly principal?: (invocation: Invocation) => unknown
  /** Subscribes to Model changes so adapters can reconcile availability. */
  readonly subscribe?: (listener: () => void) => () => void
}

/**
 * An `Agent.Definition` bound to a live Runtime.
 *
 * Protocol adapters bind to this seam rather than reaching into `update`.
 */
export interface AgentRuntime<Model = unknown, Context_ = unknown, Principal = unknown> {
  readonly definition: Definition<Model, Context_, Principal>

  /** The projected agent context, or `undefined` when the definition declares none. */
  readonly context: Effect.Effect<Context_ | undefined>

  readonly resources: {
    readonly read: (name: string) => Effect.Effect<unknown, ResourceError>
  }

  readonly messages: {
    /** Every exposed capability, regardless of availability. */
    readonly list: Effect.Effect<ReadonlyArray<MessageDescriptor>>
    /** Only the capabilities whose `available(model)` currently holds. */
    readonly available: Effect.Effect<ReadonlyArray<MessageDescriptor>>
    readonly dispatch: (
      name: string,
      input: unknown,
      invocation: Invocation,
    ) => Effect.Effect<DispatchResult, DispatchError>
  }

  /** Subscribes to Model changes, when the host supports it. Returns an unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * Binds an agent contract to a live Foldkit Runtime.
 *
 * @example
 * ```ts
 * const agentRuntime = Agent.bind({
 *   definition: AppAgent,
 *   host: { model: () => store.model, dispatch: message => store.dispatch(message) },
 * })
 * ```
 */
export interface BindOptions<Model, Context_, Principal, Message extends AnyMessage> {
  readonly definition: Definition<Model, Context_, Principal>
  readonly host: AgentHost<Model, Message>
}

export const bind = <Model, Context_, Principal, Message extends AnyMessage = AnyMessage>(
  options: BindOptions<Model, Context_, Principal, Message>,
): AgentRuntime<Model, Context_, Principal> => {
  const { definition, host } = options

  // The contract is immutable, so every lookup table and descriptor is built
  // once here rather than on each invocation.
  const byName = new Map<string, ExposedVariant<Model, Principal>>()
  for (const variant of definition.messages.variants) {
    byName.set(variant.name, variant)
  }

  const resourcesByName = new Map(
    definition.resources.map(resource => [resource.name, resource] as const),
  )

  const descriptors = describeMessages(definition)
  const descriptorByName = new Map(
    descriptors.map(descriptor => [descriptor.name, descriptor] as const),
  )

  const isAvailable = (variant: ExposedVariant<Model, Principal>, model: Model): boolean =>
    variant.available === undefined || variant.available(model)

  const dispatch = (
    name: string,
    input: unknown,
    invocation: Invocation,
  ): Effect.Effect<DispatchResult, DispatchError> =>
    Effect.gen(function* () {
      const variant = byName.get(name)
      if (variant === undefined) {
        return yield* Effect.fail(new UnknownCapabilityError({ capability: name }))
      }

      const model = host.model()

      // Availability gates discovery and invocation; authorization is separate.
      if (!isAvailable(variant, model)) {
        return yield* Effect.fail(
          new CapabilityUnavailableError({ capability: name, tag: variant.tag }),
        )
      }

      // Untrusted agent input crosses a Schema boundary before anything else.
      const decoded: unknown = yield* Effect.mapError(
        Schema.decodeUnknownEffect(variant.inputSchema)(input),
        cause => new InvalidInputError({ capability: name, tag: variant.tag, cause }),
      )

      const principal = host.principal?.(invocation) as Principal

      if (variant.authorize !== undefined) {
        const decision = variant.authorize({
          principal,
          input: decoded,
          model,
          transport: invocation.transport,
        })
        const allowed = Effect.isEffect(decision) ? yield* decision : decision
        if (!allowed) {
          return yield* Effect.fail(
            new AuthorizationError({ capability: name, tag: variant.tag }),
          )
        }
      }

      const context: InvocationContext<Model, Principal> = { model, principal, invocation }
      const message = variant.construct(decoded, context)

      // `construct` always produces a member of this application's Message union.
      const sent = host.dispatch(message as Message)
      if (Effect.isEffect(sent)) {
        yield* Effect.orDie(sent)
      } else if (sent instanceof Promise) {
        yield* Effect.orDie(Effect.promise(() => sent))
      }

      return { name, tag: variant.tag, message, invocation } satisfies DispatchResult
    })

  return {
    definition,

    context: Effect.sync(() =>
      definition.context === undefined ? undefined : definition.context.select(host.model()),
    ),

    resources: {
      read: (name: string) =>
        Effect.suspend(() => {
          const resource = resourcesByName.get(name)
          return resource === undefined
            ? Effect.fail(new ResourceError({ resource: name, reason: 'no such resource' }))
            : Effect.sync(() => resource.read(host.model()))
        }),
    },

    messages: {
      list: Effect.succeed(descriptors),
      available: Effect.sync(() => {
        const model = host.model()
        return definition.messages.variants
          .filter(variant => isAvailable(variant, model))
          .map(variant => descriptorByName.get(variant.name)!)
      }),
      dispatch,
    },

    subscribe: (listener: () => void) => host.subscribe?.(listener) ?? (() => {}),
  }
}
