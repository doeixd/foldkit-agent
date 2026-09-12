/**
 * A worked Remote + Surface + Mixins trace. `ProjectPage` is a Surface that
 * selects a project out of the Remote store; a SurfaceView renders the
 * `RemoteData` through Style and Behavior. The demo runs the real path — plan,
 * prefetch, select, render, mutate, and a decode failure — against an
 * in-process `RemoteClient`.
 */
import { Effect, Layer, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Behavior, Capability, Slot, Slots, Style, type SlotAttributes } from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import {
  Entity,
  Mutation,
  Remote,
  RemoteClient,
  RemoteData,
  Selection,
  entityKey,
  writeEntity,
  type EntityStore,
} from 'foldkit-remote'
import { Projection, Surface } from 'foldkit-surface'

const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String }),
)

const ProjectSummary = Selection.make(Project, { id: true, name: true, status: true })

const RenameProject = Mutation.make('RenameProject', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

const Data = Remote.make({ entities: [Project], mutations: [RenameProject] })

const Model = Schema.Struct({ remote: Data.Model, projectId: Schema.String })
const Message = defineMessageUnion({ Ping: {}, GotRemote: { message: Data.Message } })

const App = Surface.application({
  Model,
  Message,
  initial: { remote: Data.initial, projectId: 'p1' },
  update: (model, message) => {
    switch (message._tag) {
      case 'Ping':
        return { model }
      case 'GotRemote':
        return { model: { ...model, remote: Data.update(model.remote, message.message) } }
    }
  },
})

const AppRemote = Remote.at(Data, App.model.remote)

const ProjectPage = Surface.define(App, 'ProjectPage', {
  Params: Schema.Struct({ projectId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({ project: Remote.select(AppRemote, ProjectSummary)(params.projectId) }),
  messages: [Message.Ping],
})

type ProjectValue = { readonly id: string; readonly name: string; readonly status: string }
type Projected = { readonly project: RemoteData<ProjectValue> }
type PageMessage = typeof Message.Ping.Type

const ProjectSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  name: Slot.make({ capability: Capability.Container }),
  status: Slot.make({ capability: Capability.Container }),
})

const ProjectStyle = Style.forSlots(ProjectSlots)(
  {
    root: Style.compose(
      Style.class('project-card'),
      Style.inline({ display: 'grid', gap: '0.25rem' }),
    ),
    status: Style.whenInput<Projected>(
      input => input.project._tag === 'Ready' && input.project.value.status === 'archived',
      Style.class('project-card-archived'),
    ),
  },
  { name: 'ProjectStyle' },
)

const StatusBehavior = Behavior.forSlots(ProjectSlots)<Projected, PageMessage>(
  {
    status: Behavior.slot({
      attributes: ({ input, h }) =>
        input.project._tag === 'Ready'
          ? [h.DataAttribute('status', input.project.value.status)]
          : [],
    }),
  },
  { name: 'StatusBehavior' },
)

const describeData = (data: RemoteData<ProjectValue>): string =>
  RemoteData.match(data, {
    Initial: () => 'Initial',
    Loading: () => 'Loading',
    Ready: value => `Ready ${JSON.stringify(value)}`,
    Refreshing: value => `Refreshing ${JSON.stringify(value)}`,
    Failed: error => `Failed ${error._tag}`,
    NotFound: () => 'NotFound',
  })

const statusText = (data: RemoteData<ProjectValue>): string =>
  RemoteData.match(data, {
    Initial: () => '...',
    Loading: () => '...',
    Ready: value => value.status,
    Refreshing: value => value.status,
    Failed: () => 'error',
    NotFound: () => 'missing',
  })

const tagOf = (attribute: SlotAttributes<PageMessage>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

const classTokens = (attributes: SlotAttributes<PageMessage>): ReadonlyArray<string> => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === 'Class') {
      return (attribute as { readonly value: string }).value.split(/\s+/)
    }
  }
  return []
}

