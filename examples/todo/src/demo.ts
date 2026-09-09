import { Agent } from '@foldkit/agent'
import { AgentWebMcp } from '@foldkit/agent-webmcp'
import type { ModelContext, ToolDescriptor } from '@foldkit/agent-webmcp'
import { Effect, Option } from 'effect'
import { AppAgent, type Principal, bindAgent } from './agent.js'
import { Message, resetIds } from './app.js'
import { makeStore } from './store.js'

/** Stands in for `document.modelContext` outside a browser. */
class RecordingModelContext implements ModelContext {
  readonly tools: Array<ToolDescriptor> = []

  registerTool = (tool: ToolDescriptor): void => {
    this.tools.push(tool)
  }

  live(): ReadonlyArray<ToolDescriptor> {
    return this.tools.filter(tool => tool.signal?.aborted !== true)
  }

  tool(name: string): ToolDescriptor {
    const found = this.live().find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`No tool named ${name} is registered`)
    return found
  }
}

/**
 * Walks the whole contract and returns a transcript.
 *
 * Returning lines rather than printing them keeps the demo assertable, so it
 * cannot quietly stop demonstrating what it claims to.
 */
export const runDemo = async (): Promise<ReadonlyArray<string>> => {
  const log: Array<string> = []
  const say = (line: string) => log.push(line)

  resetIds()
  const store = makeStore()
  let principal: Principal = { canDelete: true }

  const agent = bindAgent({
    definition: AppAgent,
    host: { ...store.host, principal: () => principal },
  })

  // 1. The contract is data, and can be read without an LLM.
  say('# capabilities')
  for (const capability of Agent.messages(AppAgent)) {
    say(`${capability.name} <- ${capability.tag}: ${capability.description}`)
  }

  // 2. A human uses the app. The agent sees the result through its projection.
  say('')
  say('# the human adds a todo')
  store.dispatch(Message.RequestedCreateTodo({ title: 'Write the proposal' }))
  say(`context: ${JSON.stringify(await Effect.runPromise(agent.context))}`)

  // 3. The agent originates the same kind of transition, by Message reference.
  say('')
  say('# the agent adds one too')
  const created = await Effect.runPromise(
    agent.messages.dispatch(Message.RequestedCreateTodo, { title: 'Ship the adapter' }),
  )
  say(`dispatched ${created.tag} as "${created.name}" over ${created.invocation.transport}`)
  say(`todos: ${store.model().todos.map(todo => todo.title).join(', ')}`)

  // 4. Availability follows the Model.
  say('')
  say('# availability follows the Model')
  const names = async () =>
    (await Effect.runPromise(agent.messages.available)).map(capability => capability.name).join(', ')
  say(`no selection: ${await names()}`)
  await Effect.runPromise(agent.messages.dispatch(Message.SelectedTodo, { id: 'todo-1' }))
  say(`selected todo-1: ${await names()}`)

  // 5. Availability is not authorization.
  say('')
  say('# authorization is a separate question')
  principal = { canDelete: false }
  const denied = await Effect.runPromise(
    Effect.result(agent.messages.dispatch(Message.RequestedDeleteTodo, { id: 'todo-1' })),
  )
  say(denied._tag === 'Failure' ? `refused: ${denied.failure.message}` : 'unexpectedly allowed')
  say(`todos still: ${store.model().todos.length}`)

  // 6. The same contract, reached the way a browser agent would reach it.
  say('')
  say('# through WebMCP')
  principal = { canDelete: true }
  const modelContext = new RecordingModelContext()
  const registration = AgentWebMcp.register({ agent, modelContext })
  await registration.refresh()
  say(`registered tools: ${registration.registered().join(', ')}`)

  const deleteTodo = modelContext.tool('delete_todo')
  say(`delete_todo inputSchema: ${JSON.stringify(deleteTodo.inputSchema)}`)

  const result = await deleteTodo.execute({ id: 'todo-1' }, {})
  say(`tool result: ${result.content[0]?.text}`)
  say(`todos now: ${store.model().todos.map(todo => todo.title).join(', ') || '(none)'}`)

  // 7. Deleting the selected todo clears the selection, so the tool goes away.
  await registration.refresh()
  say(`registered tools: ${registration.registered().join(', ')}`)
  say(
    `selection: ${Option.isNone(store.model().selectedTodoId) ? 'cleared by update' : 'still set'}`,
  )

  // 8. Untrusted input is refused before it reaches `update`.
  say('')
  say('# untrusted input')
  // Written as a shorthand, so its name is the normalized tag.
  const invalid = await modelContext.tool('requested_create_todo').execute({ title: 42 }, {})
  say(`tool result: ${invalid.content[0]?.text}`)

  registration.unregister()
  return log
}
