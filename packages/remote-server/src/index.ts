/**
 * `foldkit-remote-server` — server-side Sources and handler compilation.
 *
 * Owns entity/query Sources, **selection authorization**, normalization, and
 * turning them into Effect RPC handlers. It does not own HTTP, serialization, or
 * auth protocol; `principal` is resolved outside and passed in.
 */
import { Effect, Queue, Schema, Stream } from 'effect'
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteLiveError,
  RemoteMutationError,
  RemoteProtocolError,
  RemoteQueryError,
  RemoteReadError,
  connectionIdentity,
  entityKey,
  refsIn,
  stableStringify,
  type Boundary,
  type ConnectionChangeSchema,
  type ConnectionIdentity,
  type LiveChange,
  type MutationDescriptor,
  type NormalizedPatch,
  type QueryDescriptor,
  type QueryWindow,
  type RelationRequirement,
  type RemoteDescriptor,
  type RemoteRpcClient,
} from 'foldkit-remote'
import { Requirement } from 'foldkit-surface'

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
  /** The fields the entity declares; a request for any other never reaches `read`. */
  readonly fields?: ReadonlySet<string> | undefined
  readonly read: (
    context: EntitySourceContext<P>,
  ) => Effect.Effect<ReadonlyArray<EntityRecord>, RemoteServerError, R>
  /** Returns the fields this principal may read; omitted means all requested. */
  readonly authorize?: (principal: P, fields: readonly string[]) => readonly string[]
}

/** A connection change a mutation made, as the wire carries it. */
export type ConnectionChange = Schema.Schema.Type<typeof ConnectionChangeSchema>

const connectionChange = (
  connection: ConnectionIdentity,
  ref: { readonly entity: string; readonly id: string },
  position: 'prepend' | 'append' | 'remove',
): ConnectionChange => {
  const edge = { entity: ref.entity, id: ref.id, key: entityKey(ref.entity, ref.id) }
  return position === 'remove'
    ? { _tag: 'Remove', connection: connectionIdentity(connection), edge }
    : { _tag: 'Insert', connection: connectionIdentity(connection), position, edge }
}

/**
 * The requested fields, in request order, that the source declares and the
 * principal may read. Never a field the client did not request, even if a
 * permissive `authorize` returns more.
 */
const allowedFields = <P, R>(
  source: EntitySource<P, R>,
  principal: P,
  requested: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const declared =
    source.fields === undefined ? requested : requested.filter(field => source.fields!.has(field))
  if (declared.length === 0) return []
  const permitted = new Set(
    source.authorize === undefined ? declared : source.authorize(principal, declared),
  )
  return declared.filter(field => permitted.has(field))
}

/** The windows of the fields being read; only a field being read carries its window. */
const windowsOf = (
  windows: Readonly<Record<string, QueryWindow>> | undefined,
  fields: ReadonlyArray<string>,
): { readonly windows?: Readonly<Record<string, QueryWindow>> } => {
  if (windows === undefined) return {}
  const kept = Object.fromEntries(
    fields.flatMap(field =>
      Object.hasOwn(windows, field) ? [[field, windows[field]!] as const] : [],
    ),
  )
  return Object.keys(kept).length === 0 ? {} : { windows: kept }
}

export interface MutationOutcome<Output> {
  readonly output: Output
  readonly entities?: ReadonlyArray<NormalizedPatch>
  /** Connection changes the mutation made; the client settles them with its patches. */
  readonly connections?: ReadonlyArray<ConnectionChange>
}

