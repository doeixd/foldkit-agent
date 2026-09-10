import type { Agent } from 'foldkit-agent'
import type { Message, Shared } from './app.js'
import type { Journal, Principal } from './journal.js'

export interface ServerAgentHostOptions {
  readonly journal: Journal
  /** The transport-authenticated caller the agent acts as. */
  readonly principal: Principal
  /** Identifies the producer in the durable log, separate from the caller. */
  readonly replicaId?: string
}

/**
 * Binds an agent contract to the shared replica as one more producer.
 *
 * A capability dispatch becomes a single durable operation: the Model it reads
 * is the authoritative snapshot and its Message is appended through the
 * journal, so the same authorization policy, ordering, and compaction apply as
 * for any browser replica. The agent is not a second mutation path.
 *
 * The caller's identity comes from the trusted `principal`; a capability that
 * declares `authorize` refuses with a typed error before anything is appended.
 */
export const serverAgentHost = (
  options: ServerAgentHostOptions,
): Agent.AgentHost<Shared, Message, Principal> & {
  // The caller is known here, so `bind` requires the principal provider rather
  // than leaving it optional.
  readonly principal: (invocation: Agent.Invocation) => Principal
} => {
  const { journal, principal } = options
  const replicaId = options.replicaId ?? 'agent'
  return {
    model: () => journal.snapshot(principal.documentId).model,
    principal: () => principal,
    dispatch: (message: Message) => {
      journal.appendAsServer(message, principal, replicaId)
    },
    subscribe: journal.subscribe,
  }
}
