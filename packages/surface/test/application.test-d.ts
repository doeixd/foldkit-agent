/**
 * `Surface.application` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from '../src/index.js'

const Model = Schema.Struct({ count: Schema.Number })
const Message = defineMessageUnion({ Incremented: {} })
const App = Surface.application({
  Model,
  Message,
  initial: { count: 0 },
  update: model => ({ model }),
})

const _initial: { readonly count: number } = App.initial
const _field = App.fields.count
const _value: number = Surface.pick(App.fields.count).get({ count: 1 }).count

// @ts-expect-error `missing` is not a Model field
App.fields.missing

Surface.application({
  Model,
  Message,
  // @ts-expect-error the initial Model must match the Model schema
  initial: { count: 'zero' },
  update: model => ({ model }),
})
