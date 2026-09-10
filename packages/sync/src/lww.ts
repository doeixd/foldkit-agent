import { Effect, Exit, Ref, Schema, SynchronizedRef } from 'effect'
import { StorageError, UnsupportedClockVersionError } from './errors.js'
import { DocumentId, ReplicaId } from './ids.js'
import type { Storage } from './indexedDb.js'

/** A logical write time; replica ids break concurrent ties using UTF-16 order. */
const Stamp = Schema.Struct({
  counter: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  replicaId: ReplicaId,
})

/** The persisted clock format. A bump must handle the older value explicitly. */
const CLOCK_SCHEMA_VERSION = 1

const ClockState = Schema.Struct({
  schemaVersion: Schema.Literal(CLOCK_SCHEMA_VERSION),
  documentId: DocumentId,
  replicaId: ReplicaId,
  // The high-water counter also serves as the storage's CAS revision.
  revision: Stamp.fields.counter,
})
export type LwwClockState = typeof ClockState.Type

export interface LwwClock {
  /** Persists a timestamp beyond the saved counter and supplied observation. */
  next: (observedCounter?: number) => Effect.Effect<typeof Stamp.Type, StorageError>
  /** Drains accepted allocations, then closes storage. Repeated calls no-op. */
  close: Effect.Effect<void>
}

const decodeClock = Schema.decodeUnknownSync(ClockState, { onExcessProperty: 'error' })
const decodeCounter = Schema.decodeUnknownSync(Stamp.fields.counter)

const clockError = (message: string, cause: unknown): StorageError =>
  new StorageError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  })

const VersionProbe = Schema.Struct({ schemaVersion: Schema.optional(Schema.Number) })
/**
 * Tells a version this build does not understand apart from malformed data, so
 * the caller gets an actionable failure and the stored state is preserved.
 */
const unsupportedVersion = (input: unknown): UnsupportedClockVersionError | undefined => {
  let found: { readonly schemaVersion?: number | undefined }
  try {
    found = Schema.decodeUnknownSync(VersionProbe)(input)
  } catch {
    return undefined
  }
  if (found.schemaVersion === CLOCK_SCHEMA_VERSION) return undefined
  return new UnsupportedClockVersionError({
    schemaVersion: found.schemaVersion ?? null,
    message: `Stored clock uses schema ${found.schemaVersion ?? '?'}; this build supports ${CLOCK_SCHEMA_VERSION}`,
  })
}

/**
 * Opens a durable clock over the caller's storage.
 *
 * Allocations are serialized through a `SynchronizedRef` and each persists before
 * its stamp is returned. A crash after the save may skip a timestamp but never
 * reuse one. Storage is owned by the caller; a failed open closes it so a partial
 * initialization does not leak the connection.
 */
export const openLwwClock = (options: {
  readonly documentId: DocumentId
  readonly replicaId: ReplicaId
  readonly storage: Storage<LwwClockState>
}): Effect.Effect<LwwClock, StorageError | UnsupportedClockVersionError> =>
  Effect.gen(function* () {
    const { documentId, replicaId, storage } = options
    yield* Effect.annotateCurrentSpan({ documentId, replicaId })
    const initial = decodeClock({
      schemaVersion: CLOCK_SCHEMA_VERSION,
      documentId,
      replicaId,
      revision: 0,
    })
    const saved = yield* storage.load()
    const state = yield* Effect.try({
      try: () => (saved === undefined ? initial : decodeClock(saved)),
      catch: cause =>
        unsupportedVersion(saved) ?? clockError('Stored clock state is invalid', cause),
    })
    if (state.documentId !== documentId || state.replicaId !== replicaId)
      return yield* new StorageError({ message: 'Wrong clock storage' })
    if (saved === undefined) yield* storage.save(state, null)

    const stateRef = yield* SynchronizedRef.make(state)
    const closed = yield* Ref.make(false)

    const next = (observedCounter = 0): Effect.Effect<typeof Stamp.Type, StorageError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return yield* new StorageError({ message: 'Clock is closed' })
        return yield* SynchronizedRef.modifyEffect(stateRef, current =>
          Effect.gen(function* () {
            // Re-check under the lock: a `close` that set the flag while this
            // allocation was queued must not save to a closed connection.
            if (yield* Ref.get(closed))
              return yield* new StorageError({ message: 'Clock is closed' })
            const allocated = yield* Effect.try({
              try: () =>
                decodeClock({
                  ...current,
                  revision: Math.max(current.revision, decodeCounter(observedCounter)) + 1,
                }),
              catch: cause => clockError('Invalid clock allocation', cause),
            })
            yield* storage.save(allocated, current.revision)
            return [{ counter: allocated.revision, replicaId }, allocated] as const
          }),
        )
      }).pipe(Effect.withSpan('Lww.next'))

    const close: Effect.Effect<void> = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.modify(closed, current => [current, true] as const)
      if (alreadyClosed) return
      // Drains any accepted allocation before releasing the connection.
      yield* SynchronizedRef.modifyEffect(stateRef, current =>
        Effect.succeed([undefined, current] as const),
      )
      yield* storage.close
    }).pipe(Effect.withSpan('Lww.close'))

    return { next, close }
  }).pipe(
    Effect.withSpan('Lww.openClock'),
    // Close a partially initialized storage on any failure, including a defect,
    // so a failed open cannot leak the connection.
    Effect.onExit(exit =>
      Exit.isSuccess(exit) ? Effect.void : options.storage.close.pipe(Effect.ignore),
    ),
  )

/**
 * A schema and reducer helper for a last-writer-wins register.
 * Allocate a unique stamp per write before dispatch, and retain it in the Message.
 * Merge is for decoded values; the application's schema validates wire input.
 */
export const lwwRegister = <Value, Encoded, RD, RE>(
  value: Schema.Codec<Value, Encoded, RD, RE>,
) => {
  const schema = Schema.Struct({ stamp: Stamp, value })
  type Register = typeof schema.Type
  const equivalent = Schema.toEquivalence(value)

  const merge = (left: Register, right: Register): Register => {
    if (left.stamp.counter !== right.stamp.counter)
      return left.stamp.counter > right.stamp.counter ? left : right
    if (left.stamp.replicaId !== right.stamp.replicaId)
      return left.stamp.replicaId > right.stamp.replicaId ? left : right
    // Reusing a write identity for different values would make arrival order win.
    if (!equivalent(left.value, right.value)) throw new Error('Conflicting LWW write identity')
    return left
  }

  return { schema, merge }
}
