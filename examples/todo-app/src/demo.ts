/**
 * A transcript of the whole contract, runnable with no browser and no network.
 *
 * Returning lines rather than printing them keeps the demo assertable: the test
 * pins the lines that matter, so the demo cannot quietly stop demonstrating
 * what it claims to. Read it as a tour; every section names the file it
 * exercises.
 */
import { Effect } from 'effect'
import { Agent } from 'foldkit-agent'
import { AgentWebMcp } from 'foldkit-agent-webmcp'
import type { ModelContext, RegisterToolOptions, ToolDescriptor } from 'foldkit-agent-webmcp'
import { A11y, Capability, Event } from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import { Surface } from 'foldkit-surface'
import { replicaId, type Storage } from 'foldkit-sync'
import { AppAgent, bindAgent } from './agent.js'
import { Message, counts, visibleTodos } from './app.js'
import { openJournal } from './journal.js'
import { toMarkdown, validate } from './module.js'
import type { Principal, SyncPrincipal } from './principal.js'
import { makeStore } from './store.js'
import { FilterSlots, ItemSlots, stylesheet } from './style.js'
import { Board } from './surface.js'
import { Sync } from './sync.js'
import { BoardView } from './view.js'

/** Stands in for `document.modelContext` outside a browser. */
class RecordingModelContext implements ModelContext {
  readonly tools: Array<{ tool: ToolDescriptor; signal: AbortSignal | undefined }> = []

  registerTool = (tool: ToolDescriptor, options?: RegisterToolOptions): void => {
    this.tools.push({ tool, signal: options?.signal })
  }

  live(): ReadonlyArray<ToolDescriptor> {
    return this.tools.filter(entry => entry.signal?.aborted !== true).map(entry => entry.tool)
  }

  tool(name: string): ToolDescriptor {
    const found = this.live().find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`No tool named ${name} is registered`)
    return found
  }
}

/** An in-memory `Storage`, so a replica can open without IndexedDB. */
const memoryStorage = (): Storage => {
  let state: unknown
  return {
    load: () => Effect.sync(() => state),
    save: next =>
      Effect.sync(() => {
        state = structuredClone(next)
      }),
    close: Effect.void,
  }
}

const titles = (todos: ReadonlyArray<{ readonly title: string }>) =>
  todos.map(todo => todo.title).join(', ') || '(none)'

