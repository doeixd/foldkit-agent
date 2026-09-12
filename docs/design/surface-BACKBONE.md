
Yes. After looking at the current `foldkit-plus` code, I think **`foldkit-surface` should become the semantic backbone of the whole repo**, and `foldkit-remote` should become the standard server-data layer that plugs into that backbone.

That would actually simplify the architecture rather than add another subsystem.

Right now the repo already has three independently invented versions of roughly the same idea:

* `foldkit-agent` has `Context<Model, Value> = { schema, select }` plus `Agent.pick`.
* `foldkit-sync` has its own `Projection<Model, Fields> = { schema, get, set }` plus `pick`.
* `foldkit-agent` resources are yet another `{ schema, read }` projection.

That is basically the architecture telling you:

> **Projection wants to be a shared primitive.**

And once Messages are also referenced through `Surface`, you have a common contract vocabulary for almost everything in `foldkit-plus`.

## The architecture I would target

```text
                         FOLDKIT
              Model · Message · update · Command
                            │
                            │
                   foldkit-surface
          ┌─────────────────┴─────────────────┐
          │                                   │
       ModelRef                           Message refs
          │                                   │
       Projection                          subsets
          └─────────────────┬─────────────────┘
                            │
                         Surface
             "what can this subsystem
               observe and report?"
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
   foldkit-agent      foldkit-sync       foldkit-remote
   agent policy       replication        remote entities
   + exposure         boundary           + normalized cache
          │                 │                  │
    ┌─────┼──────┐          │             transport
    ▼     ▼      ▼          ▼                  │
 WebMCP  MCP    A2A    foldkit-durable       server
              Native        journal
```

There are still multiple packages because they solve genuinely different problems.

But they stop inventing their own notions of:

```text
projection
schema
model subset
message subset
```

---

# `foldkit-surface` becomes the common language

I would make this the lowest-level `foldkit-plus` package.

```ts
const App = Surface.make({
  Model,
  Message,
})
```

Everything else can understand:

```ts
App.model.todos
App.model.selectedTodoId

Projection.struct(...)
Projection.of(...)

Message.CreatedTodo
Message.DeletedTodo

Surface.define(...)
```

The important architectural property is:

> Higher-level packages can **produce, consume, refine, or interpret Surfaces** without Surface knowing anything about those packages.

That's what makes it a backbone instead of a god abstraction.

---

# 1. `foldkit-agent` should be rebuilt on Surface

This is the most obvious integration.

Today the core Agent definition contains:

```ts
{
  context?: Context<Model, Context>
  messages: ExposedMessages<...>
  resources: Resource<Model, unknown>[]
}
```

and `Context` itself carries `schema + select`.

That entire Model-projection half should come from Surface.

But **I would not remove `foldkit-agent`**.

Agent does substantially more than Surface:

```text
Surface                         Agent
───────                         ─────
Model visibility               protocol naming
Message subset                 descriptions
                               external input mapping
                               availability
                               authorization
                               principal
                               completion semantics
                               audit
                               cancellation
```

Your existing Agent implementation has real policy semantics—authorization, mapped external inputs, completion correlation, auditing, snapshot consistency, etc. Surface should not absorb any of that.

Instead Agent becomes an **externalization interpreter for a Surface**.

### Current

```ts
const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  context: Agent.pick(Model, [
    "selectedTodoId",
    "todos",
  ]),

  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: "Create a todo",

    RequestedDeleteTodo: {
      description: "Delete a todo",
      available: model => ...,
    },
  }),
})
```

### New direction

I'd prefer something like:

```ts
const AppAgent = Agent.define(
  App,
  "TodoAgent",
  {
    model: ({ model }) =>
      Projection.struct({
        todos: model.todos,
        selectedTodoId: model.selectedTodoId,
      }),

    capabilities: [
      Agent.capability(
        Message.RequestedCreateTodo,
        {
          description: "Create a todo",
        },
      ),

      Agent.capability(
        Message.RequestedDeleteTodo,
        {
          description: "Delete a todo",

          available: model => ...,
        },
      ),
    ],
  },
)
```

