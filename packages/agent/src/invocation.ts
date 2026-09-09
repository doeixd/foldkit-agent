import type { Invocation } from './types.js'

/** A unique invocation id, falling back where `crypto.randomUUID` is unavailable. */
export const newInvocationId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/**
 * Fills in the invocation metadata an adapter would normally supply.
 *
 * In-app callers and tests dispatch without ceremony; a protocol adapter passes
 * its own id, transport, and cancellation signal.
 */
export const resolveInvocation = (invocation?: Partial<Invocation>): Invocation => ({
  id: invocation?.id ?? newInvocationId(),
  transport: invocation?.transport ?? 'in-app',
  signal: invocation?.signal,
})
