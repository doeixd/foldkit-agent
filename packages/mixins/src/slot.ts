/**
 * Slot witnesses. Ported from `effect-atom-jsx/src/View.ts` `Slot`, without
 * Handle binding. A slot is named metadata: capability, allowed events,
 * attributes, platform requirements, hidden, and Foldkit-only `protected`.
 */
import type { AttrToken } from './attr.js'
import type { Any as AnyCapability } from './capability.js'
import * as Capability from './capability.js'
import type { EventToken } from './event.js'
import * as MetadataToken from './metadataToken.js'
import { pipeSelf, type Pipeable } from './pipe.js'
import type { RequirementToken } from './requirement.js'

export const SlotTypeId: unique symbol = Symbol.for('foldkit-mixins/Slot')
export type SlotTypeId = typeof SlotTypeId

export type EventName = string | EventToken
export type AttributeName = string | AttrToken
export type RequirementName = string | RequirementToken
export type SlotCapability = string | AnyCapability

export interface SlotProtection {
  readonly events: ReadonlyArray<EventName>
  readonly attributes: ReadonlyArray<AttributeName>
  readonly style: ReadonlyArray<string>
}

export interface SlotMetadata<Name extends string = string> {
  readonly name: Name
  readonly capability: SlotCapability
  readonly allowedEvents: readonly EventName[]
  readonly allowedAttributes: readonly AttributeName[]
  readonly platformRequirements: readonly RequirementName[]
  readonly hidden: boolean
  readonly protected: SlotProtection
}

export interface Slot<
  Name extends string = string,
  C extends SlotCapability = typeof Capability.Base,
  Events extends readonly EventName[] = readonly [],
  Attributes extends readonly AttributeName[] = readonly [],
  Requirements extends readonly RequirementName[] = readonly [],
  Hidden extends boolean = false,
> extends Pipeable<Slot<Name, C, Events, Attributes, Requirements, Hidden>> {
  readonly [SlotTypeId]: {
    readonly Name: Name
    readonly Capability: C
    readonly Events: Events
    readonly Attributes: Attributes
    readonly Requirements: Requirements
    readonly Hidden: Hidden
  }
  readonly name: Name
  readonly capability: C
  readonly events: Events
  readonly attributes: Attributes
  readonly requirements: Requirements
  readonly hidden: Hidden
  readonly protected: SlotProtection
  readonly metadata: SlotMetadata<Name> & {
    readonly capability: C
    readonly allowedEvents: Events
    readonly allowedAttributes: Attributes
    readonly platformRequirements: Requirements
    readonly hidden: Hidden
  }
}

export type Any = Slot<
  string,
  SlotCapability,
  readonly EventName[],
  readonly AttributeName[],
  readonly RequirementName[],
  boolean
>

export type UnnamedSlot<
  C extends SlotCapability = SlotCapability,
  Events extends readonly EventName[] = readonly EventName[],
  Attributes extends readonly AttributeName[] = readonly AttributeName[],
  Requirements extends readonly RequirementName[] = readonly RequirementName[],
  Hidden extends boolean = boolean,
> = Omit<Slot<'', C, Events, Attributes, Requirements, Hidden>, 'name'> & {
  readonly name?: never
}

export type NameOf<T> = T extends Slot<infer Name, any, any, any, any, any> ? Name : never
export type CapabilityOf<T> =
  T extends Slot<any, infer C, any, any, any, any> ? MetadataToken.NameOf<C> : never
export type CapabilityValueOf<T> = T extends Slot<any, infer C, any, any, any, any> ? C : never
export type EventsOf<T> =
  T extends Slot<any, any, infer Events, any, any, any> ? MetadataToken.NamesOf<Events> : never
export type AttributesOf<T> =
  T extends Slot<any, any, any, infer Attributes, any, any>
    ? MetadataToken.NamesOf<Attributes>
    : never
export type HiddenOf<T> = T extends Slot<any, any, any, any, any, infer Hidden> ? Hidden : never
export type AssignableCapabilityNamesOf<T> = Capability.AssignableNamesOf<CapabilityValueOf<T>>
export type Public<T> = HiddenOf<T> extends true ? never : T
export type Hidden<T> = HiddenOf<T> extends true ? T : never

export const is = (value: unknown): value is Any | UnnamedSlot =>
  typeof value === 'object' && value !== null && SlotTypeId in value