Internally this creates:

```ts
AppAgent.surface
```

which is a real:

```ts
Surface<
  Model,
  AgentContext,
  RequestedCreateTodo | RequestedDeleteTodo
>
```

and Agent adds policy around it.

Notice we've also eliminated the remaining Message-tag strings.

Instead of:

```ts
RequestedDeleteTodo: { ... }
```

we use:

```ts
Agent.capability(
  Message.RequestedDeleteTodo,
  { ... }
)
```

which matches the direction we established for Surface.

---

# Agent context essentially disappears

This:

```ts
Agent.context({
  schema,
  select,
})
```

becomes unnecessary.

Likewise:

```ts
Agent.pick(Model, ["todos"])
```

becomes unnecessary.

Surface gives us:

```ts
Projection.struct({
  todos: App.model.todos,
})
```

which carries:

```text
schema
reader
dependency metadata
```

and is useful everywhere else too.

That's a straight deletion of duplicated concepts.

---

# Agent resources become Projection + metadata

Current:

```ts
Agent.resource("todos", {
  description: "...",
  schema: TodoList,
  read: model => model.todos,
})
```

Current resources explicitly duplicate Schema and Model reader.

New:

```ts
Agent.resource("todos", {
  description: "The user's todos",

  projection:
    App.model.todos.select(TodoList),
})
```

Schema is derived.

Reader is derived.

Dependency information is derived.

Now MCP can potentially describe exactly what a resource observes.

---

# The existing agent adapters barely change

This is important.

These should remain leaf packages:

```text
foldkit-agent-webmcp
foldkit-agent-mcp
foldkit-agent-a2a
foldkit-agent-native
```

Today WebMCP simply converts available Agent capabilities into browser tools and dispatches into the same runtime.

MCP maps Agent capabilities to `tools/list`/`tools/call` and resources to MCP resources.

A2A maps them into skills/tasks.

That's already the correct dependency direction.

After the refactor:

```text
Surface
   ↓
Agent
   ↓
compiled AgentRuntime
   ↓
┌──────┬───────┬──────┬────────┐
MCP  WebMCP   A2A    Native
```

None of those adapters should need to understand ModelRefs.

They consume Agent's compiled interpretation of the Surface.

---

# 2. `foldkit-sync` is the second huge win

This is the most compelling evidence that Surface is actually fundamental.

`foldkit-sync` literally already contains:

```ts
interface Projection<Model, Fields> {
  schema
  get(model)
  set(model, shared)
}
```

plus:

```ts
pick(Model, ["todos"])
```

That should be replaced.

But there is one important difference:

> Surface projections are read-oriented; Sync needs a **writable projection** because a checkpoint must be merged back into Model.

I would **not** make every Surface Projection writable just to satisfy Sync.

Instead Sync can provide one tiny specialization over `ModelRef`.

Something like:

```ts
const Shared = Sync.project({
  todos: App.model.todos,
})
```

Because `App.model.todos` is a `ModelRef`, Sync knows:

```text
Schema
get
set
path
```

So this automatically produces the thing `sync/src/projection.ts` currently hand-builds.

No field strings:

```ts
Sync.project({
  todos: App.model.todos,
  projects: App.model.projects,
})
```

instead of:

```ts
pick(Model, ["todos", "projects"])
```

Very clean.

---

# Sync's durable Message selection should also use references

Today the low-level Sync definition takes the whole Message schema plus:

```ts
durable: (message) => boolean
```

and the docs show tag-set filtering.

I think the preferred API should become:

