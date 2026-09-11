/**
 * Ported from `effect-atom-jsx/src/MetadataToken.ts`. Kinded name tokens so
 * Event, Attr, Requirement, and Capability share one witness instead of four
 * ad-hoc brands.
 */
export const MetadataTokenTypeId: unique symbol = Symbol.for('foldkit-mixins/MetadataToken')

export interface MetadataToken<Kind extends string, Name extends string> {
  readonly [MetadataTokenTypeId]: {
    readonly Kind: Kind
    readonly Name: Name
  }
  readonly kind: Kind
  readonly name: Name
}

export type Any = MetadataToken<string, string>

export type NameOf<T> =
  T extends MetadataToken<any, infer Name> ? Name : T extends string ? T : never

export type KindOf<T> = T extends MetadataToken<infer Kind, any> ? Kind : never

export type NamesOf<T extends readonly unknown[]> = NameOf<T[number]>

export const make = <const Kind extends string, const Name extends string>(
  kind: Kind,
  name: Name,
): MetadataToken<Kind, Name> => {
  if (name === '') {
    throw new Error(`${kind} name must be non-empty`)
  }
  return {
    [MetadataTokenTypeId]: {
      Kind: undefined as unknown as Kind,
      Name: undefined as unknown as Name,
    },
    kind,
    name,
  }
}

export const is = (value: unknown): value is Any =>
  typeof value === 'object' && value !== null && MetadataTokenTypeId in value

export const nameOf = (value: string | Any): string => (is(value) ? value.name : value)
