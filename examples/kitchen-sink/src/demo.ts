/**
 * Runs the kitchen-sink stack end to end and returns an assertable transcript.
 *
 * The same `update` is driven by a server-derived read, a durable replicated
 * note, a human, and an agent; the four agent adapters project one contract.
 */
import { Effect, Fiber, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Agent } from 'foldkit-agent'
import { AgentA2a } from 'foldkit-agent-a2a'
import { AgentMcp } from 'foldkit-agent-mcp'
import { AgentNative } from 'foldkit-agent-native'
import { AgentWebMcp } from 'foldkit-agent-webmcp'
import type { ModelContext, RegisterToolOptions, ToolDescriptor } from 'foldkit-agent-webmcp'
import { Capability, Slot, Slots, Style, type SlotAttributes } from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import { Button, ButtonSlots } from 'foldkit-mixins-ui'
import { view as buttonView } from '@foldkit/ui/button'
import { Surface } from 'foldkit-surface'
import { Remote, RemoteData, Query, type EntityStore } from 'foldkit-remote'
import { layerFromPromise } from 'foldkit-sync'
import {
  App,
  AppRemote,
  BoardSurface,
  Message,
  ProjectSummary,
  ProjectsByOwner,
  RenameProject,
  KitchenSync,
  makeSyncServer,
  openReplica,
  serverClient,
  update,
} from './stack.js'
import { AppAgent, bindAgent } from './agent.js'

const describeData = (data: RemoteData<{ readonly name: string }>): string =>
  RemoteData.match(data, {
    Initial: () => 'Initial',
    Loading: () => 'Loading',
    Ready: value => `Ready ${value.name}`,
    Refreshing: value => `Refreshing ${value.name}`,
    Failed: error => `Failed ${error._tag}`,
    NotFound: () => 'NotFound',
  })

const withStore = (model: typeof App.initial, store: EntityStore): typeof App.initial => ({
  ...model,
  remote: { ...model.remote, entities: store },
})

/** Stands in for `document.modelContext` outside a browser. */
class RecordingModelContext implements ModelContext {
  readonly tools: Array<{ tool: ToolDescriptor; signal: AbortSignal | undefined }> = []
  registerTool = (tool: ToolDescriptor, options?: RegisterToolOptions): void => {
    this.tools.push({ tool, signal: options?.signal })
  }
  live(): ReadonlyArray<ToolDescriptor> {
    return this.tools.filter(entry => entry.signal?.aborted !== true).map(entry => entry.tool)
  }
  static tool(context: RecordingModelContext, name: string): ToolDescriptor {
    return context.live().find(tool => tool.name === name) as ToolDescriptor
  }
}

const BoardSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  name: Slot.make({ capability: Capability.Container }),
})

type Projected = {
  readonly project: RemoteData<{
    readonly id: string
    readonly name: string
    readonly status: string
    readonly owner: { readonly name: string }
  }>
  readonly notes: ReadonlyArray<{ readonly id: string; readonly body: string }>
  readonly selectedNoteId: string | null
}

const BoardStyle = Style.forSlots(BoardSlots)({
  root: Style.compose(Style.class('board'), Style.inline({ display: 'grid' })),
  name: Style.class('board-name'),
})

