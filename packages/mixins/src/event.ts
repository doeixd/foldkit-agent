/**
 * Slot event tokens. Ported from `effect-atom-jsx/src/View.ts` `Event`, plus
 * the extra names the Foldkit plan lists.
 */
import * as MetadataToken from './metadataToken.js'

export type EventToken<Name extends string = string> = MetadataToken.MetadataToken<
  'view.event',
  Name
>

export const is = (value: unknown): value is EventToken =>
  MetadataToken.is(value) && value.kind === 'view.event'

export const make = <const Name extends string>(name: Name): EventToken<Name> =>
  MetadataToken.make('view.event', name)

export const equals = (left: EventToken, right: EventToken): boolean => left.name === right.name

export const describe = (event: EventToken): { readonly name: string } => ({
  name: event.name,
})

export const Press = make('press')
export const Click = make('click')
export const Cancel = make('cancel')
export const Input = make('input')
export const Change = make('change')
export const Focus = make('focus')
export const Blur = make('blur')
export const KeyDown = make('keydown')
export const PointerDown = make('pointerdown')
export const PointerUp = make('pointerup')
export const Hover = make('hover')
export const Submit = make('submit')
