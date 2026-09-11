/**
 * A worked Surface + Mixins example. `ProjectCard` is a Surface that projects
 * only the project fields it needs and exposes only two of the three Messages;
 * the SlotView styles and decorates it, and the resolved attributes are printed
 * so the demo reads as an end-to-end trace.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import {
  Behavior,
  Capability,
  Event,
  Slot,
  Slots,
  Style,
  type SlotAttributes,
} from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import { Projection, Surface } from 'foldkit-surface'

const Model = Schema.Struct({
  project: Schema.Struct({ name: Schema.String, archived: Schema.Boolean }),
  selection: Schema.NullOr(Schema.String),
  internalNotes: Schema.String,
})

const Message = defineMessageUnion({
  ArchiveProject: { name: Schema.String },
  SelectProject: { name: Schema.String },
  DeleteProject: {},
})

type ProjectedModel = {
  readonly project: { readonly name: string; readonly archived: boolean }
  readonly selection: string | null
}
type CardMessage = typeof Message.ArchiveProject.Type | typeof Message.SelectProject.Type
type AppMessage = typeof Message.Type

const App = Surface.make({ Model, Message })

/** Projects two fields and exposes two of the three Messages. */
const ProjectCard = Surface.define(App, 'ProjectCard', {
  model: ({ model }) => Projection.struct({ project: model.project, selection: model.selection }),
  messages: [Message.ArchiveProject, Message.SelectProject],
})

const ProjectCardSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  title: Slot.make({ capability: Capability.Container }),
  status: Slot.make({ capability: Capability.Container }),
  archive: Slot.make({ capability: Capability.Interactive, events: [Event.Click] }),
})

const ProjectCardStyle = Style.forSlots(ProjectCardSlots)(
  {
    root: Style.compose(
      Style.class('card'),
      Style.inline({ display: 'grid', gap: '0.5rem' }),
      Style.pseudo(':hover', { boxShadow: '0 1px 2px' }),
    ),
    title: Style.class('card-title'),
    status: Style.whenInput<ProjectedModel>(
      input => input.project.archived,
      Style.class('archived'),
    ),
  },
  { name: 'ProjectCardStyle' },
)

const ArchiveBehavior = Behavior.forSlots(ProjectCardSlots)<ProjectedModel, CardMessage>(
  {
    archive: Behavior.slot({
      requires: { events: [Event.Click] },
      attributes: ({ input, h }) => (input.project.archived ? [h.AriaDisabled(true)] : []),
    }),
  },
  { name: 'ArchiveBehavior' },
)

const tagOf = (attribute: SlotAttributes<CardMessage>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

const classTokens = (attributes: SlotAttributes<CardMessage>): ReadonlyArray<string> => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === 'Class') {
      return (attribute as { readonly value: string }).value.split(/\s+/)
    }
  }
  return []
}

const styleValue = (attributes: SlotAttributes<CardMessage>): unknown => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === 'Style') return (attribute as { readonly value: unknown }).value
  }
  return undefined
}

const attributeValue = (attributes: SlotAttributes<CardMessage>, tag: string): unknown => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === tag) return (attribute as { readonly value: unknown }).value
  }
  return undefined
}

export const runDemo = (): ReadonlyArray<string> => {
  const inspection = Surface.inspect(ProjectCard, undefined)
  const lines: string[] = [
    `surface: ${inspection.name}`,
    `observes: ${inspection.dependencies.map(path => path.join('.')).join(', ')}`,
  ]

  let seen: unknown
  const resolved: {
    root: SlotAttributes<CardMessage>
    status: SlotAttributes<CardMessage>
    archive: SlotAttributes<CardMessage>
  } = {
    root: [],
    status: [],
    archive: [],
  }

  const ProjectCardView = SurfaceView.define(ProjectCard, ProjectCardSlots, (model, slots, h) => {
    seen = model
    resolved.root = slots.root.attrs()
    resolved.status = slots.status.attrs()
    resolved.archive = slots.archive.attrs([
      h.OnClick(Message.ArchiveProject({ name: model.project.name })),
    ])
    return h.article(resolved.root, [
      h.h2(slots.title.attrs(), [model.project.name]),
      h.span(resolved.status, [model.project.archived ? 'archived' : 'active']),
      h.button(resolved.archive, ['Archive']),
    ])
  }).pipe(Style.attach(ProjectCardStyle), Behavior.attach(ArchiveBehavior))

  const viewInfo = SurfaceView.inspect(ProjectCardView)
  lines.push(
    `slots: ${Object.entries(viewInfo.slots)
      .map(([name, slot]) => `${name}(${slot.capability})`)
      .join(', ')}`,
  )
  lines.push(`mixins: ${viewInfo.mixins.join(', ')}`)

  const h = inertHtml as unknown as HtmlBuilder<AppMessage>
  const rootView = Surface.rootView(ProjectCard, undefined, SurfaceView.toRenderer(ProjectCardView))
  rootView(
    { project: { name: 'Apollo', archived: true }, selection: 'p1', internalNotes: 'hidden' },
    h,
  )

  lines.push(`projected: ${JSON.stringify(seen)}`)
  lines.push(`root classes: ${classTokens(resolved.root).join(' ')}`)
  lines.push(`root style: ${JSON.stringify(styleValue(resolved.root))}`)
  lines.push(`status classes: ${classTokens(resolved.status).join(' ')}`)
  lines.push(`archive aria-disabled: ${String(attributeValue(resolved.archive, 'AriaDisabled'))}`)
  lines.push(`stylesheet: ${Style.stylesheet(ProjectCardStyle)}`)

  const description = SurfaceView.describe(ProjectCard, undefined, ProjectCardView)
  lines.push(`description: ${JSON.stringify(description)}`)
  lines.push('')
  lines.push(...SurfaceView.toMarkdown(description).split('\n'))
  return lines
}
