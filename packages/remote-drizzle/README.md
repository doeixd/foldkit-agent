# foldkit-remote-drizzle

**Provisional.** A compiler from `foldkit-remote` entity reads and query
connections into Drizzle SELECTs, and Drizzle rows back into normalized Remote
patches. It captures no connection: sources require a `DrizzleDatabase` service
that the application provides.

```text
Remote Selection / Query
          |
   RemoteServer Source
          |
 RemoteDrizzle compiler
          |
   DrizzleDatabase
          |
 normalized Remote patches
```

## Quick start

```ts
// schema.ts
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
})
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull(),
})
```

```ts
// remote.ts
import { Remote, Selection } from 'foldkit-remote'
import { RemoteServer } from 'foldkit-remote-server'
import { entity, one, source } from 'foldkit-remote-drizzle'
import { projects, users } from './schema.js'

// One declaration per entity. The returned value is both the Drizzle binding and
// the Remote EntityDescriptor: relation fields are derived from the foreign keys.
const User = entity('User', users)
const Project = entity('Project', projects, {
  relations: { owner: one(User, { field: projects.ownerId }) },
})

// A Surface selects exactly these fields; a query is described separately.
const ProjectSummary = Selection.make(Project, { id: true, name: true, owner: true })

const Data = Remote.make({ entities: [User, Project] })

const Server = RemoteServer.make({
  entities: [source(User), source(Project)],
})
// Every source names a descriptor the domain declared.
RemoteServer.validate(Data, Server)

// The handlers require `DrizzleDatabase`; provide it with the application's db.
const handlers = RemoteServer.handlers(Server, principal)
```

The application provides the database once:

```ts
import { databaseLayer } from 'foldkit-remote-drizzle'

const DatabaseLive = databaseLayer(db)
```

## Bind an entity to a table

```ts
import { entity } from 'foldkit-remote-drizzle'

const User = entity('User', users)
```

`entity(name, table, { fields?, relations?, computed? })` derives an Effect
Schema from the table with `drizzle-orm/effect-schema` and exposes the table
columns. The result **is** a `foldkit-remote` `EntityDescriptor`, so
`Selection.make` checks field names against the table without a second
declaration. Each declared relation adds a ref field (`owner: Entity.ref(User)`,
or an array of refs for a collection); each computed adds a number field.

A table must have an `id` column; every read needs it for normalization even when
the client did not select it. Several mistakes are rejected at definition time: a
relation (or computed) name that collides with a field; a computed naming an
undeclared or singular relation; and a `one` relation pointed at a nullable
column without `{ nullable: true }` (below).

`fields` replaces the field map Drizzle derives, for a custom id codec or a
narrower client schema. Relation and computed fields still derive on top:

```ts
const User = entity('User', users, {
  fields: { id: UserId, name: Schema.String },
})
```

## Provide the database

```ts
import { databaseLayer } from 'foldkit-remote-drizzle'

const DatabaseLive = databaseLayer(db)
```

`db` is any Drizzle database whose select builder is thenable
(`db.select(columns).from(table).where(...).groupBy(...).orderBy(...).limit(...)`)
— the same builder for any Drizzle dialect. `databaseLayer` confines the one cast
the structurally-typed service needs, so the application does not write it.

> `drizzle-orm/effect-postgres` is deliberately not imported: its driver calls
> `Schema.TaggedErrorClass`, absent from `effect@4.0.0-rc.112`, and throws on
> load. Provide the tag directly until Drizzle and Effect agree on an RC.

## Entity reads

```ts
import { source } from 'foldkit-remote-drizzle'

const UserSource = source(User)
// or, with field authorization:
const UserSource = source(User, {
  authorize: (principal, fields) => fields.filter(field => field !== 'email'),
})
```

The read prunes to the requested columns (always including the primary key),
batches every id into one `IN (...)`, and returns `{ id, values }` records.
Authorization stays in `RemoteServer`: the adapter only reads the fields it was
handed. Use `reader(binding, run)` to inject your own executor for another driver
or a test.

## Query connections

```ts
import { eq } from 'drizzle-orm'
import { Query } from 'foldkit-remote'
import { query } from 'foldkit-remote-drizzle'

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: UserId }),
  Result: Query.connection({ name: 'Project' }),
})

const ProjectsByOwnerSource = query(ProjectsByOwner, {
  entity: Project,
  orderBy: [
    { column: projects.createdAt, direction: 'desc' },
    { column: projects.id, direction: 'desc' },
  ],
  where: input => eq(projects.ownerId, input.ownerId),
})
```

