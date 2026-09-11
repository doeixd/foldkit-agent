/**
 * Slot attribute tokens. Ported from `effect-atom-jsx/src/View.ts` `Attribute`,
 * plus ARIA names the Foldkit plan lists.
 */
import * as MetadataToken from './metadataToken.js'

export type AttrToken<Name extends string = string> = MetadataToken.MetadataToken<
  'view.attribute',
  Name
>

export const is = (value: unknown): value is AttrToken =>
  MetadataToken.is(value) && value.kind === 'view.attribute'

export const make = <const Name extends string>(name: Name): AttrToken<Name> =>
  MetadataToken.make('view.attribute', name)

export const equals = (left: AttrToken, right: AttrToken): boolean => left.name === right.name

export const describe = (attr: AttrToken): { readonly name: string } => ({
  name: attr.name,
})

export const Role = make('role')
export const AriaLabel = make('aria-label')
export const AriaDescribedby = make('aria-describedby')
export const AriaExpanded = make('aria-expanded')
export const AriaSelected = make('aria-selected')
export const AriaInvalid = make('aria-invalid')
export const AriaDisabled = make('aria-disabled')
export const Disabled = make('disabled')
export const Value = make('value')