export interface MutationSource<P, R = never> {
  readonly mutation: string
  readonly Input: Schema.Codec<unknown>
  readonly Output: Schema.Codec<unknown>
  readonly run: (context: { readonly input: unknown; readonly principal: P }) => Effect.Effect<
    {
      readonly output: unknown
      readonly entities: ReadonlyArray<NormalizedPatch>
      readonly connections: ReadonlyArray<ConnectionChange>
    },
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
    readonly requirements: ReadonlyArray<Requirement>
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

/** A nested selection may not reach further than this many relation levels. */
const DEFAULT_MAX_DEPTH = 8

export interface HandlerOptions<P, R = never> {
  /** A read or live subscription may not name more ids of one entity than this; default 1000. */
  readonly maxIdsPerEntity?: number | undefined
  /** A nested selection may not reach further than this many relation levels; default 8. */
  readonly maxDepth?: number | undefined
  /** A hub whose `changed`/`deleted` signals reach the subscribers this handler registers. */
  readonly live?: LiveHub<P, R> | undefined
}

/** Fails when the requirements name more distinct ids of one entity than `maxIds`. */
const checkIdsPerEntity = (
  requirements: ReadonlyArray<Requirement>,
  maxIds: number,
): string | undefined => {
  const ids = new Map<string, Set<string>>()
  for (const requirement of requirements) {
    const seen = ids.get(requirement.entity) ?? new Set<string>()
    seen.add(requirement.id)
    ids.set(requirement.entity, seen)
    if (seen.size > maxIds) return requirement.entity
  }
  return undefined
}

type LiveChangeValue = Schema.Schema.Type<typeof LiveChange>
type Uncursored<T> = T extends unknown ? Omit<T, 'cursor'> : never

interface LiveRef {
  readonly entity: string
  readonly id: string
}

/**
 * The server-side "these fields changed" signal. A hub tracks each live
 * subscriber's requirements (entity, id, fields) and principal; `changed`
 * re-reads the changed fields a subscriber selects through the entity's own
 * source, under that subscriber's principal, and streams the patch to it.
 * Subscribers that select none of the changed fields do no work. Cursors
 * continue from the cursor each subscriber resumed at, so the client's
 * duplicate and gap handling is unchanged.
 */
export interface LiveHub<P, R = never> {
  readonly changed: (
    ref: LiveRef,
    fields: ReadonlyArray<string>,
  ) => Effect.Effect<void, RemoteServerError, R>
  readonly deleted: (ref: LiveRef) => Effect.Effect<void>
  /** Registers a subscriber for the stream's lifetime; `handlers` calls this. */
  readonly subscribe: (context: {
    readonly requirements: ReadonlyArray<Requirement>
    readonly after: number
    readonly principal: P
    /** Refuses a subscription naming more ids of one entity than this. */
    readonly maxIdsPerEntity?: number | undefined
  }) => Stream.Stream<LiveChangeValue, RemoteServerError>
  /** How many subscribers are registered now. */
  readonly size: Effect.Effect<number>
}

interface Selected {
  readonly fields: Set<string>
  /** The window each paged field was subscribed with, so a re-read pages the same way. */
  readonly windows: Map<string, QueryWindow>
}

/** The subscribers one source read answers, and the fields each wants of it. */
interface ReadGroup<P> {
  readonly windows: Readonly<Record<string, QueryWindow>>
  readonly entries: Array<{ readonly subscriber: Subscriber<P>; readonly fields: string[] }>
}

interface Subscriber<P> {
  /** Per entity:id, the fields (and their windows) this subscriber selects. */
  readonly selected: ReadonlyMap<string, Selected>
  readonly principal: P
  readonly queue: Queue.Queue<LiveChangeValue>
  cursor: number
}

const liveHub = <P, R>(entities: ReadonlyArray<EntitySource<P, R>>): Effect.Effect<LiveHub<P, R>> =>
  Effect.sync(() => {
    const sources = new Map(entities.map(source => [source.entity, source]))
    const subscribers = new Set<Subscriber<P>>()
    const emit = (subscriber: Subscriber<P>, change: Uncursored<LiveChangeValue>) => {
      subscriber.cursor += 1
      return Queue.offer(subscriber.queue, {
        ...change,
        cursor: subscriber.cursor,
      } as LiveChangeValue)
    }

    return {
      subscribe: ({ requirements, after, principal, maxIdsPerEntity }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const over = checkIdsPerEntity(
              requirements,
              Math.max(1, maxIdsPerEntity ?? DEFAULT_MAX_IDS_PER_ENTITY),
            )
            if (over !== undefined) {
              return yield* new RemoteServerError({
                message: `Too many "${over}" ids in one live subscription`,
              })
            }
            const selected = new Map<string, Selected>()
            for (const requirement of requirements) {
              const key = `${requirement.entity}:${requirement.id}`
              const entry = selected.get(key) ?? { fields: new Set<string>(), windows: new Map() }
              for (const field of requirement.fields) entry.fields.add(field)
              for (const [field, window] of Object.entries(requirement.windows ?? {})) {
                entry.windows.set(field, window)
              }
              selected.set(key, entry)
            }
            const subscriber: Subscriber<P> = {
              selected,
              principal,
              queue: yield* Queue.unbounded<LiveChangeValue>(),
              cursor: after,
            }
            subscribers.add(subscriber)
            return Stream.fromQueue(subscriber.queue).pipe(
              Stream.ensuring(Effect.sync(() => void subscribers.delete(subscriber))),
            )
          }),
        ),

      changed: (ref, fields) =>
        Effect.gen(function* () {
          const key = `${ref.entity}:${ref.id}`
          const source = sources.get(ref.entity)
          if (source === undefined) return
          // One source read per principal (by identity) and window signature:
          // subscribers sharing both share the read, and a paged field is
          // re-read with the window the subscriber selected it with.
          const groups = new Map<P, Map<string, ReadGroup<P>>>()
          for (const subscriber of subscribers) {
            const selected = subscriber.selected.get(key)
            if (selected === undefined) continue
            const wanted = fields.filter(field => selected.fields.has(field))
            if (wanted.length === 0) continue
            const windows = Object.fromEntries(
              wanted.flatMap(field => {
                const window = selected.windows.get(field)
                return window === undefined ? [] : [[field, window] as const]
              }),
            )
            const byWindows = groups.get(subscriber.principal) ?? new Map<string, ReadGroup<P>>()
            groups.set(subscriber.principal, byWindows)
            const windowKey = stableStringify(windows)
            const group = byWindows.get(windowKey) ?? { windows, entries: [] }
            byWindows.set(windowKey, group)
            group.entries.push({ subscriber, fields: wanted })
          }
          for (const [principal, byWindows] of groups) {
            for (const { windows, entries: group } of byWindows.values()) {
              const requested = [...new Set(group.flatMap(entry => entry.fields))]
              const allowed = allowedFields(source, principal, requested)
              if (allowed.length === 0) continue
              const allowedSet = new Set(allowed)
              const records = yield* source.read({
                ids: [ref.id],
                fields: allowed,
                principal,
                ...windowsOf(windows, allowed),
              })
              const record = records.find(candidate => candidate.id === ref.id)
              if (record === undefined) continue
              for (const { subscriber, fields: wanted } of group) {
                const values: Record<string, unknown> = Object.create(null)
                for (const field of wanted) {
                  if (allowedSet.has(field) && Object.hasOwn(record.values, field)) {
                    values[field] = record.values[field]
                  }
                }
                const changed = Object.keys(values)
                if (changed.length === 0) continue
                yield* emit(subscriber, {
                  _tag: 'EntityPatched',
                  entity: ref.entity,
                  id: ref.id,
                  values,
                  changed,
                })
              }
            }
          }
        }),

      deleted: ref =>
        Effect.gen(function* () {
          const key = `${ref.entity}:${ref.id}`
          for (const subscriber of subscribers) {
            if (!subscriber.selected.has(key)) continue
            yield* emit(subscriber, { _tag: 'EntityDeleted', entity: ref.entity, id: ref.id })
          }
        }),

      size: Effect.sync(() => subscribers.size),
    }
  })

