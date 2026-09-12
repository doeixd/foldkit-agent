/**
 * Who is acting. Two shapes, because two boundaries:
 *
 * - `Principal` is what the agent runtime sees. In the browser it is the page's
 *   token; a real app resolves it from a session.
 * - `SyncPrincipal` is what the server journal sees. It is supplied by the
 *   transport after authentication and is never decoded from an operation, so
 *   a client cannot claim to be someone else.
 *
 * The contract's `authorize` rules (see `sync.ts`) run against `SyncPrincipal`
 * inside the journal's append transaction. The agent contract mirrors the same
 * rules against `Principal`, so an agent is refused early with a typed error
 * instead of late with a rejected operation.
 */
export interface Principal {
  readonly actorId: string
}

export interface SyncPrincipal {
  readonly actorId: string
  readonly documentId: string
  readonly canWrite: boolean
}

/** The dev convention: the token `owner` may do the destructive, list-wide things. */
export const isOwner = (principal: { readonly actorId: string }): boolean =>
  principal.actorId === 'owner'
