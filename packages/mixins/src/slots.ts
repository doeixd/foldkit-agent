/**
 * Slot contracts. Ported from `effect-atom-jsx/src/View.ts` `Slots.define`,
 * without minting element Handles. Names come from keys. Entries may be
 * `Slot.make({...})` or AF-UI option objects `{ capability, allowedEvents }`.
 */
import * as Capability from './capability.js'
import * as Slot from './slot.js'
import type {
  Any as AnySlot,
  MakeOptions,
  Slot as NamedSlot,
  SlotCapability,
  UnnamedSlot,
} from './slot.js'

export const SlotsTypeId: unique symbol = Symbol.for('foldkit-mixins/Slots')

export type Contract<S extends { readonly [K in keyof S]: UnnamedSlot | MakeOptions }> = {
  readonly [K in keyof S]: S[K] extends UnnamedSlot<
    infer C,
    infer Events,
    infer Attributes,
    infer Requirements,
    infer Hidden
  >
    ? NamedSlot<K & string, C, Events, Attributes, Requirements, Hidden>
    : S[K] extends MakeOptions<
          infer C,
          infer Events,
          infer Attributes,
          infer Requirements,
          infer Hidden
        >
      ? NamedSlot<K & string, C, Events, Attributes, Requirements, Hidden>
      : never
}

export type NamesOf<T> = keyof T & string
export type PublicNamesOf<T> = {
  readonly [K in keyof T & string]: Slot.HiddenOf<T[K]> extends true ? never : K
}[keyof T & string]
export type HiddenNamesOf<T> = {
  readonly [K in keyof T & string]: Slot.HiddenOf<T[K]> extends true ? K : never
}[keyof T & string]
export type WithCapability<T, C extends SlotCapability> = {
  readonly [
    K in keyof T & string as Capability.NameOf<C> extends Slot.AssignableCapabilityNamesOf<T[K]>
      ? K
      : never
  ]: T[K]
}

const toUnnamed = (value: unknown, key: string): UnnamedSlot => {
  if (Slot.is(value)) {
    return value as UnnamedSlot
  }
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'capability')) {
    return Slot.make(value as MakeOptions)
  }
  throw new Error(`Slots.define: "${key}" is not a Slot or slot options object`)
}

export const define = <const S extends { readonly [K in keyof S]: UnnamedSlot | MakeOptions }>(
  spec: S,
): Contract<S> => {
  const proto = Object.getPrototypeOf(spec)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      'Slots.define: pass a plain object; quote ["__proto__"] to use that as a slot name',
    )
  }
  const contract = Object.create(null) as Record<string, NamedSlot>
  for (const key of Object.getOwnPropertyNames(spec)) {
    const unnamed = toUnnamed((spec as Record<string, unknown>)[key], key)
    Object.defineProperty(contract, key, {
      value: Slot.make(key, {
        capability: unnamed.capability,
        events: unnamed.events,
        attributes: unnamed.attributes,
        requirements: unnamed.requirements,
        hidden: unnamed.hidden,
        protected: unnamed.protected,
      }),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  Object.freeze(contract)
  return contract as unknown as Contract<S>
}

export const describe = (contract: {
  readonly [key: string]: AnySlot | UnnamedSlot
}): {
  readonly slots: Readonly<
    Record<
      string,
      {
        readonly name: string
        readonly capability: string
        readonly events: ReadonlyArray<string>
        readonly attributes: ReadonlyArray<string>
        readonly requirements: ReadonlyArray<string>
        readonly hidden: boolean
        readonly protected: {
          readonly events: ReadonlyArray<string>
          readonly attributes: ReadonlyArray<string>
          readonly style: ReadonlyArray<string>
        }
      }
    >
  >
} => {
  const slots: Record<string, ReturnType<typeof Slot.describe> & { readonly name: string }> = {}
  for (const key of Object.getOwnPropertyNames(contract)) {
    const slot = contract[key]
    if (slot === undefined || !Slot.is(slot)) continue
    const described = Slot.describe(slot)
    slots[key] = {
      ...described,
      name: slot.name !== undefined && slot.name !== '' ? slot.name : key,
    }
  }
  return { slots }
}

export const withCapability = <
  T extends { readonly [key: string]: AnySlot },
  C extends SlotCapability,
>(
  contract: T,
  capability: C,
): WithCapability<T, C> => {
  const out = Object.create(null) as Record<string, AnySlot>
  for (const key of Object.getOwnPropertyNames(contract)) {
    const slot = contract[key]
    if (slot === undefined || !Slot.is(slot)) continue
    if (Capability.extendsCapability(slot.capability, capability)) {
      out[key] = slot
    }
  }
  return out as WithCapability<T, C>
}