```ts
const TodoSync = Sync.define(
  App,
  "Todos",
  {
    documentId: documentId("todos"),

    model: Sync.project({
      todos: App.model.todos,
    }),

    messages: [
      Message.CreatedTodo,
      Message.RenamedTodo,
      Message.DeletedTodo,
    ],

    replay: (shared, message) => {
      ...
    },
  },
)
```

That's basically a specialized Surface.

Internally:

```ts
TodoSync.surface
```

could be:

```text
observes/writes:
  Model.todos

accepts:
  CreatedTodo
  RenamedTodo
  DeletedTodo
```

Now `replay` is inferred against only:

```ts
CreatedTodo
| RenamedTodo
| DeletedTodo
```

rather than the complete application union.

That's better inference **and** a better architecture.

---

# This creates an interesting unification

A Surface doesn't have to mean:

> UI component.

It really means:

> **A subsystem's typed interface to the application.**

So you might have:

```text
ProjectCardSurface
    UI boundary

TodoAgent.surface
    agent boundary

TodoSync.surface
    replication boundary
```

Same abstraction.

Different interpreters.

That's powerful.

---

# 3. `foldkit-durable` should mostly stay independent

This is where I would resist forcing the abstraction.

`foldkit-durable` is currently intentionally generic:

> ordered durable operations + snapshot + cursor + caller-supplied reducer.

It owns persistence/ordering, not application semantics.

That's good.

I would **not** make:

```text
foldkit-durable → foldkit-surface
```

a foundational dependency just for conceptual neatness.

Instead `foldkit-sync` can produce the contract Durable needs.

For example:

```ts
const TodoSync = Sync.define(...)

const journal = yield* makeJournal({
  ...Sync.journalContract(TodoSync),

  file,
  opId,
  actorId,
  validate,
  authorize,
})
```

Where:

```ts
Sync.journalContract(TodoSync)
```

returns something approximately like:

```ts
{
  operation: {
    encode,
    decode,
  },

  snapshot: {
    encode,
    decode,
  },

  empty,

  reduce,
}
```

Those are already the major pieces `makeJournal` needs today.

So:

```text
Surface
   ↓
Sync definition
   ↓
plain replay contract
   ↓
Durable journal
```

Durable remains independently useful.

That's exactly the sort of **appropriate integration** I think you want.

---

# `foldkit-sync` then becomes the bridge to Durable

You currently describe `sync` and `durable` as the client and server halves of replicated state, connected by the exchange protocol.

After this redesign:

```text
                  Replication Surface

                Model projection
                       +
                Message subset
                       │
                       ▼
                foldkit-sync
               /             \
              /               \
     local replica        journal contract
         │                      │
    IndexedDB                    ▼
                         foldkit-durable
                              SQLite
```

Now both halves are literally derived from the same application contract.

That is a very strong guarantee.

---

# 4. `foldkit-remote` slots into Projection itself

Remote is different from Sync.

Sync answers:

> How does shared domain state replicate and converge?

Remote answers:

> How do I obtain server-owned entity data efficiently?

Don't merge them.

Instead Remote should extend the **Projection graph**.

For example:

```ts
const ProjectPage = Surface.define(
  App,
  "ProjectPage",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        route: model.route,

        project:
          Remote.entity(
            model.remote,
            Project,
            params.projectId,
          ).select(ProjectSummary),
      }),

    messages: [
      Message.ClickedArchiveProject,
    ],
  },
)
```

The resulting Projection contains two kinds of dependency:

```text
ProjectPage

LOCAL
─────
route

REMOTE
──────
Project:p123
  id
  name
  status
  owner
    User
      id
      name
```

Surface doesn't care.

It just sees Projection nodes.

Remote interprets the remote nodes.

---

# Remote should produce ordinary Projection values

That's the integration seam I'd insist on.

Don't create:

```ts
RemoteView
RemoteSelector
RemoteFragment
RemoteContext
```

if `Projection` already exists.

Instead:

```ts
Remote.entity(...)
```

returns something implementing/composing as:

