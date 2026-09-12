import { Cause, Effect, Option, Schema } from 'effect'
import type { Definition } from './make.js'
import {
  AuthorizationError,
  CancelledError,
  CapabilityUnavailableError,
  type DispatchError,
  InvalidInputError,
  ResourceError,
  UnknownCapabilityError,
} from './errors.js'
import type { AnyCapabilitiesByName, AnyCapabilitiesByTag, ExposedVariant } from './expose.js'
import { resolveInvocation } from './invocation.js'
import type { AuditDecision, AuditSink } from './audit.js'
import { awaitCompletion } from './completion.js'
import { messageTag } from './tag.js'
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
export interface AgentHost<Model, Message extends AnyMessage = AnyMessage, Principal = unknown> {
  /** Reads the current Model. Called once per invocation, before validation. */
  readonly model: () => Model
  /**
   * Sends a Message into the Foldkit Runtime.
   *
   * A real application host accepts its whole Message union, which is wider
   * than the exposed subset; it may not be narrower.
   */
  readonly dispatch: (message: Message) => void | Promise<void> | Effect.Effect<void>
  /** Resolves the caller's identity for `authorize`. */
  readonly principal?: (invocation: Invocation) => Principal
  /** Subscribes to Model changes so adapters can reconcile availability. */
  readonly subscribe?: (listener: () => void) => () => void
  /**
   * Subscribes to every Message the Runtime processes.
   *
   * Required only by a contract that declares a `completion`, which needs to
   * see the Message that finishes the operation.
   */
  readonly observe?: (listener: (message: AnyMessage) => void) => () => void
}

/**
 * The Message type a host must accept.
 *
 * Every exposed capability constructs one of these, so a host that cannot
 * receive them is not a host for this contract.
 */
type MessagesOf<ByTag> = ByTag[keyof ByTag] extends { readonly message: infer Message }
  ? Message
  : AnyMessage

/**
 * What a host must supply for `authorize`.
 *
 * A contract whose hooks read a principal needs one; a contract that never
 * mentions it may omit the provider.
 */
type PrincipalOf<Principal> = unknown extends Principal
  ? { readonly principal?: (invocation: Invocation) => Principal }
  : { readonly principal: (invocation: Invocation) => Principal }

/**
 * An `Agent.Definition` bound to a live Runtime.
 *
 * Protocol adapters bind to this seam rather than reaching into `update`.
 */
/** A Message constructor, used to name a capability by reference. */
type MessageConstructorFor<Tag extends string> = (...args: never) => { readonly _tag: Tag }

/**
 * Names a capability and types its input.
 *
 * A capability can be named by its Message constructor, which infers the input
 * from the union, or by its protocol name. Both are checked; adapters bind
 * against the permissive default maps and pass a name from the wire.
 */
export interface Dispatch<ByName, ByTag> {
  <Tag extends keyof ByTag & string>(
    message: MessageConstructorFor<Tag>,
    input: ByTag[Tag] extends { readonly input: infer Input } ? Input : never,
    invocation?: Partial<Invocation>,
  ): Effect.Effect<DispatchResult, DispatchError>

  <Name extends keyof ByName & string>(
    name: Name,
    input: ByName[Name],
    invocation?: Partial<Invocation>,
  ): Effect.Effect<DispatchResult, DispatchError>
}

export interface AgentRuntime<
  Model = unknown,
  Context_ = unknown,
  Principal = unknown,
  ByName = AnyCapabilitiesByName,
  ByTag = AnyCapabilitiesByTag,
