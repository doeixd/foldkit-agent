import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Effect } from 'effect'
import { RemoteServer } from 'foldkit-remote-server'
import { describe, expect, it } from 'vitest'
import {
  DrizzleDatabase,
  entity,
  source,
  type DrizzleDatabaseService,
  type DrizzleStatement,
} from '../src/index.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})

const UserBinding = entity('User', users)

/** Projects each row to the selected columns, as Drizzle's typed select would. */
const fakeDatabase = (rows: ReadonlyArray<Record<string, unknown>>) => {
  const calls: Array<{ selection: Record<string, unknown>; where: unknown }> = []
  const database: DrizzleDatabaseService = {
    select: selection => {
      const call = { selection, where: undefined as unknown }
      calls.push(call)
      const promise = Promise.resolve(
        rows.map(row => Object.fromEntries(Object.keys(selection).map(key => [key, row[key]]))),
      )
      const statement = {
        where: (condition: unknown) => {
          call.where = condition
          return statement
        },
        orderBy: () => statement,
        limit: () => statement,
        then: promise.then.bind(promise),
      } as unknown as DrizzleStatement
      return { from: () => statement }
    },
  }
  return { database, calls }
}

describe('RemoteDrizzle execution', () => {
  it('reads through the DrizzleDatabase service with a pruned projection', async () => {
    const { database, calls } = fakeDatabase([{ id: 'a', name: 'A', email: 'a@b.c' }])
    const read = source(UserBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: ['a'], fields: ['name'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([{ id: 'a', values: { id: 'a', name: 'A' } }])
    expect(Object.keys(calls[0]!.selection)).toEqual(['id', 'name'])
    expect(calls[0]!.where).toBeDefined()
  })

  it('serves through RemoteServer with a provided database service', async () => {
    const { database } = fakeDatabase([{ id: 'a', name: 'A', email: 'a@b.c' }])
    const server = RemoteServer.make({}, { entities: [source(UserBinding)] })

    const result = await Effect.runPromise(
      RemoteServer.handlers(server, null)
        .FoldkitRemoteRead({ requests: [{ entity: 'User', id: 'a', fields: ['name'] }] })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'a', values: { name: 'A' } }])
  })

  it('is inert for an empty id batch', async () => {
    const { database, calls } = fakeDatabase([])
    const read = source(UserBinding)

    const records = await Effect.runPromise(
      read
        .read({ ids: [], fields: ['name'], principal: null })
        .pipe(Effect.provideService(DrizzleDatabase, database)),
    )

    expect(records).toEqual([])
    expect(calls).toEqual([])
  })

  it('does not leak a database error to the client', async () => {
    const failing: DrizzleDatabaseService = {
      select: () => {
        const statement = {
          where: () => statement,
          orderBy: () => statement,
          limit: () => statement,
          then: (
            resolve: (value: ReadonlyArray<Record<string, unknown>>) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            Promise.reject(new Error('relation "secret_table" does not exist')).then(
              resolve,
              reject,
            ),
        } as unknown as DrizzleStatement
        return { from: () => statement }
      },
    }
    const server = RemoteServer.make({}, { entities: [source(UserBinding)] })

    const result = await Effect.runPromise(
      Effect.result(
        RemoteServer.handlers(server, null)
          .FoldkitRemoteRead({ requests: [{ entity: 'User', id: 'a', fields: ['name'] }] })
          .pipe(Effect.provideService(DrizzleDatabase, failing)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteReadError')
    expect(result.failure.message).toBe('Database query failed')
  })
})
