import { Schema } from 'effect'

/** A logical write time; replica ids break concurrent ties using UTF-16 order. */
const Stamp = Schema.Struct({
  counter: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  replicaId: Schema.NonEmptyString,
})

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