```ts
Projection<RootModel, RemoteData<Entity>>
```

Then all consumers automatically work with it:

```text
Surface
Agent resources
DevTools
tests
documentation
render invalidation
```

No adapters necessary.

---

# `foldkit-remote` owns its normalized Model

As discussed earlier:

```ts
const Remote = Remote.make({
  entities: [
    User,
    Project,
  ],
})
```

gives:

```text
Remote.Model
Remote.Message
Remote.update
Remote.subscriptions
```

and the app embeds it as an ordinary Foldkit Submodel.

Then Surface references it:

```ts
App.model.remote
```

and Remote builds specialized Projections from that ref.

So the architecture stays:

```text
Application Model
│
├── UI state
├── sync-backed shared state
└── remote
     ├ entities
     ├ connections
     ├ presence bits
     ├ requests
     └ optimistic layers
```

No hidden query cache outside Foldkit.

---

# 5. Remote and Sync should NOT share a cache

This boundary matters a lot.

You will have three kinds of state:

| State                                 | Owner            |
| ------------------------------------- | ---------------- |
| local UI/process state                | Foldkit Model    |
| server-derived/cacheable entity data  | `foldkit-remote` |
| replicated/offline-first domain state | `foldkit-sync`   |

Do **not** store the same domain object in both `Remote.Model` and `Sync`'s shared projection.

Otherwise you recreate the exact "two sources of truth" problem these libraries are trying to avoid.

A Surface can compose all three:

```ts
Projection.struct({
  editor: model.editor,

  project:
    Remote.entity(...),

  sharedDraft:
    model.collaboration.draft,
})
```

but each leaf has one owner.

---

# Use Remote when data is disposable

For example:

```text
search results
product catalog
user profile loaded from API
analytics
large server lists
read-heavy entity graph
pagination
server-calculated values
```

Use Sync when the client should own pending edits and converge later:

```text
collaborative document
todo state
board state
offline edits
multi-device shared state
```

That's a clean conceptual division.

---

# 6. Remote + Durable can integrate server-side, optionally

There are legitimate cases where they're useful together.

Suppose an agent or human does:

```text
ClickedArchiveProject
```

and that mutation is a durable application operation.

The server path could be:

```text
Remote mutation
      │
      ▼
decode command
      │
      ▼
append Foldkit Message
to Durable journal
      │
      ▼
replay/update state
      │
      ▼
return normalized entity patch
```

Then Remote clients receive:

```text
Project:p123.status = archived
```

while the operation itself is durably recorded as:

```text
ArchivedProject(...)
```

But this should be an adapter:

```ts
RemoteServer.fromJournal(...)
```

or similar.

Not a dependency of Remote core.

---

# 7. Agent + Remote gets very interesting

Once Agent context/resources are Projections, agents can inspect the same remote-backed state the human Surface sees.

For instance:

```ts
Agent.resource("project", {
  description: "The selected project",

  projection:
    Remote.entity(
      App.model.remote,
      Project,
      App.model.selectedProjectId,
    ).select(ProjectDetail),
})
```

There is one unresolved design decision:

> What happens if that Projection is not loaded?

For normal UI:

```ts
RemoteData<Project>
```

is fine.

For MCP `resources/read`, you may prefer:

```text
ensure required fields
→ await transport
→ return resolved data
```

I would solve that as an **optional Remote interpreter**, not change Projection itself.

Perhaps:

```ts
Agent.resource("project", {
  projection: ...,
  resolution: Remote.resolve,
})
```

or a tiny integration:

```ts
Remote.agentResource(...)
```

But I would defer this until the core Remote cache works.

---

# 8. Surface gives DevTools a unified topology

This might become one of the coolest consequences of the whole repo.

Today the repo has agent state and replicated state as two independent extensions of Foldkit's state machine.

Surface lets DevTools show all of them in one language:

