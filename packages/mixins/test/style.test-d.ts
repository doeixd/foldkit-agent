/**
 * Compile-time Style contract. Type-checked, not executed.
 */
import { Style } from '../src/index.js'
import { FieldSlots } from './fixture.js'

const _ok = Style.forSlots(FieldSlots)({ root: Style.class('x') })
void _ok

// @ts-expect-error unknown slot key.
Style.forSlots(FieldSlots)({ missing: Style.class('x') })

// @ts-expect-error inline declarations are string-valued.
Style.inline({ width: 3 })