const protocolMismatch = (received: number): RemoteProtocolError | undefined =>
  received === REMOTE_PROTOCOL_VERSION
    ? undefined
    : new RemoteProtocolError({
        message: `Remote protocol version ${received} is not ${REMOTE_PROTOCOL_VERSION}`,
        expected: REMOTE_PROTOCOL_VERSION,
        received,
      })

interface EntityGroup {
  readonly ids: Set<string>
  /** The union of the requests' fields, windows, and relations. */
  slice: RelationRequirement
}

/**
 * One level's requests grouped per entity and window signature: ids and
 * slices unioned. Requests that page a relation differently are separate
 * groups, so one window never answers for another id.
 */
const groupByEntity = (requests: ReadonlyArray<Requirement>): EntityGroup[] => {
  const grouped = new Map<string, EntityGroup>()
  for (const request of requests) {
    const groupKey = `${request.entity}\u0000${stableStringify(request.windows ?? null)}`
    const group = grouped.get(groupKey)
    if (group === undefined) {
      grouped.set(groupKey, {
        ids: new Set([request.id]),
        slice: Requirement.mergeRelation({ entity: request.entity, fields: [] }, request),
      })
    } else {
      group.ids.add(request.id)
      group.slice = Requirement.mergeRelation(group.slice, request)
    }
  }
  return [...grouped.values()]
}