```text
APPLICATION

ProjectPage
├─ observes
│   ├ route.projectId
│   └ Remote Project:p123 { name, status, owner }
│
└─ emits
    └ ClickedArchiveProject


TodoAgent
├─ observes
│   ├ todos
│   └ selectedTodoId
│
└─ externally exposes
    ├ RequestedCreateTodo
    └ RequestedDeleteTodo


TodoSync
├─ replicates
│   └ todos
│
└─ operations
    ├ CreatedTodo
    ├ RenamedTodo
    └ DeletedTodo
```

That's almost an application architecture inspector.

---

# 9. The adapters remain extremely boring

Which is good.

After this change I would want package responsibilities to look like this:

| Package                | Responsibility                                                   | Surface relationship                                |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `foldkit-surface`      | refs, projections, message subsets, semantic boundaries          | **foundation**                                      |
| `foldkit-remote`       | entities, normalized store, queries, batching, transport         | creates/consumes Projections                        |
| `foldkit-agent`        | external policy, authorization, input mapping, completion, audit | builds/interprets Surface                           |
| `foldkit-agent-webmcp` | WebMCP protocol mapping                                          | consumes Agent only                                 |
| `foldkit-agent-mcp`    | MCP mapping                                                      | consumes Agent only                                 |
| `foldkit-agent-a2a`    | A2A mapping                                                      | consumes Agent only                                 |
| `foldkit-agent-native` | Agent Native mapping                                             | consumes Agent only                                 |
| `foldkit-sync`         | offline replica, replay, reconciliation, presence                | specialized writable Surface                        |
| `foldkit-durable`      | durable ordering/storage/effect ledger                           | consumes generic replay contract; stays independent |

I think that's the right dependency graph.

---

# 10. There should be one shared application scope

This becomes especially nice.

Currently packages often start from Model independently.

Instead:

```ts
export const App = Surface.make({
  Model,
  Message,
})
```

becomes the root semantic object.

Then:

```ts
const ProjectPage =
  Surface.define(App, ...)

const Remote =
  Remote.make(App, ...)

const AppAgent =
  Agent.define(App, ...)

const Sync =
  Sync.define(App, ...)
```

Everything knows it belongs to the same application universe.

That means you can prevent accidentally composing:

```text
Model refs from App A
Messages from App B
Remote entities from App C
```

at compile time as far as TypeScript's type system permits.

---

# 11. Higher-level builders should produce Surfaces, not require them

This is a subtle DX decision.

I **wouldn't** make everyone write this:

```ts
const FooSurface = Surface.define(...)

const FooAgent = Agent.define(FooSurface, ...)
```

and:

```ts
const SyncSurface = Surface.define(...)

const Sync = Sync.define(SyncSurface, ...)
```

all the time.

That's ceremonious.

Instead specialized APIs should be able to create Surface descriptors internally.

So:

```ts
const AppAgent = Agent.define(
  App,
  "Agent",
  {
    model: ...,

    capabilities: [
      Agent.capability(...),
    ],
  },
)
```

automatically exposes:

```ts
AppAgent.surface
```

And:

```ts
const TodoSync = Sync.define(
  App,
  "Todos",
  {
    model: ...,
    messages: [...],
    replay: ...,
  },
)
```

automatically exposes:

```ts
TodoSync.surface
```

Then if you *already* have a Surface and want to reuse it, there can be:

```ts
Agent.fromSurface(...)
Sync.fromSurface(...)
```

That's the best combination:

```text
simple default
+
composable escape hatch
```

---

# 12. I'd make Projection the real common primitive

When I look at this repo now, **Projection may actually be more fundamental than Surface**.

Surface is:

```text
Projection + Message subset
```

Remote queries are:

```text
specialized Projection nodes
```

Agent context is:

```text
Projection
```

Agent resources are:

```text
named Projection
```

Sync shared state is:

```text
writable Projection
```

Rendering dependencies are:

```text
Projection
```

MCP resources can be:

