**Surface should be built on Effect Optic**, and **Entity should be built on Effect Schema.Struct**. Those two Effect primitives should eliminate a lot of machinery we were about to reinvent.

Effect v4 Optic already models `Lens`, `Prism`, `Optional`, `Traversal`, composition, immutable replacement/modification, struct-key focus, keyed optional focus, etc. For example, the current docs/source use `Optic.id<Person>().key("name")` for a guaranteed field and `.at("a")` for an optional/keyed focus.

## Surface should absolutely incorporate Optics

Our current:

```ts
App.model.session.user.name
```

should really be ergonomic syntax for an Effect optic plus Surface metadata.

Conceptually:

```ts
App.model.session.user.name
```

contains something like:

```ts
{
  optic: Optic.id<Model>()
    .key("session")
    .key("user")
    .key("name"),

  schema: Schema.String,

  dependency: [
    "session",
    "user",
    "name",
  ],
}
```

So `ModelRef` is basically:

```ts
interface ModelRef<Root, Value> {
  readonly optic: Optic.Lens<Root, Value>
  readonly schema: Schema.Schema<Value>
  readonly dependency: Dependency
}
```

Not literally always `Lens`—it might be `Optional`, `Traversal`, etc.—but that's the conceptual model.

That is much better than implementing our own:

```ts
get(model)
set(model, value)
path
```

logic.

Effect Optic already gives us the lawful read/update composition. Surface only adds the things Optic doesn't know about:

```text
Schema of the focus
dependency metadata
application identity
Surface observation semantics
```

So:

```text
Effect Optic
     +
Effect Schema
     +
dependency metadata
     =
ModelRef
```

That should be the actual design.

### It also improves Sync

This matters because `foldkit-sync` needs writable projections.

Today Sync has invented:

```ts
{
  schema,
  get,
  set,
}
```

A ModelRef backed by an Effect `Lens` already gives us the core of that.

So:

```ts
Sync.project({
  todos: App.model.todos,
})
```

can derive:

```text
schema → ModelRef.schema
get    → optic.get
set    → optic.replace
```

Meaning Effect Optic potentially deletes most of `sync/projection.ts`.

That's a strong sign we're at the right abstraction.

---

## Projection then becomes composition over ModelRefs

For example:

```ts
const Header = Projection.struct({
  user: App.model.session.user,
  route: App.model.route,
})
```

is roughly combining two optics into a read projection.

A nested selected ModelRef:

```ts
App.model.session.user
```

knows:

```text
Optic<Model, User>
Schema<User>
dependency path
```

And:

```ts
Projection.struct(...)
```

knows how to produce:

```ts
{
  user: User
  route: Route
}
```

while combining dependency metadata.

So Surface isn't an optics framework.

It's an **observation semantics layer over Effect Optics**.

---

# And yes: Entity should lean much harder on Schema

Our earlier Entity API:

```ts
const User = Entity.make("User", {
  id: UserId,

  fields: {
    name: Schema.String,
    avatarUrl: Schema.String,
  },
})
```

actually duplicates `Schema.Struct`.

I wouldn't do that anymore.

Instead:

```ts
const UserSchema = Schema.Struct({
  id: UserId,
  name: Schema.String,
  avatarUrl: Schema.String,
})

const User = Entity.make(
  "User",
  UserSchema,
)
```

That's much cleaner.

Effect Schema already knows:

```text
field names
field Schemas
decoded type
encoded type
validation
transforms
brands
optional fields
annotations
encoding services
decoding services
```

Why rebuild that?

Effect v4 also explicitly keeps struct field manipulation at the `Schema.Struct` level through field mappings and `Struct.pick`/`omit`, rather than manipulating low-level ASTs.

So `Entity` should be a very thin semantic wrapper around a Struct Schema.

---

# `id` can be inferred

If we adopt a convention:

> Every normalized Entity has an `id` field.

Then:

```ts
const User = Entity.make(
  "User",
  Schema.Struct({
    id: UserId,
    name: Schema.String,
  }),
)
```

can infer:

```ts
User.Id
```

as:

```ts
typeof UserSchema.fields.id.Type
```

and:

```ts
User.ref(id)
```

automatically requires `UserId`.

So this:

```ts
User.ref(userId)
```

works.

This:

```ts
User.ref(projectId)
```

fails.

No:

```ts
id: UserId
```

needs to be repeated outside the Struct.

That's a notable DX improvement.

---

# Maybe Entity is almost this small

Conceptually:

```ts
interface Entity<
  Name extends string,
  S extends Schema.Struct<any>
> {
  readonly name: Name
  readonly schema: S
  readonly id: S["fields"]["id"]
}
```

plus normalization metadata.

Usage:

```ts
const User = Entity.make(
  "User",

  Schema.Struct({
    id: UserId,
    name: Schema.String,
    avatarUrl: Schema.String,
  }),
)
```

Then:

```ts
User.schema
User.fields
User.id
User.ref(userId)
```

could all derive naturally.

Potentially:

```ts
User.fields === User.schema.fields
```

rather than inventing another field namespace.

---

# Relations are the only tricky part

This is where Entity needs to add something Schema alone doesn't represent.

Suppose:

```ts
const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  owner: ???,
})
```

We need `owner` to mean:

> This is a relation to normalized `User`, not merely some structurally equivalent object.

There are a few ways to model that.

I think the cleanest is to make **Entity references themselves Schemas**.

Something like:

```ts
const Project = Entity.make(
  "Project",

  Schema.Struct({
    id: ProjectId,
    name: Schema.String,

    owner: Entity.ref(User),
  }),
)
```

where:

```ts
Entity.ref(User)
```

is both:

```text
a Schema
+
normalization metadata
```

This would be excellent if we can make the types pleasant.

Then `Project.schema` is still a perfectly normal Effect Schema tree.

But Remote knows that:

```ts
owner: Entity.ref(User)
```

means:

```text
normalize the relationship to User:u7
```

rather than store the User inline.

---

# The decoded type is an interesting design choice

There are two plausible representations.

### Option A: decoded field is an `EntityRef<User>`

```ts
type Project = {
  id: ProjectId
  name: string
  owner: EntityRef<typeof User>
}
```

The normalized store directly matches the Schema type.

Very pure.

But selections then have to dereference relationships.

### Option B: entity Schema describes the domain object

```ts
type Project = {
  id: ProjectId
  name: string
  owner: User
}
```

while Remote internally normalizes:

```text
owner → User:u7
```

This is closer to Fate.

I think **B is nicer for selections and Sources**, while normalized cache representation remains internal.

In other words:

```text
Entity Schema
    domain representation

Normalized Entity Store
    storage representation
```

and Remote owns the transformation between them.

That is already something Effect Schema is very good at expressing: **decoded and encoded forms can differ**.

---

# There may be a really elegant Schema transformation here

For example, conceptually:

```ts
const UserRef = Entity.ref(User)
```

could have:

```text
decoded:
  User

encoded/internal:
  EntityRef<User>
```

or perhaps vice versa depending where the codec boundary belongs.

Effect Schema supports distinct encoded and decoded types, so we should seriously explore using that rather than inventing separate "relation field metadata + codec" machinery.

Then:

```ts
Schema.Struct({
  id: ProjectId,
  owner: Entity.ref(User),
})
```

could simultaneously describe:

```text
application form:
{
  id,
  owner: User
}

normalized form:
{
  id,
  owner: UserRef
}
```

That could be very powerful.

I wouldn't commit to the exact direction until prototyped, because recursive Entity schemas and partial field selections may complicate encoding.

But **Schema transformations are exactly the machinery we should investigate**.

---

# Selection should also derive Schemas

This is another place Schema helps us.

Given:

```ts
const User = Entity.make(
  "User",
  Schema.Struct({
    id: UserId,
    name: Schema.String,
    email: Schema.String,
    avatarUrl: Schema.String,
  }),
)
```

and:

```ts
const UserSummary = Selection.make(User, {
  id: true,
  name: true,
  avatarUrl: true,
})
```

`UserSummary` should derive an Effect Schema equivalent to:

```ts
Schema.Struct({
  id: UserId,
  name: Schema.String,
  avatarUrl: Schema.String,
})
```

Not merely a TypeScript type.

So:

```ts
UserSummary.schema
```

exists at runtime.

That gives us automatically:

```text
static type
runtime validation
RPC codec
MCP/JSON Schema
cache validation
SSR serialization
testing
```

from one selection.

That's enormous leverage.

---

# `Selection.make` is therefore basically Schema selection + relation semantics

For scalar fields:

```ts
Selection.make(User, {
  id: true,
  name: true,
})
```

can internally operate over:

```ts
User.schema.fields
```

and construct a new Struct Schema.

For relations:

```ts
owner: UserSummary
```

it recursively uses:

```ts
UserSummary.schema
```

while retaining remote requirement metadata.

So:

```text
Selection
=
derived Schema
+
remote requirement AST
```

Very analogous to:

```text
ModelRef
=
Optic
+
Schema
+
dependency metadata
```

Notice the symmetry.

---

# I think these become the foundational formulas

For Surface:

```text
ModelRef
=
Optic
+
Schema
+
Model dependency metadata
```

For Remote:

```text
Entity
=
Schema.Struct
+
stable entity identity
+
normalization metadata
```

For Selection:

```text
Selection
=
derived Schema
+
remote field requirement metadata
```

For Surface itself:

```text
Surface
=
Projection
+
Message constructor references
```

