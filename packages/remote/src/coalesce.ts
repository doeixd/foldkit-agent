/**
 * Read coalescing: every requirement a client asks for goes through one
 * `RequestResolver`, so requirements issued together become one `ReadBatch`
 * (ids batched, fields unioned) and a requirement already in flight is joined
 * rather than re-requested. The planner stays pure; this is the transport
 * seam's concern, and the store is still the only cache.
 */
import { Deferred, Duration, Effect, Request, RequestResolver, type Schema } from 'effect'
import { Requirement } from 'foldkit-surface'
import { REMOTE_PROTOCOL_VERSION, type ReadBatch, type ReadBatchResult } from './wire.js'
import type { RemoteProtocolError, RemoteReadError } from './wire.js'

type Batch = Schema.Schema.Type<typeof ReadBatch>
type BatchResult = Schema.Schema.Type<typeof ReadBatchResult>
type ReadError = RemoteReadError | RemoteProtocolError
export type BatchRead = (batch: Batch) => Effect.Effect<BatchResult, ReadError>

export interface CoalesceOptions {
  /**
   * How long a batch waits to collect more requirements before it runs.
   * Requirements issued concurrently coalesce even at the default of no wait.
   */
  readonly window?: Duration.Input | undefined
}

/** A stable key for a requirement, so an equal requirement in flight is joined. */
export const requirementKey = (requirement: Requirement): string =>
  JSON.stringify([
    requirement.entity,
    requirement.id,
    [...requirement.fields].sort(),
    requirement.windows ?? null,
    requirement.relations ?? null,
  ])

class ReadRequirement extends Request.Class<
  { readonly key: string; readonly requirement: Requirement },
  BatchResult,
  ReadError
> {}

/**
 * Wraps a raw batch read so that requirements are batched and deduplicated.
 * Every waiter receives the whole batch result; `Remote.writeRead` is
 * idempotent, so writing it more than once is harmless.
 */
export const coalesceReads = (
  read: BatchRead,
  options: CoalesceOptions = {},
): Effect.Effect<BatchRead> =>
  Effect.gen(function* () {
    // Requirements a batch is currently reading; a later equal requirement
    // joins the deferred instead of starting another read.
    const inFlight = new Map<string, Deferred.Deferred<BatchResult, ReadError>>()

    // A batch runs to completion even when every requester is interrupted, so
    // an in-flight requirement is always settled and released by its read.
    const runAll = (entries: ReadonlyArray<Request.Entry<ReadRequirement>>) =>
      Effect.gen(function* () {
        // Per requirement key: the deferred this batch's entries wait on. One
        // already in flight from an earlier batch is joined; the rest are
        // owned here and settled by this batch's read.
        const joins = new Map<string, Deferred.Deferred<BatchResult, ReadError>>()
        const own = new Map<string, Deferred.Deferred<BatchResult, ReadError>>()
        for (const entry of entries) {
          const key = entry.request.key
          if (joins.has(key)) continue
          const existing = inFlight.get(key)
          if (existing !== undefined) {
            joins.set(key, existing)
            continue
          }
          const deferred = yield* Deferred.make<BatchResult, ReadError>()
          inFlight.set(key, deferred)
          own.set(key, deferred)
          joins.set(key, deferred)
        }
        if (own.size > 0) {
          const exit = yield* Effect.exit(
            read({
              version: REMOTE_PROTOCOL_VERSION,
              requests: Requirement.merge(
                entries
                  .filter(entry => own.has(entry.request.key))
                  .map(entry => entry.request.requirement),
              ),
            }),
          )
          for (const [key, deferred] of own) {
            inFlight.delete(key)
            yield* Deferred.done(deferred, exit)
          }
        }
        for (const entry of entries) {
          yield* Request.completeEffect(entry, Deferred.await(joins.get(entry.request.key)!))
        }
      })

    let resolver = RequestResolver.make<ReadRequirement>(runAll)
    if (options.window !== undefined) {
      resolver = RequestResolver.setDelay(resolver, Duration.fromInputUnsafe(options.window))
    }

    return batch =>
      batch.requests.length === 0
        ? Effect.succeed({ entities: [] })
        : Effect.forEach(
            batch.requests,
            requirement =>
              Effect.request(
                new ReadRequirement({ key: requirementKey(requirement), requirement }),
                resolver,
              ),
            { concurrency: 'unbounded' },
          ).pipe(
            Effect.map(results => ({
              entities: [...new Set(results)].flatMap(result => result.entities),
            })),
          )
  })
