/**
 * Ported from `effect-atom-jsx/src/Element.ts` `Capability`, without Handle
 * objects. Inheritance is metadata: a behavior that needs Interactive can
 * attach to TextInput. Lookups go through a Map so `__proto__` is a legal name.
 */
import * as MetadataToken from './metadataToken.js'

export type CapabilityParent = string | MetadataToken.MetadataToken<'element.capability', string>

export interface Capability<
  Name extends string = string,
  Extends extends readonly CapabilityParent[] = readonly [],
> extends MetadataToken.MetadataToken<'element.capability', Name> {
  readonly extends: Extends
}

export type Any = Capability<string, readonly CapabilityParent[]>
export type NameOf<T> = MetadataToken.NameOf<T>
export type NamesOf<T extends readonly unknown[]> = MetadataToken.NamesOf<T>
export type ExtendsOf<T> =
  T extends Capability<any, infer Extends> ? MetadataToken.NameOf<Extends[number]> : never
export type AssignableNamesOf<T> = T extends string
  ? T
  : T extends Capability<any, infer Extends>
    ? MetadataToken.NameOf<T> | AssignableNamesOf<Extends[number]>
    : MetadataToken.NameOf<T>

export type Satisfies<Actual, Required extends { readonly name: string }> =
  Required['name'] extends AssignableNamesOf<Actual> ? true : false

const parentsByName = new Map<string, ReadonlyArray<string>>()
const registry = new Map<string, Any>()

export const is = (value: unknown): value is Any =>
  MetadataToken.is(value) && value.kind === 'element.capability'

export const make = <
  const Name extends string,
  const Extends extends readonly CapabilityParent[] = readonly [],
>(
  name: Name,
  options?: { readonly extends?: Extends },
): Capability<Name, Extends> => {
  if (name === '') {
    throw new Error('Capability name must be non-empty')
  }
  const parents = (options?.extends ?? []) as Extends
  const parentNames = parents.map(parent => MetadataToken.nameOf(parent))
  const existing = registry.get(name)
  if (existing !== undefined) {
    const existingNames = existing.extends.map(parent => MetadataToken.nameOf(parent))
    if (
      existingNames.length === parentNames.length &&
      existingNames.every((parentName, index) => parentName === parentNames[index])
    ) {
      return existing as Capability<Name, Extends>
    }
    throw new Error(`Capability "${name}" is already defined with a different extends list`)
  }
  parentsByName.set(name, parentNames)
  const capability: Capability<Name, Extends> = {
    ...MetadataToken.make('element.capability', name),
    extends: Object.freeze([...parents]) as Extends,
  }
  registry.set(name, capability)
  return Object.freeze(capability)
}

/** True when `value` is `base` or inherits from it. Ported from AF-UI. */
export const extendsCapability = (value: string | Any, base: string | Any): boolean => {
  const valueName = MetadataToken.nameOf(value)
  const baseName = MetadataToken.nameOf(base)
  if (valueName === baseName) return true
  const visited = new Set<string>()
  const stack = [...(parentsByName.get(valueName) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    if (current === baseName) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(parentsByName.get(current) ?? []))
  }
  return false
}

export const satisfies = (actual: string | Any, required: string | Any): boolean =>
  extendsCapability(actual, required)

export const names = (capability: Any): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const walk = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const parent of parentsByName.get(name) ?? []) walk(parent)
  }
  walk(capability.name)
  return [...seen]
}

export const describe = (
  capability: Any,
): { readonly name: string; readonly extends: ReadonlyArray<string> } => ({
  name: capability.name,
  extends: capability.extends.map(parent => MetadataToken.nameOf(parent)),
})

export const Base = make('Base')
export const Interactive = make('Interactive', { extends: [Base] })
export const Container = make('Container', { extends: [Interactive] })
export const Focusable = make('Focusable', { extends: [Interactive] })
export const TextInput = make('TextInput', { extends: [Focusable] })
export const Draggable = make('Draggable', { extends: [Interactive] })
export const Collection = make('Collection', { extends: [Base] })