That's beautifully small.

---

# Even Query and Mutation should just carry Schema

Query:

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

The input Schema already gives us:

```text
decoded input
encoded input
runtime decoder
RPC codec
canonicalizable representation
JSON Schema
```

Mutation:

```ts
const RenameProject = Mutation.make(
  "RenameProject",
  {
    Input: Schema.Struct({
      id: ProjectId,
      name: Schema.String,
    }),

    Output: Schema.Struct({
      projectId: ProjectId,
    }),
  },
)
```

Again, no extra generic declarations.

---

# Remote patches should also be Schema-derived

Given:

```ts
Project
```

this:

```ts
Entity.patch(
  Project.ref(id),
  {
    name: "Foo",
  },
)
```

should type-check against Project's Schema fields.

This fails:

```ts
Entity.patch(
  Project.ref(id),
  {
    banana: 123,
  },
)
```

And this fails:

```ts
Entity.patch(
  Project.ref(id),
  {
    status: 123,
  },
)
```

The patch schema can be derived from the Entity's `Schema.Struct` fields.

No secondary field type system.

---

# Schema annotations might even carry Remote metadata

There's an even more aggressive possibility.

Instead of wrapping relation schemas in a bespoke object hierarchy, some Remote-specific metadata could be attached using Schema annotations.

Conceptually:

```ts
Entity.ref(User)
```

could produce a Schema annotated with:

```text
RemoteRelation = User
```

Then Remote's Selection/compiler walks the Struct Schema and reads those annotations.

This would mean Entity schemas remain ordinary Effect Schemas all the way down.

I think that is worth prototyping.

I would not necessarily expose annotation mechanics publicly, but internally:

```text
Schema AST
+
Remote relation annotation
```

could eliminate yet another parallel representation.

---

# But don't overuse Schema AST

Important caveat.

Effect v4's migration guidance explicitly pushes field manipulation back toward the public Struct-level APIs instead of low-level AST picking.

So Remote shouldn't become:

```text
inspect arbitrary Schema AST
reverse engineer everything
```

for normal operations.

Prefer:

```ts
Schema.Struct
schema.fields
Struct.pick
schema.mapFields(...)
```

and use annotations only for genuinely Remote-specific metadata.

Keep the supported Entity input intentionally constrained to Struct-like schemas if necessary.

That's better than claiming arbitrary Schema support and ending up with extremely complex inference.

---

# I'd constrain Entity initially

Instead of:

```ts
Entity.make(
  "Whatever",
  arbitrarySchema,
)
```

I'd require:

```text
Schema.Struct
with an `id` field
```

That buys us:

```text
known fields
field lookup
partial selections
patch schemas
ID extraction
good inference
```

without needing to solve arbitrary:

```text
Union
transform
recursive custom declaration
refinement
```

as entity roots.

Individual fields can still use rich Effect Schemas.

For example:

```ts
Schema.Struct({
  id: ProjectId,

  email:
    Schema.String.check(...),

  createdAt:
    Schema.Date,

  amount:
    Schema.NumberFromString,

  owner:
    Entity.ref(User),
})
```

So you aren't losing Schema power.

---

# This changes our public Entity API

I would now prefer:

```ts
const User = Entity.make(
  "User",

  Schema.Struct({
    id: UserId,
    name: Schema.String,
    avatarUrl: Schema.String,
  }),
)
```

over:

```ts
const User = Entity.make("User", {
  id: UserId,

  fields: {
    name: Schema.String,
    avatarUrl: Schema.String,
  },
})
```

The first is much more Effect-native.

Likewise:

```ts
const Project = Entity.make(
  "Project",

  Schema.Struct({
    id: ProjectId,
    name: Schema.String,
    status: ProjectStatus,
    owner: Entity.ref(User),
  }),
)
```

That's probably the API I'd prototype.

---

# The whole stack becomes very "Effect-shaped"

```text
Effect Optic
   │
   ▼
ModelRef
   │
   ▼
Projection
   │
   ▼
Surface


Effect Schema.Struct
   │
   ▼
Entity
   │
   ▼
Selection
   │
   ▼
Remote Projection


Effect Schema
   │
   ├── Query Input
   ├── Mutation Input/Output
   ├── RPC encoding
   ├── cache validation
   └── persistence encoding


Effect RPC
   │
   ▼
Remote wire execution


Effect Persistence
   │
   ▼
optional Remote cache persistence
```

That's much better than designing `foldkit-plus` as a parallel framework on top of Effect.

I'd now state the design principle as:

> **Whenever Effect already has a lawful structural primitive, Foldkit Plus should enrich it with Foldkit semantics rather than replace it.**

Optic gets enriched into `ModelRef`.

Schema.Struct gets enriched into `Entity`.

Schema-derived selections become `Selection`.

Effect RPC carries Remote operations.

Effect persistence stores Remote snapshots.

That should make the whole ecosystem feel like a natural extension of Effect/Foldkit rather than a separate stack layered beside them.

# Foldkit Surfaces

## Explicit observation and capability boundaries for Foldkit applications

**Status:** Proposal
**Target:** Foldkit / Effect v4
**Working names:** `Surface`, `Projection`, `ModelRef`

---

## 1. Summary

Foldkit makes the important parts of an application explicit:

* **Model** — application state
* **Message** — facts that happened
* **update** — state transitions
* **Command** — effects requested by those transitions
* **Submodel** — independently owned state machines

What Foldkit does not currently make explicit is the boundary between a particular piece of UI and the larger application:

1. **What part of the Model may this feature observe?**
2. **What subset of Messages may this feature produce?**

Today a view generally receives:

```ts
(model: Model, h: HtmlBuilder<Message>)
```

Even when the view only needs:

```ts
model.projects[id].name
model.projects[id].status
```

and only emits:

```ts
Message.ChangedProjectName
Message.ClickedArchiveProject
```

The entire Model and entire Message universe are still available.

This proposal introduces **Surface** as a declarative boundary around existing Foldkit architecture.

A Surface declares:

```text
what this feature may know
+
what this feature may report
```

The central API is:

```ts
const ProjectCard = Surface.define(App, "ProjectCard", {
  Params: Schema.Struct({
    projectId: ProjectId,
  }),

  model: ({ model, params }) =>
    Projection.struct({
      project: model.projects
        .at(params.projectId)
        .select(ProjectSummary),
    }),

  messages: [
    Message.ChangedProjectName,
    Message.ClickedArchiveProject,
  ],
})
```

The resulting view receives only the selected Model:

```ts
const projectCardView = Surface.view(
  ProjectCard,
  (model, h) =>
    h.article([], [
      h.h2([], [model.project.name]),

      h.button(
        [
          h.OnClick(
            Message.ClickedArchiveProject({
              projectId: model.project.id,
            }),
          ),
        ],
        ["Archive"],
      ),
    ]),
)
```

Inside this view:

```ts
model
```

is inferred as only the projected state.

And:

```ts
h
```

only permits the Messages declared by the Surface.

The Surface therefore becomes a statically checked statement of:

```text
OBSERVATION

What can this feature know?


CAPABILITY

What can this feature cause the application to hear?
```

This is inspired by Fate/Relay-style data masking, but adapted to Foldkit's existing Model/Message architecture rather than introducing a query system, normalized cache, or separate component architecture.

---

# 2. Motivation

Foldkit already solves application-wide implicitness unusually well.

State changes pass through Messages and `update`. Effects become Commands. The Model is Schema-defined and remains the source of truth. Foldkit deliberately rejects hidden mutation and arbitrary component-owned state.

But views still have an unusually broad authority:

```ts
const view = (
  model: Model,
  h: HtmlBuilder<Message>,
) => ...
```

That grants two capabilities simultaneously:

```text
read anything in Model

emit anything in Message
```

Large applications therefore retain a form of ambient authority even though their transitions themselves are explicit.

Consider:

```ts
const projectCardView = (
  model: Model,
  h: HtmlBuilder<Message>,
) => ...
```

Nothing prevents it from later reaching into:

```ts
model.billing
model.admin
model.session.tokens
model.projects.otherProject
```

Likewise, nothing in its type prevents it from constructing:

```ts
Message.LoggedUserOut()
Message.DeletedWorkspace()
Message.ClickedAdminReset()
```

even if none of those concepts belong to ProjectCard.

Code review and convention can enforce the intended boundary.

The type system cannot.

Surface makes that boundary part of the program.

---

# 3. Design principles

The proposal should satisfy the following rules.

### 3.1 Foldkit remains Foldkit

Surface must not replace:

```text
Model
Message
update
Command
Submodel
OutMessage
```

It operates above them.

---

### 3.2 The Model remains the single source of truth

A Projection is a view of the Model.

It is not storage.

There is no second cache:

```text
                   Model
                     │
             ┌───────┼───────┐
             ▼       ▼       ▼
         Projection Projection Projection
```

---

### 3.3 Messages remain facts

A Surface does not invent:

```ts
send.archive(...)
send.rename(...)
```

The UI still produces:

```ts
Message.ClickedArchiveProject(...)
Message.ChangedProjectName(...)
```

Foldkit intentionally models Messages as verb-first facts and Commands as imperative effects. Surface should strengthen that distinction, not obscure it.

---

### 3.4 Commands remain invisible to Surface

The architecture remains:

```text
Surface
   │
   ├── observes Model
   │
   └── produces Message
              │
              ▼
            update
              │
              ▼
           Command
              │
              ▼
            Effect
```

