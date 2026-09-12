/**
 * The browser entry: inject the compiled stylesheet, open the replica on
 * IndexedDB, mount the app, start the exchange loop, and expose the same
 * contract as WebMCP tools.
 */
import { Effect, Scope } from 'effect'
import { AgentWebMcp } from 'foldkit-agent-webmcp'
import { indexedDb, layerSocket, replicaId } from 'foldkit-sync'
import { AppAgent, bindAgent } from './agent.js'
import type { Message } from './app.js'
import type { Principal } from './principal.js'
import { mountApp } from './runtime.js'
import { stylesheet } from './style.js'
import { Sync } from './sync.js'

// The rule-based styles (`pseudo`, `media`, `nest`) compiled to CSS once, at
// module load, from the same Style values the views resolve.
const styles = document.createElement('style')
styles.textContent = stylesheet
document.head.append(styles)

const token = new URLSearchParams(location.search).get('token') ?? 'owner'
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

// The exchange loop: once, then after every submit, until the page unloads.
// Committed operations from other replicas re-install the shared slice
// through the mount; nothing here has to forward them.
Effect.runFork(Effect.provide(replica.start, layerSocket({ url })))

// The same contract, as browser tools, where the browser supports WebMCP. The
// host is the mount itself: `observe` lets `add_todo` wait for its fact.
const principal: Principal = { actorId: token }
const agent = bindAgent({
  definition: AppAgent,
  host: {
    model: mounted.model,
    dispatch: (message: Message) => {
      mounted.dispatch(message)
    },
    subscribe: mounted.subscribe,
    observe: mounted.observe,
    principal: () => principal,
  },
})
const modelContext = AgentWebMcp.documentModelContext()
if (modelContext !== undefined) {
  const registration = AgentWebMcp.register({ agent, modelContext })
  void registration.refresh()
  window.addEventListener('beforeunload', () => registration.unregister())
}
