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

Private while the API is settling (`0.0.0`). See [DESIGN.md](../mixins/DESIGN.md).
