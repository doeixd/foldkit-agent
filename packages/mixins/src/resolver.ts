/**
 * The deterministic resolver. `resolve` is pure: it decomposes the base
 * attributes, applies contributions in attachment order, enforces ownership
 * and protection, then emits one canonical `Class`, one `Style`, and at most
 * one `OnMount`. Conflicts throw a `DiagnosticError` before Foldkit could
 * silently chain or replace.
 */
import { Stream } from 'effect'
import type { Attribute, ChildAttribute } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'
import {
  classAttribute,
  isChildAttribute,
  isTagged,
  mountAttribute,
  styleAttribute,
} from './attribute.js'
import type { StaticContribution } from './contribution.js'
import { DiagnosticError, type Diagnostic, type DiagnosticCode } from './diagnostics.js'
import * as MetadataToken from './metadataToken.js'
import type { SlotProtection } from './slot.js'

export type SlotAttributes<Message> = ReadonlyArray<Attribute<Message> | ChildAttribute>

export interface ResolveOptions {
  readonly slot?: string
  readonly protected?: SlotProtection
}

/** `AriaLabel` -> `arialabel`, `aria-label` -> `arialabel`; tags and tokens agree. */
const normalizeName = (name: string): string => name.replace(/[^a-z0-9]/gi, '').toLowerCase()

/** Attribute tags are PascalCase (`OnKeyDown`); event tokens are lowercase. */
const eventNameOfTag = (tag: string): string =>
  normalizeName(tag.startsWith('On') ? tag.slice(2) : tag)

const splitClasses = (value: string): ReadonlyArray<string> =>
  value.split(/\s+/).filter(token => token.length > 0)

/** `Prop`/`Attribute`/`DataAttribute`/`OnCustomEvent` are keyed individually. */
const ownershipKey = (tag: string, value: unknown): string => {
  if (typeof value !== 'object' || value === null) return tag
  const record = value as { readonly key?: unknown; readonly name?: unknown }
  switch (tag) {
    case 'Prop':
    case 'Attribute':
    case 'DataAttribute':
      return `${tag}:${String(record.key)}`
    case 'OnCustomEvent':
      return `${tag}:${String(record.name)}`
    default:
      return tag
  }
}

const toDiagnostic = (
  code: DiagnosticCode,
  message: string,
  slot: string | undefined,
  details: Readonly<Record<string, unknown>>,
): Diagnostic => ({
  source: 'mixins',
  code,
  severity: 'error',
  message,
  ...(slot === undefined ? {} : { slot }),
  details,
})

