/**
 * Platform requirement tokens. Ported from `effect-atom-jsx/src/View.ts`
 * `Requirement`.
 */
import * as MetadataToken from './metadataToken.js'

export type RequirementToken<Name extends string = string> = MetadataToken.MetadataToken<
  'view.requirement',
  Name
>

export const is = (value: unknown): value is RequirementToken =>
  MetadataToken.is(value) && value.kind === 'view.requirement'

export const make = <const Name extends string>(name: Name): RequirementToken<Name> =>
  MetadataToken.make('view.requirement', name)

export const describe = (requirement: RequirementToken): { readonly name: string } => ({
  name: requirement.name,
})

export const Keyboard = make('keyboard')
export const Pointer = make('pointer')
export const Clipboard = make('clipboard')