const dataAttribute = (attributes: SlotAttributes<PageMessage>, key: string): unknown => {
  for (const attribute of attributes) {
    if (
      tagOf(attribute) === 'DataAttribute' &&
      (attribute as { readonly key?: string }).key === key
    ) {
      return (attribute as { readonly value?: unknown }).value
    }
  }
  return undefined
}

const withStore = (model: typeof App.initial, store: EntityStore): typeof App.initial => ({
  ...model,
  remote: { ...model.remote, entities: store },
})

/** An in-process `RemoteClient`; no server, but the whole path is the real one. */
const FakeClient = Layer.succeed(RemoteClient, {
  read: batch =>
    Effect.sync(() => ({
      entities: batch.requests.map(request => ({
        entity: request.entity,
        id: request.id,
        values: { id: request.id, name: 'Apollo', status: 'active' },
      })),
    })),
  query: () => Effect.die('unused'),
  mutate: request =>
    Effect.sync(() => {
      const input = request.input as { readonly id: string; readonly name: string }
      return {
        output: { id: input.id },
        entities: [{ entity: 'Project', id: input.id, values: { name: input.name } }],
      }
    }),
  live: () => Stream.empty,
})

export const runDemo = async (): Promise<ReadonlyArray<string>> => {
  const lines: string[] = ['surface: ProjectPage']

  const initial = App.initial
  const projection = Remote.select(AppRemote, ProjectSummary)('p1')
  const requirements = Remote.planSurface(AppRemote, initial, ProjectPage, { projectId: 'p1' })
  lines.push(
    `plan: ${requirements.map(entry => `${entry.entity}:${entry.id} [${entry.fields.join(',')}]`).join(', ')}`,
  )
  lines.push(`before fetch: ${describeData(projection.read(initial))}`)

  const store = await Effect.runPromise(
    Remote.prefetch(AppRemote, initial, projection).pipe(Effect.provide(FakeClient)),
  )
  const loaded = withStore(initial, store)
  lines.push(`after fetch: ${describeData(projection.read(loaded))}`)

  let resolved:
    | {
        readonly root: SlotAttributes<PageMessage>
        readonly name: SlotAttributes<PageMessage>
        readonly status: SlotAttributes<PageMessage>
      }
    | undefined
  const ProjectView = SurfaceView.define(ProjectPage, ProjectSlots, (model, slots, h) => {
    resolved = {
      root: slots.root.attrs(),
      name: slots.name.attrs(),
      status: slots.status.attrs(),
    }
    return h.article(resolved.root, [
      h.h2(resolved.name, [describeData(model.project)]),
      h.span(resolved.status, [statusText(model.project)]),
    ])
  }).pipe(Style.attach(ProjectStyle), Behavior.attach(StatusBehavior))

  const h = inertHtml as unknown as HtmlBuilder<typeof Message.Type>
  const rootView = Surface.rootView(
    ProjectPage,
    { projectId: 'p1' },
    SurfaceView.toRenderer(ProjectView),
  )
  rootView(loaded, h)
  const view = resolved!
  lines.push(`rendered classes: ${classTokens(view.root).join(' ')}`)
  lines.push(`rendered status: ${String(dataAttribute(view.status, 'status'))}`)

  const renamed = await Effect.runPromise(
    Remote.mutateInto(
      AppRemote,
      loaded,
      RenameProject,
      { id: 'p1', name: 'Apollo II' },
      'req-1',
    ).pipe(Effect.provide(FakeClient)),
  )
  lines.push(`mutation RenameProject: output ${JSON.stringify(renamed.output)}`)
  lines.push(`after mutation: ${describeData(projection.read(renamed.model))}`)

  const corrupted = withStore(
    loaded,
    writeEntity(store, entityKey('Project', 'p1'), { status: 42 }),
  )
  lines.push(`corrupt store: ${describeData(projection.read(corrupted))}`)

  return lines
}