export const resolve = <Message>(
  base: SlotAttributes<Message> | undefined,
  contributions: ReadonlyArray<StaticContribution<Message>>,
  options: ResolveOptions = {},
): SlotAttributes<Message> => {
  const slot = options.slot
  const protection = options.protected
  const protectedEvents = new Set(
    (protection?.events ?? []).map(event => normalizeName(MetadataToken.nameOf(event))),
  )
  const protectedAttributes = new Set(
    (protection?.attributes ?? []).map(attr => normalizeName(MetadataToken.nameOf(attr))),
  )
  const protectedStyle = new Set(protection?.style ?? [])

  const classes: Array<string> = []
  const classSeen = new Set<string>()
  const style = new Map<string, string>()
  const mounts: Array<MountAction<Message, any>> = []
  const mountNames = new Map<string, number>()
  const preserved: Array<Attribute<Message> | ChildAttribute> = []
  const added: Array<Attribute<Message> | ChildAttribute> = []
  const ownedEvents = new Map<string, string>()
  const ownedAttributes = new Map<string, string>()

  function fail(
    code: DiagnosticCode,
    message: string,
    details: Readonly<Record<string, unknown>>,
  ): never {
    throw new DiagnosticError(toDiagnostic(code, message, slot, details))
  }

  const addClass = (token: string): void => {
    if (classSeen.has(token)) return
    classSeen.add(token)
    classes.push(token)
  }

  const addMount = (action: MountAction<Message, any>): void => {
    const count = (mountNames.get(action.name) ?? 0) + 1
    mountNames.set(action.name, count)
    if (count > 1) {
      fail('mixins:duplicate-mount-name', `two Mounts are both named "${action.name}"`, {
        name: action.name,
      })
    }
    mounts.push(action)
  }

  const reserve = (tag: string, value: unknown): void => {
    if (tag === 'OnMount') return
    // `OnCustomEvent` is keyed by its event name, not treated as one native event.
    if (tag.startsWith('On') && tag !== 'OnCustomEvent') {
      ownedEvents.set(eventNameOfTag(tag), tag)
      return
    }
    ownedAttributes.set(ownershipKey(tag, value), tag)
  }

  const addBase = (attribute: Attribute<Message> | ChildAttribute): void => {
    if (isChildAttribute(attribute)) {
      const inner = (attribute as { readonly attribute?: unknown }).attribute
      if (isTagged(inner)) reserve(inner._tag, inner)
      preserved.push(attribute)
      return
    }
    const tag = attribute._tag
    switch (tag) {
      case 'Class':
        for (const token of splitClasses(attribute.value)) addClass(token)
        return
      case 'Style':
        for (const [property, value] of Object.entries(attribute.value)) style.set(property, value)
        return
      case 'OnMount':
        addMount(attribute.action)
        return
      default:
        reserve(tag, attribute)
        preserved.push(attribute)
    }
  }

  const applyMixinAttribute = (attribute: Attribute<Message> | ChildAttribute): void => {
    if (isChildAttribute(attribute)) {
      const inner = (attribute as { readonly attribute?: unknown }).attribute
      if (isTagged(inner)) reserve(inner._tag, inner)
      added.push(attribute)
      return
    }
    const tag = attribute._tag
    switch (tag) {
      case 'Class':
        for (const token of splitClasses(attribute.value)) addClass(token)
        return
      case 'Style':
        for (const [property, value] of Object.entries(attribute.value)) {
          if (protectedStyle.has(property)) {
            fail(
              'mixins:protected-style-property',
              `slot "${slot ?? '?'}" protects style property "${property}"`,
              { property },
            )
          }
          style.set(property, value)
        }
        return
      case 'OnMount':
        addMount(attribute.action)
        return
      case 'Key':
      case 'InnerHTML':
        fail(
          'mixins:structural-override',
          `a Mixin may not contribute "${tag}"; it is structural ownership`,
          { tag },
        )
      default:
        if (tag.startsWith('On') && tag !== 'OnCustomEvent') {
          const eventName = eventNameOfTag(tag)
          if (protectedEvents.has(eventName)) {
            fail('mixins:protected-event', `slot "${slot ?? '?'}" protects event "${eventName}"`, {
              tag,
              event: eventName,
            })
          }
          const owner = ownedEvents.get(eventName)
          if (owner !== undefined) {
            fail(
              'mixins:event-conflict',
              `two owners for event "${eventName}": "${owner}" already owns it`,
              { tag, event: eventName, owner },
            )
          }
          ownedEvents.set(eventName, tag)
        } else {
          const key = ownershipKey(tag, attribute)
          if (protectedAttributes.has(normalizeName(tag))) {
            fail(
              'mixins:protected-attribute',
              `slot "${slot ?? '?'}" protects attribute "${tag}"`,
              { tag },
            )
          }
          const owner = ownedAttributes.get(key)
          if (owner !== undefined) {
            fail(
              'mixins:attribute-conflict',
              `two owners for "${key}": a ${owner} attribute already occupies it`,
              { tag, key, owner },
            )
          }
          ownedAttributes.set(key, tag)
        }
        added.push(attribute)
    }
  }

  for (const attribute of base ?? []) addBase(attribute)

  for (const contribution of contributions) {
    for (const token of contribution.classes ?? []) addClass(token)
    for (const [property, value] of Object.entries(contribution.style ?? {})) {
      if (protectedStyle.has(property)) {
        fail(
          'mixins:protected-style-property',
          `slot "${slot ?? '?'}" protects style property "${property}"`,
          { property },
        )
      }
      style.set(property, value)
    }
    for (const attribute of contribution.attributes ?? []) applyMixinAttribute(attribute)
    for (const mount of contribution.mounts ?? []) addMount(mount)
  }

  const emitted: Array<Attribute<Message> | ChildAttribute> = []
  if (classes.length > 0) emitted.push(classAttribute(classes.join(' ')))
  if (style.size > 0) emitted.push(styleAttribute(Object.fromEntries(style)))
  emitted.push(...preserved, ...added)
  const composed = composeMounts(mounts, slot)
  if (composed !== undefined) emitted.push(composed)
  return emitted
}

const composeMounts = <Message>(
  mounts: ReadonlyArray<MountAction<Message, any>>,
  slot: string | undefined,
): Attribute<Message> | undefined => {
  const first = mounts[0]
  if (first === undefined) return undefined
  if (mounts.length === 1) return mountAttribute(first)
  const name = `Mixins[${slot ?? 'slot'}](${mounts.map(mount => mount.name).join(',')})`
  return mountAttribute({
    name,
    args: {
      slot: slot ?? null,
      actions: mounts.map(mount => ({ name: mount.name, args: mount.args })),
    },
    f: (element, viewStateChanges) =>
      Stream.mergeAll(
        mounts.map(mount => mount.f(element, viewStateChanges)),
        { concurrency: 'unbounded' },
      ),
  })
}
