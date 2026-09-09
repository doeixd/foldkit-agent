import { Duration, Effect } from 'effect'
import { CompletionTimeoutError } from './errors.js'
import { messageTags } from './tag.js'
import type { AnyMessage, Completion, Invocation } from './types.js'

/** How a dispatched Message finished, once a completion contract is declared. */
export interface CompletionOutcome<Message extends AnyMessage = AnyMessage> {
  readonly status: 'completed' | 'failed'
  /** The Message that completed the operation. */
  readonly message: Message
}

/** A completion contract compiled into the tags and predicate the runtime matches on. */
export interface CompiledCompletion {
  readonly success: ReadonlySet<string>
  readonly failure: ReadonlySet<string>
  readonly correlate: ((request: unknown, result: AnyMessage) => boolean) | undefined
  readonly timeout: Duration.Duration
}

/**
 * A completion contract that never resolves is a leak, so a waiter always has a
 * deadline. Long-running Commands should raise it deliberately.
 */
const DEFAULT_TIMEOUT = Duration.seconds(30)

export const compileCompletion = (
  completion: Completion,
  capability: string,
): CompiledCompletion => {
  const success = new Set(messageTags(completion.success))
  const failure = new Set(messageTags(completion.failure ?? []))

  if (success.size === 0) {
    throw new Error(
      `Cannot expose "${capability}": its completion contract names no success Message`,
    )
  }
  for (const tag of failure) {
    if (success.has(tag)) {
      throw new Error(
        `Cannot expose "${capability}": "${tag}" is both a success and a failure Message`,
      )
    }
  }

  return {
    success,
    failure,
    correlate: completion.correlate as CompiledCompletion['correlate'],
    timeout:
      completion.timeout === undefined
        ? DEFAULT_TIMEOUT
        : Duration.fromInputUnsafe(completion.timeout),
  }
}

/** Subscribes to the host's Messages and resolves on the first that this invocation owns. */
export interface CompletionWaiter {
  readonly outcome: Effect.Effect<CompletionOutcome, CompletionTimeoutError>
  /**
   * Releases the subscription. Safe to call more than once.
   *
   * The subscription is taken before dispatch, so the caller owns it from that
   * moment and must release it from a finalizer that also covers the dispatch.
   */
  readonly release: () => void
}

/**
 * Starts waiting **before** the Message is dispatched.
 *
 * `update` can produce the completing Message synchronously, so a waiter that
 * subscribed afterwards would miss it and then sit until its timeout.
 */
export const awaitCompletion = (options: {
  readonly completion: CompiledCompletion
  readonly capability: string
  readonly input: unknown
  readonly invocation: Invocation
  readonly observe: (listener: (message: AnyMessage) => void) => () => void
}): CompletionWaiter => {
  const { completion, capability, input, invocation, observe } = options

  let settle: ((outcome: CompletionOutcome) => void) | undefined
  let settled: CompletionOutcome | undefined
  let unsubscribe: (() => void) | undefined
  let released = false

  const release = (): void => {
    if (released) return
    released = true
    unsubscribe?.()
    unsubscribe = undefined
  }

  const owns = (message: AnyMessage): boolean =>
    completion.correlate === undefined || completion.correlate(input, message)

  unsubscribe = observe(message => {
    // A settled invocation never settles twice: a second matching Message, or
    // one arriving after a timeout, is ignored rather than resolving again.
    if (settled !== undefined || released) return

    const status = completion.success.has(message._tag)
      ? ('completed' as const)
      : completion.failure.has(message._tag)
        ? ('failed' as const)
        : undefined

    if (status === undefined || !owns(message)) return

    // `settled` is the guard against a second Message; the subscription itself
    // is released by the caller's finalizer, on every exit path.
    settled = { status, message }
    settle?.(settled)
  })

  const outcome = Effect.callback<CompletionOutcome>(resume => {
    // The Message may already have arrived while dispatch was in flight.
    if (settled !== undefined) {
      resume(Effect.succeed(settled))
      return
    }
    settle = outcome => resume(Effect.succeed(outcome))
  }).pipe(
    Effect.timeoutOrElse({
      duration: completion.timeout,
      orElse: () =>
        Effect.fail(CompletionTimeoutError.of(capability, invocation.id, completion.timeout)),
    }),
  )

  return { outcome, release }
}
