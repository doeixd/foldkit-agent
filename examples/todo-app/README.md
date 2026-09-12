# The todo app

A local-first, agent-ready todo list that shows how the Foldkit Plus packages
fit together, and why. One application definition drives everything: the view
a human uses, the tools an agent calls, the document replicas share, and the
policy the server enforces.

```text
pnpm demo   # a transcript of the whole contract, no browser, no network
pnpm dev    # the sync server on SQLite plus Vite; open two tabs with different ?token= values
pnpm test   # from the repo root: pnpm vitest run examples/todo-app
```

## The idea in one diagram

```text
                       app.ts
            Model + Message + update          <- the only reducer
                       │
         surface.ts    │    Surface.application(App)
    ┌──────────────────┼──────────────────────┐
    │                  │                      │
 Surfaces        sync fragments          agent contract
 Header, Composer,   Todos, ListMeta      Overview + capabilities
 Board, Footer,      (sync.ts)            (agent.ts)
 Overview                │                      │
    │                    │                      │
 view.ts            Sync.mount             Agent.bind
 slots + styles     one reducer,           WebMCP tools
 (style.ts)         replica, journal       completion, authorize
    │                    │                      │
    └──────────────── module.ts ────────────────┘
              Module.validate / manifest / toMarkdown
```

The top is pure data: schemas, projections, Message sets, styles, rules. The
bottom is interpreters: the Foldkit runtime, the replica, the SQLite journal,
the WebMCP registration. `module.ts` is where the pure half is inspected as one
value.

## The files, in the order to read them

| File | What it teaches |
| --- | --- |
| `app.ts` | The Model, the Message union, and `update`. Three kinds of Message: durable facts, effectful intents, and local state. Why an id is minted in a Command and never in `update`. |
| `principal.ts` | Two principals for two boundaries: the agent's and the server's. The same `isOwner` rule serves both. |
| `surface.ts` | `Surface.application` and the feature Surfaces. A Surface is what a part of the UI observes and may cause; its Message list is a compile-time capability boundary. |
| `style.ts` | Slots, Styles, Behaviors, and a Theme. Appearance and interaction attached from outside the views. `Style.recipe`, `Style.whenInput`, `pseudo`/`media`/`nest` compiling to one stylesheet. |
| `view.ts` | The views. No class names, no inline style, no keyboard code: `slots.x.attrs(base)` merges what is attached. `@foldkit/ui` Button and Checkbox resolved through `foldkit-mixins-ui`. `Surface.rootView` at the Root boundary. |
| `sync.ts` | The local-first contract derived from the application: two fragments composed into one document, `authorize` rules per durable variant, and `mountTodos` over `Sync.mount`. |
| `agent.ts` | The agent contract: capabilities are existing Messages, the context is a Surface, `add_todo` exposes the intent with a `completion` contract, `authorize` mirrors the sync policy. |
| `module.ts` | `Module.make` over every contract: validation and the ownership manifest. |
| `runtime.ts`, `client.ts` | Mounting in a browser: the stylesheet injected once, the replica on IndexedDB, the exchange loop, WebMCP registration with the mount as the agent's host. |
| `journal.ts`, `server.ts` | The server: `foldkit-durable` on SQLite, spreading the contract so codecs, reducer, and policy are never written twice; a WebSocket transport that authenticates per connection. |
| `demo.ts` | The transcript. Every section names the file it exercises; the test pins its lines. |

## The rules the code follows

**One reducer.** The human, the agent, and a peer's committed operation all
become a `Message` and run through `update`. The replica's replay and the
journal's reducer are `update` on the shared slice; `Sync.forApplication`
derives them and refuses a durable Message that returns a Command or touches a
local field.

**Facts carry their own nondeterminism.** `SubmittedTodo` carries the id and
the timestamp. `RequestedTodo` is the intent: local, and its `update` returns a
Command that reads the clock, mints the id, and emits the fact. The agent
exposes the intent, not the fact, and waits for the fact through a completion
contract.

**One owner per datum.** `todos` and `listTitle` are owned by the sync
contract; everything else is local. `Module.manifest` prints this, and
`Module.validate` would report a second owner.

**Policy on the contract, enforced at the journal.** `authorize` rules are
declared once, next to the Messages they govern, with `message` typed as that
variant. The server applies them inside the append transaction. The agent
contract mirrors the two owner-only rules so an agent is refused early with a
typed error.

**Views publish slots; styles and behaviors attach.** A view names the points
it lets others customize. `Style` is data, `Behavior` is attributes built from
the view's input and builder, and one resolver merges them, refusing two owners
of one event. Per-row concerns (a done title, the priority badge, the editor's
Escape key) are `Style.whenInput` and a `Behavior` over the row's input, not
branches in the view.

## Things to try in the browser

- Open the app in two tabs with `?token=owner` and `?token=guest`. Add a todo
  in one; it appears in the other through the SQLite journal.
- Rename the list as `guest`. The field reverts and the footer reports it: the
  server refused `RenamedList`, and the replica rolled the edit back.
- Double-click a title to rename it; Escape cancels, Enter or blur commits.
  `EditingCommitted` is local; its Command emits `RenamedTodo`.
- Click a priority badge to cycle it; the list re-sorts, highest first.
- With a browser that supports WebMCP, the same capabilities appear as tools
  named `add_todo`, `toggle_todo`, `rename_todo`, `set_priority`, `delete_todo`,
  `clear_completed`, and `rename_list`.

## What is deliberately not here

- **Presence.** The server can host a presence hub, but the client would need
  to share one socket between the sync transport and the presence channel across
  reconnects. It is a good next exercise; see `examples/sync` for the primitive.
- **Remote data.** Server-derived, non-replicated entities are `foldkit-remote`;
  `examples/kitchen-sink` shows them beside a sync document.