export const runDemo = async (): Promise<ReadonlyArray<string>> => {
  const lines: string[] = []
  const say = (line: string) => lines.push(line)

  // -------------------------------------------------------------------------
  // Server-derived state: Remote + remote-server + remote-drizzle
  // -------------------------------------------------------------------------
  const client = serverClient('u1')
  const projection = Remote.select(AppRemote, ProjectSummary)('p1')
  say(
    `plan: ${projection.requirements.map(r => `${r.entity}:${r.id} [${r.fields.join(',')}]`).join(', ')}`,
  )
  say(`before fetch: ${describeData(projection.read(App.initial))}`)

  const store = await Effect.runPromise(
    Remote.prefetch(AppRemote, App.initial, projection).pipe(Effect.provide(client)),
  )
  const loaded = withStore(App.initial, store)
  say(`after fetch (Drizzle SQLite): ${describeData(projection.read(loaded))}`)
  const fetched = projection.read(loaded)
  say(
    `nested selection (one read): owner ${fetched._tag === 'Ready' ? fetched.value.owner.name : fetched._tag}`,
  )

  const renamed = await Effect.runPromise(
    Remote.mutateInto(
      AppRemote,
      loaded,
      RenameProject,
      { id: 'p1', name: 'Apollo II' },
      'req-1',
    ).pipe(Effect.provide(client)),
  )
  say(
    `mutation: ${JSON.stringify(renamed.output)} -> ${describeData(projection.read(renamed.model))}`,
  )

  const ref = Query.first(25)(ProjectsByOwner.ref({ ownerId: 'u1' }))
  const page = await Effect.runPromise(Remote.query(ref).pipe(Effect.provide(client)))
  say(`query connection: ${page.edges.map(edge => edge.key).join(', ')}`)
  say(`inspect: ${Remote.inspect(renamed.model.remote).entities.length} entities cached`)

  // -------------------------------------------------------------------------
  // Client-owned replicated state: durable + sync
  // -------------------------------------------------------------------------
  const replicated = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeSyncServer({ actorId: 'owner', canWrite: true })
        const replica = yield* openReplica
        const settled = yield* replica.statusChanges.pipe(
          Stream.filter(status => status.cursor === 1),
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* Effect.forkScoped(
          replica.start.pipe(Effect.provide(layerFromPromise(server.transport))),
        )
        yield* replica.submit(Message.RequestedCreateNote({ id: 'n1', body: 'First note' }))
        yield* Fiber.join(settled)
        const shared = yield* replica.shared
        yield* replica.close
        return shared
      }),
    ),
  )
  say(`replicated (durable journal): ${replicated.notes.map(note => note.body).join(', ')}`)

  // -------------------------------------------------------------------------
  // The agent contract, driven by a human and by the agent
  // -------------------------------------------------------------------------
  let live = { ...renamed.model, notes: replicated.notes }
  const listeners = new Set<() => void>()
  const dispatch = (message: typeof Message.Type): void => {
    live = update(live, message).model
    for (const listener of listeners) listener()
  }
  const agent = bindAgent({
    definition: AppAgent,
    host: {
      model: () => live,
      dispatch,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      principal: () => ({ canWrite: true }),
    },
  })

  say(
    `capabilities: ${Agent.messages(AppAgent)
      .map(capability => capability.name)
      .join(', ')}`,
  )
  say(`agent context: ${JSON.stringify(await Effect.runPromise(agent.context))}`)
  await Effect.runPromise(
    agent.messages.dispatch(Message.RequestedCreateNote, { id: 'n2', body: 'From the agent' }),
  )
  say(`notes after agent: ${live.notes.map(note => note.body).join(', ')}`)

  // -------------------------------------------------------------------------
  // The same contract, through each adapter
  // -------------------------------------------------------------------------
  const modelContext = new RecordingModelContext()
  const registration = AgentWebMcp.register({ agent, modelContext })
  await registration.refresh()
  say(`webmcp tools: ${registration.registered().join(', ')}`)
  const toolResult = await RecordingModelContext.tool(
    modelContext,
    'requested_create_note',
  ).execute({ id: 'n3', body: 'From WebMCP' }, {})
  say(`webmcp call: ${toolResult.content[0]?.text}`)

  const mcp = AgentMcp.handler({ agent, onNotification: () => {} })
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  const mcpList = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
    readonly result?: { readonly tools: ReadonlyArray<{ readonly name: string }> }
  }
  say(`mcp tools: ${(mcpList.result?.tools ?? []).map(tool => tool.name).join(', ')}`)

  const card = AgentA2a.agentCard(AppAgent, {
    name: 'Kitchen Sink',
    description: 'A project board',
    url: 'https://example/a2a',
  })
  say(`a2a card: ${card.name} (${card.skills.length} skills)`)
  const a2a = AgentA2a.handler({ agent })
  await a2a.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'm-1',
        parts: [
          {
            kind: 'data',
            data: { skill: 'requested_create_note', input: { id: 'n4', body: 'From A2A' } },
          },
        ],
      },
    },
  })
  say(`notes after A2A: ${live.notes.map(note => note.body).join(', ')}`)

  const native = AgentNative.actions({ definition: AppAgent, resolveRuntime: () => agent })
  say(`native actions: ${Object.keys(native).join(', ')}`)

  // -------------------------------------------------------------------------
  // The view: mixins + mixins-surface over the Surface projection
  // -------------------------------------------------------------------------
  let rendered: SlotAttributes<typeof Message.Type> | undefined
  const BoardView = SurfaceView.define(BoardSurface, BoardSlots, (model, slots, h) => {
    rendered = slots.root.attrs()
    return h.article(slots.root.attrs(), [h.h2(slots.name.attrs(), [describeData(model.project)])])
  }).pipe(Style.attach(BoardStyle))
  const h = inertHtml as unknown as HtmlBuilder<typeof Message.Type>
  Surface.rootView(BoardSurface, undefined, SurfaceView.toRenderer(BoardView))(live, h)
  const classes = (() => {
    for (const attribute of rendered ?? []) {
      if (typeof attribute === 'object' && attribute !== null && '_tag' in attribute) {
        if ((attribute as { readonly _tag: string })._tag === 'Class') {
          return (attribute as { readonly value: string }).value
        }
      }
    }
    return ''
  })()
  say(`rendered classes: ${classes}`)

  // A `@foldkit/ui` component customised through `foldkit-mixins-ui`: the
  // component hands its attribute bundle to `toView`, and `Button.resolve`
  // merges the attached Mixins around it without disturbing the base bundle.
  const SaveStyle = Style.forSlots(ButtonSlots)({ button: Style.class('save') })
  let buttonClasses = ''
  buttonView<typeof Message.Type>(
    {
      onClick: Message.SelectedNote({ id: 'n1' }),
      toView: attributes => {
        const slots = Button.resolve(attributes, [SaveStyle.mixin], {
          input: undefined,
          h,
        })
        for (const attribute of slots.button as ReadonlyArray<unknown>) {
          if (typeof attribute === 'object' && attribute !== null && '_tag' in attribute) {
            if ((attribute as { readonly _tag: string })._tag === 'Class') {
              buttonClasses = (attribute as unknown as { readonly value: string }).value
            }
          }
        }
        return h.button(slots.button, ['Rename'])
      },
    },
    h,
  )
  say(`mixins-ui button classes: ${buttonClasses || '(none)'}`)

  registration.unregister()
  return lines
}
