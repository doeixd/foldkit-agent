/**
 * `foldkit-mixins-ui` — published slot contracts and mixin adapters for
 * `@foldkit/ui`. Components still lay out their own markup through `toView`;
 * `resolve` merges attached Mixins into the component's attribute bundles.
 */
export * as Button from './button.js'
export * as Checkbox from './checkbox.js'
export * as Dialog from './dialog.js'
export * as Disclosure from './disclosure.js'
export * as Fieldset from './fieldset.js'
export * as Input from './input.js'
export * as Popover from './popover.js'
export * as Switch from './switch.js'
export * as Textarea from './textarea.js'
export * as Tooltip from './tooltip.js'

export { ButtonSlots } from './button.js'
export { CheckboxSlots } from './checkbox.js'
export { DialogSlots } from './dialog.js'
export { DisclosureSlots } from './disclosure.js'
export { FieldsetSlots } from './fieldset.js'
export { InputSlots } from './input.js'
export { PopoverSlots } from './popover.js'
export { SwitchSlots } from './switch.js'
export { TextareaSlots } from './textarea.js'
export { TooltipSlots } from './tooltip.js'

export { resolveFor as resolve } from './resolve.js'
export type { MixinList, ResolveContext, ResolvedSlots } from './resolve.js'