Surface has no Command API.

---

### 3.5 Existing values should be referenced, not redescribed

This is invalid design:

```ts
messages: [
  "ClickedArchiveProject",
  "ChangedProjectName",
]
```

The Surface must reference the actual constructors:

```ts
messages: [
  Message.ClickedArchiveProject,
  Message.ChangedProjectName,
]
```

Likewise Model structure should preferably be accessed through typed references rather than string paths.

---

### 3.6 No implicit dependency tracking

This should not exist:

```ts
Surface.select(model => ({
  name: model.project.name,
}))
```

if the implementation discovers dependencies by running the callback against a Proxy.

Ordinary property reads should never secretly mean:

> register this path as a dependency.

Dependencies are declared.

They are not discovered from incidental execution.

---

### 3.7 Runtime and static representation should agree

A Surface should be useful simultaneously to:

```text
TypeScript
runtime
DevTools
tests
MCP
documentation
render optimization
```

The declaration should produce a real runtime descriptor, not disappear after type checking.

---

# 4. Concepts

The proposal introduces two primary concepts and one supporting reference type.

## 4.1 ModelRef

A `ModelRef<A>` identifies a location within the application's Model.

It contains enough information to:

* infer the focused type,
* read the value,
* compose deeper references,
* identify its dependency path,
* expose runtime metadata.

Conceptually:

```ts
interface ModelRef<Root, Value> {
  readonly Schema: Schema.Schema<Value>
  readonly optic: Optic<Root, Value>
  readonly dependency: Dependency
}
```

The exact implementation type is internal.

Effect v4's `Optic` is a natural substrate for the actual focus operation.

Surface adds the dependency metadata necessary for DevTools, introspection, invalidation and agents.

---

## 4.2 Projection

A `Projection<Root, Value>` declares an observable projection of a root Model.

For example:

```ts
const UserSummary = Projection.of(User)({
  id: true,
  name: true,
  avatarUrl: true,
})
```

Conceptually:

```text
User

id
name
avatarUrl
email
settings
permissions
billing

        │
        ▼

UserSummary

id
name
avatarUrl
```

A Projection carries:

```ts
interface Projection<Root, Value> {
  readonly Model: Schema.Schema<Value>
  readonly dependencies: DependencyTree

  read(root: Root): Value
}
```

A `ModelRef` can itself act as a Projection selecting the entire focused value.

---

## 4.3 Surface

A Surface combines:

```text
Projection
+
Message subset
+
optional Params
+
identity/metadata
```

It does not own state.

It does not own an update function.

It is therefore distinct from a Submodel.

```text
SUBMODEL
────────

owns Model
owns Message
owns update
may own Commands
may emit OutMessage


SURFACE
───────

observes an existing Model
permits a subset of existing Messages
owns no transitions
owns no effects
```

A Submodel is an ownership boundary.

A Surface is an access boundary.

They are complementary.

---

# 5. Application scope

Surfaces need to know which Model and Message universe they belong to.

Rather than repeating generic arguments:

```ts
Surface<Model, Message, ...>
```

the application creates a scope once:

```ts
export const App = Surface.make({
  Model,
  Message,
})
```

`Surface.make` is purely descriptive.

It does not create or run a Foldkit Runtime.

It produces:

```ts
App.Model
App.Message
App.model
```

where:

```ts
App.Model === Model
App.Message === Message
```

and:

```ts
App.model
```

is the typed root `ModelRef`.

For example:

```ts
App.model.session
App.model.session.user
App.model.projects
App.model.route
```

These expressions do **not** read application state.

They construct references.

---

# 6. Typed reference syntax

Given:

```ts
const Model = Schema.Struct({
  session: Session,
  projects: Projects,
  route: AppRoute,
})
```

this:

```ts
const App = Surface.make({
  Model,
  Message,
})
```

provides:

```ts
App.model.session
App.model.projects
App.model.route
```

Every property is statically derived from the Model Schema.

For a nested Struct:

```ts
App.model.session.user.name
```

is a typed reference to:

```ts
Model["session"]["user"]["name"]
```

No `"session.user.name"` string exists.

No selector callback is inspected.

No Model value has been read.

---

## 6.1 Implementation note: Proxy use

The ergonomic reference tree may reasonably use a JavaScript `Proxy` internally.

That does **not** imply Proxy-based dependency tracking.

There is an important distinction:

### Rejected

```ts
select(model => model.user.name)
```

Run arbitrary user code against a Proxy and infer what happened.

### Allowed

```ts
App.model.user.name
```

Property access explicitly constructs:

```text
ModelRef<Model, string>
```

The expression itself is the dependency declaration.

The Proxy is merely syntax for constructing an immutable descriptor.

A non-Proxy implementation or lower-level API can coexist if necessary.

---

# 7. Projection API

## 7.1 Selecting an entire reference

Any ModelRef can be used as a Projection.

```ts
Projection.struct({
  route: App.model.route,
  theme: App.model.theme,
})
```

produces:

```ts
{
  route: AppRoute
  theme: Theme
}
```

---

## 7.2 Reusable structural projections

```ts
const UserSummary = Projection.of(User)({
  id: true,
  name: true,
  avatarUrl: true,
})
```

Nested projections compose:

```ts
const ProjectSummary = Projection.of(Project)({
  id: true,
  name: true,
  status: true,
  owner: UserSummary,
})
```

This produces:

```ts
{
  id: ProjectId
  name: string
  status: ProjectStatus

  owner: {
    id: UserId
    name: string
    avatarUrl: string
  }
}
```

The keys are checked against the referenced Schema.

They are not free-form path strings.

---

## 7.3 Selecting a Projection from a ModelRef

```ts
App.model.session.user.select(UserSummary)
```

returns:

```ts
Projection<
  Model,
  UserSummary.Model.Type
>
```

Example:

```ts
Projection.struct({
  currentUser: App.model.session.user.select(UserSummary),
})
```

---

## 7.4 Combining unrelated references

```ts
const HeaderModel = Projection.struct({
  user: App.model.session.user.select(UserSummary),
  route: App.model.route,
  notificationCount: App.model.notifications.count,
})
```

The inferred result is:

```ts
{
  user: UserSummary
  route: AppRoute
  notificationCount: number
}
```

and its dependency metadata is the union of the dependencies of all three children.

---

## 7.5 Option

For an optional focused value:

```ts
const MaybeUserSummary =
  Projection.option(UserSummary)
```

This maps:

```text
Option<User>
```

to:

```text
Option<UserSummary>
```

while preserving absence.

---

## 7.6 Arrays

```ts
const ProjectList =
  Projection.array(ProjectSummary)
```

maps:

```text
ReadonlyArray<Project>
```

to:

```text
ReadonlyArray<ProjectSummary>
```

---

## 7.7 Records and keyed containers

A keyed collection reference supports:

```ts
App.model.projects.at(projectId)
```

Safe lookup semantics should be preserved.

If the underlying collection does not guarantee that a key exists, the resulting focus is optional:

```ts
ModelRef<Model, Option<Project>>
```

The API should not introduce an unsafe:

```ts
.getOrThrow()
```

merely for Surface convenience.

Foldkit's existing preference for making invalid or absent state explicit should remain intact.

---

# 8. Initial Projection API

The proposed v1 public API is intentionally small:

```ts
Projection.of(Schema)(selection)

Projection.struct({
  ...
})

Projection.array(projection)

Projection.option(projection)

Projection.read(projection, model)
Projection.read(projection)(model)
```

ModelRefs provide:

```ts
ref.select(projection)

ref.at(key)

ref.index(index)
```

where those operations make sense for the referenced Schema.

No general `Projection.map` is included initially.

Derived display values can be computed by the view:

```ts
const fullName =
  `${model.user.firstName} ${model.user.lastName}`
```

This keeps a Projection semantically close to:

> data this Surface observes from Model

rather than gradually becoming another derived-state system.

A later `Projection.map` can be added if real applications establish the need.

---

# 9. Defining a Surface

The basic form is:

```ts
const ProjectCard = Surface.define(
  App,
  "ProjectCard",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        project: model.projects
          .at(params.projectId)
          .select(ProjectSummary),
      }),

    messages: [
      Message.ChangedProjectName,
      Message.ClickedArchiveProject,
    ],
  },
)
```

`"ProjectCard"` is a diagnostic identifier.

It is not a magic reference to another program value.

It exists for:

* DevTools,
* diagnostics,
* MCP,
* documentation,
* duplicate detection.

Renaming it cannot change application semantics.

---

# 10. Surfaces without Params

`Params` is optional.

```ts
const SessionBadge = Surface.define(
  App,
  "SessionBadge",
  {
    model: ({ model }) =>
      model.session.user.select(UserSummary),

    messages: [
      Message.ClickedUserAvatar,
    ],
  },
)
```

Conceptually its Params type is `void`.

---

# 11. Read-only Surfaces

`messages` may be omitted.

```ts
const BuildVersion = Surface.define(
  App,
  "BuildVersion",
  {
    model: ({ model }) =>
      Projection.struct({
        version: model.application.version,
      }),
  },
)
```

Its Message type is:

```ts
never
```

It cannot construct an interactive Foldkit attribute requiring a Message.

---

# 12. Surface result API

A defined Surface exposes:

```ts
ProjectCard.name

ProjectCard.Params

ProjectCard.Model

ProjectCard.Message

ProjectCard.messages

ProjectCard.projection(params)
```

### `name`

```ts
"ProjectCard"
```

