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
import type { AnyColumn, SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Context } from 'effect'

export interface DrizzleStatement extends PromiseLike<ReadonlyArray<Record<string, unknown>>> {
  where(condition: SQL | undefined): DrizzleStatement
  innerJoin(table: PgTable, on: SQL): DrizzleStatement
  orderBy(...order: SQL[]): DrizzleStatement
  limit(count: number): DrizzleStatement
}

export interface DrizzleSelect {
  from(table: PgTable): DrizzleStatement
}

export interface DrizzleDatabaseService {
  select(selection: Record<string, AnyColumn>): DrizzleSelect
}

export class DrizzleDatabase extends Context.Service<DrizzleDatabase, DrizzleDatabaseService>()(
  'foldkit-remote-drizzle/DrizzleDatabase',
) {}
