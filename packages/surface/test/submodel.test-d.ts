import { Surface } from '../src/index.js'
import { counterView, Message, Panel } from './submodelFixture.js'

// A Surface renderer embeds a Foldkit Submodel via `h.submodel`. The builder is
// narrowed to Panel's Messages, so `toParentMessage` must lift the child's
// Messages into Panel's set.
export const panelView = Surface.view(Panel, (model, h) => {
  const _count: number = model.count
  return h.div(
    [],
    [
      h.submodel({
        slotId: 'counter',
        model: { count: model.count },
        view: counterView,
        toParentMessage: message =>
          message._tag === 'Incremented' ? Message.Incremented() : Message.Reset(),
      }),
    ],
  )
})

const _badLift = Surface.view(Panel, (model, h) =>
  h.submodel({
    slotId: 'counter',
    model: { count: model.count },
    view: counterView,
    // @ts-expect-error `ChangedLabel` is not declared on Panel
    toParentMessage: () => Message.ChangedLabel({ text: 'x' }),
  }),
)

void _badLift
