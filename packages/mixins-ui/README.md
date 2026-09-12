# foldkit-mixins-ui

Published slot contracts and mixin adapters for [`@foldkit/ui`](https://www.npmjs.com/package/@foldkit/ui),
built on [`foldkit-mixins`](../mixins).

`@foldkit/ui` components do not own markup: they build typed attribute bundles
and hand them to a consumer `toView` callback. This package formalizes those
bundles as `Slots` contracts and resolves attached Style/Behavior Mixins around
them, so you can customize an official component without copying it.

```ts
import { Button as UiButton } from 'foldkit-mixins-ui'
import { Button } from '@foldkit/ui/button'

Button.view(
  {
    onClick: Saved(),
    toView: attributes => {
      const slots = UiButton.resolve(attributes, [SaveStyle.mixin], { input, h })
      return h.button(slots.button, ['Save'])
    },
  },
  h,
)
```

Base accessibility attributes, event Messages and any `ChildAttribute` are
preserved; Mixin contributions merge through the same deterministic resolver as
the core package. A Behavior cannot silently take over an event the component
already owns.

## Components

| Component | Slots |
| --- | --- |
| Button | `button` |
| Input | `input`, `label`, `description` |
| Textarea | `textarea`, `label`, `description` |
| Select | `select`, `label`, `description` |
| Checkbox | `checkbox`, `label`, `description`, `hiddenInput` |
| Switch | `button`, `label`, `description`, `hiddenInput` |
| Fieldset | `fieldset`, `legend`, `description` |
| Disclosure | `button`, `panel` |
| Dialog | `dialog`, `backdrop`, `panel`, `title`, `description`, `initialFocus`, `closeButton` |
| Popover | `button`, `panel`, `backdrop`, `arrow` |
| Tooltip | `trigger`, `panel` |
| Slider | `root`, `track`, `filledTrack`, `thumb`, `label`, `hiddenInput` |
| Tabs | `tablist`, `tab`, `panel` |
| RadioGroup | `group`, `option`, `label`, `description`, `hiddenInput` |
| Calendar | shared top-level groups plus `columnHeader`/`weekRow`/`dayCell`/`dayButton`/`monthCell`/`monthButton`/`yearCell`/`yearButton` |

Submodel components (Dialog, Popover, Tooltip, Slider, Tabs, RadioGroup, Calendar)
publish `ChildAttribute`s, which carry the child boundary's dispatcher; the
resolver preserves them by identity. The nested components apply one slot
contribution to every item while each item's base keeps its own event ownership.

## Limits

`Menu`, `Listbox`, `ComboBox` and `DatePicker` build their own element tree and
expose no attribute bundles, so there is nothing to resolve against; they are not
adapted.

Private while the API is settling (`0.0.0`). See [DESIGN.md](../mixins/DESIGN.md).