### `Params`

The supplied Effect Schema.

```ts
typeof ProjectCard.Params.Type
```

is:

```ts
{
  projectId: ProjectId
}
```

### `Model`

A Schema for the projected Model.

```ts
typeof ProjectCard.Model.Type
```

is inferred as:

```ts
{
  project: {
    id: ProjectId
    name: string
    status: ProjectStatus
    owner: {
      id: UserId
      name: string
      avatarUrl: string
    }
  }
}
```

No parallel TypeScript interface is declared.

### `messages`

The original constructor references:

```ts
[
  Message.ChangedProjectName,
  Message.ClickedArchiveProject,
]
```

### `Message`

A generated Schema representing the allowed Message union.

Therefore:

```ts
typeof ProjectCard.Message.Type
```

is equivalent to:

```ts
ChangedProjectName
| ClickedArchiveProject
```

The application still constructs Messages through the original union:

```ts
Message.ClickedArchiveProject(...)
```

`ProjectCard.Message` exists for typing, validation, introspection and integrations.

It does not create a second Message vocabulary.

### `projection(params)`

Returns the parameterized Projection for this Surface.

This is especially important for Surface composition.

---

# 13. Message inference

Message constructors themselves are capability references.

Given:

```ts
messages: [
  Message.ChangedProjectName,
  Message.ClickedArchiveProject,
]
```

`Surface.define` uses a `const` generic so TypeScript preserves the tuple without requiring:

```ts
as const
```

or explicit generics.

Conceptually:

```ts
type SurfaceMessage =
  MessageOf<
    typeof messages[number]
  >
```

The declaration therefore has one source of truth:

```text
actual Message constructor
        │
        ├── constructs Messages
        ├── defines Surface capability
        ├── provides payload Schema
        ├── powers MCP metadata
        └── powers DevTools
```

---

# 14. Surface views

A Surface can type a view:

```ts
const projectCardView = Surface.view(
  ProjectCard,
  (model, h) =>
    h.article([], [
      h.h2([], [model.project.name]),

      h.button(
        [
          h.OnClick(
            Message.ClickedArchiveProject({
              projectId: model.project.id,
            }),
          ),
        ],
        ["Archive"],
      ),
    ]),
)
```

Both arguments are inferred.

No annotation is necessary.

Inside the callback:

```ts
model
```

is:

```ts
typeof ProjectCard.Model.Type
```

and:

```ts
h
```

behaves as:

```ts
HtmlBuilder<
  typeof ProjectCard.Message.Type
>
```

This works:

```ts
h.OnClick(
  Message.ClickedArchiveProject({
    projectId: model.project.id,
  }),
)
```

This does not:

```ts
h.OnClick(
  Message.LoggedUserOut(),
)
```

unless `LoggedUserOut` belongs to the Surface's declared Message set.

---

# 15. Rendering from an ordinary Foldkit view

Surfaces do not require a new Runtime.

An existing root view can resolve a Surface explicitly:

```ts
const view = (
  model: Model,
  h: HtmlBuilder<Message>,
): Document => {
  const projectCardModel = Surface.read(
    ProjectCard,
    model,
    {
      projectId: model.route.projectId,
    },
  )

  return {
    title: "Project",

    body: projectCardView(
      projectCardModel,
      h,
    ),
  }
}
```

`Surface.read` supports both Effect-style forms:

```ts
Surface.read(surface, model, params)
```

and:

```ts
pipe(
  model,
  Surface.read(surface, params),
)
```

Use `pipe` when it improves data flow; ordinary direct calls remain ordinary direct calls, matching Foldkit's existing style guidance.

---

# 16. View composition

Surface composition should use ordinary values and ordinary functions.

There is no:

```ts
children: {
  ProjectCard,
}
```

registry.

Suppose a page contains ProjectCard.

The page can compose the child's Projection:

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
        card: ProjectCard.projection({
          projectId: params.projectId,
        }),

        canNavigateBack:
          model.navigation.canNavigateBack,
      }),

    messages: [
      ...ProjectCard.messages,
      Message.ClickedBack,
    ],
  },
)
```

Notice that the child contract is reused twice:

```ts
ProjectCard.projection(...)
```

for its observational requirements, and:

```ts
...ProjectCard.messages
```

for its behavioral requirements.

There is no re-description.

---

# 17. Child rendering

The parent view receives:

```ts
model.card
```

with exactly the child's Model shape.

Therefore:

```ts
const projectPageView = Surface.view(
  ProjectPage,
  (model, h) =>
    h.main([], [
      projectCardView(
        model.card,
        h,
      ),
    ]),
)
```

should type-check.

`Surface.view` should make its resulting view polymorphic over any parent `HtmlBuilder` whose Message universe contains the child's Message universe.

Conceptually:

```text
ProjectCard Messages
        ⊆
ProjectPage Messages
```

therefore:

```text
ProjectPage HtmlBuilder
        can safely be used by
ProjectCard view
```

Inside ProjectCard, however, the builder remains narrowed to ProjectCard's own Message set.

The child cannot gain access to additional parent Messages merely because its parent happens to support them.

This provides capability composition without wrapper Messages or dispatcher adapters.

---

# 18. Composition invariant

A child Surface can be used directly when two conditions hold:

```text
child Model requirement
        is provided by
parent projected Model

AND

child Message set
        ⊆
parent Message set
```

That is the complete composition rule.

This can be statically checked.

---

# 19. Submodels and Surfaces

A Submodel may expose one or more Surfaces.

For example:

```text
ProjectEditor Submodel

owns:
  editing state
  validation state
  update logic
  Commands

may expose:

ProjectEditor.FormSurface
ProjectEditor.ToolbarSurface
ProjectEditor.StatusSurface
```

The Submodel remains responsible for state transitions.

The Surfaces describe different observation/capability boundaries over it.

This creates a useful separation:

```text
ownership topology
    Submodels

observation topology
    Surfaces
```

They need not be identical.

---

# 20. Commands

Surface does not expose Commands.

This is intentional.

The following API should not exist:

```ts
Surface.define({
  commands: [
    SaveProject,
  ],
})
```

Nor:

```ts
actions.rename.pending
```

Nor:

```ts
Surface.Action(...)
```

The existing Foldkit flow already answers that problem:

```text
ClickedSave
    │
    ▼
  update
    │
    ▼
SaveProject
    │
    ▼
CompletedSaveProject
    │
    ▼
  update
```

Foldkit explicitly confines side effects to Commands produced by update.

Surface should not add another mutation abstraction.

---

# 21. No normalized cache

Surface is not Fate's cache architecture transplanted into Foldkit.

There is no:

```text
User:123
Project:456
```

entity store unless the application's Model itself chooses such a representation.

The Model is authoritative.

```text
              Model
                │
                ▼
            ModelRef
                │
                ▼
           Projection
                │
                ▼
             Surface
                │
                ▼
               view
```

Fate inspired the idea of explicit observational boundaries.

Foldkit already supplies the state architecture.

---

# 22. No automatic Message inference

Surface should not infer allowed Messages from what its view currently happens to construct.

For example, this:

```ts
Surface.view(ProjectCard, ...)
```

must not inspect the view and conclude:

```text
apparently this view emits
ClickedArchiveProject
```

The distinction is the same reason Projection exists.

The contract is:

```text
what the feature MAY depend on
```

not:

```text
what today's implementation happened to use
```

A future edit attempting to emit an undeclared Message should fail.

That is the feature.

---

# 23. Runtime descriptor

A Surface is a real immutable descriptor.

Conceptually:

```ts
interface Surface<
  RootModel,
  Model,
  Message,
  Params,
> {
  readonly name: string

  readonly Params: Schema.Schema<Params>

  readonly Model: Schema.Schema<Model>

  readonly Message: Schema.Schema<Message>

  readonly messages:
    ReadonlyArray<MessageConstructor>

  readonly dependencies:
    DependencyTree

  readonly projection:
    (params: Params) =>
      Projection<RootModel, Model>
}
```

Additional internal metadata may include:

```ts
scopeId
messageMetadata
projectionMetadata
sourceLocation?
```

but application semantics should not depend on them.

---

# 24. Projection descriptor

Conceptually:

```ts
interface Projection<Root, Value> {
  readonly Model:
    Schema.Schema<Value>

  readonly dependencies:
    DependencyTree

  readonly read:
    (root: Root) => Value
}
```

A dependency tree may look like:

```ts
{
  projects: {
    kind: "at",
    key: projectId,

    children: {
      id: true,
      name: true,
      status: true,
    },
  },
}
```

The exact representation is internal.

It should be serializable where practical.

---

# 25. Why metadata matters

The Projection could simply be:

```ts
Model => Value
```

but then Foldkit would know the output without understanding the dependency.

Keeping structural metadata enables many capabilities from one declaration:

```text
Projection
    │
    ├── compile-time masking
    ├── runtime reading
    ├── DevTools
    ├── documentation
    ├── test fixtures
    ├── render invalidation
    ├── MCP descriptions
    └── architectural analysis
```

That leverage is the reason to introduce the primitive.

---

# 26. Effect v4 integration

Effect v4 includes first-class optics for typed immutable focus and composition.

ModelRef should use Effect Optic internally wherever its semantics align.

For example, conceptually:

```text
ModelRef

Optic:
  how to focus

Dependency:
  what was focused

Schema:
  what type/value lives there
```

Surface should not expose raw Optics as its main API because Optics alone do not encode the metadata Surface needs.

Instead:

```text
Effect Optic
     +