```text
Projection
```

Testing fixtures can be:

```text
Projection schema
```

So internally I would organize it roughly:

```text
foldkit-surface
│
├── ModelRef
│
├── Projection
│
└── Surface
│    ├ model: Projection
│    └ messages: MessageRefs
│
├── consumed by Agent
├── consumed by Sync
└── extended by Remote
```

That's a very coherent foundation.

---

# 13. One thing I'd change from our Surface design

After seeing `foldkit-sync`, I would design `ModelRef` from day one with both:

```ts
ModelRef.get(model)
ModelRef.set(model, value)
```

internally.

That doesn't mean UI Surfaces get mutation authority.

They don't.

It just means the **descriptor is a real Effect-style optic**.

Then:

```ts
Projection
```

can remain read-only at the public semantic level, while Sync can derive:

```ts
SyncProjection
```

from a collection of writable `ModelRef`s.

That makes the implementation much cleaner and fits the Effect v4 Optic foundation we discussed.

---

# 14. A full example of the new `foldkit-plus`

Imagine Todo.

Application:

```ts
const App = Surface.make({
  Model,
  Message,
})
```

UI:

```ts
const TodoList = Surface.define(
  App,
  "TodoList",
  {
    model: ({ model }) =>
      Projection.struct({
        todos: model.todos,
        selection: model.selectedTodoId,
      }),

    messages: [
      Message.ClickedTodo,
      Message.RequestedCreateTodo,
      Message.RequestedDeleteTodo,
    ],
  },
)
```

Agent:

```ts
const TodoAgent = Agent.define(
  App,
  "TodoAgent",
  {
    model: ({ model }) =>
      Projection.struct({
        todos: model.todos,
        selection: model.selectedTodoId,
      }),

    capabilities: [
      Agent.capability(
        Message.RequestedCreateTodo,
        {
          description: "Create a todo",
        },
      ),

      Agent.capability(
        Message.RequestedDeleteTodo,
        {
          description: "Delete the selected todo",
          available: model =>
            Option.isSome(model.selectedTodoId),
        },
      ),
    ],
  },
)
```

Replication:

```ts
const TodoSync = Sync.define(
  App,
  "TodoSync",
  {
    documentId: documentId("todos"),

    model: Sync.project({
      todos: App.model.todos,
    }),

    messages: [
      Message.CreatedTodo,
      Message.RenamedTodo,
      Message.DeletedTodo,
    ],

    replay: updateShared,
  },
)
```

Durability:

```ts
const journal = yield* makeJournal({
  ...Sync.journalContract(TodoSync),

  file,
  actorId,
  opId,
  authorize,
})
```

Remote server data elsewhere:

```ts
const UserSummary = Projection.of(User)({
  id: true,
  name: true,
})

const Header = Surface.define(
  App,
  "Header",
  {
    model: ({ model }) =>
      Projection.struct({
        user:
          Remote.entity(
            model.remote,
            User,
            model.session.userId,
          ).select(UserSummary),
      }),
  },
)
```

All five systems now speak one structural language.

---

## The bigger change to the repo

Your root README currently says there are **two independent extensions** to the same Foldkit state machine: agents and replicated state.

I think Surface reveals a better architecture:

```text
                    Foldkit state machine
                            │
                            ▼
                    Semantic surfaces
                 Projection + Messages
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
        Agents          Replication       Remote data
          │                 │                 │
       protocols         durable          transport
```

So rather than `foldkit-plus` being a collection of separate Foldkit extensions, it becomes a coherent stack:

> **Foldkit defines application behavior. Surface defines typed boundaries over that behavior. Agent, Sync, and Remote interpret those boundaries for different environments. Durable and protocol adapters remain specialized infrastructure at the edges.**

I think that's substantially stronger than the current architecture—and importantly, it actually **removes** duplicate primitives from `agent` and `sync` rather than adding conceptual weight.