/** A descriptor's name and, when it declares them, its fields. */
interface EntityName {
  readonly name: string
  readonly fields?: Readonly<Record<string, unknown>> | undefined
}

export const RemoteServer = {
  /** A mutation outcome's report that `ref` now heads the connection. */
  prepend: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => connectionChange(connection, ref, 'prepend'),

  /** A mutation outcome's report that `ref` now ends the connection. */
  append: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => connectionChange(connection, ref, 'append'),

  /** A mutation outcome's report that `ref` left the connection. */
  remove: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => connectionChange(connection, ref, 'remove'),

  /**
   * An entity source. Given the Entity (or anything with its `name` and
   * `fields`), a request for a field the entity does not declare never
   * reaches `read` or `authorize`.
   */
  entity: <P = unknown, R = never>(
    entity: EntityName,
    options: {
      readonly read: EntitySource<P, R>['read']
      readonly authorize?: EntitySource<P, R>['authorize']
    },
  ): EntitySource<P, R> => ({
    entity: entity.name,
    ...(entity.fields === undefined ? {} : { fields: new Set(Object.keys(entity.fields)) }),
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
        Effect.map(outcome => ({
          output: outcome.output,
          entities: outcome.entities ?? [],
          connections: outcome.connections ?? [],
        })),
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
    entity: EntityName,
    options: { readonly subscribe: LiveSource<P, R>['subscribe'] },
  ): LiveSource<P, R> => ({
    entity: entity.name,
    subscribe: options.subscribe,
  }),

  /**
   * A `LiveHub` over entity sources. Pass it to `handlers` as `live`, then
   * call `hub.changed(ref, fields)` from wherever the data changes (a mutation
   * source, a database trigger); each subscriber that selects any of those
   * fields receives them, re-read through the entity source under its own
   * principal. It needs only the entity sources, so the mutation sources that
   * signal it can be built after it.
   */
  liveHub,

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
   * Checks every source name against the declared domain, so an undeclared
   * entity/query/mutation fails at startup rather than returning nothing at
   * call time.
   */
  validate: (domain: RemoteDescriptor, server: ServerDefinition<any, any>): void => {
    const assertDeclared = (
      kind: string,
      declared: ReadonlyMap<string, unknown>,
      names: Iterable<string>,
    ): void => {
      for (const name of names) {
        if (!declared.has(name))
          throw new Error(`RemoteServer: ${kind} "${name}" is not declared in the Remote domain`)
      }
    }
    assertDeclared('entity', domain.registry.entities, server.entities.keys())
    assertDeclared('query', domain.registry.queries, server.queries.keys())
    assertDeclared('mutation', domain.registry.mutations, server.mutations.keys())
  },

  /**
   * Compiles the server into the `Read`/`Mutate` RPC handlers. `principal` is
   * resolved outside (authentication middleware in a later phase); unknown
   * entities, entities with no allowed fields, and unknown mutations return an
   * error or nothing rather than leaking existence.
   */
  handlers: <P, R>(
    server: ServerDefinition<P, R>,
    principal: P,
    options: HandlerOptions<P, R> = {},
  ): RemoteRpcClient<R> => ({
    FoldkitRemoteRead: Effect.fn('RemoteServer.FoldkitRemoteRead')(function* (payload) {
      const mismatch = protocolMismatch(payload.version)
      if (mismatch !== undefined) return yield* mismatch

      const entities: Array<{
        readonly entity: string
        readonly id: string
        readonly values: Record<string, unknown>
      }> = []
      // What this batch has already read per entity:id (fields and values), so
      // a target several relations share is fetched once, a later spec's nested
      // relation is followed from the values already in hand, and a cyclic
      // selection stays finite.
      const fetched = new Map<string, Set<string>>()
      const fetchedValues = new Map<string, Record<string, unknown>>()
      const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
      const maxIds = Math.max(1, options.maxIdsPerEntity ?? DEFAULT_MAX_IDS_PER_ENTITY)

      // The limit guards the client's batch, whatever windows split it into;
      // a nested level's fan-out is the server's own doing, so it is chunked
      // rather than refused.
      const over = checkIdsPerEntity(payload.requests, maxIds)
      if (over !== undefined) {
        return yield* new RemoteReadError({ message: `Too many "${over}" ids in one read batch` })
      }

      // Level by level: a level's relation refs become the next level's requests.
      let pending: ReadonlyArray<Requirement> = payload.requests
      for (let depth = 0; pending.length > 0; depth++) {
        if (depth > maxDepth) {
          return yield* new RemoteReadError({
            message: `Nested selection deeper than ${maxDepth} relation levels`,
          })
        }
        const next: Requirement[] = []

        /**
         * Follows each relation's refs in `values` into the next level, asking
         * only for fields this batch has not read of the target; a target read
         * in full already is followed further from its fetched values.
         */
        const follow = (
          values: Record<string, unknown>,
          relations: Readonly<Record<string, RelationRequirement>>,
        ): void => {
          for (const [field, relation] of Object.entries(relations)) {
            if (!Object.hasOwn(values, field)) continue
            for (const ref of refsIn(values[field])) {
              if (ref.entity !== relation.entity) continue
              const key = `${relation.entity}:${ref.id}`
              const read = fetched.get(key)
              const fields = relation.fields.filter(name => read?.has(name) !== true)
              if (fields.length > 0) {
                next.push({
                  entity: relation.entity,
                  id: ref.id,
                  fields,
                  ...(relation.windows === undefined ? {} : { windows: relation.windows }),
                  ...(relation.relations === undefined ? {} : { relations: relation.relations }),
                })
              } else if (relation.relations !== undefined) {
                follow(fetchedValues.get(key) ?? {}, relation.relations)
              }
            }
          }
        }

        for (const { ids, slice } of groupByEntity(pending)) {
          const name = slice.entity
          const source = server.entities.get(name)
          if (source === undefined) continue
          const allowed = allowedFields(source, principal, slice.fields)
          if (allowed.length === 0) continue

          const windows = windowsOf(slice.windows, allowed)
          const idList = [...ids]
          const records: EntityRecord[] = []
          for (let start = 0; start < idList.length; start += maxIds) {
            records.push(
              ...(yield* source
                .read({
                  ids: idList.slice(start, start + maxIds),
                  fields: allowed,
                  principal,
                  ...windows,
                })
                .pipe(
                  Effect.catchTag('RemoteServerError', error =>
                    Effect.fail(new RemoteReadError({ message: error.message })),
                  ),
                )),
            )
          }

          for (const record of records) {
            // Null-prototype so a crafted field name (`__proto__`) cannot reach
            // the prototype, and `Object.hasOwn` so inherited names are ignored.
            const values: Record<string, unknown> = Object.create(null)
            for (const field of allowed) {
              if (Object.hasOwn(record.values, field)) values[field] = record.values[field]
            }
            entities.push({ entity: name, id: record.id, values })

            const key = `${name}:${record.id}`
            const known = fetched.get(key) ?? new Set<string>()
            for (const field of allowed) known.add(field)
            fetched.set(key, known)
            fetchedValues.set(key, { ...fetchedValues.get(key), ...values })

            // `values` holds only allowed fields, so a relation the principal
            // may not read is never followed.
            follow(values, slice.relations ?? {})
          }
        }
        // A target read by this level (as another group's request) is not
        // read again by the next.
        pending = next.flatMap(request => {
          const read = fetched.get(`${request.entity}:${request.id}`)
          const fields = request.fields.filter(field => read?.has(field) !== true)
          return fields.length === 0 ? [] : [{ ...request, fields }]
        })
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
        connections: outcome.connections,
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
      const mismatch = protocolMismatch(payload.version)
      if (mismatch !== undefined) return Stream.fail(mismatch)
      const entities = [...new Set(payload.requirements.map(request => request.entity))]
      const streams: Array<Stream.Stream<LiveChangeValue, RemoteServerError, R>> = entities.flatMap(
        entity => {
          const source = server.live.get(entity)
          if (source === undefined) return []
          return [
            source.subscribe({
              requirements: payload.requirements.filter(request => request.entity === entity),
              after: payload.after,
              principal,
            }),
          ]
        },
      )
      if (options.live !== undefined) {
        streams.push(
          options.live.subscribe({
            requirements: payload.requirements,
            after: payload.after,
            principal,
            maxIdsPerEntity: options.maxIdsPerEntity,
          }),
        )
      }
      // An entity with no live source simply contributes nothing; the client's
      // planner refetches it rather than the stream failing.
      return Stream.mergeAll(streams, { concurrency: 'unbounded' }).pipe(
        Stream.mapError(error => new RemoteLiveError({ message: error.message })),
      )
    },
  }),
}
