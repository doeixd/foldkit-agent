/**
 * `Surface.application` inference contract. Type-checked but not executed.
 */
import { Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from '../src/index.js'

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
const _value: number = Projection.pick(App.fields.count).get({ count: 1 }).count

// References only: an agent-only application needs no `initial` or `update`.
const RefsOnly = Surface.application({ Model, Message })
const _refsOnlyKey: 'count' = RefsOnly.fields.count.key

// An update whose Commands need a resource is accepted.
declare const serviceEffect: Effect.Effect<Schema.Schema.Type<typeof Message>, never, 'Service'>
const _runnable = Surface.application({
  Model,
  Message,
  initial: { count: 0 },
  update: () => ({
    model: { count: 1 },
    commands: [{ name: 'Load', effect: serviceEffect }],
  }),
})

// @ts-expect-error `missing` is not a Model field
App.fields.missing

// @ts-expect-error the initial Model must match the Model schema
Surface.application({
  Model,
  Message,
  initial: { count: 'zero' },
  update: (model: { readonly count: number }) => ({ model }),
})