const emptyProtection: SlotProtection = Object.freeze({
  events: Object.freeze([]) as ReadonlyArray<EventName>,
  attributes: Object.freeze([]) as ReadonlyArray<AttributeName>,
  style: Object.freeze([]) as ReadonlyArray<string>,
})

export interface MakeOptions<
  C extends SlotCapability = SlotCapability,
  Events extends readonly EventName[] = readonly EventName[],
  Attributes extends readonly AttributeName[] = readonly AttributeName[],
  Requirements extends readonly RequirementName[] = readonly RequirementName[],
  Hidden extends boolean = boolean,
> {
  readonly capability?: C
  readonly events?: Events
  readonly allowedEvents?: Events
  readonly attributes?: Attributes
  readonly allowedAttributes?: Attributes
  readonly requirements?: Requirements
  readonly platformRequirements?: Requirements
  readonly hidden?: Hidden
  readonly protected?: {
    readonly events?: ReadonlyArray<EventName>
    readonly attributes?: ReadonlyArray<AttributeName>
    readonly style?: ReadonlyArray<string>
  }
}

const protectionOf = (options: MakeOptions | undefined): SlotProtection => {
  const specified = options?.protected
  if (specified === undefined) return emptyProtection
  return Object.freeze({
    events: Object.freeze([...(specified.events ?? [])]),
    attributes: Object.freeze([...(specified.attributes ?? [])]),
    style: Object.freeze([...(specified.style ?? [])]),
  })
}

const createSlot = <
  Name extends string,
  C extends SlotCapability,
  Events extends readonly EventName[],
  Attributes extends readonly AttributeName[],
  Requirements extends readonly RequirementName[],
  Hidden extends boolean,
>(
  name: Name,
  options: MakeOptions<C, Events, Attributes, Requirements, Hidden> | undefined,
): Slot<Name, C, Events, Attributes, Requirements, Hidden> => {
  const capability = (options?.capability ?? Capability.Base) as C
  const events = (options?.events ?? options?.allowedEvents ?? []) as Events
  const attributes = (options?.attributes ?? options?.allowedAttributes ?? []) as Attributes
  const requirements = (options?.requirements ??
    options?.platformRequirements ??
    []) as Requirements
  const hidden = (options?.hidden ?? false) as Hidden
  const protection = protectionOf(options)
  const metadata = {
    name,
    capability,
    allowedEvents: events,
    allowedAttributes: attributes,
    platformRequirements: requirements,
    hidden,
    protected: protection,
  }
  const out = {
    [SlotTypeId]: {
      Name: undefined as unknown as Name,
      Capability: undefined as unknown as C,
      Events: undefined as unknown as Events,
      Attributes: undefined as unknown as Attributes,
      Requirements: undefined as unknown as Requirements,
      Hidden: undefined as unknown as Hidden,
    },
    name,
    capability,
    events,
    attributes,
    requirements,
    hidden,
    protected: protection,
    metadata,
  } as Slot<Name, C, Events, Attributes, Requirements, Hidden>
  return Object.assign(out, {
    pipe: (...fns: ReadonlyArray<(value: any) => any>) => pipeSelf(out, fns),
  }) as Slot<Name, C, Events, Attributes, Requirements, Hidden>
}

/** AF-UI form: name is the first argument. */
export function make<
  const Name extends string,
  const C extends SlotCapability = typeof Capability.Base,
  const Events extends readonly EventName[] = readonly [],
  const Attributes extends readonly AttributeName[] = readonly [],
  const Requirements extends readonly RequirementName[] = readonly [],
  const Hidden extends boolean = false,
>(
  name: Name,
  options?: MakeOptions<C, Events, Attributes, Requirements, Hidden>,
): Slot<Name, C, Events, Attributes, Requirements, Hidden>
/** Foldkit form: name comes from `Slots.define` keys. */
export function make<
  const C extends SlotCapability = typeof Capability.Base,
  const Events extends readonly EventName[] = readonly [],
  const Attributes extends readonly AttributeName[] = readonly [],
  const Requirements extends readonly RequirementName[] = readonly [],
  const Hidden extends boolean = false,
>(
  options: MakeOptions<C, Events, Attributes, Requirements, Hidden>,
): UnnamedSlot<C, Events, Attributes, Requirements, Hidden>
export function make(
  nameOrOptions: string | MakeOptions,
  options?: MakeOptions,
): Any | UnnamedSlot {
  if (typeof nameOrOptions === 'string') {
    return createSlot(nameOrOptions, options)
  }
  const unnamed = createSlot('', nameOrOptions)
  const { name: _dropped, ...rest } = unnamed
  return rest as UnnamedSlot
}

