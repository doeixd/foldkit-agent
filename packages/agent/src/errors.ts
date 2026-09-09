import { Data } from 'effect'

/**
 * Raised when a capability name is not part of the agent contract.
 *
 * Adapters should surface this as a protocol-level "unknown tool" rather than
 * as an application failure.
 */
export class UnknownCapabilityError extends Data.TaggedError('AgentUnknownCapabilityError')<{
  readonly capability: string
}> {}

/**
 * Raised when a capability exists but its `available(model)` predicate is
 * currently false. Availability is discoverability, not authorization.
 */
export class CapabilityUnavailableError extends Data.TaggedError('AgentCapabilityUnavailableError')<{
  readonly capability: string
  readonly tag: string
}> {}

/** Raised when agent-supplied input fails the capability's Schema boundary. */
export class InvalidInputError extends Data.TaggedError('AgentInvalidInputError')<{
  readonly capability: string
  readonly tag: string
  readonly cause: unknown
}> {}

/**
 * Raised when a capability's `authorize` hook denies the call.
 *
 * Denied calls never dispatch a Message.
 */
export class AuthorizationError extends Data.TaggedError('AgentAuthorizationError')<{
  readonly capability: string
  readonly tag: string
  readonly reason?: string | undefined
}> {}

/** Raised when a named resource does not exist or cannot be read. */
export class ResourceError extends Data.TaggedError('AgentResourceError')<{
  readonly resource: string
  readonly reason: string
}> {}

/** Every failure `AgentRuntime.messages.dispatch` can produce. */
export type DispatchError =
  | UnknownCapabilityError
  | CapabilityUnavailableError
  | InvalidInputError
  | AuthorizationError