> {
  readonly definition: Definition<Model, Context_, Principal, ByName, ByTag>

  /**
   * The projected agent context, encoded through its declared schema, or
   * `undefined` when the definition declares none.
   *
   * The value is the schema's *encoded* side, which is what adapters serialize
   * onto the wire, so it is typed as `unknown` rather than as the decoded
   * `Context_` the application's `select` returns.
   */
  readonly context: Effect.Effect<unknown>

  readonly resources: {
    readonly read: (name: string) => Effect.Effect<unknown, ResourceError>
  }

  readonly messages: {
    /** Every exposed capability, regardless of availability. */
    readonly list: Effect.Effect<ReadonlyArray<MessageDescriptor>>
    /** Only the capabilities whose `available(model)` currently holds. */
    readonly available: Effect.Effect<ReadonlyArray<MessageDescriptor>>
    /**
     * Validates input and dispatches the Message.
     *
     * `invocation` is optional: an adapter passes its own id, transport, and
     * signal, while an in-app caller can omit it.
     */
    readonly dispatch: Dispatch<ByName, ByTag>

    /**
     * Dispatches a capability named by a string that is not known statically.
     *
     * This is the protocol path: an adapter reads a tool name and an unvalidated
     * payload off the wire, so neither can be checked at compile time. In-app
     * callers should use `dispatch`, which checks both.
     */
    readonly dispatchUnknown: (
      name: string,
      input: unknown,
      invocation?: Partial<Invocation>,
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
export type BindOptions<
  Model,
  Context_,
  Principal,
  Message extends AnyMessage,
  ByName = AnyCapabilitiesByName,
  ByTag = AnyCapabilitiesByTag,
> = {
  readonly definition: Definition<Model, Context_, Principal, ByName, ByTag>
  /**
   * Records every decision, refusals included.
   *
   * A sink that throws never fails the dispatch: accountability must not be a
   * new way for a capability to break.
   */
  readonly audit?: AuditSink | undefined
  /** The host must accept every Message the contract can construct. */
  readonly host: AgentHost<Model, Message, Principal> & {
    readonly dispatch: (message: MessagesOf<ByTag>) => void | Promise<void> | Effect.Effect<void>
  }
} & { readonly host: PrincipalOf<Principal> }

export const bind = <
  Model,
  Context_,
  Principal,
  Message extends AnyMessage = AnyMessage,
  ByName = AnyCapabilitiesByName,
  ByTag = AnyCapabilitiesByTag,
>(
  options: BindOptions<Model, Context_, Principal, Message, ByName, ByTag>,
): AgentRuntime<Model, Context_, Principal, ByName, ByTag> => {
  const { definition, host } = options

  // The contract is immutable, so every lookup table and descriptor is built
  // once here rather than on each invocation.
  const byName = new Map<string, ExposedVariant<Model, Principal>>()
  const byConstructor = new Map<unknown, ExposedVariant<Model, Principal>>()
  for (const variant of definition.messages.variants) {
    byName.set(variant.name, variant)
    byConstructor.set(variant.messageConstructor, variant)
  }

  /** A capability is named by its protocol name or by its Message constructor. */
  const resolve = (target: unknown): ExposedVariant<Model, Principal> | undefined =>
    typeof target === 'function' ? byConstructor.get(target) : byName.get(String(target))

  /** Recording is best-effort by design; a broken sink must not break dispatch. */
  const record = (entry: Parameters<AuditSink['record']>[0]): void => {
    try {
      options.audit?.record(entry)
    } catch {
      // Deliberately swallowed.
    }
  }

  const dispatch = (
    target: unknown,
    input: unknown,
    requested?: Partial<Invocation>,
  ): Effect.Effect<DispatchResult, DispatchError> =>
    // Resolved per execution, not per construction: an Effect is a description
    // and may be run repeatedly, and each run is a distinct invocation. A
    // caller-supplied id still passes through unchanged.
    Effect.suspend(() => withAudit(target, input, resolveInvocation(requested)))

  const withAudit = (
    target: unknown,
    input: unknown,
    invocation: Invocation,
  ): Effect.Effect<DispatchResult, DispatchError> => {
    if (options.audit === undefined) return dispatchResolved(target, input, invocation)

    // What dispatch learned, left here for the record. The principal resolver is
    // application code: it may be expensive, and a stateful one can answer
    // differently the second time, so it runs once, during dispatch, and leaves
    // what it returned here. `delivery` is the fact a refusal and a
    // post-dispatch failure differ on, and only dispatch can observe it.
    const progress: DispatchProgress = { delivery: 'none' }
    const effect = dispatchResolved(target, input, invocation, progress)

    return Effect.onExit(effect, exit =>
      Effect.sync(() => {
        const principal = progress.principal

        if (exit._tag === 'Success') {
          const result = exit.value
          record({
            invocation,
            capability: result.name,
            tag: result.tag,
            principal,
            decision: 'dispatched',
            outcome: result.completion?.status ?? 'dispatched',
            input,
          })
          return
        }

        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as
          { _tag?: string; capability?: string; tag?: string } | undefined
        record({
          invocation,
          // A capability that resolved names itself even when the failure does
          // not carry a name -- a completion timeout knows no Message tag.
          capability: progress.capability ?? error?.capability ?? describeTarget(target),
          tag: progress.tag ?? error?.tag,
          principal,
          decision: decisionOf(progress.delivery),
          outcome: outcomeOf(exit.cause, error?._tag),
          input,
        })
      }),
    )
  }

  const resourcesByName = new Map(
    definition.resources.map(resource => [resource.name, resource] as const),
  )

  // A contract that cannot be honoured is refused here rather than at the first
  // call, where it would look like an application bug.
  const needsObserve = definition.messages.variants.filter(
    variant => variant.compiledCompletion !== undefined,
  )
  if (needsObserve.length > 0 && host.observe === undefined) {
    throw new Error(
      `This host cannot observe Messages, which ${needsObserve
        .map(variant => `"${variant.name}"`)
        .join(', ')} needs to report completion. Supply host.observe.`,
    )
  }

  const descriptors = describeMessages(definition)
  const descriptorByName = new Map(
    descriptors.map(descriptor => [descriptor.name, descriptor] as const),
  )

  const isAvailable = (variant: ExposedVariant<Model, Principal>, model: Model): boolean =>
    variant.available === undefined || variant.available(model)

  const dispatchResolved = Effect.fn('Agent.dispatch')(function* (
    target: unknown,
    input: unknown,
    invocation: Invocation,
    progress?: DispatchProgress,
  ) {
    {
      // Read through a function so control flow analysis cannot narrow it away:
      // the caller can abort while an await below is suspended.
      const cancelled = (): boolean => invocation.signal?.aborted === true

      const found = resolve(target)
      // A resolved capability reports its own protocol name, whichever way it
      // was named; an unresolved one reports what the caller asked for.
      const name = found?.name ?? describeTarget(target)
      yield* Effect.annotateCurrentSpan('agent.capability', name)
      yield* Effect.annotateCurrentSpan('agent.transport', invocation.transport)
      yield* Effect.annotateCurrentSpan('agent.invocation', invocation.id)
      if (found === undefined) {
        return yield* UnknownCapabilityError.of(name)
      }
      const variant = found
      if (progress !== undefined) {
        progress.capability = name
        progress.tag = variant.tag
      }

      // An invocation that is already cancelled never reaches the Model.
      if (cancelled()) {
        return yield* CancelledError.of(name)
      }

      const model = host.model()

      // Availability gates discovery and invocation; authorization is separate.
      if (!isAvailable(variant, model)) {
        return yield* CapabilityUnavailableError.of(name, variant.tag)
      }

      // Untrusted agent input crosses a Schema boundary before anything else.
      // Excess properties are an error, not stripped: the derived JSON Schema
      // advertises additionalProperties: false, so accepting them would enforce
      // something looser than the contract the agent was handed.
      const decoded: unknown = yield* Schema.decodeUnknownEffect(variant.inputSchema, {
        onExcessProperty: 'error',
      })(input).pipe(
        Effect.catchTag('SchemaError', cause =>
          Effect.fail(InvalidInputError.of(name, variant.tag, cause)),
        ),
      )

      const principal = host.principal?.(invocation) as Principal
      if (progress !== undefined) progress.principal = principal

      if (variant.authorize !== undefined) {
        const decision = variant.authorize({
          principal,
          input: decoded,
          model,
          transport: invocation.transport,
        })
        const allowed = Effect.isEffect(decision) ? yield* decision : decision
        if (!allowed) {
          return yield* AuthorizationError.of(name, variant.tag)
        }
      }

      // Checked again after decoding and authorization, either of which can
      // suspend. Nothing is constructed or dispatched once cancelled.
      if (cancelled()) {
        return yield* CancelledError.of(name)
      }

      const context: InvocationContext<Model, Principal> = { model, principal, invocation }
      const message = variant.construct(decoded, context)

      // Subscribed before dispatching: `update` can produce the completing
      // Message synchronously, and a waiter that started afterwards would miss
      // it and then sit until its timeout.
      const waiter =
        variant.compiledCompletion === undefined || host.observe === undefined
          ? undefined
          : awaitCompletion({
              completion: variant.compiledCompletion,
              capability: name,
              input: decoded,
              invocation,
              observe: host.observe,
            })

      // Inside `suspend` so a host that throws synchronously fails the Effect
      // rather than the generator: a JS `try` around `yield*` would not see a
      // rejected Promise or a defecting Effect, which is how the subscription
      // used to leak.
      const send = Effect.suspend(() => {
        // Marked before the call, not after: a host that raises leaves this at
        // `attempted`, which is all anyone can honestly say about the Message.
        if (progress !== undefined) progress.delivery = 'attempted'
        // `construct` always produces a member of this application's Message union.
        const sent = host.dispatch(message as Message)
        if (Effect.isEffect(sent)) return Effect.orDie(sent)
        if (sent instanceof Promise) return Effect.orDie(Effect.promise(() => sent))
        return Effect.void
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (progress !== undefined) progress.delivery = 'sent'
          }),
        ),
      )

      if (waiter === undefined) {
        yield* send
        return { name, tag: variant.tag, message, invocation } satisfies DispatchResult
      }

      // The two synchronous checks above cannot help once the wait has begun,
      // so the signal has to settle it. Only the waiting stops: the Message is
      // already in the Runtime, and nothing is rolled back.
      const wait =
        invocation.signal === undefined
          ? waiter.outcome
          : Effect.raceFirst(waiter.outcome, abortedWhile(invocation.signal, name))

      // One finalizer covers both windows: the subscription is taken before
      // dispatch, so a failing dispatch and a failing, timed-out, aborted or
      // interrupted wait all release it.
      const completion = yield* Effect.ensuring(
        Effect.flatMap(send, () => wait),
        Effect.sync(waiter.release),
      )
      return { name, tag: variant.tag, message, invocation, completion } satisfies DispatchResult
    }
  })

  return {
    definition,

    context: Effect.suspend(() => {
      const declared = definition.context
      if (declared === undefined) return Effect.succeed(undefined)
      return project(
        declared.Model as unknown as Schema.Codec<unknown>,
        declared.read(host.model()),
        'context',
      )
    }),

    resources: {
      read: (name: string) =>
        Effect.suspend(() => {
          const resource = resourcesByName.get(name)
          return resource === undefined
            ? ResourceError.of(name, 'no such resource')
            : project(resource.schema, resource.read(host.model()), `resource "${name}"`)
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
      dispatch: dispatch as Dispatch<ByName, ByTag>,
      dispatchUnknown: dispatch,
    },

    subscribe: (listener: () => void) => host.subscribe?.(listener) ?? (() => {}),
  }
}

/**
 * A projection returned a value its declared schema rejects.
 *
 * The contract advertises that schema to agents, so serving a value that
 * violates it is an application bug, not something the caller did. It is a
 * defect: `read`'s failure channel stays reserved for what a caller can act on,
 * and a defect cannot be mistaken for a caller error. The message names the
 * projection only; the schema issue, which describes application data, is kept
 * on `cause` for the application's own reporting.
 */
class ProjectionError extends Error {
  override readonly name = 'AgentProjectionError'
  constructor(projection: string, cause: unknown) {
    super(`The ${projection} projection does not match its declared schema`, { cause })
  }
}

/**
 * Validates a projection and produces its wire representation.
 *
 * Encoding, not decoding: `select`/`read` return the schema's decoded side, and
 * adapters serialize the encoded side (MCP `resources/read` writes it as JSON).
 * `encodeUnknown` checks the value against the decoded side first, so this both
 * enforces the advertised contract and yields what actually leaves the process.
 * Properties the schema does not declare are dropped rather than served.
 */
const project = (
  schema: Schema.Codec<any, any, never, never>,
  value: unknown,
  projection: string,
): Effect.Effect<unknown> =>
  Effect.catchCause(Schema.encodeUnknownEffect(schema)(value), cause =>
    Effect.die(new ProjectionError(projection, cause)),
  )

/**
 * Fails as soon as the signal aborts, so racing it settles a wait that has no
 * other reason to stop before its timeout.
 *
 * The listener is removed when the race interrupts the loser, which is the only
 * way this effect ends without the abort firing.
 */
const abortedWhile = (
  signal: AbortSignal,
  capability: string,
): Effect.Effect<never, DispatchError> =>
  Effect.callback<never, DispatchError>(resume => {
    const stop = (): void => resume(Effect.fail(CancelledError.whileWaiting(capability)))
    if (signal.aborted) {
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', stop))
  })

/**
 * What dispatch had managed to do when it exited, so the record can say what
 * happened rather than assuming a failure means a refusal.
 */
interface DispatchProgress {
  principal?: unknown
  capability?: string
  tag?: string
  /** `attempted` means the host was called and raised: delivery is unknowable. */
  delivery: 'none' | 'attempted' | 'sent'
}

const decisionOf = (delivery: DispatchProgress['delivery']): AuditDecision =>
  delivery === 'sent' ? 'dispatched' : delivery === 'attempted' ? 'unknown' : 'refused'

/**
 * A failed exit reported in the same vocabulary a successful one uses.
 *
 * A timeout is `timeout`, not a refusal tag: the Message was dispatched and
 * only the waiting stopped. Interruption reads the same way -- nothing was
 * undone -- so neither may be recorded as a decision not to act.
 */
const outcomeOf = (cause: Cause.Cause<unknown>, tag: string | undefined): string => {
  if (tag === 'AgentCompletionTimeoutError') return 'timeout'
  if (tag !== undefined) return tag
  return Cause.hasInterrupts(cause) ? 'interrupted' : 'AgentDefect'
}

/**
 * Names whatever the caller passed, for the "no such capability" message.
 *
 * A Message constructor is reported by its tag, which the types already prevent
 * reaching here, so the read is defensive.
 */
const describeTarget = (target: unknown): string =>
  typeof target === 'function' ? (messageTag(target) ?? 'an unexposed Message') : String(target)
