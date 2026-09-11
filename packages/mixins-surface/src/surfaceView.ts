/**
 * Binds a Surface's projected Model and Message subset to a SlotView.
 *
 * The renderer's input is the Surface's projected Model, so Style and Behavior
 * contributions can only read what the Surface projects. Its builder is typed
 * with the Surface's Message subset, so a Behavior cannot emit a Message the
 * Surface does not expose. The returned value is an ordinary `SlotView`, so the
 * core attach/pipe algebra applies unchanged.
 */
import type { HtmlBuilder } from 'foldkit/html'
import { Surface, type Requirement, type Renderer } from 'foldkit-surface'
import { Slots, SlotView, type SlotViewRender } from 'foldkit-mixins'

export const define = <Root, Model, Message, Params, Slots_>(
  surface: Surface<Root, Model, Message, Params>,
  slots: Slots_,
  render: SlotViewRender<Slots_, Model, Message>,
  options?: { readonly name?: string },
): SlotView.SlotView<Slots_, Model, Message> =>
  SlotView.define<Slots_, Model, Message>(slots, render, {
    name: options?.name ?? surface.name,
  })

/**
 * Adapts a SlotView to a Surface renderer. `Surface.view` hands a renderer a
 * `ViewBuilder` — the real builder with its `MessageUniverse` phantom removed —
 * and this is the matching boundary cast, sound because the renderer only
 * constructs the Surface's Message subset.
 */
export const toRenderer =
  <Slots_, Model, Message>(
    view: SlotView.SlotView<Slots_, Model, Message>,
  ): Renderer<Model, Message> =>
  (model, h) =>
    view(model, h as unknown as HtmlBuilder<Message>)

export interface SurfaceViewInspection {
  /** The SlotView's name, defaulted from the Surface's name. */
  readonly name: string
  readonly slots: ReturnType<typeof Slots.describe>['slots']
  readonly mixins: ReadonlyArray<string>
}

/**
 * Serializable metadata for DevTools and docs: the published slots and the
 * names of the attached Mixins, with no functions. It composes with
 * `Surface.inspect`, which reports what the Surface observes and emits.
 */
export const inspect = <Slots_, Model, Message>(
  view: SlotView.SlotView<Slots_, Model, Message>,
): SurfaceViewInspection => ({
  name: view.name ?? '',
  slots: Slots.describe(view.slots as unknown as Parameters<typeof Slots.describe>[0]).slots,
  mixins: view.mixins.map(mixin => mixin.name),
})

/** Reads the tag off a Foldkit Message constructor without constructing one. */
const constructorTag = (constructor: unknown): string => {
  const literal = (constructor as { fields?: { _tag?: { ast?: { literal?: unknown } } } }).fields
    ?._tag?.ast?.literal
  if (typeof literal === 'string') return literal
  const name = (constructor as { readonly name?: unknown }).name
  return typeof name === 'string' ? name : 'unknown'
}

export interface SurfaceViewDescription {
  readonly name: string
  readonly observes: ReturnType<typeof Surface.inspect>['dependencies']
  readonly requirements: ReadonlyArray<Requirement>
  /** Emitted Message tags, not constructors, so the value stays serializable. */
  readonly emits: ReadonlyArray<string>
  readonly slots: ReturnType<typeof Slots.describe>['slots']
  readonly mixins: ReadonlyArray<string>
}

/**
 * One serializable description of a Surface and the SlotView that renders it:
 * what it observes and may emit, and where Style/Behavior attach. No functions,
 * so it can be committed, diffed, or handed to DevTools and agent tooling.
 */
export const describe = <Root, Model, Message, Params, Slots_>(
  surface: Surface<Root, Model, Message, Params>,
  params: Params,
  view: SlotView.SlotView<Slots_, Model, Message>,
): SurfaceViewDescription => {
  const inspection = Surface.inspect(surface, params)
  const ui = inspect(view)
  return {
    name: ui.name === '' ? inspection.name : ui.name,
    observes: inspection.dependencies,
    requirements: inspection.requirements,
    emits: inspection.emits.map(constructorTag),
    slots: ui.slots,
    mixins: ui.mixins,
  }
}

/** Deterministic Markdown for a description; stable key order, no timestamps. */
export const toMarkdown = (description: SurfaceViewDescription): string => {
  const lines: string[] = [`# ${description.name}`, '', '## Observes', '']
  for (const path of description.observes) lines.push(`- \`${path.join('.')}\``)
  lines.push('', '## May emit', '')
  for (const tag of description.emits) lines.push(`- \`${tag}\``)
  lines.push('', '## Slots', '')
  for (const [name, slot] of Object.entries(description.slots)) {
    const events = slot.events.length === 0 ? '' : ` (events: ${slot.events.join(', ')})`
    lines.push(`- \`${name}\` — ${slot.capability}${events}`)
  }
  lines.push('', '## Mixins', '')
  for (const name of description.mixins) lines.push(`- \`${name}\``)
  return lines.join('\n')
}
