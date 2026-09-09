import type { Duration, Effect, Schema } from 'effect'
import type { AuthorizationError } from './errors.js'

/** Any Foldkit Message: a tagged struct value. */
export type AnyMessage = { readonly _tag: string }

/** The protocol an invocation arrived over. Adapters normalize this before dispatch. */
export type Transport = 'webmcp' | 'mcp' | 'in-app' | 'a2a' | (string & {})

/** Normalized metadata about a single agent invocation. */
export interface Invocation {
  readonly id: string
  readonly transport: Transport
  readonly signal?: AbortSignal | undefined
}

/** What a capability hook sees at invocation time. */
export interface InvocationContext<Model, Principal = unknown> {
  readonly model: Model
  readonly principal: Principal
  readonly invocation: Invocation
}

/** What an `authorize` hook is asked to decide. */
export interface AuthorizationRequest<Input, Model, Principal = unknown> {
  readonly principal: Principal
  readonly input: Input
  readonly model: Model
  readonly transport: Transport
}

/**
 * Optional description of when a dispatched Message is considered complete.
 *
 * Reserved for a later version: `@foldkit/agent` records the contract and
 * exposes it through introspection, but validated dispatch remains the
 * completion boundary.
 */
export interface Completion<Request = unknown, Result = unknown> {
  readonly success: unknown | ReadonlyArray<unknown>
  readonly failure?: unknown | ReadonlyArray<unknown>
  readonly correlate?: ((request: Request, result: Result) => boolean) | undefined
  readonly timeout?: Duration.DurationInput | undefined
}

/** Configuration for one exposed Message variant. */
export interface VariantConfig<
  MessageInput = unknown,
  ExternalInput = MessageInput,
  Model = unknown,
  Principal = unknown,
> {
  /** Optional protocol-facing capability name. The internal Message tag never changes. */
  readonly name?: string | undefined

  /** Required natural-language description of semantic behavior. */
  readonly description: string

  /** Optional Model-dependent capability predicate. Controls discoverability, not authorization. */
  readonly available?: ((model: Model) => boolean) | undefined

  /** Optional external input Schema, when the internal payload has fields an agent should not supply. */
  readonly input?: Schema.Codec<ExternalInput, any, unknown, unknown> | undefined

  /** Required when `input` is provided: maps external input onto the internal Message. */
  readonly toMessage?:
    | ((input: ExternalInput, context: InvocationContext<Model, Principal>) => MessageInput)
    | undefined

  /** Optional pre-dispatch authorization hook. Denied calls never dispatch. */
  readonly authorize?:
    | ((
        request: AuthorizationRequest<ExternalInput, Model, Principal>,
      ) => boolean | Effect.Effect<boolean, AuthorizationError>)
    | undefined

  /** Optional completion contract. Recorded but not executed in this version. */
  readonly completion?: Completion | undefined
}

/**
 * The protocol-neutral description of one exposed capability.
 *
 * Adapters should depend on this rather than inspecting application internals.
 */
export interface MessageDescriptor {
  /** The protocol-facing capability name. */
  readonly name: string
  /** The internal Foldkit Message tag. Never renamed. */
  readonly tag: string
  readonly description: string
  /** JSON Schema for the capability's input, derived from the Effect Schema. */
  readonly inputSchema: Record<string, unknown>
  /** True when the variant declares an `available` predicate. */
  readonly dynamic: boolean
  /** True when the variant declares an `authorize` hook. */
  readonly authorized: boolean
  /** The declared completion contract, if any. */
  readonly completion?: Completion | undefined
}

/** Protocol-neutral description of one read-only resource. */
export interface ResourceDescriptor {
  readonly name: string
  readonly description: string
  readonly schema: Record<string, unknown>
}

/** The full, data-only description of an agent contract. */
export interface AgentSchema {
  readonly messages: ReadonlyArray<MessageDescriptor>
  readonly resources: ReadonlyArray<ResourceDescriptor>
  readonly context?: Record<string, unknown> | undefined
}

/** The result of a successful validated dispatch. */
export interface DispatchResult<Message extends AnyMessage = AnyMessage> {
  readonly name: string
  readonly tag: string
  /** The Message that was dispatched into the Foldkit Runtime. */
  readonly message: Message
  readonly invocation: Invocation
}
