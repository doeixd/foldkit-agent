/**
 * The kitchen-sink stack: one application that composes every package.
 *
 * - `foldkit-surface` owns the application and its projections.
 * - `foldkit-remote` is the server-derived cache submodel; `foldkit-remote-drizzle`
 *   compiles its entity reads and query connections into SQL, and
 *   `foldkit-remote-server` serves them.
 * - `foldkit-durable` orders the client-owned `notes` operations and `foldkit-sync`
 *   replicates them, exchanging through a `TransportClient`.
 * - `foldkit-agent` (and its adapters) project the same Model and Messages.
 */
import { DatabaseSync } from 'node:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Effect, Layer, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import * as Update from 'foldkit/update'
import {
  Entity,
  Mutation,
  Query,
  REMOTE_PROTOCOL_VERSION,
  Remote,
  RemoteClient,
  Selection,
  liveEventOf,
  type RemoteModel,
} from 'foldkit-remote'
import {
  databaseLayer,
  entity,
  normalize,
  one,
  query,
  selectColumns,
  source,
} from 'foldkit-remote-drizzle'
import { RemoteServer } from 'foldkit-remote-server'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
import {
  actorId as toDurableActorId,
  cursor as toDurableCursor,
  documentId as toDurableDocumentId,
  makeJournal,
  opId,
} from 'foldkit-durable'
import {
  type Sync as SyncContract,
  documentId as toSyncDocumentId,
  forApplication,
  replicaId,
  sequence,
  StorageError,
  type Storage,
  type TransportClient,
} from 'foldkit-sync'

// ---------------------------------------------------------------------------
// The Drizzle-backed Remote domain
// ---------------------------------------------------------------------------

export const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL
  );
  INSERT INTO users (id, name) VALUES ('u1', 'Ada');
  INSERT INTO projects (id, name, owner_id, status) VALUES
    ('p1', 'Apollo', 'u1', 'active'),
    ('p2', 'Borealis', 'u1', 'archived');
