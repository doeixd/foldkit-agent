import type { Invocation, Transport } from './types.js'

/** What the runtime reports about one decision. A sink decides what to keep. */
export interface AuditRecord {
  readonly invocation: Invocation
  /** The capability as the caller named it. */
  readonly capability: string
  /** The internal Message tag, when the capability resolved to one. */
  readonly tag: string | undefined
  readonly principal: unknown
  readonly decision: 'dispatched' | 'refused'
  /**
   * `dispatched`, a completion status, or the failure tag for a refusal --
   * which is the entry worth reading.
   */
  readonly outcome: string
  /** Exactly what the caller sent, before any policy is applied. */
  readonly input: unknown
}

/** Where decisions go. Implement it to forward them somewhere durable. */
export interface AuditSink {
  readonly record: (record: AuditRecord) => void
}

/** One decision as kept by {@link auditLog}. */
export interface AuditEntry {
  /** Epoch milliseconds. */
  readonly at: number
  readonly invocation: string
  readonly transport: Transport
  readonly capability: string
  readonly tag?: string | undefined
  /** Whatever the `principal` projection returned. Omitted without one. */
  readonly principal?: unknown
  readonly decision: 'dispatched' | 'refused'
  readonly outcome: string
  /** Present only when `includeInput` is set, with redacted fields replaced. */
  readonly input?: Record<string, unknown> | undefined
}

export interface AuditLogOptions {
  /** Entries kept before the oldest is dropped. Defaults to 500. */
  readonly capacity?: number | undefined
  /**
   * Records the agent's input.
   *
   * Off by default: input is caller-supplied and may carry anything. Turn it on
   * deliberately, with `redact` for the fields that must not be kept.
   */
  readonly includeInput?: boolean | undefined
  /** Field names replaced with `[redacted]` when input is recorded. */
  readonly redact?: ReadonlyArray<string> | undefined
  /**
   * Projects the principal down to what is safe to keep -- an id, not the whole
   * identity. Without it the principal is not recorded at all.
   */
  readonly principal?: ((principal: unknown) => unknown) | undefined
  /** Injected for tests. */
  readonly clock?: (() => number) | undefined
}

export interface AuditLog extends AuditSink {
  /** Oldest first. */
  readonly entries: () => ReadonlyArray<AuditEntry>
  readonly clear: () => void
}

const REDACTED = '[redacted]'

/** Shallow: the point is to keep a field name without keeping its value. */
const redactInput = (
  input: unknown,
  redact: ReadonlyArray<string>,
): Record<string, unknown> | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key,
      redact.includes(key) ? REDACTED : value,
    ]),
  )
}

/**
 * An in-memory ring buffer of agent decisions.
 *
 * It records refusals as well as successes, holds a bounded number of entries,
 * and never sees the Model. This is accountability, not Model replay: nothing
 * here re-dispatches anything.
 *
 * @example
 * ```ts
 * const audit = Agent.auditLog({ capacity: 200, principal: user => user.id })
 * const runtime = Agent.bind({ definition, host, audit })
 * ```
 */
export const auditLog = (options: AuditLogOptions = {}): AuditLog => {
  const capacity = Math.max(1, options.capacity ?? 500)
  const clock = options.clock ?? (() => Date.now())
  const redact = options.redact ?? []
  const entries: Array<AuditEntry> = []

  return {
    record: record => {
      const input = options.includeInput === true ? redactInput(record.input, redact) : undefined

      entries.push({
        at: clock(),
        invocation: record.invocation.id,
        transport: record.invocation.transport,
        capability: record.capability,
        ...(record.tag === undefined ? {} : { tag: record.tag }),
        ...(options.principal === undefined
          ? {}
          : { principal: options.principal(record.principal) }),
        decision: record.decision,
        outcome: record.outcome,
        ...(input === undefined ? {} : { input }),
      })

      if (entries.length > capacity) entries.shift()
    },

    entries: () => [...entries],
    clear: () => {
      entries.length = 0
    },
  }
}
