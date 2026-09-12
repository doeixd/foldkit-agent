
Exactly. Given Drizzle’s current Effect support, `foldkit-remote-drizzle` should be **much more semantic and much less infrastructural**.

Drizzle now has an Effect-native PostgreSQL driver via `drizzle-orm/effect-postgres`, built around `@effect/sql-pg`, and also ships `drizzle-orm/effect-schema`, which can derive Effect select/insert/update Schemas directly from Drizzle tables. ([Drizzle ORM][1])

So `foldkit-remote-drizzle` should **not** provide:

```text
database connection management
Effect Layers for Drizzle
SQL error wrapping
Effect conversion
Schema generation from tables
transaction wrappers
```

Drizzle already does those things.

Its job should be much narrower:

> **Translate Foldkit Remote's Entity / Selection / Query semantics into efficient Drizzle queries, and translate Drizzle results back into normalized Remote patches.**

That’s enough to justify a package.

## The bridge

Think of it as:

```text
Remote semantics                 Drizzle semantics

Entity              ←──────→     Table
Selection            ───────→     Partial SELECT
EntityRef             ───────→     PK predicate
relation Selection    ───────→     join / batched relation load
QueryRef              ───────→     WHERE / ORDER / LIMIT
Connection            ←───────     rows + pagination
EntityPatch           ←───────     selected row
```

Everything else stays with Effect/Drizzle.

---

## Entity definitions could become extremely concise

Without the adapter we might write:

```ts
const UserSchema = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
})

const User = Entity.make(
  "User",
  UserSchema,
)
```

But Drizzle can already derive an Effect Schema:

```ts
import {
  createSelectSchema,
} from "drizzle-orm/effect-schema"

const UserSchema =
  createSelectSchema(users)
```

Drizzle's Effect Schema integration derives select, insert, and update schemas and allows per-column Schema overrides/refinements. ([Drizzle ORM][2])

So `remote-drizzle` could offer:

```ts
const User = RemoteDrizzle.entity(
  "User",
  users,
)
```

and internally essentially use:

```ts
Entity.make(
  "User",
  createSelectSchema(users),
)
```

plus Drizzle table metadata.

That's useful because the resulting Entity knows both:

```text
Effect Schema semantics
+
Drizzle table semantics
```

without the user declaring them twice.

---

## Branded IDs need an override

Database:

```ts
users.id // text column
```

Application:

```ts
type UserId = string & Brand<"UserId">
```

So you'd likely want:

```ts
const User = RemoteDrizzle.entity(
  "User",
  users,
  {
    schema: {
      id: UserId,
    },
  },
)
```

which can delegate directly to Drizzle's existing Effect Schema override mechanism rather than implementing another one.

Potentially even:

```ts
const User = RemoteDrizzle.entity(
  "User",
  users,
  {
    id: {
      column: users.id,
      schema: UserId,
    },
  },
)
```

but I'd resist that if Drizzle already gives us the override cleanly.

---

# Where the package really becomes valuable: Selection → SELECT

Suppose:

```ts
const ProjectSummary =
  Selection.make(Project, {
    id: true,
    name: true,
    status: true,
  })
```

and the client requires:

```text
Project:p123
├ id
├ name
└ status
```

A generic `RemoteServer.entity` source might have to manually interpret that:

```ts
RemoteServer.entity(
  Project,

  ({ ids, selection }) =>
    loadProjects(ids, selection),
)
```

With Drizzle, `RemoteDrizzle.source(Project)` can compile the Selection automatically:

```ts
const ProjectSource =
  RemoteDrizzle.source(Project)
```

because the Entity already knows its table.

Then Remote asks for:

```text
id
name
status
```

and the adapter generates approximately:

```ts
db
  .select({
    id: projects.id,
    name: projects.name,
    status: projects.status,
  })
  .from(projects)
  .where(inArray(projects.id, ids))
```

That's real value.

The selected Remote fields become the selected SQL columns.

---

# This should be automatic

Ideally:

```ts
const Project = RemoteDrizzle.entity(
  "Project",
  projects,
  {
    schema: {
      id: ProjectId,
    },
  },
)
```

then:

```ts
const ProjectSource =
  RemoteDrizzle.entitySource(Project)
```

That's it for ordinary flat entities.

The source:

1. receives IDs + Remote Selection,
2. maps Selection fields to Drizzle columns,
3. executes an Effect-native Drizzle query,
4. validates/maps results,
5. returns normalized Remote entity patches.

