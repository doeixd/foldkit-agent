/**
 * A transcript of the whole contract, runnable with no browser and no network.
 *
 * Returning lines rather than printing them keeps the demo assertable, so it
 * cannot quietly stop demonstrating what it claims to.
 */
import { Effect } from 'effect'
import { Agent } from 'foldkit-agent'
import { AgentWebMcp } from 'foldkit-agent-webmcp'
import type { ModelContext, RegisterToolOptions, ToolDescriptor } from 'foldkit-agent-webmcp'
import { Message, counts, replay, visibleTodos } from './app.js'
import { AppAgent, type Principal, bindAgent } from './agent.js'
import { makeStore } from './store.js'

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

export const runDemo = async (): Promise<ReadonlyArray<string>> => {
  const log: Array<string> = []
  const say = (line: string) => log.push(line)

  const store = makeStore()
  const principal: Principal = { actorId: 'demo' }

  const agent = bindAgent({
    definition: AppAgent,
    host: { ...store.host, principal: () => principal },
  })

  // 1. The contract is data, readable without an LLM.
  say('# capabilities')
  for (const capability of Agent.messages(AppAgent)) {
    say(`${capability.name} <- ${capability.tag}: ${capability.description}`)
  }

  // 2. A human uses the app.
  say('')
  say('# the human adds two todos')
  store.dispatch(Message.SubmittedTodo({ id: 't1', title: 'Write the proposal' }))
  store.dispatch(Message.SubmittedTodo({ id: 't2', title: 'Ship the adapter' }))
  say(
    `todos: ${store
      .model()
      .todos.map(todo => todo.title)
      .join(', ')}`,
  )

  // 3. The agent sees the same state through a projection of the same Model.
  say('')
  say('# the agent sees the same state')
  say(`context: ${JSON.stringify(await Effect.runPromise(agent.context))}`)

  // 4. The agent drives the same transitions, by Message reference.
  say('')
  say('# the agent writes through the same update')
  const created = await Effect.runPromise(
    agent.messages.dispatch(Message.SubmittedTodo, { title: 'Record the demo' }),
  )
  say(`dispatched ${created.tag} as "${created.name}" over ${created.invocation.transport}`)

  await Effect.runPromise(agent.messages.dispatch(Message.ToggledTodo, { id: 't1' }))
  say(`counts: ${JSON.stringify(counts(store.model()))}`)
  say(
    `visible when filtering "active": ${visibleTodos({ ...store.model(), filter: 'active' }).length}`,
  )

  await Effect.runPromise(agent.messages.dispatch(Message.ClearedCompleted, {}))
  say(
    `after clear-completed: ${
      store
        .model()
        .todos.map(todo => todo.title)
        .join(', ') || '(none)'
    }`,
  )

  // 5. The same contract, reached the way a browser agent reaches it.
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
  say(
    `todos now: ${store
      .model()
      .todos.map(todo => todo.title)
      .join(', ')}`,
  )

  // 6. Untrusted input is refused before it reaches `update`.
  say('')
  say('# untrusted input')
  const invalid = await modelContext.tool('add_todo').execute({ title: 42 }, {})
  say(`tool result: ${invalid.content[0]?.text}`)

  // 7. Replay is pure over the shared slice, and refuses local Messages.
  say('')
  say('# replay stays inside the shared slice')
  say(
    `replayed: ${JSON.stringify(
      replay({ todos: [] }, Message.SubmittedTodo({ id: 'r1', title: 'Replay me' })),
    )}`,
  )
  try {
    replay(store.model(), Message.FilterSelected({ filter: 'active' }))
    say('unexpectedly replayed a local-only Message')
  } catch (error) {
    say(`refused: ${(error as Error).message}`)
  }

  registration.unregister()
  return log
}
