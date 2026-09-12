/**
 * The Drizzle database service.
 *
 * The adapter captures no connection: generated sources yield this service and
 * the application provides it — for example `Layer.succeed(DrizzleDatabase, db)`
 * over any Drizzle database whose select builder is thenable.
 *
 * `drizzle-orm/effect-postgres` is deliberately not imported. Its driver pulls
 * in `cache/core/cache-effect.ts`, which calls `Schema.TaggedErrorClass`, a name
 * effect@4.0.0-rc.112 does not export, so the module throws on load. Requiring
 * this tag lets an application provide a Drizzle database today and swap in the
 * Effect driver when the two versions agree.
 */
import type { AnyColumn, SQL, Table } from 'drizzle-orm'
import { Context, Layer } from 'effect'

export interface DrizzleStatement extends PromiseLike<ReadonlyArray<Record<string, unknown>>> {
  where(condition: SQL | undefined): DrizzleStatement
  innerJoin(table: Table, on: SQL): DrizzleStatement
  groupBy(...columns: AnyColumn[]): DrizzleStatement
  orderBy(...order: SQL[]): DrizzleStatement
  limit(count: number): DrizzleStatement
}

export interface DrizzleSelect {
  from(table: Table): DrizzleStatement
}

export interface DrizzleDatabaseService {
  select(selection: Record<string, AnyColumn | SQL>): DrizzleSelect
}

export class DrizzleDatabase extends Context.Service<DrizzleDatabase, DrizzleDatabaseService>()(
  'foldkit-remote-drizzle/DrizzleDatabase',
) {}

/**
 * Provides a Drizzle database as the `DrizzleDatabase` service. Any Drizzle
 * database qualifies; the cast is confined here because its builder is generic
 * over dialect and is not structurally nameable.
 */
export const databaseLayer = (database: unknown): Layer.Layer<DrizzleDatabase> =>
  Layer.succeed(DrizzleDatabase, database as DrizzleDatabaseService)
