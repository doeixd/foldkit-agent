/**
 * `foldkit-remote-server` — server-side Sources and handler compilation.
 *
 * Owns entity/query Sources, **selection authorization**, normalization, and
 * turning them into Effect RPC handlers. It does not own HTTP, serialization, or
 * auth protocol; `principal` is resolved outside and passed in.
 */
import { Effect, Schema } from 'effect'
import {
  MutationResult,
  ReadBatch,
  ReadBatchResult,
  RemoteMutationError,
  RemoteReadError,
  type EntityDescriptor,
  type MutationDescriptor,
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

export interface NormalizedPatch {
  readonly entity: string
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface EntitySourceContext<P> {
  readonly ids: readonly string[]
  readonly fields: readonly string[]
  readonly principal: P
}

export interface EntitySource<P> {
  readonly entity: string
  readonly read: (
    context: EntitySourceContext<P>,
  ) => Effect.Effect<ReadonlyArray<EntityRecord>, RemoteServerError>
  /** Returns the fields this principal may read; omitted means all requested. */
  readonly authorize?: (principal: P, fields: readonly string[]) => readonly string[]
}

export interface MutationOutcome<Output> {
  readonly output: Output
  readonly entities?: ReadonlyArray<NormalizedPatch>
}

export interface MutationSource<P> {
  readonly mutation: string
  readonly Input: Schema.Codec<unknown>
  readonly Output: Schema.Codec<unknown>
  readonly run: (context: {
    readonly input: unknown
    readonly principal: P
  }) => Effect.Effect<
    { readonly output: unknown; readonly entities: ReadonlyArray<NormalizedPatch> },
    RemoteServerError
  >
}

export interface ServerDefinition<P> {
  readonly entities: ReadonlyMap<string, EntitySource<P>>
  readonly mutations: ReadonlyMap<string, MutationSource<P>>
}

export const RemoteServer = {
  entity: <P = unknown>(
    entity: EntityDescriptor<any, any>,
    options: {
      readonly read: EntitySource<P>['read']
      readonly authorize?: EntitySource<P>['authorize']
    },
  ): EntitySource<P> => ({
    entity: entity.name,
    read: options.read,
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
  }),

  mutation: <P = unknown, Name extends string = string, Input = unknown, Output = unknown>(
    mutation: MutationDescriptor<Name, Input, Output>,
    run: (context: {
      readonly input: Input
      readonly principal: P
    }) => Effect.Effect<MutationOutcome<Output>, RemoteServerError>,
  ): MutationSource<P> => ({
    mutation: mutation.name,
    Input: mutation.Input,
    Output: mutation.Output,
    run: context =>
      run({ input: context.input as Input, principal: context.principal }).pipe(
        Effect.map(outcome => ({ output: outcome.output, entities: outcome.entities ?? [] })),
      ),
  }),

  make: <P = unknown>(
    _data: unknown,
    config: {
      readonly entities: readonly EntitySource<P>[]
      readonly mutations?: readonly MutationSource<P>[]
    },
  ): ServerDefinition<P> => ({
    entities: new Map(config.entities.map(source => [source.entity, source])),
    mutations: new Map((config.mutations ?? []).map(source => [source.mutation, source])),
  }),

  /**
   * Compiles the server into the `Read`/`Mutate` RPC handlers. `principal` is
   * resolved outside (authentication middleware in a later phase); unknown
   * entities, entities with no allowed fields, and unknown mutations return an
   * error or nothing rather than leaking existence.
   */
  handlers: <P>(
    server: ServerDefinition<P>,
    principal: P,
  ): {
    readonly FoldkitRemoteRead: (
      payload: Schema.Schema.Type<typeof ReadBatch>,
    ) => Effect.Effect<Schema.Schema.Type<typeof ReadBatchResult>, RemoteReadError>
    readonly FoldkitRemoteMutate: (payload: {
      readonly requestId: string
      readonly mutation: string
      readonly input: unknown
    }) => Effect.Effect<Schema.Schema.Type<typeof MutationResult>, RemoteMutationError>
  } => ({
    FoldkitRemoteRead: payload =>
      Effect.gen(function* () {
        const grouped = new Map<string, { ids: string[]; fields: Set<string> }>()
        for (const request of payload.requests) {
          let group = grouped.get(request.entity)
          if (group === undefined) {
            group = { ids: [], fields: new Set() }
            grouped.set(request.entity, group)
          }
          if (!group.ids.includes(request.id)) group.ids.push(request.id)
          for (const field of request.fields) group.fields.add(field)
        }

        const entities: Array<{
          readonly entity: string
          readonly id: string
          readonly values: Record<string, unknown>
        }> = []

        for (const [name, group] of grouped) {
          const source = server.entities.get(name)
          if (source === undefined) continue
          const requested = [...group.fields]
          const allowed =
            source.authorize === undefined ? requested : source.authorize(principal, requested)
          if (allowed.length === 0) continue

          const records = yield* source
            .read({ ids: group.ids, fields: allowed, principal })
            .pipe(Effect.mapError(error => new RemoteReadError({ message: error.message })))

          for (const record of records) {
            const values: Record<string, unknown> = {}
            for (const field of allowed) {
              if (field in record.values) values[field] = record.values[field]
            }
            entities.push({ entity: name, id: record.id, values })
          }
        }

        return { entities }
      }),

    FoldkitRemoteMutate: payload =>
      Effect.gen(function* () {
        const source = server.mutations.get(payload.mutation)
        if (source === undefined) {
          return yield* new RemoteMutationError({
            message: `Unknown mutation: ${payload.mutation}`,
          })
        }

        const input = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(source.Input)(payload.input),
          catch: () => new RemoteMutationError({ message: 'Invalid mutation input' }),
        })

        const outcome = yield* source
          .run({ input, principal })
          .pipe(Effect.mapError(error => new RemoteMutationError({ message: error.message })))

        return {
          output: Schema.encodeSync(source.Output)(outcome.output),
          entities: outcome.entities.map(patch => ({
            entity: patch.entity,
            id: patch.id,
            values: patch.values,
          })),
        }
      }),
  }),
}
