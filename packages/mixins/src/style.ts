/**
 * `Style` is pure data: class tokens and inline declarations that compile to a
 * `SlotContribution`. It never touches the DOM and never mutates state.
 * `forSlots` validates piece keys against the published contract at definition
 * time, so a typo fails loudly.
 */
import type { InputContribution, SlotContribution } from './contribution.js'
import { DiagnosticError } from './diagnostics.js'
import * as Mixin from './mixin.js'
import type { Mixin as MixinValue } from './mixin.js'
import * as SlotView from './slotView.js'
import * as Rules from './styleRules.js'
import type { StyleRule } from './styleRules.js'

export interface StyleValue {
  readonly classes: ReadonlyArray<string>
  readonly style: Readonly<Record<string, string>>
  /** Input-driven pieces resolved at render time; empty for a static style. */
  readonly conditions?: ReadonlyArray<StyleCondition>
  /** Rule-based appearance compiled to a deterministic class plus CSS. */
  readonly rules?: ReadonlyArray<StyleRule>
}

export interface StyleCondition {
  readonly predicate: (input: unknown) => boolean
  readonly piece: StyleValue
}

export type StylePieces<Slots> = {
  readonly [K in keyof Slots]?: StyleValue
}

export interface NamedStyle<Slots> {
  readonly name?: string
  readonly pieces: StylePieces<Slots>
  readonly mixin: MixinValue<never>
  /** Concatenated rule CSS for every static piece; identical rules share a class. */
  readonly css: string
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
export const compose = (...pieces: ReadonlyArray<StyleValue>): StyleValue => {
  const conditions = pieces.flatMap(piece => piece.conditions ?? [])
  const rules = pieces.flatMap(piece => piece.rules ?? [])
  return Object.freeze({
    classes: Object.freeze(pieces.flatMap(piece => piece.classes)),
    style: Object.freeze(Object.assign(Object.create(null), ...pieces.map(piece => piece.style))),
    ...(conditions.length === 0 ? {} : { conditions: Object.freeze(conditions) }),
    ...(rules.length === 0 ? {} : { rules: Object.freeze(rules) }),
  })
}

/** A pseudo-class/element rule, e.g. `Style.pseudo(':hover', { color: 'red' })`. */
export const pseudo = (
  suffix: string,
  declarations: Readonly<Record<string, string>>,
): StyleValue =>
  Object.freeze({
    classes: empty.classes,
    style: empty.style,
    rules: Object.freeze([Rules.pseudo(suffix, declarations)]),
  })

/** An at-rule, e.g. `Style.media('(min-width: 40rem)', { color: 'red' })`. */
export const media = (query: string, declarations: Readonly<Record<string, string>>): StyleValue =>
  Object.freeze({
    classes: empty.classes,
    style: empty.style,
    rules: Object.freeze([Rules.media(query, declarations)]),
  })

/** A boolean known at authoring time. */
export const when = (condition: boolean, piece: StyleValue): StyleValue =>
  condition ? piece : empty

/** A condition read from the view input at render time. The piece applies when
 *  `predicate` returns true for the input the view was rendered with. */
export const whenInput = <Input>(
  predicate: (input: Input) => boolean,
  piece: StyleValue,
): StyleValue =>
  Object.freeze({
    classes: empty.classes,
    style: empty.style,
    conditions: Object.freeze([
      { predicate: (input: unknown) => predicate(input as Input), piece },
    ]),
  })

/** Fold every active condition (recursively) into a condition-free style. */
const resolveStyle = (style: StyleValue, input: unknown): StyleValue => {
  const active = (style.conditions ?? [])
    .filter(condition => condition.predicate(input))
    .map(condition => resolveStyle(condition.piece, input))
  return Object.freeze({
    classes: Object.freeze([...style.classes, ...active.flatMap(piece => piece.classes)]),
    style: Object.freeze(
      Object.assign(Object.create(null), style.style, ...active.map(piece => piece.style)),
    ),
  })
}

const hasConditionalRules = (style: StyleValue): boolean =>
  (style.conditions ?? []).some(
    condition => (condition.piece.rules ?? []).length > 0 || hasConditionalRules(condition.piece),
  )

interface CompiledStyle {
  readonly classes: ReadonlyArray<string>
  readonly style: Readonly<Record<string, string>>
  readonly css?: string
}

/** A rule-bearing style gets one deterministic class and its CSS text. */
const compileStyle = (style: StyleValue): CompiledStyle => {
  const rules = style.rules ?? []
  if (rules.length === 0) return { classes: style.classes, style: style.style }
  const generated = Rules.className(rules)
  return {
    classes: Object.freeze([...style.classes, generated]),
    style: style.style,
    css: Rules.css(generated, rules),
  }
}

/**
 * A static style stays static data. A style with input conditions compiles to a
 * message-free `InputContribution`, so it still attaches to any view. Rules
 * inside a condition are rejected: the class is static while the condition is
 * not.
 */
export const toContribution = (style: StyleValue): SlotContribution<never> => {
  if (hasConditionalRules(style)) {
    throw new DiagnosticError({
      source: 'mixins',
      code: 'style:conditional-rules-unsupported',
      severity: 'error',
      message: 'Style.pseudo/media may not appear inside Style.whenInput',
    })
  }
  const compiled = compileStyle(style)
  const base = {
    classes: compiled.classes,
    style: compiled.style,
    ...(compiled.css === undefined ? {} : { css: compiled.css }),
  }
  if ((style.conditions ?? []).length === 0) return Object.freeze(base)
  const contribution: InputContribution<never> = context => {
    const resolved = resolveStyle({ ...style, classes: compiled.classes }, context.input)
    return Object.freeze({
      classes: resolved.classes,
      style: resolved.style,
      ...(compiled.css === undefined ? {} : { css: compiled.css }),
    })
  }
  return contribution
}

export const forSlots =
  <Slots>(slots: Slots) =>
  (pieces: StylePieces<Slots>, options?: { readonly name?: string }): NamedStyle<Slots> => {
    const known = slots as unknown as Record<string, unknown>
    const contributions: Record<string, SlotContribution<never>> = Object.create(null)
    let css = ''
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
      if (piece !== undefined) {
        const contribution = toContribution(piece)
        contributions[key] = contribution
        if (typeof contribution !== 'function' && contribution.css !== undefined) {
          css += contribution.css
        }
      }
    }
    return Object.freeze({
      ...(options?.name === undefined ? {} : { name: options.name }),
      pieces,
      mixin: Mixin.dynamic<never>(options?.name ?? 'Style', contributions),
      css,
    })
  }

/** Concatenate the rule CSS of several styles for one `<style>` block. */
export const stylesheet = (...styles: ReadonlyArray<{ readonly css: string }>): string =>
  styles.map(style => style.css).join('')

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
  whenInput,
  pseudo,
  media,
  empty,
  toContribution,
  forSlots,
  attach,
  recipe,
  stylesheet,
} as const