Schema
     +
dependency descriptor
     =
ModelRef
```

A low-level bridge may be provided for extension:

```ts
ModelRef.fromOptic(...)
```

but ordinary application code should rarely need it.

---

# 27. Type-safety requirements

The implementation should satisfy the following.

### Invalid Model fields fail

```ts
Projection.of(Project)({
  doesNotExist: true,
})
```

must fail.

### Wrong nested Projection fails

```ts
Projection.of(Project)({
  owner: ProjectSummary,
})
```

must fail when `owner` is a User.

### Invalid collection key type fails

```ts
model.projects.at(123)
```

must fail if projects are keyed by `ProjectId`.

### Message outside application scope fails

```ts
Surface.define(App, ..., {
  messages: [
    OtherApplication.Message.Foo,
  ],
})
```

should fail whenever the types establish that the constructor is outside `App.Message`.

### Invalid Message in view fails

```ts
Surface.view(ProjectCard, (_, h) =>
  h.button([
    h.OnClick(Message.DeletedAccount()),
  ])
)
```

must fail unless that Message was granted.

### Child capability mismatch fails

A child view requiring:

```text
ClickedArchiveProject
```

cannot be rendered inside a parent builder whose Message set omits it.

### Params are inferred

No explicit generic arguments should be necessary.

### Model output is inferred

No manual TypeScript interface should duplicate the Projection.

---

# 28. Structural typing caveat

TypeScript is structurally typed.

Two independently declared Message variants with exactly the same runtime shape may therefore be structurally compatible even when they came from different unions.

Surface should provide all safety available from Foldkit's existing Message representation.

If strict nominal application isolation becomes important, Foldkit could eventually attach a hidden union identity to Message constructors without changing serialized Message values.

That should not block the initial design.

The important invariant is that users never manually reproduce a Message tag or payload in a Surface declaration.

---

# 29. Developer experience

A developer working in ProjectCard sees approximately:

```text
model.
  project.
    id
    name
    status
    owner.
      id
      name
      avatarUrl
```

and the editor knows the allowed Message type.

Attempts to reach unrelated state simply do not compile:

```ts
model.billing
// Property 'billing' does not exist
```

The API therefore makes the local feature boundary visible through ordinary autocomplete.

---

# 30. DevTools

Surface metadata allows Foldkit DevTools to introduce a Surface view:

```text
ProjectCard

PARAMS
──────
projectId: "p123"

OBSERVES
────────
projects[p123].id
projects[p123].name
projects[p123].status
projects[p123].owner.id
projects[p123].owner.name
projects[p123].owner.avatarUrl

MAY EMIT
────────
ChangedProjectName
ClickedArchiveProject
```

Given Foldkit already records Messages, Model snapshots and state transitions, Surface metadata can connect those runtime facts to feature boundaries. Foldkit's current DevTools already exposes the program's Model/Message history and time travel.

A later integration could display:

```text
LAST RELEVANT MESSAGE
─────────────────────
SucceededUpdateProject

WHY DID THIS SURFACE CHANGE?
────────────────────────────
projects[p123].status

"draft" → "active"
```

---

# 31. Render optimization

Optimization is a downstream benefit, not the justification for Surface.

Given:

```text
ProjectCard observes

projects[p123].name
projects[p123].status
```

and a Model transition only changes:

```text
notifications.unreadCount
```

the runtime can know that ProjectCard's Projection is unchanged.

A future integration can therefore:

```text
Model transition
      │
      ▼
changed paths
      │
      ▼
intersects Surface dependencies?
       / \
     no   yes
     │     │
 reuse   render
```

This could provide fine-grained invalidation while preserving Foldkit's ordinary immutable Model and VDOM architecture.

No signal system is required.

No hidden dependency tracking is required.

The initial implementation should **not** depend on this optimization.

Correctness comes first.

---

# 32. Testing

Surface declarations can improve both Story- and Scene-style testing.

A Surface fixture needs only its projected Model:

```ts
const model: typeof ProjectCard.Model.Type = {
  project: {
    id: ProjectId.make("p123"),
    name: "Foldkit",
    status: ProjectStatus.Active,
    owner: {
      id: UserId.make("u1"),
      name: "Devin",
      avatarUrl: "...",
    },
  },
}
```

The test does not need to construct unrelated application state.

A Surface-specific scene helper could eventually be:

```ts
scene(
  ProjectCard,
  given(model),
  click(role("button", { name: "Archive" })),
  message(
    Message.ClickedArchiveProject({
      projectId: model.project.id,
    }),
  ),
)
```

This would sit on top of Foldkit's existing testing system rather than replacing it.

---

# 33. MCP and agent integration

Foldkit already exposes the running Model, Message history and Message dispatch to AI agents through MCP.

Surface adds semantic scope.

Instead of telling an agent only:

```text
Here is the application Model.

Here is every Message.
```

Foldkit can describe:

```text
Surface: ProjectCard

observes:
  Project.id
  Project.name
  Project.status

may emit:
  ChangedProjectName
  ClickedArchiveProject
```

The actual Message Schemas already define tool inputs.

No parallel tool schema is required.

Conceptually:

```text
Surface
   │
   ├── Model Schema ──────▶ MCP resource shape
   │
   └── Message Schemas ───▶ MCP tool inputs
```

An agent dispatches the same Message the UI does:

```json
{
  "_tag": "ClickedArchiveProject",
  "projectId": "p123"
}
```

There is one application ontology.

---

# 34. Production agent exposure must be opt-in

A compile-time Surface capability is **not an authorization boundary**.

Declaring:

```ts
messages: [
  Message.ClickedDeleteProject,
]
```

means:

> this feature may produce this Message.

It does not mean:

> arbitrary remote agents are authorized to produce this Message.

Therefore production MCP/WebMCP exposure should remain separate and explicit:

```ts
Mcp.exposeSurfaces(
  Surfaces,
  {
    allow: [
      ProjectCard,
      Search,
    ],
  },
)
```

or an equivalent integration.

DevTools may inspect every Surface during development.

External control must be explicitly granted.

---

# 35. Surface registry

Core Surface definitions should not mutate a hidden global registry during module evaluation.

Instead applications may explicitly build one:

```ts
export const Surfaces = Surface.registry(
  App,
  [
    ProjectCard,
    ProjectPage,
    SessionBadge,
  ],
)
```

The registry can:

* verify unique names,
* verify common application scope,
* provide DevTools metadata,
* expose documentation,
* drive optional MCP integration.

A future Runtime option could accept it:

```ts
Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  surfaces: Surfaces,
  container,
})
```

The Runtime should not require Surfaces.

Existing Foldkit applications continue working unchanged.

---

# 36. Full proposed public API

Initial public imports:

```ts
import {
  Projection,
  Surface,
} from "foldkit/surface"
```

Low-level extension API:

```ts
import {
  ModelRef,
} from "foldkit/surface"
```

---

## Surface

```ts
Surface.make({
  Model,
  Message,
})
```

Creates a static application Surface scope.

---

```ts
Surface.define(
  scope,
  name,
  options,
)
```

Where:

```ts
options = {
  Params?: Schema,

  model:
    ({ model, params }) =>
      Projection,

  messages?:
    readonly MessageConstructor[],
}
```

Returns a Surface descriptor.

---

```ts
Surface.read(
  surface,
  model,
  params,
)
```

and:

```ts
Surface.read(
  surface,
  params,
)(model)
```

Reads the Surface's projected Model.

---

```ts
Surface.view(
  surface,
  view,
)
```

Constrains and infers the Surface's projected Model and Message subset.

---

```ts
Surface.registry(
  scope,
  surfaces,
)
```

Creates an explicit registry for tooling and integrations.

---

## Projection

```ts
Projection.of(Schema)({
  field: true,
  nested: OtherProjection,
})
```

Defines a reusable structural selection.

---

```ts
Projection.struct({
  ...
})
```

Combines arbitrary ModelRefs and Projections sharing the same root.

---

```ts
Projection.array(projection)
```

Lifts a Projection over an array.

---

```ts
Projection.option(projection)
```

Lifts a Projection over `Option`.

---

```ts
Projection.read(
  projection,
  model,
)
```

and:

```ts
Projection.read(
  projection,
)(model)
```

Reads a Projection.

---

## ModelRef

Normally obtained through:

```ts
App.model
```

Supports typed field access:

```ts
App.model.session.user.name
```

and appropriate collection focus operations:

```ts
ref.at(key)
ref.index(index)
```

plus:

```ts
ref.select(projection)
```

Low-level extension may provide:

```ts
ModelRef.fromOptic(...)
```

when custom domain containers require specialized focusing.

---

# 37. Complete example

```ts
import { Schema } from "effect"
import {
  Projection,
  Surface,
} from "foldkit/surface"
import { defineMessageUnion } from "foldkit/message"

// DOMAIN

const User = Schema.Struct({
  id: UserId,
  name: Schema.String,
  avatarUrl: Schema.String,
})

const Project = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  status: ProjectStatus,
  owner: User,
})

const Model = Schema.Struct({
  projects: ProjectStore,
  selectedProjectId: Schema.Option(ProjectId),
  session: Session,
})

const Message = defineMessageUnion({
  ChangedProjectName: {
    projectId: ProjectId,
    name: Schema.String,
  },

  ClickedArchiveProject: {
    projectId: ProjectId,
  },

  LoggedUserOut: {},
})