That's enough convenience to justify the adapter.

---

# Relations are the harder and more interesting part

Suppose Drizzle has:

```ts
export const projects = pgTable("projects", {
  id: text().primaryKey(),
  name: text().notNull(),
  ownerId: text("owner_id").notNull(),
})
```

Remote wants:

```ts
const Project = Entity.make(... {
  owner: Entity.ref(User)
})
```

The adapter needs to know:

```text
Project.owner
        │
        ▼
projects.ownerId
        │
        ▼
User.id
```

Maybe:

```ts
const Project = RemoteDrizzle.entity(
  "Project",
  projects,
  {
    relations: {
      owner: RemoteDrizzle.one(User, {
        field: projects.ownerId,
      }),
    },
  },
)
```

Then:

```ts
const ProjectSummary =
  Selection.make(Project, {
    id: true,
    name: true,

    owner: Selection.make(User, {
      id: true,
      name: true,
    }),
  })
```

can compile automatically.

---

# But don't force JOINs

This matters.

A nested Selection:

```text
Project:p1
└ owner
   ├ id
   └ name
```

does **not** necessarily mean:

```sql
JOIN users ...
```

The adapter should be free to optimize.

For a batch of projects:

```text
Project:p1 → User:u1
Project:p2 → User:u1
Project:p3 → User:u2
```

it might be better to perform:

```sql
SELECT id, name, owner_id
FROM projects
WHERE id IN (...)
```

then:

```sql
SELECT id, name
FROM users
WHERE id IN (u1, u2)
```

That's exactly the kind of batching normalized entity systems are good at.

So relation metadata should describe:

> how the entities relate

not:

> what SQL strategy to execute.

The adapter can choose joins, two-stage batching, etc.

---

# This could integrate beautifully with Remote's planner

Remember Remote already says:

```text
missing:

Project:p1.status

User:u1.avatarUrl
User:u2.avatarUrl
```

`remote-drizzle` can group that into SQL work:

```text
projects:
  ids = [p1]
  columns = [id, status]

users:
  ids = [u1, u2]
  columns = [id, avatar_url]
```

Then generate two batched SELECTs.

That's substantially more useful than a generic "Drizzle Source wrapper."

---

# Queries become another important piece

Suppose:

```ts
const ProjectsByOwner = Query.make(
  "ProjectsByOwner",
  {
    Input: Schema.Struct({
      ownerId: UserId,
    }),

    Result: Query.connection(Project),
  },
)
```

Generic server implementation:

```ts
const ProjectsByOwnerSource =
  RemoteServer.query(
    ProjectsByOwner,
    ({ input, selection, page }) => ...
  )
```

Drizzle adapter could make this:

```ts
const ProjectsByOwnerSource =
  RemoteDrizzle.query(
    ProjectsByOwner,
    {
      entity: Project,

      where: ({ ownerId }) =>
        eq(
          projects.ownerId,
          ownerId,
        ),

      orderBy:
        desc(projects.createdAt),
    },
  )
```

Then Remote automatically handles the requested field Selection.

If Surface asks for:

```text
Project
├ id
├ name
└ owner.name
```

the query only retrieves the relevant fields.

---

# Pagination can also be derived

For cursor pagination:

```ts
RemoteDrizzle.query(
  ProjectsByOwner,
  {
    entity: Project,

    where: ({ ownerId }) =>
      eq(projects.ownerId, ownerId),

    cursor: {
      column: projects.createdAt,
      direction: "desc",
    },
  },
)
```

Then the adapter can produce:

```text
Connection<Project>

items
endCursor
hasNextPage
```

without application code writing the plumbing.

That's another substantial adapter feature.

---

# Mutations are less compelling

I would **not** make `remote-drizzle` into a mutation DSL initially.

You already have excellent Drizzle:

```ts
yield* db
  .update(projects)
  .set({
    name: input.name,
  })
  .where(
    eq(projects.id, input.id),
  )
```

and now that API is Effect-native. Drizzle's Effect PostgreSQL integration exposes an Effect-native database service/API rather than forcing Promise interop. ([Drizzle ORM][1])

So this:

```ts
const RenameProjectSource =
  RemoteServer.mutation(
    RenameProject,

    ({ input }) =>
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle

        yield* db
          .update(projects)
          .set({
            name: input.name,
          })
          .where(
            eq(projects.id, input.id),
          )

        return RemoteServer.result({
          entities: [
            Entity.patch(
              Project.ref(input.id),
              {
                name: input.name,
              },
            ),
          ],
        })
      }),
  )
```

is already pretty good.

I wouldn't hide it prematurely.

---

# Maybe mutation result helpers later

There could eventually be something like:

```ts
RemoteDrizzle.returning(
  Project,
  ProjectSummary,
)
```

so:

```ts
yield* db
  .update(projects)
  .set(...)
  .where(...)
  .returning(
    RemoteDrizzle.columns(
      Project,
      ProjectSummary,
    ),
  )
```

and then:

```ts
RemoteDrizzle.normalize(
  Project,
  rows,
)
```

But that's convenience on top.

Reads are where the adapter has the strongest reason to exist.

---

# Schema integration is another major reason for it

The combination could be:

```text
Drizzle table
     │
     ├───────────────┐
     ▼               ▼
Effect Schema     SQL columns
     │               │
     ▼               │
Remote Entity         │
     │               │
     └───────┬───────┘
             ▼
      RemoteDrizzle binding
```

So:

```ts
const User = RemoteDrizzle.entity(
  "User",
  users,
)
```

provides:

```text
User.schema
    Effect Schema derived by Drizzle

User.table
    Drizzle table metadata

User.fields.name
    knows both Schema.String + users.name

User.id
    knows id Schema + primary key column
```

That's an unusually strong bridge.

---

# Maybe fields should actually carry both sides

Conceptually, after binding:

```ts
Project.fields.name
```

could know:

```ts
{
  schema: Schema.String,
  column: projects.name,
}
```

Not necessarily exposed exactly like that, but internally.

Then a Selection:

```ts
Selection.make(Project, {
  id: true,
  name: true,
})
```

directly maps to:

```ts
{
  id: projects.id,
  name: projects.name,
}
```

No string lookup.

No reflection.

No query parser.

Very clean.

---

# Effect Schema generation means fewer packages again

This is the crucial observation.

Because Drizzle itself provides:

```ts
createSelectSchema
createInsertSchema
createUpdateSchema
```

for Effect Schema, `foldkit-remote-drizzle` doesn't need a whole "Drizzle ↔ Effect" compatibility layer. ([Drizzle ORM][2])

So the package becomes approximately:

```text
foldkit-remote-drizzle

1. Drizzle table → Remote Entity binding

2. Remote Selection → Drizzle partial select

3. Remote entity requirements → batched Drizzle SELECT

4. Drizzle rows → normalized Remote patches

5. Remote Query → Drizzle query Source

6. optionally relation planning / pagination
```

That's it.

And I think that's enough.

---

# I would make the API approximately this

Flat entity:

```ts
const User = RemoteDrizzle.entity(
  "User",
  users,
  {
    schema: {
      id: UserId,
    },
  },
)
```

Entity with relation:

```ts
const Project = RemoteDrizzle.entity(
  "Project",
  projects,
  {
    schema: {
      id: ProjectId,
    },

    relations: {
      owner: RemoteDrizzle.one(
        User,
        {
          field: projects.ownerId,
        },
      ),
    },
  },
)
```

Selections remain generic Remote:

```ts
const UserSummary =
  Selection.make(User, {
    id: true,
    name: true,
  })

const ProjectSummary =
  Selection.make(Project, {
    id: true,
    name: true,
    status: true,
    owner: UserSummary,
  })
```

Source:

```ts
const ProjectSource =
  RemoteDrizzle.source(Project)
```

No duplicated mapping.

---

# Query source

```ts
const ProjectsByOwner =
  Query.make(
    "ProjectsByOwner",
    {
      Input: Schema.Struct({
        ownerId: UserId,
      }),

      Result:
        Query.connection(Project),
    },
  )
```

Then:

```ts
const ProjectsByOwnerSource =
  RemoteDrizzle.query(
    ProjectsByOwner,
    {
      entity: Project,

      where: ({ ownerId }) =>
        eq(
          projects.ownerId,
          ownerId,
        ),

      orderBy:
        desc(projects.createdAt),
    },
  )
```

Remote Server:

```ts
const Server =
  RemoteServer.make(
    Data,
    {
      entities: [
        ProjectSource,
        UserSource,
      ],

      queries: [
        ProjectsByOwnerSource,
      ],
    },
  )
```

