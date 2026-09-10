import { Effect } from 'effect'
import { Agent } from 'foldkit-agent'
import { AgentMcp } from 'foldkit-agent-mcp'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, expect, it } from 'vitest'
import { Message, type Shared } from '../src/app.js'
import { openJournal, type Principal } from '../src/journal.js'
import { serverAgentHost } from '../src/serverAgent.js'
import { closeStorages, openReplica, openStorage } from './helpers.js'

afterEach(closeStorages)

const principal: Principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const SyncAgent = Agent.forModel<Shared, Principal>()

const request = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

it('commits a durable operation from an MCP tool call and converges a replica', async () => {
  const journal = openJournal(':memory:')
  const replica = await openReplica(
    'browser',
    await Effect.runPromise(openStorage('browser', new IDBFactory())),
  )
  try {
    journal.append(
      {
        protocolVersion: 1,
        schemaVersion: 1,
        documentId: 'todos',
        replicaId: 'seed',
        localSequence: 1,
        opId: 'seed:1',
        baseCursor: 0,
        message: Message.CreatedTodo({ id: 'a', title: 'a' }),
      },
      principal,
    )
    const agent = Agent.bind({
      definition: SyncAgent.define({
        messages: SyncAgent.expose(Message, {
          RenamedTodo: { name: 'rename_todo', description: 'Rename a shared todo' },
        }),
      }),
      host: serverAgentHost({ journal, principal }),
    })
    const served = AgentMcp.handler({ agent })
    await served.handle(request(0, 'initialize'))

    const response = await served.handle(
      request(1, 'tools/call', { name: 'rename_todo', arguments: { id: 'a', title: 'via mcp' } }),
    )

    // A remote tool call is one durable operation under the caller's actor.
    expect(response).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'Dispatched RenamedTodo' }] },
    })
    expect(journal.read('todos', 0).at(-1)).toMatchObject({ replicaId: 'agent', actorId: 'owner' })

    // The browser replica converges on the committed operation.
    await replica.synchronize(journal.transport(principal))
    expect(replica.shared().todos).toEqual([{ id: 'a', title: 'via mcp' }])

    served.close()
  } finally {
    replica.close()
    journal.close()
  }
})