// SURFACE SCOPE

const App = Surface.make({
  Model,
  Message,
})

// REUSABLE PROJECTIONS

const UserSummary = Projection.of(User)({
  id: true,
  name: true,
  avatarUrl: true,
})

const ProjectSummary = Projection.of(Project)({
  id: true,
  name: true,
  status: true,
  owner: UserSummary,
})

// SURFACE

const ProjectCard = Surface.define(
  App,
  "ProjectCard",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        project: model.projects
          .at(params.projectId)
          .select(ProjectSummary),
      }),

    messages: [
      Message.ChangedProjectName,
      Message.ClickedArchiveProject,
    ],
  },
)

// VIEW

const projectCardView = Surface.view(
  ProjectCard,
  (model, h) =>
    h.article([], [
      h.h2([], [
        model.project.name,
      ]),

      h.p([], [
        model.project.status,
      ]),

      h.button(
        [
          h.OnClick(
            Message.ClickedArchiveProject({
              projectId: model.project.id,
            }),
          ),
        ],
        ["Archive"],
      ),
    ]),
)
```

Trying this:

```ts
model.session
```

fails.

Trying this:

```ts
h.OnClick(
  Message.LoggedUserOut(),
)
```

fails.

Nothing about `update`, Commands, Submodels or the Runtime changes.

---

# 38. Rejected alternatives

## Magic Message tags

Rejected:

```ts
messages: [
  "ClickedArchiveProject",
]
```

Reason:

* duplicates identifiers,
* weaker refactoring,
* unnecessary,
* loses constructor metadata,
* poor inference.

Use:

```ts
Message.ClickedArchiveProject
```

---

## Imperative capabilities

Rejected:

```ts
send.archive(...)
```

Reason:

It translates a Foldkit fact:

```text
ClickedArchiveProject
```

into an RPC-like imperative:

```text
archive
```

and creates a second behavioral vocabulary.

Messages are already the capability references.

---

## Arbitrary selector callbacks

Rejected:

```ts
model: state => ({
  name: state.project.name,
})
```

when dependency metadata is inferred by executing the callback.

Reason:

Dependency structure becomes implicit runtime behavior.

---

## Command exposure

Rejected:

```ts
commands: [
  ArchiveProject,
]
```

Reason:

It bypasses Foldkit's:

```text
Message → update → Command
```

boundary.

---

## Action abstraction

Rejected initially:

```ts
Action.define({
  message,
  command,
  success,
  failure,
})
```

Reason:

It imposes request/mutation semantics on Foldkit's more general transition model and duplicates existing abstractions.

---

## Child registry

Rejected:

```ts
children: {
  projectCard: ProjectCard,
}
```

Reason:

Projection and Message composition already express the relevant requirements through ordinary values.

---

## Normalized entity cache

Rejected.

Reason:

The Foldkit Model already owns application state.

---

## Automatically inferred Messages

Rejected.

Reason:

A capability contract should declare what is permitted, not merely report what the current implementation happened to use.

---

# 39. Extensibility

The initial primitives deliberately expose enough metadata for later extensions without requiring them now.

Potential future integrations include:

```text
Surface
├── DevTools
├── Scene
├── SSR
├── lazy rendering
├── dependency visualization
├── architecture linting
├── MCP
├── WebMCP
├── generated docs
└── agent context generation
```

Those systems consume Surface descriptors.

They do not require Surface itself to become larger.

This is the desired extensibility model:

```text
small semantic core
        │
        ▼
many external interpreters
```

rather than:

```text
one enormous Surface abstraction
that understands everything
```

---

# 40. Implementation phases

## Phase 1 — Core descriptors

Implement:

```text
Surface.make
ModelRef tree
Projection.of
Projection.struct
Projection.option
Projection.array
Surface.define
Surface.read
Surface.view
```

Goals:

* excellent inference,
* zero annotations in normal use,
* no Runtime changes,
* no performance optimization,
* no MCP integration.

This phase proves whether the abstraction itself deserves to exist.

---

## Phase 2 — Composition

Prove:

```text
Surface inside Surface
Submodel + Surface
parameterized Surface
Option/Record/Array projections
parent Message supersets
```

Build realistic examples:

```text
Kanban
auth
shopping cart
typing game
```

A framework primitive should survive existing complex Foldkit examples before being expanded.

---

## Phase 3 — Tooling

Add:

```text
Surface.registry
DevTools Surface inspection
dependency display
Message capability display
```

No behavior changes yet.

---

## Phase 4 — Rendering optimization

Experiment with dependency-based lazy rendering.

Treat this as an interpreter over Projection metadata.

Do not change Surface semantics to accommodate optimization.

---

## Phase 5 — Agent integration

Expose registered Surfaces through development MCP.

Investigate:

```text
surface discovery
Surface Model resources
Message tool generation
scoped Message dispatch
WebMCP
```

Keep production exposure separately authorized.

---

# 41. Success criteria

The abstraction succeeds if a Foldkit developer can look at:

```ts
const ProjectCard = Surface.define(...)
```

and immediately answer:

```text
What does ProjectCard know?

What can ProjectCard report?
```

while receiving useful consequences from the same declaration:

```text
better autocomplete
compile-time isolation
simpler fixtures
better DevTools
machine-readable capabilities
potential render optimization
agent integration
```

without changing Foldkit's fundamental architecture.

It fails if using Surface requires learning an alternative architecture containing:

```text
Actions
stores
queries
dispatchers
mutation state
component state
effects
cache invalidation
```

Surface should reduce authority, not add another world.

---

# 42. Architectural result

With this proposal Foldkit's vocabulary becomes:

```text
Model
    what exists

ModelRef
    where something exists

Projection
    what may be observed

Surface
    what a feature may observe and report

Message
    what happened

update
    what that fact means

Command
    what external work should happen

Submodel
    who owns a state machine
```

The complete flow becomes:

```text
                       MODEL
                         │
                    ModelRefs
                         │
                    Projection
                         │
                         ▼
                       Surface
                ┌────────┴────────┐
                │                 │
                ▼                 ▼
         projected Model     Message subset
                │                 │
                └────────┬────────┘
                         ▼
                        view
                         │
                         ▼
                      Message
                         │
                         ▼
                       update
                    ┌────┴────┐
                    ▼         ▼
                  Model     Command
                              │
                              ▼
                            Effect
                              │
                              ▼
                            Message
```

No existing layer is bypassed.

Surface merely makes two previously ambient relationships explicit:

```text
observation
capability
```

---

# 43. Why this belongs in Foldkit

The strongest argument for Surface is not Fate, MCP, performance, or AI.

It is the same argument underlying Foldkit itself:

> Important application structure should be visible in the program.

Foldkit already makes state transitions and effects explicit.

Surface extends the same philosophy to access.

Instead of a view implicitly receiving authority over the whole application, it declares its actual relationship to the application.

That relationship is statically typed, available at runtime, composable as data, and reusable by other tooling.

Fate demonstrates the value of declaring what a component may observe.

Foldkit provides the missing second half because it also has an explicit event model.

A Surface can therefore describe both directions:

```text
             APPLICATION

                   │
             observation
                   │
                   ▼
               Surface
                   │
              capability
                   │
                   ▼

             APPLICATION
```

Or more simply:

> **A Surface is the typed semantic interface between a Foldkit feature and the rest of its application.**

That is the proposed primitive.


Yes. I think the answer is to build **one layer below `Surface`**, not turn `Surface` itself into Fate.

The architecture I’d aim for is:

```text
Surface                semantic UI boundary
   │
Projection             what data is needed
   │
Remote                  resolves remote parts of Projection
   │
Normalized Store       canonical server-state cache
   │
RequestResolver        batching / dedupe / scheduling
   │
Transport              HTTP / RPC / WebSocket
   │
Server Sources         authorize + resolve selections
```

The crucial Foldkit-specific decision is:

> **The normalized cache should itself be a Foldkit Submodel.**

Not a hidden mutable cache living in a hook, singleton, or Effect service.

That gives us Fate-like behavior without violating Foldkit.

Fate itself normalizes entities by `__typename:id`, keeps relations as references, batches HTTP operations, and merges live updates into that same normalized store. ([GitHub][1])

---

# 1. Split it into `Surface` and `Remote`

I'd leave:

```ts
@foldkit/surface
```

roughly exactly as designed.

Then add:

```ts
@foldkit/remote
```

or if this is third-party:

```ts
foldkit-remote
```

`Surface` knows nothing about networking.

`Remote` understands:

```text
entities
identity
field presence
relations
connections
requests
transport
live updates
optimistic state
```

This means you could use Surface perfectly well for a completely local application.

---

# 2. Remote owns a Submodel

Something like:

```ts
const Remote = Remote.make({
  entities: [
    User,
    Project,
    Comment,
  ],
})
```

which produces:

```ts
Remote.Model
Remote.Message
Remote.update
```

You install it like any normal Foldkit Submodel:

```ts
const Model = Schema.Struct({
  route: Route,
  remote: Remote.Model,
  // ...
})
```

Conceptually:

```text
App.Model
│
├── route
├── editor
├── session
│
└── remote
     │
     ├── entities
     ├── connections
     ├── requests
     └── optimistic layers
```

So server data is still:

> application state represented in Model.

That's much more Foldkit-native than:

```text
Model
+
secret mutable React-Query-style cache
```

---

# 3. Define first-class entities

This is where the Fate-like part begins.

```ts
const User = Entity.define(
  Schema.Struct({
    id: UserId,
    name: Schema.String,
    avatarUrl: Schema.String,
  }),
)

