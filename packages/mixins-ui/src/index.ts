/**
 * `foldkit-mixins-ui` — published slot contracts and mixin adapters for
 * `@foldkit/ui`. Components still lay out their own markup through `toView`;
 * `resolve` merges attached Mixins into the component's attribute bundles.
 */
export * as Button from './button.js'
export * as Checkbox from './checkbox.js'
export * as Disclosure from './disclosure.js'
export * as Input from './input.js'

export { ButtonSlots } from './button.js'
export { CheckboxSlots } from './checkbox.js'
export { DisclosureSlots } from './disclosure.js'
export { InputSlots } from './input.js'

export { resolveFor as resolve } from './resolve.js'
export type { MixinList, ResolveContext, ResolvedSlots } from './resolve.js'