And Drizzle's Effect-native Layer provides the actual DB.

---

# The dependency direction stays clean

```text
                    foldkit-remote
                          ▲
                          │
               foldkit-remote-server
                          ▲
                          │
              foldkit-remote-drizzle
                          │
                          ▼
                     Drizzle ORM
                          │
                          ▼
                  Effect Postgres
                          │
                          ▼
                    @effect/sql-pg
```

`remote-drizzle` itself should capture **no database connection**.

The generated Sources simply require Drizzle's Effect service.

That preserves Effect's Layer model.

---

# Could `remote-drizzle` disappear entirely?

Possibly.

That's actually the right bar to set.

If generic code is only:

```ts
RemoteServer.entity(
  Project,
  ({ ids, selection }) =>
    db.select(...)
)
```

and writing a Drizzle Source is straightforward, then don't make the package.

But if we can make this:

```ts
RemoteDrizzle.source(Project)
```

automatically deliver:

```text
field pruning
batched IDs
relation fetching
normalization
Selection-aware joins
query pagination
Effect Schema derivation
```

then it's very worthwhile.

I suspect it **will** be worthwhile, because Remote's field-level Selection AST maps unusually well onto Drizzle's typed partial-select machinery.

That's the actual package thesis:

> **`foldkit-remote-drizzle` is not a Drizzle driver. It is a compiler from Remote's declarative entity/selection graph into Drizzle's typed relational query graph.**

That framing makes much more sense now that Drizzle itself is Effect-native. ([Drizzle ORM][1])

[1]: https://orm.drizzle.team/docs/connect-effect-postgres?utm_source=chatgpt.com "Drizzle ORM - Effect Postgres"
[2]: https://orm.drizzle.team/docs/effect-schema?utm_source=chatgpt.com "Drizzle ORM - effect-schema"

Yes — **most of the architectural benefits of Fate, and arguably some additional ones that are uniquely Foldkit-native**.

The key is that the pieces line up surprisingly well:

| Fate concept               | Foldkit stack equivalent                    |
| -------------------------- | ------------------------------------------- |
| View / fragment            | `Selection` + `Projection`                  |
| Data masking               | `Surface`                                   |
| normalized cache           | `Remote.Model` entity store                 |
| entity refs                | `EntityRef`                                 |
| field-level fetch planning | `Remote.plan`                               |
| batched requests           | Remote `ReadBatch` + Effect RPC             |
| transport                  | Effect RPC Protocol Layers                  |
| server data views          | `RemoteServer.entity/query`                 |
| mutations                  | Foldkit Message → Command → `Remote.mutate` |
| optimistic updates         | Remote optimistic layers                    |
| live views                 | streaming Effect RPC → normalized patches   |
| persisted cache            | Effect Persistence / KV                     |
| React integration          | Foldkit Surface/view integration            |
| query composition          | Selection + Surface composition             |

So the core Fate loop:

```text
View declares fields
      ↓
cache checks what exists
      ↓
missing fields requested
      ↓
server fetches only those fields
      ↓
response normalized
      ↓
all dependent views update
```

becomes:

```text
Surface
   │
   ▼
Projection
   │
   ▼
Selection / Entity requirements
   │
   ▼
Remote.plan
   │
   ├── cache hit → read
   │
   └── cache miss
          ↓
      Effect RPC
          ↓
    RemoteServer
          ↓
     Drizzle compiler
          ↓
     selected columns
          ↓
   normalized patches
          ↓
    Remote.Message
          ↓
     Remote.update
          ↓
       Model
          ↓
       Surface
```

That's basically the same architectural payoff.

## And we get real data masking

This is one of Fate's most important ideas.

A Project page may declare:

```ts
const ProjectPage = Surface.define(
  App,
  "ProjectPage",
  {
    model: ({ params }) =>
      Projection.struct({
        project: pipe(
          Project.ref(params.projectId),
          Remote.select(
            AppRemote,
            ProjectSummary,
          ),
        ),
      }),

    messages: [
      Message.ClickedArchiveProject,
    ],
  },
)
```

and:

```ts
const ProjectSummary = Selection.make(
  Project,
  {
    id: true,
    name: true,
    status: true,
  },
)
```

The view sees:

```ts
model.project.value.id
model.project.value.name
model.project.value.status
```

but not:

```ts
model.project.value.billingData
model.project.value.internalNotes
```

