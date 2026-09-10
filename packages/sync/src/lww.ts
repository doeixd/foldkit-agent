import { Schema } from 'effect'
import type { Storage } from './indexedDb.js'

/** A logical write time; replica ids break concurrent ties using UTF-16 order. */
const Stamp = Schema.Struct({
  counter: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  replicaId: Schema.NonEmptyString,
})

const ClockState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  documentId: Schema.NonEmptyString,
  replicaId: Stamp.fields.replicaId,
  // The high-water counter also serves as the storage's CAS revision.
  revision: Stamp.fields.counter,
})
export type LwwClockState = typeof ClockState.Type

export interface LwwClock {
  /** Persists a timestamp beyond the saved counter and supplied observation. */
  next(observedCounter?: number): Promise<typeof Stamp.Type>
  /** Drains accepted allocations and closes storage; repeated calls share completion. */
  close(): Promise<void>
}

const decodeClock = Schema.decodeUnknownSync(ClockState, { onExcessProperty: 'error' })
const decodeCounter = Schema.decodeUnknownSync(Stamp.fields.counter)

/** Opens a durable clock in its own storage, taking ownership even if opening fails. */
export const openLwwClock = async ({
  documentId,
  replicaId,
  storage,
}: {
  readonly documentId: string
  readonly replicaId: string
  readonly storage: Storage<LwwClockState>
}): Promise<LwwClock> => {
  let state: LwwClockState
  try {
    const initial = decodeClock({
      schemaVersion: 1,
      documentId,
      replicaId,
      revision: 0,
    })
    const saved = await storage.load()
    state = saved === undefined ? initial : decodeClock(saved)
    if (state.documentId !== documentId || state.replicaId !== replicaId)
      throw new Error('Wrong clock storage')
    if (saved === undefined) await storage.save(state, null)
  } catch (error) {
    storage.close()
    throw error
  }

  let tail = Promise.resolve()
  let closing: Promise<void> | undefined
  return {
    next: (observedCounter = 0) => {
      if (closing !== undefined) return Promise.reject(new Error('Clock is closed'))
      const allocation = tail.then(async () => {
        const next = decodeClock({
          ...state,
          revision: Math.max(state.revision, decodeCounter(observedCounter)) + 1,
        })
        // A crash after this save may skip a timestamp, but must never reuse it.
        await storage.save(next, state.revision)
        state = next
        return { counter: next.revision, replicaId }
      })
      tail = allocation.then(
        () => {},
        () => {},
      )
      return allocation
    },
    close: () => (closing ??= tail.then(() => storage.close())),
  }
}

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
