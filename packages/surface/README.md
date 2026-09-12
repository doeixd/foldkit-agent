# `foldkit-surface`

The observation boundary for a Foldkit application. A Surface is a **pure
projection** of the Model: it declares exactly which fields a feature reads and
which Messages it may construct, and it does so from the application's existing
Schema, not a second hand-written interface.

`foldkit-surface` is the foundation under
[`foldkit-sync`](https://github.com/doeixd/foldkit-plus/tree/main/packages/sync)
and [`foldkit-remote`](https://github.com/doeixd/foldkit-plus/tree/main/packages/remote):
both consume the projection and Message-subset values this package produces.

## Quick start

```ts
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'

const Model = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean })),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  ToggledTodo: { id: Schema.String },
  SelectedTodo: { id: Schema.String },
})

const update = (model: typeof Model.Type, message: typeof Message.Type) => {
  switch (message._tag) {
    case 'CreatedTodo':
      return { model: { ...model, todos: [...model.todos, { id: message.id, title: message.title, done: false }] } }
    case 'ToggledTodo':
      return { model: { ...model, todos: model.todos.map(todo => todo.id === message.id ? { ...todo, done: !todo.done } : todo) } }
    case 'SelectedTodo':
      return { model: { ...model, selectedTodoId: message.id } }
  }
}

// A runnable application carries `initial` and `update`, so a replicator can
// derive the shared value and replay; both are optional.
const App = Surface.application({
  Model,
  Message,
  initial: { todos: [], selectedTodoId: null },
  update,
})

const Todos = Projection.pick(App.fields.todos)

const TodoList = Surface.make(App, 'TodoList', {
  model: ({ model }) =>
    Projection.struct({
      todos: model.todos,
      selectedTodoId: model.selectedTodoId,
    }),
  messages: [Message.ToggledTodo, Message.SelectedTodo],
})
```

## Field references

`Surface.application` generates a reference tree from the Model Schema, one node
per field: `App.fields.todos`, `App.fields.someStruct.title`. Each `FieldRef`
carries its optic, codec, `get`, and `set`, plus the field name as a literal type,
so a selection can infer its own output keys without a parallel field registry.

```ts
App.fields.todos                 // FieldRef<Model, Todo[], 'todos'>
App.fields.selectedTodoId        // FieldRef<Model, string | null, 'selectedTodoId'>
App.fields.todosById.at('t1')    // OptionalRef<Model, Option<Todo>> (dynamic key)
App.fields.todos.index(0)        // OptionalRef<Model, Option<Todo>> (dynamic index)
```

Struct fields recurse, so a nested reference such as `App.fields.todo.title` is a
`FieldRef`. Array and record access is `.index(i)` / `.at(key)`, which returns an
`OptionalRef` — a `ModelRef` with an `Option` value. Those are dynamic selections,
so `Projection.pick` (which needs a static field name) rejects them; they are useful
inside a `Projection`.

`App.model` is the same tree under its older name; prefer `App.fields`.

`Projection.pick` turns references into a writable projection — a `Schema.Struct`,
`get`, and `set`:

```ts
const Shared = Projection.pick(App.fields.todos, App.fields.selectedTodoId)
// { schema, dependencies, get, set }
```

A reference from a different application is rejected by a per-application owner
token, so two structurally identical Models cannot be mixed. Duplicate members
deduplicate; a conflicting definition throws.

`Projection.compose` merges disjoint writable projections, keeping each part's own
write behavior. `ModelRef.fromOptic` builds a reference from an optic you already
have.

## Projections

A `Projection<Root, Value>` is three things: a `Model` codec for `Value`, a pure
`read(root) => Value`, and its `dependencies`/`requirements`. Reading never
performs I/O.

```ts
Projection.struct({ todos: model.todos, selectedTodoId: model.selectedTodoId })
Projection.of(Model)({ todos: true, selectedTodoId: true })  // from the Schema
Projection.array(projection)     // Projection<ReadonlyArray<Root>, ReadonlyArray<Value>>
Projection.option(projection)    // Projection<Option<Root>, Option<Value>>
Projection.fromReader(codec, read)  // escape hatch for a non-ModelRef value
```

`Projection.struct` accepts `ModelRef`s and nested `Projection`s, so a Surface can
mix local fields with remote or replicated values. A nested projection
contributes its dependencies and requirements to the parent.

## Applications

`Surface.application({ Model, Message })` captures the pure references (`App.model`,
`App.Model`, `App.Message`, `App.owner`) with no transition. Use it when a
consumer needs only the reference tree.

`Surface.application({ Model, Message, initial, update })` additionally captures
the transition and returns a **Runnable** application. `update`'s Commands may
carry resources; the resource set is threaded through the returned type.

## Message subsets

A subset selects typed variants of one application's Message union by constructor
reference:

```ts
const TodoChanges = MessageSet.make(App, [Message.CreatedTodo, Message.ToggledTodo])
const SelectionChanges = MessageSet.make(App, [Message.SelectedTodo])
const AllChanges = MessageSet.union(TodoChanges, SelectionChanges)
```

A subset carries the constructors, a pure codec for exactly those variants, a
`tags` set, and an `includes` guard. A constructor that is not a variant of the
application, a duplicate tag, or a subset from another application throws.
Surface does not label a subset durable, agent-visible, or presence; `Sync` and
`Agent` attach those policies to the same value.

## Surfaces

`Surface.make(app, name, { Params?, model, messages? })` binds a projection and
the Messages a feature may use into a named, inspectable contract.

```ts
const TodoDetail = Surface.make(App, 'TodoDetail', {
  model: ({ model }) =>
    Projection.struct({
      todos: model.todos,
      selectedTodoId: model.selectedTodoId,
    }),
  messages: [Message.ToggledTodo],
})

// A parameterized Surface may read `params`; dynamic lookups are OptionalRefs.
const ById = Surface.make(App, 'ById', {
  Params: Schema.Struct({ id: Schema.String }),
  model: ({ model, params }) =>
    Projection.struct({ todo: model.todosById.at(params.id) }),
})

Surface.read(TodoDetail, root)                     // project purely
Surface.read(ById, root, { id: 't1' })
Surface.view(TodoDetail, render)                   // bind a renderer
Surface.rootView(TodoDetail, undefined, render)    // bound to the app root
```

`Surface.make` does not evaluate `projection(undefined)` for a parameterized
Surface, because the projection may read `params`.

## Modules

A `Module` collects an application's contracts as pure data, so their
relationships can be validated and inspected without starting a runtime. Sync,
Remote, and Agent contracts carry a `contract` description; a Surface is
described in place (`Surface.contract(surface, params)` for a parameterized one).

```ts
import { Module } from 'foldkit-surface'

const Project = Module.make(App, [BoardSurface, ProjectSync, ProjectRemote, ProjectAgent])

Module.validate(Project) // [] or findings
Module.manifest(Project) // fields, Messages, who owns each Model path, contracts
Module.toMarkdown(Project)
```

```text
Model
├── route           LOCAL
├── selectedNoteId  LOCAL
├── notes           SYNC notes
└── remote          REMOTE remote
```

`validate` reports what the types cannot: a contract from another application,
a duplicate `kind:name`, two owners of overlapping Model paths, a Message
recorded by two replication contracts, and a path or Message the application
does not declare. `Module.add(module, ...more)` returns a new Module, so feature
modules can contribute their contracts independently.

## What it owns

- Reference-based Model selection (`App.fields`, `Projection.pick`,
  `Projection.compose`).
- Pure `Projection` values with their codec, reader, dependencies, and remote
  requirements.
- Application scopes (`make` / `application`) and their identity token.
- Typed Message subsets (`MessageSet.make`, `MessageSet.union`).
- Named Surfaces and their renderer binding.

## Limits

- It performs no I/O and knows nothing about transport. Fetching remote data is
  [`foldkit-remote`](https://github.com/doeixd/foldkit-plus/tree/main/packages/remote);
  replicating Messages is
  [`foldkit-sync`](https://github.com/doeixd/foldkit-plus/tree/main/packages/sync).
- `Model` codecs are pure by construction: Foldkit Model fields carry no decoding
  or encoding services.
- A projection declares dependencies and requirements but does not resolve them.