because those fields aren't in the Selection.

That's essentially Fate/Relay data masking.

But Surface additionally masks **Messages**, which Fate doesn't really have an equivalent for:

```text
Fate:
what may this component know?

Surface:
what may this component know?
+
what may this component report?
```

That's arguably stronger.

---

## Normalized cache: yes

You get the main Fate behavior.

Suppose:

```text
Project:p1
├ id
├ name
├ owner → User:u7
```

and:

```text
User:u7
├ id
├ name
├ avatar
```

Three different Surfaces can reference the same User.

If one mutation changes:

```text
User:u7.name
```

you update that normalized entity once.

Every Surface selecting `User.name` sees the new value.

No:

```ts
queryClient.invalidateQueries(...)
```

No manually synchronizing copies of:

```text
projects
projectDetail
userProfile
searchResults
```

That's one of Fate's biggest wins.

---

## Field-level fetching: yes

And this is where Drizzle makes it especially compelling.

If the cache already contains:

```text
Project:p1

id      ✓
name    ✓
status  ✗
```

and the Surface requires:

```text
id
name
status
```

then:

```ts
Remote.plan(...)
```

should request only:

```text
Project:p1.status
```

`remote-drizzle` can turn that directly into approximately:

```sql
SELECT id, status
FROM projects
WHERE id = 'p1'
```

instead of fetching an entire DTO.

That's basically the Fate model all the way down to the database.

---

## Composition works like Fate fragments

Suppose:

```ts
const AvatarSelection =
  Selection.make(User, {
    id: true,
    name: true,
    avatarUrl: true,
  })
```

Project:

```ts
const ProjectSummary =
  Selection.make(Project, {
    id: true,
    name: true,
    owner: AvatarSelection,
  })
```

The parent doesn't duplicate Avatar's requirements.

They compose.

That gives you the same important property Relay/Fate have:

> local feature requirements compose upward into the total data requirement.

---

## Request deduplication gets arguably cleaner

If three Surfaces require:

```text
A:
Project:p1 { name, status }

B:
Project:p1 { name, owner }

C:
Project:p1 { status }
```

Remote combines:

```text
Project:p1
{
  name
  status
  owner
}
```

then subtracts what's already in the normalized cache.

The actual Effect RPC request contains only what's missing.

You don't need Fate's transport implementation specifically because Effect RPC already gives you the lower-level networking/runtime machinery.

---

## Optimistic updates: yes

Same normalized cache means:

```ts
Entity.patch(
  Project.ref(projectId),
  {
    name: "New Name",
  },
)
```

can be applied as an optimistic layer.

Every Surface selecting:

```text
Project:p1.name
```

immediately sees it.

On success:

```text
merge authoritative server patch
remove optimistic layer
```

On failure:

```text
remove optimistic layer
```

No manually patching several query caches.

Again, very Fate-like.

---

## Live data: yes

Effect RPC supports streaming, so live updates can arrive as:

```text
EntityPatch
QueryPatch
EntityDeleted
...
```

and go through:

```text
streaming RPC
     ↓
Remote.Message
     ↓
Remote.update
     ↓
same normalized cache
```

Which gives you the Fate live-view advantage:

> requests, mutations and live events all converge onto one cache.

No separate WebSocket-state subsystem.

---

## SSR/prefetch: yes

Because a Surface already describes its requirements:

```ts
Remote.prefetch(
  AppRemote,
  ProjectPage,
  params,
)
```

can derive everything needed.

Server:

```text
Surface
 ↓
requirements
 ↓
Remote.plan
 ↓
in-process Effect RPC
 ↓
populate Remote.Model
 ↓
render
 ↓
serialize Model
```

Client hydrates with the same normalized cache.

That's very close to what you'd want from Fate.

---

# But we'd gain some things Fate doesn't naturally give us

This is where I think the architecture potentially becomes more interesting than "Fate port."

### 1. Message capability masking

A Surface declares:

```ts
messages: [
  Message.RenamedProject,
  Message.ClickedArchiveProject,
]
```

So it describes not only:

```text
READS
```

but also:

```text
CAUSES
```

That gives agents, DevTools and architectural tooling a richer semantic graph.

---

### 2. Full application transition history

Because incoming Remote data becomes Foldkit Messages:

```text
ReceivedRemoteBatch
```

and cache changes happen in `update`, Foldkit's normal debugging/time-travel architecture can potentially understand:

