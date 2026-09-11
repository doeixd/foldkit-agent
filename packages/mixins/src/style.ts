/**
 * `Style` is pure data: class tokens and inline declarations that compile to a
 * `SlotContribution`. It never touches the DOM and never mutates state.
 * `forSlots` validates piece keys against the published contract at definition
 * time, so a typo fails loudly.
 */
import type { StaticContribution } from './contribution.js'
import { DiagnosticError } from './diagnostics.js'
import * as Mixin from './mixin.js'
import type { StaticMixin } from './mixin.js'
import * as SlotView from './slotView.js'

export interface StyleValue {
  readonly classes: ReadonlyArray<string>
  readonly style: Readonly<Record<string, string>>
}

export type StylePieces<Slots> = {
  readonly [K in keyof Slots]?: StyleValue
}

export interface NamedStyle<Slots> {
  readonly name?: string
  readonly pieces: StylePieces<Slots>
  readonly mixin: StaticMixin<never>
}

const tokens = (value: string): ReadonlyArray<string> =>
  value.split(/\s+/).filter(token => token.length > 0)

export const empty: StyleValue = Object.freeze({
  classes: Object.freeze([]) as ReadonlyArray<string>,
  style: Object.freeze({}) as Readonly<Record<string, string>>,
})

export const classPiece = (value: string): StyleValue =>
  Object.freeze({ classes: Object.freeze(tokens(value)), style: empty.style })

export const inline = (value: Readonly<Record<string, string>>): StyleValue =>
  Object.freeze({ classes: empty.classes, style: Object.freeze({ ...value }) })

/** Concatenate classes; later inline declarations win per property. */
export const compose = (...pieces: ReadonlyArray<StyleValue>): StyleValue =>
  Object.freeze({
    classes: Object.freeze(pieces.flatMap(piece => piece.classes)),
    style: Object.freeze(Object.assign(Object.create(null), ...pieces.map(piece => piece.style))),
  })

export const when = (condition: boolean, piece: StyleValue): StyleValue =>
  condition ? piece : empty

export const toContribution = (style: StyleValue): StaticContribution<never> =>
  Object.freeze({ classes: style.classes, style: style.style })

export const forSlots =
  <Slots>(slots: Slots) =>
  (pieces: StylePieces<Slots>, options?: { readonly name?: string }): NamedStyle<Slots> => {
    const known = slots as unknown as Record<string, unknown>
    const contributions: Record<string, StaticContribution<never>> = Object.create(null)
    for (const [key, piece] of Object.entries(pieces as Record<string, StyleValue | undefined>)) {
      if (!Object.hasOwn(known, key)) {
        throw new DiagnosticError({
          source: 'mixins',
          code: 'mixins:unknown-slot',
          severity: 'error',
          message: `Style targets unknown slot "${key}"`,
          slot: key,
        })
      }
      if (piece !== undefined) contributions[key] = toContribution(piece)
    }
    return Object.freeze({
      ...(options?.name === undefined ? {} : { name: options.name }),
      pieces,
      mixin: Mixin.make<never>(options?.name ?? 'Style', contributions),
    })
  }

export const attach =
  <Slots>(style: NamedStyle<Slots>) =>
  <ViewSlots, Input, Message>(
    view: SlotView.SlotView<ViewSlots, Input, Message>,
  ): SlotView.SlotView<ViewSlots, Input, Message> =>
    SlotView.attach(style.mixin)(view)

export type RecipeVariantDef = Readonly<Record<string, StyleValue>>

export interface RecipeDef<Variants extends Readonly<Record<string, RecipeVariantDef>>> {
  readonly base?: StyleValue
  readonly variants: Variants
  readonly defaults?: { readonly [K in keyof Variants]?: keyof Variants[K] & string }
}

export type AnyRecipeDef = RecipeDef<Record<string, RecipeVariantDef>>

export type RecipeSelection<D extends AnyRecipeDef> = {
  readonly [K in keyof D['variants']]?: keyof D['variants'][K] & string
}

/** A recipe is just Style data: base + one piece per selected variant. */
export const recipe =
  <D extends AnyRecipeDef>(def: D) =>
  (selection: RecipeSelection<D>): StyleValue => {
    const pieces: Array<StyleValue> = []
    if (def.base !== undefined) pieces.push(def.base)
    for (const [variant, values] of Object.entries(def.variants)) {
      const chosen =
        (selection as Record<string, string | undefined>)[variant] ??
        (def.defaults as Record<string, string | undefined> | undefined)?.[variant]
      if (chosen === undefined) continue
      const piece = (values as Record<string, StyleValue>)[chosen]
      if (piece !== undefined) pieces.push(piece)
    }
    return compose(...pieces)
  }

export const Style = {
  class: classPiece,
  inline,
  compose,
  when,
  empty,
  toContribution,
  forSlots,
  attach,
  recipe,
} as const