const Project = Entity.define(
  Schema.Struct({
    id: ProjectId,
    name: Schema.String,
    status: ProjectStatus,
    owner: Entity.ref(User),
  }),
)
```

I'd probably make `id` a convention rather than requiring:

```ts
id: "id"
```

everywhere.

An entity definition gives Remote:

```text
type identity
ID schema
field schema
relation metadata
normalization instructions
```

The actual internal cache becomes approximately:

```text
Project:p123
├── id       = p123
├── name     = "Foldkit"
├── status   = "active"
└── owner    = User:u42

User:u42
├── id        = u42
├── name      = "Devin"
└── avatarUrl = ...
```

Exactly the valuable part of Fate's cache model. ([GitHub][1])

---

# 4. The cache must track fields, not just objects

This is important.

Suppose one Surface has fetched:

```ts
{
  id: true,
  name: true,
}
```

and another needs:

```ts
{
  id: true,
  name: true,
  avatarUrl: true,
}
```

Remote must know:

```text
User:u42

id          PRESENT
name        PRESENT
avatarUrl   MISSING
email       MISSING
```

So internally an entity entry needs something conceptually like:

```ts
interface EntityEntry {
  readonly values: Record<FieldId, unknown>
  readonly present: FieldSet
}
```

You cannot infer presence from:

```ts
value === undefined
```

because `undefined`, `null`, absent, and unfetched are different states.

That's what allows a request planner to say:

> I already have `id` and `name`; fetch only `avatarUrl`.

---

# 5. Projection becomes the query language

This is where our Surface design pays off massively.

We already have:

```ts
const ProjectSummary = Projection.of(Project)({
  id: true,
  name: true,
  status: true,

  owner: UserSummary,
})
```

That is already basically a typed query AST.

We should **not invent another query language**.

Instead the same Projection means two things:

```text
LOCAL
─────
What may this Surface observe?

REMOTE
──────
Which entity fields are required?
```

One declaration.

---

# 6. Referencing remote data from a Surface

Suppose our application's Remote submodel lives at:

```ts
model.remote
```

Then I'd want something approximately like:

```ts
const ProjectCard = Surface.define(
  App,
  "ProjectCard",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        project: Remote.byId(
          model.remote,
          Project,
          params.projectId,
        ).select(ProjectSummary),
      }),

    messages: [
      Message.ChangedProjectName,
      Message.ClickedArchiveProject,
    ],
  },
)
```

Notice:

```ts
model.remote
```

is still a `ModelRef`.

And:

```ts
Remote.byId(...)
```

creates another Projection.

So the final dependency tree may contain:

```text
LOCAL DEPENDENCIES

route.current


REMOTE DEPENDENCIES

Project:p123
├ id
├ name
├ status
└ owner
    └ User:?
       ├ id
       ├ name
       └ avatarUrl
```

The same Projection tree can drive both rendering and fetching.

---

# 7. Don't hide loading state

Here's where I would deliberately diverge from Fate/React.

Fate can suspend while missing data is being fetched.

Foldkit shouldn't suddenly grow React Suspense semantics.

So:

```ts
Remote.byId(...).select(ProjectSummary)
```

should initially project something like:

```ts
RemoteData<ProjectSummary>
```

where:

```ts
type RemoteData<A> =
  | Initial
  | Loading
  | Success<A>
  | Failure<RemoteError>
```

preferably as an Effect Schema tagged union.

Then:

```ts
RemoteData.match(model.project, {
  Initial: () => ...,
  Loading: () => ...,
  Failure: ({ error }) => ...,
  Success: ({ value: project }) => ...
})
```

Yes, it's slightly more explicit than Suspense.

But it's Foldkit.

And importantly:

```text
loading/error/data
```

become visible application states rather than hidden renderer control flow.

We can later add ergonomic helpers.

---

# 8. How does data actually get requested?

This is where Foldkit **Subscriptions** fit beautifully.

A page says:

> As long as I'm on this route, this projection is desired.

Something like:

```ts
const subscriptions = (model: Model) => [
  Remote.observe(
    model.remote,
    ProjectPage.projection({
      projectId: model.route.projectId,
    }),
  ),
]
```

`Remote.observe`:

1. examines the Projection,
2. extracts its remote entity dependencies,
3. examines `model.remote`,
4. determines which requested fields are absent or stale,
5. creates a Foldkit Subscription for the missing data.

Conceptually:

```text
Surface Projection
       │
       ▼
remote requirements
       │
       ▼
compare with Remote.Model
       │
       ▼
missing fields
       │
       ▼
Subscription
       │
       ▼
network
```

This is a very natural fit because a Subscription represents:

> an ongoing relationship between Model state and the outside world.

---

# 9. Example

Route:

```ts
Person({
  projectId: "p123",
})
```

Surface wants:

```text
Project:p123
├── id
├── name
├── status
└── owner
    ├── id
    ├── name
    └── avatarUrl
```

Cache currently contains:

```text
Project:p123
├── id       ✓
├── name     ✓
├── status   ✗
└── owner    ✓ → User:u7

User:u7
├── id        ✓
├── name      ✓
└── avatarUrl ✗
```

The request planner produces:

```text
Project:p123
  status

User:u7
  avatarUrl
```

Not the entire entities.

Not the entire Surface.

Just the missing fields.

That is the Fate/Relay idea.

---

# 10. Effect v4 already gives us an excellent batching primitive

This is one place where we should absolutely lean on Effect rather than implement everything ourselves.

Effect v4's `RequestResolver` is explicitly designed to:

* collect requests,
* group them,
* batch them,
* execute backend work,
* deduplicate/cachе requests,
* control batching delays,
* trace them. ([GitHub][2])

So Remote could turn each missing entity selection into an Effect request:

```ts
EntityRequest({
  entity: Project,
  id: projectId,
  select: ProjectSelection,
})
```

and run:

```ts
Effect.request(
  request,
  RemoteRequestResolver,
)
```

The resolver batches all concurrent requests.

For example:

```text
Project:p1 { name, status }
Project:p2 { name }
User:u1    { avatarUrl }
User:u7    { name, avatarUrl }
```

could become one transport operation:

```text
POST /remote

[
  Project:p1 { name, status },
  Project:p2 { name },
  User:u1    { avatarUrl },
  User:u7    { name, avatarUrl }
]
```

Effect's resolver machinery already exists precisely for this kind of collection/batching problem. ([GitHub][2])

---

# 11. But don't use Effect's request cache as our entity cache

This distinction is critical.

Effect can cache:

```text
Request → Result
```

That's useful for:

```text
dedupe
in-flight reuse
transport scheduling
TTL
```

But our canonical cache needs to be:

```text
Entity → Fields
```

Those are fundamentally different caches.

For example:

```text
GetProject(p1, { name })
```

and:

```text
GetProject(p1, { status })
```

are different requests but populate the same entity.

So:

```text
Effect Request cache
        ↓
transport-level optimization


Remote.Model entity store
        ↓
application server-state cache
```

I'd use both where appropriate, but never confuse them.

---

# 12. Transport should be tiny

The core transport interface could be close to:

```ts
interface Transport {
  readonly execute: (
    batch: RequestBatch,
  ) => Effect.Effect<
    ResponseBatch,
    TransportError
  >
}
```

Then provide:

```text
RemoteTransport.http
RemoteTransport.rpc
RemoteTransport.memory
RemoteTransport.websocket
```

Maybe:

```ts
const RemoteLive = RemoteTransport.http({
  url: "/remote",
})
```

implemented using Effect Platform `HttpClient`.

The normalized cache and Projection system don't care.

---

# 13. Wire protocol

I'd keep the wire protocol boring.

Something approximately like:

```json
{
  "requests": [
    {
      "entity": "Project",
      "id": "p123",
      "select": {
        "status": true,
        "owner": {
          "id": true
        }
      }
    }
  ]
}
```

Response:

```json
{
  "entities": [
    {
      "type": "Project",
      "id": "p123",
      "fields": {
        "status": "active",
        "owner": {
          "type": "User",
          "id": "u7"
        }
      }
    }
  ]
}
```

The server can return normalized form directly, which saves the client from traversing arbitrary nested responses.

Or server responses can be nested and client-normalized.

I'd prefer **normalized wire responses** for a native protocol.

---

# 14. Server-side selection authorization is mandatory

This is another Fate lesson worth copying.

The client cannot be allowed to say:

```json
{
  "select": {
    "passwordHash": true
  }
}
```

and have your ORM blindly honor it.

Fate solves this using server-side data views that whitelist selectable fields and computed relationships. ([GitHub][1])

We need the same concept.

For example:

```ts
const UserSource = RemoteServer.entity(User, {
  fields: {
    id: Field.value,
    name: Field.value,
    avatarUrl: Field.value,

    email: Field.computed({
      authorize: ({ context, entity }) =>
        context.userId === entity.id,

      resolve: ...
    }),
  },

  byId: ({ ids, select }) =>
    ...
})
```

Or with adapters:

```ts
RemoteServer.drizzle(User, {
  table: users,
  // ...
})
```

Client Projection:

```text
what I want
```

Server Source:

```text
what I'm allowed to ask for
+
how that field is resolved
```

Those must remain separate.

---

# 15. Full request path

Now the whole thing becomes:

```text
ProjectPage Surface
        │
        ▼
