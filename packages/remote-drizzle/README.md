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

## Bind an entity to a table

```ts
import { entity } from 'foldkit-remote-drizzle'
import { users } from './schema.js'

const User = entity('User', users)
```

`entity(name, table, { schema?, relations? })` derives an Effect Schema from the
table with `drizzle-orm/effect-schema` and exposes the table columns. The derived
Schema can seed the Remote Entity, so the table is declared once and the Entity
still checks field names:

```ts
import { Entity } from 'foldkit-remote'

const User = entity('User', users)
const UserEntity = Entity.make('User', User.Schema)
```

Pass `schema` to override the derived Schema, and `relations` to name a foreign
key:

```ts
const User = entity('User', users)
const Project = entity('Project', projects, {
  relations: { owner: { entity: User, field: projects.ownerId } },
})
```

A table must have an `id` column; every read needs it for normalization even
when the client did not select it.

## Provide the database

```ts
import { Layer } from 'effect'
import { DrizzleDatabase } from 'foldkit-remote-drizzle'

const DatabaseLive = Layer.succeed(DrizzleDatabase, db)
```

`db` is any Drizzle database whose select builder is thenable
(`db.select(columns).from(table).where(...).orderBy(...).limit(...)`).

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
handed. Use `reader(binding, run)` to inject your own executor for another
driver or a test.

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
- The window is client-supplied: `first`/`last` are clamped to a positive integer
  under `maxPageSize` (default 100), and `after`/`before` or `first`/`last`
  cannot be combined.
- A cursor that no longer resolves fails the query rather than silently
  returning page one.

## Relations

A singular relation is normalized: the Entity declares it as a ref, and a
Selection asks for the ref.

```ts
import { Entity, Selection } from 'foldkit-remote'

const User = entity('User', users)
const UserEntity = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Project = entity('Project', projects, {
  relations: { owner: { entity: User, field: projects.ownerId } },
})

// The Remote Entity, paired with the binding above.
const ProjectEntity = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    owner: Schema.NullOr(Entity.ref(UserEntity)),
  }),
)

const selection = Selection.make(ProjectEntity, { id: true, name: true, owner: true })
```

The read selects `projects.owner_id` and emits `values.owner = "User:u1"` — the
key the ref codec decodes. A null foreign key emits `null`, so the client holds a
present null rather than refetching forever. Select the target's fields
separately and let the normalized store share it.

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
`values.comments = ["Comment:c1", "Comment:c2"]`. The Entity declares the field as
`Schema.Array(Entity.ref(CommentEntity))` and the Selection selects it as `true`.

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

## Compose a server

```ts
import { RemoteServer } from 'foldkit-remote-server'

const Server = RemoteServer.make({}, {
  entities: [UserSource, ProjectSource],
  queries: [ProjectsByOwnerSource],
})

// handlers require DrizzleDatabase
const handlers = RemoteServer.handlers(Server, principal)
```

Sources may require different services, but a single `RemoteServer.make` takes
one environment: if two sources need different services, annotate the union,
`RemoteServer.make<P, A | B>(...)`. This is a compile error rather than a
silently dropped requirement.

## Limits

- Singular, to-many, and many-to-many relations selected as refs work (above).
  A to-many relation loads its children in one `IN (...)`; a many-to-many joins
  the through table to the target. Both order by the target id. Per-relation
  ordering/pagination and an embedded target object are not supported yet, and
  `reader`, the injected-executor path, does not load children.
- No mutation DSL: use Drizzle directly inside `RemoteServer.mutation`.
- No computed/aggregate selections yet.

## License

MIT. The keyset-cursor and projection logic adapts [fate](https://github.com/nkzw-tech/fate)'s
Drizzle integration (MIT, Copyright (c) 2025 Nakazawa Tech); see
`THIRD_PARTY_NOTICES.md`.