- `orderBy` must be non-empty and a stable total order; add a unique tie-breaker.
- The cursor is the row id. A cursor request re-reads that row's ordering tuple
  before the page query, so the wire cursor stays a string whatever the ordered
  column types are.
- A nullable ordered column pages under Postgres' default NULL ordering (ASC:
  nulls last, DESC: nulls first); the keyset predicate uses `IS NULL` / `IS NOT
  NULL` rather than comparing a column to NULL.
- The window is client-supplied: `first`/`last` are clamped to a non-negative
  integer under `maxPageSize` (default 100), with `0` honored as boundaries
  only, and `after`/`before` or `first`/`last` cannot be combined.
- A cursor that no longer resolves fails the query rather than silently returning
  page one.

## Relations

A singular relation is normalized: the binding declares it with `one`, which
derives a ref field on the Entity, and a Selection asks for the ref.

```ts
import { Selection } from 'foldkit-remote'
import { entity, one } from 'foldkit-remote-drizzle'

const User = entity('User', users)
const Project = entity('Project', projects, {
  relations: { owner: one(User, { field: projects.ownerId, nullable: true }) },
})

const selection = Selection.make(Project, { id: true, name: true, owner: true })
```

Pass `{ nullable: true }` when the foreign key is nullable; the derived field is
then `Entity.ref(User) | null`, so the client decodes a present null rather than
failing. A non-nullable key omits the flag. The read selects `projects.owner_id`
and emits `values.owner = "User:u1"` — the key the ref codec decodes. A null
foreign key emits `null`, so the client holds a present null rather than
refetching forever. Select the target's fields separately and let the normalized
store share it.

A to-many relation is an array of refs. The foreign key lives on the target:

```ts
const Comment = entity('Comment', comments)
const Post = entity('Post', posts, {
  relations: {
    comments: many(Comment, { foreignKey: comments.postId, localKey: posts.id }),
  },
})
```

The read loads every child row in one `IN (...)`, ordered by child id, and emits
`values.comments = ["Comment:c1", "Comment:c2"]`. The binding derives the field
as an array of refs; the Selection selects it as `true`.
A collection relation may also take `orderBy` (default target id) and `where`
(appended to the child query, e.g. to exclude soft-deleted rows).

A many-to-many relation joins through a table; `localColumn` references the
owner's `id` and `foreignColumn` the target's `id`:

```ts
const Post = entity('Post', posts, {
  relations: {
    tags: manyToMany(Tag, {
      through: postTags,
      localColumn: postTags.postId,
      foreignColumn: postTags.tagId,
    }),
  },
})
```

The read joins the target table (`innerJoin` on the foreign key) so dangling
through rows are dropped, then emits refs ordered by target id.

A collection relation can be filtered per principal at the source, e.g. to expose
only rows the caller may see:

```ts
const PostSource = source(Post, {
  policies: {
    comments: principal => eq(comments.visibleTo, principal.id),
  },
})
```

The policy is applied to `many`/`manyToMany` child queries alongside any static
`where` on the binding. Keying a policy by a singular relation is rejected at
definition time — it filters nothing.

A relation can be paginated. Select the collection field with a window; the
Entity field stays an array of refs, and the connection supplies the page shape:

```ts
const selection = Selection.make(Project, {
  id: true,
  comments: Selection.connection(Comment, { first: 10 }),
})
```

The read pages every parent in one statement: children are ranked per parent
in a window (`row_number() over (partition by parent order by ...)`) and the
first `pageSize + 1` of each are kept, so the statement count does not grow
with the number of parents. It emits `{ refs, hasNext, hasPrevious }`. `first`
and `last` page per parent; `after` and `before` cursors work when the read
targets a single parent (a cursor across parents is ambiguous and fails). Changing the window refetches the relation, and
a cursor page applied through `Remote.update` merges onto the stored page (append
for `after`, prepend for `before`), so "load more" accumulates.

## Computed fields

An aggregate over a collection relation is a binding-level `computed`; the read
runs a grouped `count(*)` and attaches the number to each row.

```ts
const Post = entity('Post', posts, {
  relations: {
    comments: many(Comment, { foreignKey: comments.postId, localKey: posts.id }),
  },
  computed: { commentCount: { relation: 'comments' } },
})
```

