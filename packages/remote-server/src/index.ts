/**
 * `foldkit-remote-server` — server-side Sources and handler compilation.
 *
 * Owns entity/query Sources, **selection authorization**, normalization, and
 * turning them into Effect RPC handlers. It does not own HTTP, serialization, or
 * auth protocol; `principal` is resolved outside and passed in.
 */
import { Effect, Schema, Stream } from 'effect'
import {
  MutationResult,
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  RemoteLiveError,
  RemoteMutationError,
  RemoteQueryError,
  RemoteReadError,
  type Boundary,
  type EntityDescriptor,
  type LiveChange,
  type LiveRequirement,
  type MutationDescriptor,
  type NormalizedPatch,
  type QueryDescriptor,
  type QueryWindow,
  type ReadRequest,
} from 'foldkit-remote'

export class RemoteServerError extends Schema.TaggedError<RemoteServerError>()(
  'RemoteServerError',
  {
    message: Schema.String,
  },
) {}

export interface EntityRecord {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface EntitySourceContext<P> {
  readonly ids: readonly string[]
  readonly fields: readonly string[]
  /** A pagination window per requested relation field. */
  readonly windows?: Readonly<Record<string, QueryWindow>> | undefined
  readonly principal: P
}

export interface EntitySource<P, R = never> {
  readonly entity: string
  readonly read: (
    context: EntitySourceContext<P>,
  ) => Effect.Effect<ReadonlyArray<EntityRecord>, RemoteServerError, R>
  /** Returns the fields this principal may read; omitted means all requested. */
  readonly authorize?: (principal: P, fields: readonly string[]) => readonly string[]
}

export interface MutationOutcome<Output> {
  readonly output: Output
  readonly entities?: ReadonlyArray<NormalizedPatch>
}

export interface MutationSource<P, R = never> {
  readonly mutation: string
  readonly Input: Schema.Codec<unknown>
  readonly Output: Schema.Codec<unknown>
  readonly run: (context: {
    readonly input: unknown
    readonly principal: P
  }) => Effect.Effect<
    { readonly output: unknown; readonly entities: ReadonlyArray<NormalizedPatch> },
    RemoteServerError,
    R
  >
}

export interface QueryPage {
  readonly edges: ReadonlyArray<{
    readonly entity: string
    readonly id: string
    readonly key: string
  }>
  readonly start: Boundary
  readonly end: Boundary
}

export interface QuerySource<P, R = never> {
  readonly query: string
  readonly Input: Schema.Codec<unknown>
  readonly run: (context: {
    readonly input: unknown
    readonly window: QueryWindow
    readonly principal: P
  }) => Effect.Effect<QueryPage, RemoteServerError, R>
}

export interface LiveSource<P, R = never> {
  readonly entity: string
  readonly subscribe: (context: {
    readonly requirements: ReadonlyArray<Schema.Schema.Type<typeof ReadRequest>>
    readonly after: number
    readonly principal: P
  }) => Stream.Stream<Schema.Schema.Type<typeof LiveChange>, RemoteServerError, R>
}

export interface ServerDefinition<P, R = never> {
  readonly entities: ReadonlyMap<string, EntitySource<P, R>>
  readonly mutations: ReadonlyMap<string, MutationSource<P, R>>
  readonly queries: ReadonlyMap<string, QuerySource<P, R>>
  readonly live: ReadonlyMap<string, LiveSource<P, R>>
}

/** A read batch may not carry more than this many distinct ids per entity. */
const DEFAULT_MAX_IDS_PER_ENTITY = 1000

export interface HandlerOptions {
  readonly maxIdsPerEntity?: number | undefined
}

export const RemoteServer = {
  entity: <P = unknown, R = never>(
    entity: EntityDescriptor<any, any>,
    options: {
      readonly read: EntitySource<P, R>['read']
      readonly authorize?: EntitySource<P, R>['authorize']
    },
  ): EntitySource<P, R> => ({
    entity: entity.name,
    read: options.read,
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
  }),

  mutation: <
    P = unknown,
    R = never,
    Name extends string = string,
    Input = unknown,
    Output = unknown,
  >(
    mutation: MutationDescriptor<Name, Input, Output>,
    run: (context: {
      readonly input: Input
      readonly principal: P
    }) => Effect.Effect<MutationOutcome<Output>, RemoteServerError, R>,
  ): MutationSource<P, R> => ({
    mutation: mutation.name,
    Input: mutation.Input,
    Output: mutation.Output,
    run: context =>
      run({ input: context.input as Input, principal: context.principal }).pipe(
        Effect.map(outcome => ({ output: outcome.output, entities: outcome.entities ?? [] })),
      ),
  }),

  query: <P = unknown, R = never, Input = unknown>(
    query: QueryDescriptor<string, Input, unknown>,
    run: (context: {
      readonly input: Input
      readonly window: QueryWindow
      readonly principal: P
    }) => Effect.Effect<QueryPage, RemoteServerError, R>,
  ): QuerySource<P, R> => ({
    query: query.name,
    Input: query.Input,
    run: context =>
      run({ input: context.input as Input, window: context.window, principal: context.principal }),
  }),

  /** Streams live entity patches for a client's live requirements. */
  live: <P = unknown, R = never>(
    entity: EntityDescriptor<any, any>,
    options: { readonly subscribe: LiveSource<P, R>['subscribe'] },
  ): LiveSource<P, R> => ({
    entity: entity.name,
    subscribe: options.subscribe,
  }),

  make: <P = unknown, R = never>(config: {
    readonly entities: readonly EntitySource<P, R>[]
    readonly mutations?: readonly MutationSource<P, R>[]
    readonly queries?: readonly QuerySource<P, R>[]
    readonly live?: readonly LiveSource<P, R>[]
  }): ServerDefinition<P, R> => ({
    entities: new Map(config.entities.map(source => [source.entity, source])),
    mutations: new Map((config.mutations ?? []).map(source => [source.mutation, source])),
    queries: new Map((config.queries ?? []).map(source => [source.query, source])),
    live: new Map((config.live ?? []).map(source => [source.entity, source])),
  }),

  /**
   * Compiles the server into the `Read`/`Mutate` RPC handlers. `principal` is
   * resolved outside (authentication middleware in a later phase); unknown
   * entities, entities with no allowed fields, and unknown mutations return an
   * error or nothing rather than leaking existence.
   */
  handlers: <P, R>(
    server: ServerDefinition<P, R>,
    principal: P,
    options: HandlerOptions = {},
  ): {
    readonly FoldkitRemoteRead: (
      payload: Schema.Schema.Type<typeof ReadBatch>,
    ) => Effect.Effect<Schema.Schema.Type<typeof ReadBatchResult>, RemoteReadError, R>
    readonly FoldkitRemoteMutate: (payload: {
      readonly requestId: string
      readonly mutation: string
      readonly input: unknown
    }) => Effect.Effect<Schema.Schema.Type<typeof MutationResult>, RemoteMutationError, R>
    readonly FoldkitRemoteQuery: (
      payload: Schema.Schema.Type<typeof QueryRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof QueryResult>, RemoteQueryError, R>
    readonly FoldkitRemoteLive: (
      payload: Schema.Schema.Type<typeof LiveRequirement>,
    ) => Stream.Stream<Schema.Schema.Type<typeof LiveChange>, RemoteLiveError, R>
  } => ({
    FoldkitRemoteRead: Effect.fn('RemoteServer.FoldkitRemoteRead')(function* (payload) {
      const grouped = new Map<
        string,
        {
          ids: string[]
          seenIds: Set<string>
          fields: Set<string>
          windows: Map<string, QueryWindow>
        }
      >()
      for (const request of payload.requests) {
        let group = grouped.get(request.entity)
        if (group === undefined) {
          group = { ids: [], seenIds: new Set(), fields: new Set(), windows: new Map() }
          grouped.set(request.entity, group)
        }
        if (!group.seenIds.has(request.id)) {
          group.seenIds.add(request.id)
          group.ids.push(request.id)
        }
        for (const field of request.fields) group.fields.add(field)
        for (const [field, window] of Object.entries(request.windows ?? {})) {
          group.windows.set(field, window)
        }
      }

      const entities: Array<{
        readonly entity: string
        readonly id: string
        readonly values: Record<string, unknown>
      }> = []

      for (const [name, group] of grouped) {
        const source = server.entities.get(name)
        if (source === undefined) continue
        if (group.ids.length > (options.maxIdsPerEntity ?? DEFAULT_MAX_IDS_PER_ENTITY)) {
          return yield* new RemoteReadError({ message: `Too many "${name}" ids in one read batch` })
        }
        const requested = [...group.fields]
        const permitted =
          source.authorize === undefined ? requested : source.authorize(principal, requested)
        // Never read or return a field the client did not request, even if a
        // permissive `authorize` allows more.
        const permittedSet = new Set(permitted)
        const allowed = requested.filter(field => permittedSet.has(field))
        if (allowed.length === 0) continue

        // Only a field being read carries its window.
        const allowedSet = new Set(allowed)
        const windows = Object.fromEntries(
          [...group.windows].filter(([field]) => allowedSet.has(field)),
        )
        const records = yield* source
          .read({
            ids: group.ids,
            fields: allowed,
            principal,
            ...(Object.keys(windows).length === 0 ? {} : { windows }),
          })
          .pipe(
            Effect.catchTag('RemoteServerError', error =>
              Effect.fail(new RemoteReadError({ message: error.message })),
            ),
          )

        for (const record of records) {
          // Null-prototype so a crafted field name (`__proto__`) cannot reach
          // the prototype, and `Object.hasOwn` so inherited names are ignored.
          const values: Record<string, unknown> = Object.create(null)
          for (const field of allowed) {
            if (Object.hasOwn(record.values, field)) values[field] = record.values[field]
          }
          entities.push({ entity: name, id: record.id, values })
        }
      }

      return { entities }
    }),

    FoldkitRemoteMutate: Effect.fn('RemoteServer.FoldkitRemoteMutate')(function* (payload) {
      const source = server.mutations.get(payload.mutation)
      if (source === undefined) {
        return yield* new RemoteMutationError({
          message: `Unknown mutation: ${payload.mutation}`,
        })
      }

      const input = yield* Schema.decodeUnknownEffect(source.Input)(payload.input).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.fail(new RemoteMutationError({ message: 'Invalid mutation input' })),
        ),
      )

      const outcome = yield* source
        .run({ input, principal })
        .pipe(
          Effect.catchTag('RemoteServerError', error =>
            Effect.fail(new RemoteMutationError({ message: error.message })),
          ),
        )

      const output = yield* Schema.encodeUnknownEffect(source.Output)(outcome.output).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.fail(new RemoteMutationError({ message: 'Invalid mutation output' })),
        ),
      )

      return {
        output,
        entities: outcome.entities.map(patch => ({
          entity: patch.entity,
          id: patch.id,
          values: patch.values,
        })),
      }
    }),

