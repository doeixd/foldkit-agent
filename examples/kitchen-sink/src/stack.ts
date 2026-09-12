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
import { createRequire } from 'node:module'
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
  Remote,
  RemoteClient,
  Selection,
  type RemoteModel,
} from 'foldkit-remote'
import {
  databaseLayer,
  entity,
  normalize,
  query,
  selectColumns,
  source,
} from 'foldkit-remote-drizzle'
import { RemoteServer } from 'foldkit-remote-server'
import { Projection, Surface } from 'foldkit-surface'
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

// Vite 5's builtin list predates `node:sqlite`, so a static import is rewritten
// to `sqlite` and fails to load under Vitest; let Node resolve it directly.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

export const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL
  );
  INSERT INTO projects (id, name, owner_id, status) VALUES
    ('p1', 'Apollo', 'u1', 'active'),
    ('p2', 'Borealis', 'u1', 'archived');
`)

export const db = drizzle({ client: sqlite })

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  status: text('status').notNull(),
})

/** The binding is the Remote `EntityDescriptor`; no second field declaration. */
export const Project = entity('Project', projects)

export const ProjectSummary = Selection.make(Project, { id: true, name: true, status: true })

export const RenameProject = Mutation.make('RenameProject', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

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
    return { output: { id: input.id }, entities: normalize(Project, rows, fields) }
  }),
)

export const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
})

const ProjectsByOwnerSource = query(ProjectsByOwner, {
  entity: Project,
  orderBy: [{ column: projects.id, direction: 'desc' }],
  where: input => eq(projects.ownerId, input.ownerId),
})

export const Data = Remote.make({
  entities: [Project],
  mutations: [RenameProject],
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
export const BoardSurface = Surface.define(App, 'Board', {
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

export const Notes = Surface.pick(App.fields.notes)
const NoteChanges = Surface.messages(App, [
  Message.RequestedCreateNote,
  Message.RequestedRenameNote,
])
export const KitchenSync: SyncContract<
  Message,
  { readonly notes: ReadonlyArray<typeof Note.Type> }
> = forApplication(App, {
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
    entities: [source(Project)],
    mutations: [RenameProjectSource],
    queries: [ProjectsByOwnerSource],
  })
  // Every source names a descriptor the domain declared.
  RemoteServer.validate(Data, server)
  const handlers = RemoteServer.handlers(server, principal)
  const onDatabase = databaseLayer(db)
  return Layer.succeed(RemoteClient, {
    read: batch => handlers.FoldkitRemoteRead(batch).pipe(Effect.provide(onDatabase)),
    query: request => handlers.FoldkitRemoteQuery(request).pipe(Effect.provide(onDatabase)),
    mutate: request => handlers.FoldkitRemoteMutate(request).pipe(Effect.provide(onDatabase)),
    live: () => Stream.empty,
  })
}
