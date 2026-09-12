/**
 * The browser entry: open the replica on IndexedDB, mount the app, connect the
 * exchange loop, and expose the same contract as WebMCP tools.
 */
import { Effect, Scope, Stream } from 'effect'
import { AgentWebMcp } from 'foldkit-agent-webmcp'
import { indexedDb, layerSocket, replicaId } from 'foldkit-sync'
import { AppAgent, bindAgent, type Principal } from './agent.js'
import { mountApp } from './runtime.js'
import { Sync } from './sync.js'

const token = new URLSearchParams(location.search).get('token') ?? 'browser'
const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
const url = `${protocol}://${location.host}/sync?token=${encodeURIComponent(token)}`

const storageScope = Effect.runSync(Scope.make())
const storage = Effect.runSync(
  Effect.provideService(indexedDb(`foldkit-todo-app/${token}`), Scope.Scope, storageScope),
)
const replica = Effect.runSync(Sync.openReplica(replicaId(token), storage))

const container = document.querySelector<HTMLElement>('#app')
if (container === null) throw new Error('#app is missing from the page')

const mounted = mountApp(replica, container)

const principal: Principal = { actorId: token }
const agent = bindAgent({
  definition: AppAgent,
  host: {
    model: mounted.model,
    dispatch: mounted.send,
    subscribe: mounted.subscribe,
    principal: () => principal,
  },
})

// Committed operations from the server arrive through the replica.
Effect.runFork(Stream.runForEach(replica.changes, () => Effect.sync(() => mounted.refresh())))

// The exchange loop: once, then after every submit, until the page unloads.
Effect.runFork(Effect.provide(replica.start, layerSocket({ url })))

// The same contract, as browser tools, where the browser supports WebMCP.
const modelContext = AgentWebMcp.documentModelContext()
if (modelContext !== undefined) {
  const registration = AgentWebMcp.register({ agent, modelContext })
  void registration.refresh()
  window.addEventListener('beforeunload', () => registration.unregister())
}