Projection
        │
        ▼
Remote.observe(...)
        │
        ▼
Requirement planner
        │
        ├──── checks Remote.Model
        │
        ▼
Missing field requests
        │
        ▼
Effect RequestResolver
        │
        │ batch / dedupe
        ▼
Transport
        │
        ▼
Remote server
        │
        ▼
Sources / DB
        │
        ▼
normalized response
        │
        ▼
Remote.Message.ReceivedBatch
        │
        ▼
Remote.update
        │
        ▼
new Remote.Model
        │
        ▼
Surface Projection
        │
        ▼
view
```

That is extremely Foldkit-native.

---

# 16. Cache updates happen through Messages

This part matters philosophically.

Network code should **not** mutate the Remote store.

Instead:

```text
transport finishes
       │
       ▼
Remote.Message.ReceivedBatch(...)
       │
       ▼
Remote.update
       │
       ▼
new cache Model
```

Therefore Foldkit DevTools gets:

```text
ReceivedBatch
    ↓
entities changed
    ↓
Surface changed
```

Time travel could even include server-state cache evolution.

That's a really cool consequence.

---

# 17. The remote Submodel owns its internal Messages

You don't want every application Message union polluted with:

```text
StartedRequest
ReceivedEntityBatch
FailedBatch
OpenedStream
ClosedStream
...
```

That's exactly why Submodel exists.

Conceptually:

```ts
App.Message.GotRemoteMessage({
  message: Remote.Message.ReceivedBatch(...)
})
```

The application delegates:

```ts
Remote.update(
  model.remote,
  message.message,
)
```

Foldkit's existing Submodel machinery should make most of that glue mechanical.

---

# 18. Connections/lists need separate normalization

Don't store:

```ts
projects: Project[]
```

inside entity records.

Instead:

```text
ENTITY STORE

Project:p1
Project:p2
Project:p3


CONNECTION STORE

ProjectsForUser:u7
├── Project:p1
├── Project:p3
├── Project:p2
├── nextCursor
└── hasNextPage
```

Then:

```ts
Remote.connection(...)
```

could be another Projection primitive:

```ts
Remote.connection(
  model.remote,
  ProjectsByOwner,
  {
    ownerId,
  },
).select(ProjectSummary)
```

A connection definition might be:

```ts
const ProjectsByOwner =
  Remote.query(Project, {
    Params: Schema.Struct({
      ownerId: UserId,
    }),
  })
```

Again: typed reference, not string procedure names.

Fate similarly stores list order separately from normalized entities. ([GitHub][1])

---

# 19. Mutations fit Foldkit Commands

This is where I would **not** recreate Fate's React Actions API.

A user clicks:

```ts
Message.ClickedRenameProject({
  projectId,
  name,
})
```

Then:

```ts
update(model, message)
```

returns a Command:

```ts
Remote.mutate(
  RenameProject({
    projectId,
    name,
  }),
)
```

The Command performs the transport.

Response becomes:

```ts
Message.GotRemoteMessage(...)
```

or an application-specific success/failure Message.

So:

```text
UI fact
  ↓
Message
  ↓
update
  ↓
Remote mutation Command
  ↓
server
  ↓
Message
  ↓
update
```

Exactly Foldkit.

---

# 20. Optimistic updates

Optimistic updates should modify the same normalized Remote Model.

Potentially:

```ts
const result = Remote.optimistic(
  model.remote,
  {
    entity: Project.ref(projectId),

    patch: {
      name,
    },

    mutation: RenameProject({
      projectId,
      name,
    }),
  },
)
```

and then:

```ts
return {
  model: {
    ...model,
    remote: result.model,
  },

  commands: [
    result.command,
  ],
}
```

But I'd make this flow through `Remote.update` internally so the app isn't directly modifying Remote's owned state.

Conceptually Remote maintains:

```text
BASE
────
name = "Old"

OPTIMISTIC LAYER 42
───────────────────
name = "New"

VISIBLE
───────
name = "New"
```

Success:

```text
merge server state
remove layer
```

Failure:

```text
remove layer
→ automatically reveals "Old"
```

This is much safer than trying to calculate inverse patches.

Fate similarly applies optimistic normalized updates and automatically rolls them back on failure. ([GitHub][3])

---

# 21. Live data becomes almost trivial

Once everything writes to the normalized entity store, SSE/WebSocket updates are just another producer of Remote Messages.

```text
SSE

Project:p123
status = "archived"

       ↓

Remote.Message.ReceivedPatch

       ↓

Remote.update

       ↓

same normalized cache
```

No special live cache.

No parallel state system.

Then Surface dependency metadata tells us precisely which Surfaces are affected.

Fate uses essentially this architecture: live updates normalize into the same cache as ordinary requests/mutations. ([Fate][4])

---

# 22. The really elegant part: Surface becomes a query planner

Given:

```ts
const ProjectCard = Surface.define(App, "ProjectCard", {
  model: ({ model, params }) =>
    Projection.struct({
      project: Remote.byId(
        model.remote,
        Project,
        params.projectId,
      ).select(ProjectSummary),

      user: Remote.byId(
        model.remote,
        User,
        model.session.userId,
      ).select(UserSummary),
    }),

  messages: [...]
})
```

the Surface descriptor contains enough information to answer:

```text
LOCAL STATE REQUIRED
────────────────────
session.userId


REMOTE STATE REQUIRED
─────────────────────
Project:p123
  id
  name
  status
  owner → User

User:u7
  id
  name
  avatarUrl


MESSAGES PERMITTED
──────────────────
ChangedProjectName
ClickedArchiveProject
```

That's more powerful than Fate because **the same descriptor connects remote data requirements to the application's transition system**.

---

# 23. And this gives us ridiculous DevTools

You could click ProjectCard and see:

```text
ProjectCard

MODEL
─────
session.userId


REMOTE
──────
Project:p123
  id             cached
  name           cached
  status         cached
  owner          cached

User:u7
  id             cached
  name           cached
  avatarUrl      fetching


REQUEST
───────
batch #72
GET User:u7 { avatarUrl }


MESSAGES
────────
ChangedProjectName
ClickedArchiveProject


LAST INVALIDATION
─────────────────
User:u7.avatarUrl
```

That's an incredibly coherent debugging model.

---

# 24. The package architecture I'd use

Probably:

```text
@foldkit/surface
    ModelRef
    Projection
    Surface


@foldkit/remote
    Entity
    Remote
    RemoteData
    Query / Connection
    cache planner
    normalized store
    optimistic layers


@foldkit/remote-http
    Effect HttpClient transport


@foldkit/remote-server
    server protocol
    Source
    selection authorization


@foldkit/remote-drizzle
@foldkit/remote-prisma
    optional source adapters
```

Maybe eventually collapse packages if they're tiny.

---

# 25. The core implementation insight

I would **not** start by building HTTP.

I'd build this completely in memory first:

```text
Projection
    ↓
Requirement AST
    ↓
normalized cache diff
    ↓
MissingSelection
```

For example, prove this works:

```ts
const requirement =
  Remote.require(
    Project.ref("p1"),
    ProjectSummary,
  )

const missing =
  Remote.missing(
    cache,
    requirement,
  )
```

returns:

```ts
{
  entity: Project.ref("p1"),
  select: {
    status: true,

    owner: {
      avatarUrl: true,
    },
  },
}
```

If **that** abstraction is beautiful, transport becomes mundane.

Then add:

```text
RequestResolver
HTTP
server Sources
mutations
live
```

in that order.

---

## I think there's a larger architectural payoff

Our earlier Surface design initially looked like:

```text
Projection = observation boundary
```

Once Remote exists, Projection becomes something more fundamental:

> **Projection is a declarative description of the information a feature requires, independent of where that information currently comes from.**

Some leaves might come directly from local Model:

```text
route
selection
editing state
```

Others might come from normalized remote entities:

```text
Project:p1.name
User:u7.avatarUrl
```

And the interpreter decides what needs to happen:

```text
already local
    → read it

cached remotely
    → read it

missing remotely
    → request it

live
    → subscribe to it
```

So we end up with something like:

```text
                Projection

        "what information do I need?"

                     │
          ┌──────────┴───────────┐
          ▼                      ▼

       LocalRef               EntityRef
          │                      │
          ▼                      ▼

        Model                Remote.Model
                                 │
                         missing fields?
                            /         \
                          no           yes
                          │             │
                         read        transport
```

That's a **very strong abstraction**.

I think that's the point where this stops being merely "Fate for Foldkit" and starts looking like a genuinely new Foldkit-native data architecture: **TEA state transitions + explicit observation boundaries + normalized server state + Effect RequestResolver batching, all represented through one declarative Projection graph.**

[1]: https://github.com/nkzw-tech/fate/blob/main/docs/integrations/server.md?utm_source=chatgpt.com "fate/docs/integrations/server.md at main · nkzw-tech/fate · GitHub"
[2]: https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/RequestResolver.ts?utm_source=chatgpt.com "effect-smol/packages/effect/src/RequestResolver.ts at main · Effect-TS/effect-smol · GitHub"
[3]: https://github.com/nkzw-tech/fate/blob/main/packages/create-fate/templates/fate/drizzle/AGENTS.md?utm_source=chatgpt.com "fate/packages/create-fate/templates/fate/drizzle/AGENTS.md at main · nkzw-tech/fate · GitHub"
[4]: https://fate.technology/guide/live-views?utm_source=chatgpt.com "Live Views | fate"