```text
what data arrived
what Model changed
which Surface was affected
what Message caused a mutation
```

That's deeper integration than a sidecar query cache.

---

### 3. Agents get the same contract automatically

An agent can inspect:

```text
ProjectPage

observes:
  Project.name
  Project.status

may emit:
  ClickedArchiveProject
```

using the same declaration the UI uses.

You don't need to design an independent "agent API."

---

### 4. Sync and Remote compose

A Surface can contain:

```ts
Projection.struct({
  draft: model.sharedDraft,        // Sync
  project: remoteProject,          // Remote
  selection: model.selection,      // local
})
```

That gives one feature access to:

```text
local state
replicated state
server-derived state
```

while maintaining clear ownership boundaries.

Fate isn't trying to solve that whole topology.

---

## Where Fate would still be ahead initially

There are meaningful things we'd have to earn.

Fate already has a coherent, tested implementation of:

```text
normalized cache
field presence
list ordering
mutation reconciliation
optimistic updates
live subscription management
React/Vue bindings
server adapters
transport behavior
```

Our design doesn't magically get those details right just because the abstractions are nice.

The hardest pieces are likely:

```text
nested relation planning
partial-field correctness
query/connection reconciliation
optimistic layer rebasing
live + optimistic interaction
garbage collection
concurrent overlapping requests
request races/stale responses
entity deletion semantics
pagination insertion semantics
```

Those are implementation problems, not architectural problems.

And Fate has already done significant engineering there.

---

# One thing we probably wouldn't copy: Suspense-centric behavior

Fate can use React's rendering model.

Foldkit would probably keep:

```ts
RemoteData<
  | Initial
  | Loading
  | Ready
  | Refreshing
  | Failed
>
```

explicit.

I actually think that's appropriate.

Foldkit's philosophy is that application states should be visible rather than hidden in renderer behavior.

So we'd get most of Fate's data architecture without inheriting React-specific control flow.

---

# One feature Fate has that we'd need to deliberately replicate

**Stable lists/connections.**

Entities are relatively straightforward.

Lists are much harder.

We need:

```text
ProjectsByOwner({ ownerId })

ordered refs:
[
  Project:p4,
  Project:p9,
  Project:p2,
]

page info
```

and mutations need explicit semantics like:

```text
insert before
insert after
remove
replace
invalidate ordering
```

If we don't build Connections well, we'd only have ~70% of Fate.

If we do build:

```text
Entity
Selection
Query
Connection
Mutation
Optimistic layer
Live patch
```

correctly, we're much closer to **90%+ of the architectural value**.

---

## Roughly how I'd score it

If `Surface + Remote + RemoteServer + RemoteDrizzle` are implemented well:

| Fate capability                   |                      Our design |
| --------------------------------- | ------------------------------: |
| data masking                      |                         **yes** |
| fragment/selection composition    |                         **yes** |
| normalized entities               |                         **yes** |
| field presence                    |                         **yes** |
| minimal fetching                  |                         **yes** |
| batching/dedupe                   |                         **yes** |
| transport independence            |       **better via Effect RPC** |
| server field selection            |                         **yes** |
| ORM field pruning                 |  **yes, potentially excellent** |
| mutation reconciliation           |                         **yes** |
| optimistic updates                |                         **yes** |
| normalized lists                  |             **yes, needs work** |
| pagination                        |             **yes, needs work** |
| live data                         |       **yes via streaming RPC** |
| SSR/prefetch                      |                         **yes** |
| persistent cache                  |              **yes via Effect** |
| React Suspense DX                 | **no / deliberately different** |
| Foldkit state-machine integration |               **much stronger** |
| typed action/capability boundary  |                    **stronger** |
| agent introspection               |                    **stronger** |

So yes: **the goal should absolutely be "capture the important architectural benefits of Fate, but express them as native Foldkit + Effect primitives."**

And the stack now has a remarkably clean decomposition:

```text
Effect Optic
   → where local state lives

Surface Projection
   → what local state may be observed

Effect Schema
   → what data is

Remote Entity
   → what has normalized identity

Remote Selection
   → what remote fields are required

Remote.plan
   → what's missing

Effect RPC
   → how requests travel

RemoteServer
   → what requests mean

RemoteDrizzle
   → how requirements become SQL

Remote.Model
   → what the client currently knows

Foldkit Message/update
   → how all state changes
```

That feels like the right architecture.
