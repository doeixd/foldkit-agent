import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { defineView } from 'foldkit/submodel'
import { Projection, Surface } from '../src/index.js'

export const CounterModel = Schema.Struct({ count: Schema.Number })
export const CounterMessage = defineMessageUnion({ Incremented: {}, Reset: {} })

/** A plain Foldkit Submodel view, branded through `defineView`. */
export const counterView = defineView<
  Schema.Schema.Type<typeof CounterModel>,
  Schema.Schema.Type<typeof CounterMessage>
>((model, h) =>
  h.div([], [h.button([h.OnClick(CounterMessage.Incremented())], [String(model.count)])]),
)

export const Model = Schema.Struct({ counter: CounterModel, label: Schema.String })
export const Message = defineMessageUnion({
  Incremented: {},
  Reset: {},
  ChangedLabel: { text: Schema.String },
})
export const App = Surface.application({ Model, Message })

export const Panel = Surface.make(App, 'Panel', {
  model: ({ model }) => Projection.struct({ count: model.counter.count }),
  messages: [Message.Incremented, Message.Reset],
})