/** Pipeable transform replacing a named slot's capability. */
export const capability =
  <const C extends SlotCapability>(capability: C) =>
  <
    Name extends string,
    OldC extends SlotCapability,
    Events extends readonly EventName[],
    Attributes extends readonly AttributeName[],
    Requirements extends readonly RequirementName[],
    Hidden extends boolean,
  >(
    slot: Slot<Name, OldC, Events, Attributes, Requirements, Hidden>,
  ): Slot<Name, C, Events, Attributes, Requirements, Hidden> =>
    createSlot(slot.name, {
      capability,
      events: slot.events,
      attributes: slot.attributes,
      requirements: slot.requirements,
      hidden: slot.hidden,
      protected: slot.protected,
    })

/** Pipeable transform replacing a named slot's allowed events. */
export const events =
  <const Next extends readonly EventName[]>(...next: Next) =>
  <
    Name extends string,
    C extends SlotCapability,
    Events extends readonly EventName[],
    Attributes extends readonly AttributeName[],
    Requirements extends readonly RequirementName[],
    Hidden extends boolean,
  >(
    slot: Slot<Name, C, Events, Attributes, Requirements, Hidden>,
  ): Slot<Name, C, Next, Attributes, Requirements, Hidden> =>
    createSlot(slot.name, {
      capability: slot.capability,
      events: next,
      attributes: slot.attributes,
      requirements: slot.requirements,
      hidden: slot.hidden,
      protected: slot.protected,
    })

/** Pipeable transform replacing a named slot's allowed attributes. */
export const attributes =
  <const Next extends readonly AttributeName[]>(...next: Next) =>
  <
    Name extends string,
    C extends SlotCapability,
    Events extends readonly EventName[],
    Attributes extends readonly AttributeName[],
    Requirements extends readonly RequirementName[],
    Hidden extends boolean,
  >(
    slot: Slot<Name, C, Events, Attributes, Requirements, Hidden>,
  ): Slot<Name, C, Events, Next, Requirements, Hidden> =>
    createSlot(slot.name, {
      capability: slot.capability,
      events: slot.events,
      attributes: next,
      requirements: slot.requirements,
      hidden: slot.hidden,
      protected: slot.protected,
    })

/** Pipeable transform replacing a named slot's platform requirements. */
export const requires =
  <const Next extends readonly RequirementName[]>(...next: Next) =>
  <
    Name extends string,
    C extends SlotCapability,
    Events extends readonly EventName[],
    Attributes extends readonly AttributeName[],
    Requirements extends readonly RequirementName[],
    Hidden extends boolean,
  >(
    slot: Slot<Name, C, Events, Attributes, Requirements, Hidden>,
  ): Slot<Name, C, Events, Attributes, Next, Hidden> =>
    createSlot(slot.name, {
      capability: slot.capability,
      events: slot.events,
      attributes: slot.attributes,
      requirements: next,
      hidden: slot.hidden,
      protected: slot.protected,
    })

/** Pipeable transform marking a named slot hidden from public attachment. */
export const hide = <
  Name extends string,
  C extends SlotCapability,
  Events extends readonly EventName[],
  Attributes extends readonly AttributeName[],
  Requirements extends readonly RequirementName[],
  Hidden extends boolean,
>(
  slot: Slot<Name, C, Events, Attributes, Requirements, Hidden>,
): Slot<Name, C, Events, Attributes, Requirements, true> =>
  createSlot(slot.name, {
    capability: slot.capability,
    events: slot.events,
    attributes: slot.attributes,
    requirements: slot.requirements,
    hidden: true,
    protected: slot.protected,
  })

export const describe = (
  slot: Any | UnnamedSlot,
): {
  readonly name?: string
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
} => {
  const named = slot.name !== undefined && slot.name !== '' ? { name: slot.name } : {}
  return {
    ...named,
    capability: MetadataToken.nameOf(slot.capability),
    events: slot.events.map(event => MetadataToken.nameOf(event)),
    attributes: slot.attributes.map(attr => MetadataToken.nameOf(attr)),
    requirements: slot.requirements.map(requirement => MetadataToken.nameOf(requirement)),
    hidden: slot.hidden,
    protected: {
      events: slot.protected.events.map(event => MetadataToken.nameOf(event)),
      attributes: slot.protected.attributes.map(attr => MetadataToken.nameOf(attr)),
      style: slot.protected.style,
    },
  }
}
