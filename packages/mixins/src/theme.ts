/**
 * `Theme` is typed token data, not a service. Dynamic theme state (light/dark)
 * belongs in the Foldkit Model; `variables` compiles the tokens to CSS custom
 * properties so switching a class or a root style is cheap and SSR-safe.
 */
import type { StyleValue } from './style.js'
import { inline } from './style.js'

export type ThemeTokens = {
  readonly [group: string]: { readonly [name: string]: string }
}

export type Theme<T extends ThemeTokens = ThemeTokens> = T

const VAR_PREFIX = '--fk'

export const define = <T extends ThemeTokens>(tokens: T): Readonly<T> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(tokens).map(([group, names]) => [group, Object.freeze({ ...names })]),
    ),
  ) as Readonly<T>

export const variable = <T extends ThemeTokens, G extends keyof T & string>(
  _theme: T,
  group: G,
  name: keyof T[G] & string,
): string => `var(${VAR_PREFIX}-${group}-${name})`

export const variables = <T extends ThemeTokens>(theme: T): StyleValue => {
  const style: Record<string, string> = {}
  for (const [group, names] of Object.entries(theme)) {
    for (const [name, value] of Object.entries(names as Record<string, string>)) {
      style[`${VAR_PREFIX}-${group}-${name}`] = value
    }
  }
  return inline(style)
}

export const Theme = { define, variable, variables } as const
