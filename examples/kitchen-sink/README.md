# Kitchen sink

Every package in this repository, wired into one application. It runs entirely
in-process — an in-memory SQLite database and a durable journal, no server and no
browser — so the transcript is deterministic and needs nothing running.

```bash
pnpm build
pnpm --filter foldkit-kitchen-sink-example demo
```

`pnpm demo` at the repository root runs it with the other examples.

## What each package does here

| Layer | Package | In this example |
| --- | --- | --- |
| Observation | `foldkit-surface` | One `Surface.application` embeds the Remote submodel beside the client-owned `notes` slice; `BoardSurface` projects both. |
| Server-derived state | `foldkit-remote` | The normalized cache submodel: `Remote.prefetch`, `Remote.live`, `Remote.mutateInto`, `Remote.mutate` with an optimistic `ConnectionChange`, `Remote.query`, `Remote.retain`, `RemotePersistence`, `Remote.inspect`. |
| Server | `foldkit-remote-server` | `RemoteServer` sources compiled to the `RemoteRpc` handlers, served in-process through `Remote.clientLayer` over the database layer; a `liveHub` feeds the live subscription from the rename mutation. |
| Server SQL | `foldkit-remote-drizzle` | `Project` and `User` are Drizzle bindings over in-memory SQLite tables; the nested `owner` selection, the reads, and the query compile to SQL. |
| Client-owned state | `foldkit-durable` | A `makeJournal` over the Sync contract orders the `notes` operations. |
| Replication | `foldkit-sync` | A replica, an in-memory `Storage`, and `replica.start` exchanging through a `TransportClient`. |
| Agent | `foldkit-agent` | One contract projected from the same Model and Messages. |
| Agent browser | `foldkit-agent-webmcp` | The contract registered into a `document.modelContext` stand-in. |
| Agent external | `foldkit-agent-mcp` | The transport-free MCP handler answers `initialize` and `tools/list`. |
| Agent A2A | `foldkit-agent-a2a` | An Agent Card and a `message/send` task. |
| Agent Native | `foldkit-agent-native` | The contract compiled to package actions. |
| View | `foldkit-mixins` | A `Slots` contract and a Style attached to it. |
| View + Surface | `foldkit-mixins-surface` | `SurfaceView.define` binds `BoardSurface`'s projected Model to the slots. |
| View + UI | `foldkit-mixins-ui` | A `@foldkit/ui` Button customised through `Button.resolve` without copying it. |

## The transcript

```
surface: the board Surface projects the project and the notes
after fetch (Drizzle SQLite): Ready Apollo      # remote read compiled to SQL
nested selection (one read): owner Ada          # owner resolved through its ref
mutation: {"id":"p1"} -> Ready Apollo II        # Remote.mutateInto reconciles
live (hub.changed): EntityPatched name=Apollo II # the server's live hub re-reads for the subscriber
query connection: Project:p2, Project:p1        # Remote.query -> a connection
optimistic insert: p3, p2, p1                    # MutationStarted shows the pending edge
confirmed insert: p3, p2, p1                     # the result's insert replaces it in place
hydrated: Ready Apollo II, plan empty            # dehydrate/hydrate, nothing left to fetch
retained with the connection: Project:p1, User:u1, Project:p3   # Remote.retain roots
retained by the Board alone: Project:p1, User:u1                # the rest is collected
replicated (durable journal): First note        # durable + sync reconciled
capabilities: requested_create_note, ...        # the agent contract is data
notes after agent: First note, From the agent   # the agent drives the same update
webmcp / mcp / a2a / native actions             # one contract, four adapters
rendered classes: board                         # mixins + mixins-surface
mixins-ui button classes: save                  # a @foldkit/ui component, customised
```

`test/demo.test.ts` asserts every line, so the example cannot quietly stop
demonstrating what it claims.
