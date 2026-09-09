import { Schema } from 'effect'

/**
 * Agent failures are Schema-backed so they survive a protocol boundary.
 *
 * An adapter often has to report a failure to a caller in another process, so
 * each error encodes to plain JSON. Every `message` is written for that
 * audience: it names the capability but never exposes application internals.
 */

/** The capability name is not part of the agent contract. */
export class UnknownCapabilityError extends Schema.TaggedError<UnknownCapabilityError>()(
  'AgentUnknownCapabilityError',
  {
    capability: Schema.String,
    message: Schema.String,
  },
) {
  static of(capability: string): UnknownCapabilityError {
    return new UnknownCapabilityError({
      capability,
      message: `No such capability: ${capability}`,
    })
  }
}

/**
 * The capability exists, but its `available(model)` predicate is currently
 * false. Availability is discoverability, not authorization.
 */
export class CapabilityUnavailableError extends Schema.TaggedError<CapabilityUnavailableError>()(
  'AgentCapabilityUnavailableError',
  {
    capability: Schema.String,
    tag: Schema.String,
    message: Schema.String,
  },
) {
  static of(capability: string, tag: string): CapabilityUnavailableError {
    return new CapabilityUnavailableError({
      capability,
      tag,
      message: `Capability "${capability}" is not available right now`,
    })
  }
}

/** Agent-supplied input failed the capability's Schema boundary. */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()(
  'AgentInvalidInputError',
  {
    capability: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    /** The decode failure. Kept for the application; never shown to the caller. */
    cause: Schema.optional(Schema.Unknown),
  },
) {
  static of(capability: string, tag: string, cause: unknown): InvalidInputError {
    return new InvalidInputError({
      capability,
      tag,
      cause,
      message: `Invalid input for "${capability}"`,
    })
  }
}

/** A capability's `authorize` hook denied the call. Denied calls never dispatch. */
export class AuthorizationError extends Schema.TaggedError<AuthorizationError>()(
  'AgentAuthorizationError',
  {
    capability: Schema.String,
    tag: Schema.String,
    message: Schema.String,
  },
) {
  static of(capability: string, tag: string, reason?: string): AuthorizationError {
    return new AuthorizationError({
      capability,
      tag,
      message: reason ?? `Not authorized to invoke "${capability}"`,
    })
  }
}

/**
 * The caller aborted the invocation.
 *
 * Cancellation stops waiting, never the dispatched effect, so `dispatched` is
 * the fact a caller has to act on: `false` means the Message never reached
 * `update`, `true` means it did and only the waiting stopped. Nothing is undone
 * either way.
 */
export class CancelledError extends Schema.TaggedError<CancelledError>()('AgentCancelledError', {
  capability: Schema.String,
  /** Whether the Message had already reached the Runtime when the abort arrived. */
  dispatched: Schema.Boolean,
  message: Schema.String,
}) {
  /** Aborted before anything was constructed or sent. */
  static of(capability: string): CancelledError {
    return new CancelledError({
      capability,
      dispatched: false,
      message: `Invocation of "${capability}" was cancelled before it was dispatched`,
    })
  }

  /** Aborted while waiting for the completion contract to resolve. */
  static whileWaiting(capability: string): CancelledError {
    return new CancelledError({
      capability,
      dispatched: true,
      message:
        `"${capability}" was dispatched, and waiting for it to complete was ` +
        `cancelled. The Message still reached update.`,
    })
  }
}

/**
 * The Message was dispatched, but its completion contract did not resolve in
 * time.
 *
 * The Message reached `update`; only the waiting stopped. Nothing is undone.
 */
export class CompletionTimeoutError extends Schema.TaggedError<CompletionTimeoutError>()(
  'AgentCompletionTimeoutError',
  {
    capability: Schema.String,
    invocation: Schema.String,
    message: Schema.String,
  },
) {
  static of(capability: string, invocation: string, timeout: unknown): CompletionTimeoutError {
    return new CompletionTimeoutError({
      capability,
      invocation,
      message:
        `"${capability}" was dispatched but did not complete within ` +
        `${String(timeout)}. The Message still reached update.`,
    })
  }
}

/** A named resource does not exist or cannot be read. */
export class ResourceError extends Schema.TaggedError<ResourceError>()('AgentResourceError', {
  resource: Schema.String,
  message: Schema.String,
}) {
  static of(resource: string, reason: string): ResourceError {
    return new ResourceError({
      resource,
      message: `Cannot read resource "${resource}": ${reason}`,
    })
  }
}

/** Every failure `AgentRuntime.messages.dispatch` can produce. */
export type DispatchError =
  | UnknownCapabilityError
  | CapabilityUnavailableError
  | InvalidInputError
  | AuthorizationError
  | CancelledError
  | CompletionTimeoutError
