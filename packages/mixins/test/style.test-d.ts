/**
 * Compile-time Style contract. Type-checked, not executed.
 */
import { Style, Theme } from '../src/index.js'
import { FieldSlots } from './fixture.js'

const _ok = Style.forSlots(FieldSlots)({ root: Style.class('x') })
void _ok

// @ts-expect-error unknown slot key.
Style.forSlots(FieldSlots)({ missing: Style.class('x') })

// @ts-expect-error inline declarations are string-valued.
Style.inline({ width: 3 })

const IntentRecipe = Style.recipe({
  variants: { intent: { primary: Style.class('p'), secondary: Style.class('s') } },
})

IntentRecipe({ intent: 'primary' })
// @ts-expect-error unknown variant value.
IntentRecipe({ intent: 'ghost' })
// @ts-expect-error unknown variant key.
IntentRecipe({ size: 'sm' })

const Brand = Theme.define({ color: { text: '#000' } })
Theme.variable(Brand, 'color', 'text')
// @ts-expect-error unknown theme group.
Theme.variable(Brand, 'spacing', 'sm')
// @ts-expect-error unknown theme token.
Theme.variable(Brand, 'color', 'missing')