    FoldkitRemoteQuery: Effect.fn('RemoteServer.FoldkitRemoteQuery')(function* (payload) {
      const source = server.queries.get(payload.query)
      if (source === undefined) {
        return yield* new RemoteQueryError({ message: `Unknown query: ${payload.query}` })
      }

      const input = yield* Schema.decodeUnknownEffect(source.Input)(payload.input).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.fail(new RemoteQueryError({ message: 'Invalid query input' })),
        ),
      )

      const page = yield* source
        .run({ input, window: payload.window, principal })
        .pipe(
          Effect.catchTag('RemoteServerError', error =>
            Effect.fail(new RemoteQueryError({ message: error.message })),
          ),
        )

      return { edges: page.edges, start: page.start, end: page.end }
    }),

    FoldkitRemoteLive: payload => {
      const entities = [...new Set(payload.requirements.map(request => request.entity))]
      const streams = entities.flatMap(entity => {
        const source = server.live.get(entity)
        if (source === undefined) return []
        return [
          source.subscribe({
            requirements: payload.requirements.filter(request => request.entity === entity),
            after: payload.after,
            principal,
          }),
        ]
      })
      // An entity with no live source simply contributes nothing; the client's
      // planner refetches it rather than the stream failing.
      return Stream.mergeAll(streams, { concurrency: 'unbounded' }).pipe(
        Stream.mapError(error => new RemoteLiveError({ message: error.message })),
      )
    },
  }),
}
