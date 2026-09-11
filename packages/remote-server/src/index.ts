/**
 * `foldkit-remote-server` — server-side Sources and handler compilation.
 *
 * Owns entity Sources, **selection authorization**, normalization, and turning
 * them into Effect RPC handlers. It does not own HTTP, serialization, or auth
 * protocol; `principal` is resolved outside and passed in.
 */
import { Effect, Schema } from 'effect'
import { ReadBatch, ReadBatchResult, RemoteReadError, type EntityDescriptor } from 'foldkit-remote'

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

export interface ServerDefinition<P> {
  readonly entities: ReadonlyMap<string, EntitySource<P>>
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

  make: <P = unknown>(
    _data: unknown,
    config: { readonly entities: readonly EntitySource<P>[] },
  ): ServerDefinition<P> => ({
    entities: new Map(config.entities.map(source => [source.entity, source])),
  }),

  /**
   * Compiles the server into the `Read` RPC handler. `principal` is resolved
   * outside (authentication middleware in a later phase); unknown entities and
   * entities with no allowed fields return nothing rather than leaking existence.
   */
  handlers: <P>(
    server: ServerDefinition<P>,
    principal: P,
  ): {
    readonly FoldkitRemoteRead: (
      payload: Schema.Schema.Type<typeof ReadBatch>,
    ) => Effect.Effect<Schema.Schema.Type<typeof ReadBatchResult>, RemoteReadError>
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
  }),
}
