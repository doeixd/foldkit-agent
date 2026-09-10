import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { lwwRegister } from '../src/index.js'

const Title = lwwRegister(Schema.String)
const write = (counter: number, replicaId: string, value: string) => ({
  stamp: { counter, replicaId },
  value,
})
const writes = [write(1, 'z', 'old'), write(2, 'Z', 'concurrent'), write(2, 'a', 'winner')]

describe('a last-writer-wins register', () => {
  it('chooses the greatest logical time, then replica id in locale-independent order', () => {
    for (const left of writes)
      for (const right of writes) {
        const expected = writes[Math.max(writes.indexOf(left), writes.indexOf(right))]
        expect(Title.merge(left, right)).toEqual(expected)
      }
  })

  it('is associative, commutative and idempotent for unique write identities', () => {
    for (const left of writes) {
      expect(Title.merge(left, structuredClone(left))).toEqual(left)
      for (const right of writes) {
        expect(Title.merge(left, right)).toEqual(Title.merge(right, left))
        for (const third of writes)
          expect(Title.merge(Title.merge(left, right), third)).toEqual(
            Title.merge(left, Title.merge(right, third)),
          )
      }
    }
  })

  it('rejects conflicting values with the same write identity in either order', () => {
    const left = write(1, 'a', 'one')
    const right = write(1, 'a', 'two')
    expect(() => Title.merge(left, right)).toThrow('Conflicting LWW write identity')
    expect(() => Title.merge(right, left)).toThrow('Conflicting LWW write identity')
  })

  it('compares structured values by the value schema and retains null tombstones', () => {
    const Entity = lwwRegister(Schema.NullOr(Schema.Struct({ title: Schema.String })))
    const live = { stamp: { counter: 1, replicaId: 'a' }, value: { title: 'Milk' } }
    expect(Entity.merge(live, structuredClone(live))).toEqual(live)
    const removed = { stamp: { counter: 2, replicaId: 'b' }, value: null }
    expect(Entity.merge(removed, live)).toEqual(removed)
    expect(Entity.merge(live, removed)).toEqual(removed)
  })

  it.each([
    ['negative counter', write(-1, 'a', 'x')],
    ['fractional counter', write(0.5, 'a', 'x')],
    ['unsafe counter', write(Number.MAX_SAFE_INTEGER + 1, 'a', 'x')],
    ['infinite counter', write(Infinity, 'a', 'x')],
    ['NaN counter', write(NaN, 'a', 'x')],
    ['empty replica id', write(1, '', 'x')],
    ['invalid value', { stamp: { counter: 1, replicaId: 'a' }, value: 42 }],
  ])('rejects malformed encoded registers: %s', (_, input) => {
    const decode = Schema.decodeUnknownSync(Title.schema, { onExcessProperty: 'error' })
    expect(() => decode(input)).toThrow()
  })

  it('preserves transforming value codecs', () => {
    const Count = lwwRegister(Schema.NumberFromString)
    const encoded = { stamp: { counter: 0, replicaId: 'initial' }, value: '42' }
    const decoded = Schema.decodeUnknownSync(Count.schema)(encoded)
    expect(decoded.value).toBe(42)
    expect(Schema.encodeSync(Count.schema)(decoded)).toEqual(encoded)
    expect(
      Count.merge(decoded, { ...decoded, stamp: { counter: 1, replicaId: 'a' }, value: 43 }),
    ).toEqual({ stamp: { counter: 1, replicaId: 'a' }, value: 43 })
  })
})
