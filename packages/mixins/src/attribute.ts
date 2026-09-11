/**
 * Internal attribute helpers. Foldkit's `isChildAttribute` and the tagged
 * attribute shape are not public, so this module localizes the two casts they
 * require. Probed against foldkit 0.158.2; see DESIGN.md.
 */
import type { Attribute, ChildAttribute } from 'foldkit/html'
import { inertHtml as ih } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'

/** The brand `childAttribute.d.ts` stamps; Foldkit's guard is not exported. */
const CHILD_ATTRIBUTE_BRAND = '__childAttribute'

export const isChildAttribute = (value: unknown): value is ChildAttribute =>
  typeof value === 'object' && value !== null && CHILD_ATTRIBUTE_BRAND in value

interface Tagged {
  readonly _tag: string
}

export const isTagged = (value: unknown): value is Tagged =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  typeof (value as { readonly _tag?: unknown })._tag === 'string'

/** `Class` carries no Message, so the inert builder is the honest constructor. */
export const classAttribute = (value: string): Attribute<never> => ih.Class(value)

export const styleAttribute = (value: Record<string, string>): Attribute<never> => ih.Style(value)

/**
 * `inertHtml.OnMount` only accepts `MountAction<never>`, so a Message-bearing
 * mount is built directly. The shape is the same tagged value `h.OnMount`
 * produces (`{ _tag: 'OnMount', action }`).
 */
export const mountAttribute = <Message>(action: MountAction<Message, any>): Attribute<Message> =>
  ({ _tag: 'OnMount', action }) as Attribute<Message>