export const runDemo = async (): Promise<ReadonlyArray<string>> => {
  const log: Array<string> = []
  const say = (line: string) => log.push(line)

  const store = makeStore()
  const owner: Principal = { actorId: 'owner' }
  const agent = bindAgent({ definition: AppAgent, host: { ...store.host, principal: () => owner } })

  // 1. agent.ts — the contract is data, readable without an LLM.
  say('# capabilities (agent.ts)')
  for (const capability of Agent.messages(AppAgent)) {
    say(`${capability.name} <- ${capability.tag}: ${capability.description}`)
  }

  // 2. app.ts — a human uses the app. `RequestedTodo` is an intent; its
  //    Command mints the id and the timestamp and emits the durable fact.
  say('')
  say('# the human adds two todos (app.ts)')
  await store.dispatch(Message.RequestedTodo({ title: 'Write the proposal' }))
  await store.dispatch(Message.RequestedTodo({ title: 'Ship the adapter' }))
  say(`todos: ${titles(store.model().todos)}`)
  say(`draft after submit: ${JSON.stringify(store.model().draft)}`)

  // 3. surface.ts — the agent sees the Overview Surface, a projection of the
  //    same Model the view renders; no composer or editor state leaks.
  say('')
  say('# the agent sees the Overview surface (surface.ts)')
  say(`context: ${JSON.stringify(await Effect.runPromise(agent.context))}`)

  // 4. The agent drives the same transitions, by Message reference, and
  //    `add_todo` waits for its fact through the completion contract.
  say('')
  say('# the agent writes through the same update, and waits for the fact')
  const created = await Effect.runPromise(
    agent.messages.dispatch(Message.RequestedTodo, { title: 'Record the demo' }),
  )
  say(`dispatched ${created.tag} as "${created.name}" over ${created.invocation.transport}`)
  say(
    `completion: ${created.completion?.status} ${
      created.completion?.message === undefined
        ? ''
        : (created.completion.message as { readonly _tag: string })._tag
    }`,
  )
  const [first] = store.model().todos
  await Effect.runPromise(agent.messages.dispatch(Message.ToggledTodo, { id: first!.id }))
  await Effect.runPromise(
    agent.messages.dispatch(Message.PrioritySet, { id: first!.id, priority: 'high' }),
  )
  say(`counts: ${JSON.stringify(counts(store.model()))}`)
  say(
    `visible when filtering "active": ${visibleTodos({ ...store.model(), filter: 'active' }).length}`,
  )
  say(`highest priority first: ${titles(visibleTodos(store.model()))}`)

  // 5. principal.ts — the same rule on both boundaries. The agent refuses a
  //    guest early with a typed error; the journal would refuse it late.
  say('')
  say('# authorization on the agent boundary (principal.ts)')
  const guestAgent = bindAgent({
    definition: AppAgent,
    host: { ...store.host, principal: () => ({ actorId: 'guest' }) },
  })
  const refused = await Effect.runPromise(
    Effect.result(guestAgent.messages.dispatch(Message.ClearedCompleted, {})),
  )
  say(`guest clear_completed: ${refused._tag === 'Failure' ? refused.failure._tag : 'allowed'}`)
  await Effect.runPromise(agent.messages.dispatch(Message.ClearedCompleted, {}))
  say(`owner clear_completed: ${titles(store.model().todos)}`)

  // 6. The same contract, reached the way a browser agent reaches it.
  say('')
  say('# through WebMCP')
  const modelContext = new RecordingModelContext()
  const registration = AgentWebMcp.register({ agent, modelContext })
  await registration.refresh()
  say(`registered tools: ${registration.registered().join(', ')}`)
  const addTodo = modelContext.tool('add_todo')
  say(`add_todo inputSchema: ${JSON.stringify(addTodo.inputSchema)}`)
  const result = await addTodo.execute({ title: 'From the browser agent' }, {})
  say(`tool result: ${result.content[0]?.text}`)
  say(`todos now: ${titles(store.model().todos)}`)

  // 7. Untrusted input is refused before it reaches `update`.
  say('')
  say('# untrusted input')
  const invalid = await modelContext.tool('add_todo').execute({ title: 42 }, {})
  say(`tool result: ${invalid.content[0]?.text}`)
  registration.unregister()

  // 8. sync.ts — the replica refuses what it cannot replicate.
  say('')
  say('# the replica refuses a local Message (sync.ts)')
  const replica = await Effect.runPromise(Sync.openReplica(replicaId('demo'), memoryStorage()))
  const local = await Effect.runPromise(
    Effect.result(replica.submit(Message.FilterSelected({ filter: 'active' }))),
  )
  say(`submit FilterSelected: ${local._tag === 'Failure' ? local.failure._tag : 'accepted'}`)
  await Effect.runPromise(replica.submit(Message.RenamedList({ title: 'Groceries' })))
  say(`shared after RenamedList: ${JSON.stringify(Effect.runSync(replica.shared))}`)
  await Effect.runPromise(replica.close)

  // 9. journal.ts — the contract's `authorize` runs in the server's append.
  say('')
  say('# authorization on the journal boundary (journal.ts)')
  const journal = openJournal(':memory:')
  const guest: SyncPrincipal = { actorId: 'guest', documentId: 'todos', canWrite: true }
  const server: SyncPrincipal = { actorId: 'owner', documentId: 'todos', canWrite: true }
  try {
    journal.appendAsServer(Message.RenamedList({ title: 'Team' }), guest, 'guest-agent')
    say('guest RenamedList: committed')
  } catch (error) {
    say(`guest RenamedList: ${(error as Error).message}`)
  }
  journal.appendAsServer(Message.RenamedList({ title: 'Team' }), server, 'server-agent')
  say(`owner RenamedList: ${journal.snapshot('todos').model.listTitle}`)
  journal.close()

  // 10. module.ts — the architecture as data: who owns what, and no conflicts.
  say('')
  say('# the application as a Module (module.ts)')
  say(`findings: ${validate().length === 0 ? 'none' : JSON.stringify(validate())}`)
  for (const line of toMarkdown().split('\n').slice(0, 11)) say(line)

  // 11. style.ts / view.ts — appearance and interaction attached from outside.
  say('')
  say('# slots, styles, and behaviors (style.ts, view.ts)')
  const board = SurfaceView.inspect(BoardView)
  say(
    `Board surface observes: ${Surface.inspect(Board, undefined)
      .dependencies.map(path => path.join('.'))
      .join(', ')}`,
  )
  say(`Board mixins: ${board.mixins.join(', ')}`)
  const accessibility = A11y.validate(
    A11y.pattern({
      button: { capability: Capability.Interactive, events: [Event.Click] },
    }),
    FilterSlots,
  )
  say(
    `filter a11y: ${accessibility.length === 0 ? 'ok' : accessibility.map(d => d.code).join(', ')}`,
  )
  const editor = A11y.validate(
    A11y.pattern({ editor: { capability: Capability.TextInput, events: [Event.KeyDown] } }),
    ItemSlots,
  )
  say(`editor a11y: ${editor.length === 0 ? 'ok' : editor.map(d => d.code).join(', ')}`)
  say(
    `stylesheet: ${stylesheet.length} bytes, ${(stylesheet.match(/\.style-/g) ?? []).length} rule classes`,
  )

  return log
}