The binding derives `commentCount` as a number field and the Selection selects it.
The config's `where` filters the counted rows, and the source's principal policy
for that relation applies too. The count is the total, not the page, and `reader`,
the injected-executor path, does not compute fields.

## Mutation results

Reads are where the adapter compiles query shape. A mutation uses Drizzle
directly and returns patches; `returning(Project, fields)` pairs the columns
to select with the normalization of the rows they yield, rewriting a `one`
relation to its ref key (`selectColumns` and `normalize` are the halves).

```ts
import { returning } from 'foldkit-remote-drizzle'

const project = returning(Project, ['id', 'name', 'owner'])
const rows = yield* db
  .update(projects)
  .set({ name })
  .where(eq(projects.id, id))
  .returning(project.columns)

return { output: { id }, entities: project.patches(rows) }
```

## Compose a server

```ts
import { RemoteServer } from 'foldkit-remote-server'

const Server = RemoteServer.make({
  entities: [UserSource, ProjectSource],
  queries: [ProjectsByOwnerSource],
})
RemoteServer.validate(Data, Server)

// handlers require DrizzleDatabase
const handlers = RemoteServer.handlers(Server, principal)
```

Sources may require different services, but a single `RemoteServer.make` takes
one environment: if two sources need different services, annotate the union,
`RemoteServer.make<P, A | B>(...)`. This is a compile error rather than a
silently dropped requirement.

## Testing a binding

Every adapter path is validated against a real database in
`test/sqlite.test.ts`, which runs Drizzle on Node's built-in `node:sqlite` through
`drizzle-orm/node-sqlite` — no external service. That is a good template for an
application's own bindings: create the tables, insert rows, cast the Drizzle
database to `DrizzleDatabaseService`, and assert the emitted refs, counts, and
pages.

```ts
const sqlite = new DatabaseSync(':memory:')
sqlite.exec('create table projects (...); insert into projects values (...);')
const database = drizzle({ client: sqlite })

const records = await Effect.runPromise(
  source(Project)
    .read({ ids: ['p1'], fields: ProjectView.fields, principal: null })
    .pipe(Effect.provide(databaseLayer(database))),
)
```

The read emits ref keys; the same `Selection` schema the client decodes with turns
them into refs, so a unit test can assert the client's view without a transport:

```ts
const wire = records[0]!.values
// { id: 'p1', owner: 'User:u1', comments: ['Comment:c1', 'Comment:c2'] }
Schema.decodeUnknownSync(ProjectView.schema)(wire)
// { id: 'p1', owner: { entity: 'User', id: 'u1' }, comments: [{ entity: 'Comment', id: 'c1' }, …] }
```

`example/nested.ts` runs the whole path — declaration, source, wire, decode, a
windowed page, and a keyset query — against seeded SQLite:

```text
pnpm exec tsx packages/remote-drizzle/example/nested.ts
```

## Dialect

The compiler is table-agnostic (it accepts Drizzle's base `Table`), but its SQL
semantics follow Postgres: keyset pagination assumes Postgres NULL ordering (ASC:
nulls last, DESC: nulls first). The integration tests run against an in-process
`node:sqlite` database as a compiler check; they exercise real SQL generation,
joins, grouping and limits, but not Postgres NULL ordering.

## Limits

- Singular, to-many, and many-to-many relations selected as refs work (above). A
  to-many relation loads its children in one `IN (...)`; a many-to-many joins the
  through table to the target. A `Selection.connection` window loads one bounded
  page per parent in one ranked statement (`first`/`last`, plus `after`/`before`
  for a single parent). An embedded target object is not supported, and `reader`,
  the injected-executor path, does not load or compute.
- Computed fields are counts only (total, not per-page). Other aggregates are not
  built.
- No mutation DSL: use Drizzle directly inside `RemoteServer.mutation`.
- Nested pagination needs window functions and row-value `IN` in the database
  (Postgres, SQLite 3.25+, MySQL 8+). `bench/nested.bench.ts` times one source
  read over 50 parents; `test/nested.test.ts` pins that the statement count
  of a windowed nested read does not grow with the number of parents.

## License

MIT. The keyset-cursor and projection logic adapts [fate](https://github.com/nkzw-tech/fate)'s
Drizzle integration (MIT, Copyright (c) 2025 Nakazawa Tech); see
`THIRD_PARTY_NOTICES.md`.
