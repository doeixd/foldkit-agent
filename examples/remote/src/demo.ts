/**
 * A worked Remote + Surface + Mixins trace. `ProjectPage` is a Surface that
 * selects a project out of the Remote store; a SurfaceView renders the
 * `RemoteData` through Style and Behavior. The demo runs the real path — plan,
 * prefetch, select, a stale-while-revalidate refresh, render, mutate,
 * retention, and a decode failure — against an in-process `RemoteClient`.
 */
import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Behavior, Capability, Slot, Slots, Style, type SlotAttributes } from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import {
  Entity,
  Mutation,
  Query,
  Remote,
  RemoteClient,
  RemoteData,
  RemotePolicy,
  Selection,
  entityKey,
  items,
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

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection(Project),
})

const Data = Remote.make({
  entities: [Project],
  mutations: [RenameProject],
  queries: [ProjectsByOwner],
})

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

const ProjectPage = Surface.make(App, 'ProjectPage', {
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
  query: () =>
    Effect.succeed({
      edges: [{ entity: 'Project', id: 'p1', key: 'Project:p1' }],
      start: { _tag: 'Terminal' as const },
      end: { _tag: 'Terminal' as const },
    }),
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
  const requirements = Remote.plan(AppRemote, initial, ProjectPage.projection({ projectId: 'p1' }))
  lines.push(
    `plan: ${requirements.map(entry => `${entry.entity}:${entry.id} [${entry.fields.join(',')}]`).join(', ')}`,
  )
  lines.push(`before fetch: ${describeData(projection.read(initial))}`)

  // The store stamps each write with the clock it is given, so the refresh
  // below can decide staleness without waiting.
  const store = await Effect.runPromise(
    Remote.prefetch(AppRemote, initial, projection, { now: () => 1_000 }).pipe(
      Effect.provide(FakeClient),
    ),
  )
  const loaded = withStore(initial, store)
  lines.push(`after fetch: ${describeData(projection.read(loaded))}`)

  // A refreshing policy keeps the value visible while it refetches: the
  // Subscription emits RefreshStarted (the projection reads Refreshing) and
  // then the read result (Ready again). `toMessage` is omitted, so the entry
  // emits `RemoteMessage`s that `Data.update` reduces directly.
  const refreshing = Remote.observe(AppRemote, ProjectPage, { projectId: 'p1' }, undefined, {
    policy: RemotePolicy.staleWhileRevalidate({ maxAge: 30_000 }),
    now: () => 60_000,
  })
  const refreshMessages = await Effect.runPromise(
    Stream.runCollect(refreshing.dependenciesToStream(refreshing.modelToDependencies(loaded))).pipe(
      Effect.provide(FakeClient),
    ),
  )
  const midRefresh = { ...loaded, remote: Data.update(loaded.remote, refreshMessages[0]!) }
  const refreshed = refreshMessages
    .slice(1)
    .reduce(
      (model, message) => ({ ...model, remote: Data.update(model.remote, message) }),
      midRefresh,
    )
  lines.push(
    `stale-while-revalidate: ${refreshMessages.map(message => message._tag).join(', ')}; ${describeData(projection.read(midRefresh))} -> ${describeData(projection.read(refreshed))}`,
  )

  // A query runs through RemoteClient and merges into a connection by ref identity.
  const ref = Query.first(25)(ProjectsByOwner.ref({ ownerId: 'u1' }))
  const page = await Effect.runPromise(Remote.query(ref).pipe(Effect.provide(FakeClient)))
  const queried = Data.update(loaded.remote, Remote.queryMessage(ref, page))
  lines.push(
    `query connection: ${items(queried.connections[ref.identity]!)
      .map(edge => edge.key)
      .join(', ')}`,
  )
  const inspection = Remote.inspect(queried)
  lines.push(
    `inspect: ${inspection.entities.length} entities, ${inspection.connections.length} connection, ${Data.registry.queries.size} registered queries`,
  )

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

  // Retention: the roots are what the active Surfaces reach. A project the page
  // does not select, and a connection nobody lists, are collected; the page's
  // project stays.
  const crowded = withStore(
    { ...renamed.model, remote: queried },
    writeEntity(renamed.model.remote.entities, entityKey('Project', 'p2'), { name: 'Borealis' }),
  )
  const retain = Remote.retain([ProjectPage.projection({ projectId: 'p1' })])
  const retention = await Effect.runPromise(
    Stream.runHead(retain.dependenciesToStream(retain.modelToDependencies(crowded))),
  )
  const collected = Data.update(crowded.remote, Option.getOrThrow(retention))
  const kept = Remote.inspect(collected)
  lines.push(
    `retained: ${kept.entities.map(entry => entry.key).join(', ')}; ${Remote.inspect(crowded.remote).entities.length - kept.entities.length} entity and ${Remote.inspect(crowded.remote).connections.length - kept.connections.length} connection collected`,
  )

  const corrupted = withStore(
    loaded,
    writeEntity(store, entityKey('Project', 'p1'), { status: 42 }),
  )
  lines.push(`corrupt store: ${describeData(projection.read(corrupted))}`)

  return lines
}