`)

export const db = drizzle({ client: sqlite })

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  status: text('status').notNull(),
})

/** The binding is the Remote `EntityDescriptor`; no second field declaration. */
export const User = entity('User', users)

/** `owner` is a relation: the entity field is a ref, and the read resolves it. */
export const Project = entity('Project', projects, {
  relations: { owner: one(User, { field: projects.ownerId }) },
})

/**
 * A nested selection: the Surface reads the owner's name through the ref, and
 * one `FoldkitRemoteRead` resolves both entities.
 */
export const ProjectSummary = Selection.make(Project, {
  id: true,
  name: true,
  status: true,
  owner: Selection.make(User, { name: true }),
})

export const RenameProject = Mutation.make('RenameProject', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

export const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
})

export const CreateProject = Mutation.make('CreateProject', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String, ownerId: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

/**
 * The live hub: mutation sources tell it what changed, and every live
 * subscriber that selects those fields receives them, re-read through the
 * entity source under its own principal. It needs only the entity sources.
 */
const entitySources = [source(User), source(Project)]
export const liveHub = Effect.runSync(
  RemoteServer.liveHub(RemoteServer.make({ entities: entitySources })),
)

const RenameProjectSource = RemoteServer.mutation(RenameProject, ({ input }) =>
  Effect.gen(function* () {
    const fields = ['id', 'name', 'status'] as const
    const rows = yield* Effect.promise(() =>
      Promise.resolve(
        db
          .update(projects)
          .set({ name: input.name })
          .where(eq(projects.id, input.id))
          .returning(selectColumns(Project, fields)),
      ),
    )
    // Live subscribers that select `name` learn of the rename from here.
    yield* liveHub.changed(Project.ref(input.id), ['name'])
    return { output: { id: input.id }, entities: normalize(Project, rows, fields) }
  }),
)

/**
 * A mutation that also changes a connection: the result carries the confirmed
 * insert, so the client's optimistic prepend becomes the real edge in place.
 */
const CreateProjectSource = RemoteServer.mutation(CreateProject, ({ input }) =>
  Effect.gen(function* () {
    const fields = ['id', 'name', 'status'] as const
    const rows = yield* Effect.promise(() =>
      Promise.resolve(
        db
          .insert(projects)
          .values({ id: input.id, name: input.name, ownerId: input.ownerId, status: 'active' })
          .returning(selectColumns(Project, fields)),
      ),
    )
    return {
      output: { id: input.id },
      entities: normalize(Project, rows, fields),
      connections: [
        {
          _tag: 'Insert' as const,
          connection: ProjectsByOwner.ref({ ownerId: input.ownerId }).identity,
          position: 'prepend' as const,
          edge: { entity: 'Project', id: input.id, key: Entity.refKey(Project.ref(input.id)) },
        },
      ],
    }
  }),
)

const ProjectsByOwnerSource = query(ProjectsByOwner, {
  entity: Project,
  orderBy: [{ column: projects.id, direction: 'desc' }],
  where: input => eq(projects.ownerId, input.ownerId),
})

export const Data = Remote.make({
  entities: [User, Project],
  mutations: [RenameProject, CreateProject],
  queries: [ProjectsByOwner],
})

// ---------------------------------------------------------------------------
// The Surface application
// ---------------------------------------------------------------------------

const Note = Schema.Struct({ id: Schema.String, body: Schema.String })

const Model = Schema.Struct({
  remote: Data.Model,
  projectId: Schema.String,
  notes: Schema.Array(Note),
  selectedNoteId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Ping: {},
  GotRemote: { message: Data.Message },
  RequestedCreateNote: { id: Schema.String, body: Schema.String },
  RequestedRenameNote: { id: Schema.String, body: Schema.String },
  SelectedNote: { id: Schema.String },
  SelectedProject: { id: Schema.String },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> => ({
  model: Message.match<Model>(message, {
    Ping: () => model,
    GotRemote: ({ message: remote }) => ({ ...model, remote: Data.update(model.remote, remote) }),
    RequestedCreateNote: ({ id, body }) => ({
      ...model,
      notes: model.notes.some(note => note.id === id)
        ? model.notes
        : [...model.notes, { id, body }],
    }),
    RequestedRenameNote: ({ id, body }) => ({
      ...model,
      notes: model.notes.map(note => (note.id === id ? { ...note, body } : note)),
    }),
    SelectedNote: ({ id }) => ({ ...model, selectedNoteId: id }),
    SelectedProject: ({ id }) => ({ ...model, projectId: id }),
  }),
})

export const App = Surface.application({
  Model,
  Message,
  initial: {
    remote: Data.initial,
    projectId: 'p1',
    notes: [],
    selectedNoteId: null,
    lastError: null,
  },
  update,
})

export const AppRemote = Remote.at(Data, App.model.remote)

/** A Surface over the server-derived project plus the replicated notes. */
export const BoardSurface = Surface.make(App, 'Board', {
  model: ({ model }) =>
    Projection.struct({
      project: Remote.select(AppRemote, ProjectSummary)('p1'),
      notes: model.notes,
      selectedNoteId: model.selectedNoteId,
    }),
  messages: [Message.SelectedNote, Message.RequestedRenameNote],
})

// ---------------------------------------------------------------------------
// The client-owned replica (durable + sync)
// ---------------------------------------------------------------------------

export const Notes = Projection.pick(App.fields.notes)
export const NoteChanges = MessageSet.make(App, [
  Message.RequestedCreateNote,
  Message.RequestedRenameNote,
])
export const KitchenSync: SyncContract<
  Message,
  { readonly notes: ReadonlyArray<typeof Note.Type> }
> = forApplication(App).make({
  documentId: toSyncDocumentId('kitchen'),
  shared: Notes,
  durable: NoteChanges,
})

/** A minimal in-memory `Storage`, so the replica needs no browser runtime. */
export const memoryStorage = (): Storage => {
  let stored: unknown
  return {
    load: () => Effect.succeed(stored),
    save: (state, expectedRevision) =>
      Effect.try({
        try: () => {
          const current = (stored as { revision?: number } | undefined)?.revision ?? null
          if (current !== expectedRevision) throw new Error('Replica was changed by another writer')
          stored = state
        },
        catch: cause => new StorageError({ message: 'Could not save the replica', cause }),
      }),
    close: Effect.void,
  }
}

export interface Principal {
  readonly actorId: string
  readonly canWrite: boolean
}

/**
 * The durable server half: a `makeJournal` over the Sync contract, and a
 * `TransportClient` the replica exchanges through.
 */
export const makeSyncServer = (principal: Principal) =>
  Effect.gen(function* () {
    const journal = yield* makeJournal({
      ...KitchenSync.journalContract(),
      file: ':memory:',
      opId: operation => opId(operation.opId),
      actorId: (value: Principal) => toDurableActorId(value.actorId),
    })
    const document = toDurableDocumentId('kitchen')
    const transport: TransportClient = {
      exchange: async (cursor, pending) => {
        for (const operation of pending) {
          await Effect.runPromise(journal.append(document, operation, principal))
        }
        const committed = await Effect.runPromise(
          journal.read(document, toDurableCursor(Number(cursor))),
        )
        return {
          operations: committed.map(entry => ({
            ...entry.operation,
            serverSequence: sequence(Number(entry.sequence)),
            actorId: String(entry.actorId),
          })),
          rejected: [],
          acknowledged: pending.map(operation => operation.opId),
        }
      },
    }
    return { journal, transport }
  })

export const openReplica = KitchenSync.openReplica(replicaId('kitchen-a'), memoryStorage())

// ---------------------------------------------------------------------------
// The server-backed RemoteClient
// ---------------------------------------------------------------------------

/**
 * Wires `RemoteClient` straight to `RemoteServer.handlers` over the Drizzle
 * database, so `Remote.observe`/`prefetch`/`mutate` run the real server path.
 */
export const serverClient = (principal: string): Layer.Layer<RemoteClient> => {
  const server = RemoteServer.make({
    entities: entitySources,
    mutations: [RenameProjectSource, CreateProjectSource],
    queries: [ProjectsByOwnerSource],
  })
  // Every source names a descriptor the domain declared.
  RemoteServer.validate(Data, server)
  const handlers = RemoteServer.handlers(server, principal, { live: liveHub })
  const onDatabase = databaseLayer(db)
  return Remote.coalesced(
    Layer.succeed(RemoteClient, {
      read: batch => handlers.FoldkitRemoteRead(batch).pipe(Effect.provide(onDatabase)),
      query: request => handlers.FoldkitRemoteQuery(request).pipe(Effect.provide(onDatabase)),
      mutate: request => handlers.FoldkitRemoteMutate(request).pipe(Effect.provide(onDatabase)),
      live: ({ requirements, after }) =>
        handlers
          .FoldkitRemoteLive({ version: REMOTE_PROTOCOL_VERSION, requirements, after })
          .pipe(Stream.map(liveEventOf), Stream.provide(onDatabase)),
    }),
  )
}
