import type { DrizzleDatabaseService, DrizzleStatement } from '../src/index.js'

export interface FakeCall {
  selection: Record<string, unknown>
  where: unknown
  innerJoin: unknown
  orderBy: ReadonlyArray<unknown> | undefined
  limit: number | undefined
}

/**
 * A structural fake database: each `select` projects the queued rows to the
 * requested column keys, as Drizzle's typed select would, and records the
 * clauses for assertions.
 */
export const makeDatabase = (rowsAt: (index: number) => ReadonlyArray<Record<string, unknown>>) => {
  const calls: FakeCall[] = []
  let index = 0
  const database: DrizzleDatabaseService = {
    select: selection => {
      const rows = rowsAt(index)
      index += 1
      const call: FakeCall = {
        selection,
        where: undefined,
        innerJoin: undefined,
        orderBy: undefined,
        limit: undefined,
      }
      calls.push(call)
      const promise = Promise.resolve(
        rows.map(row => Object.fromEntries(Object.keys(selection).map(key => [key, row[key]]))),
      )
      const statement = {
        where: (condition: unknown) => {
          call.where = condition
          return statement
        },
        innerJoin: (table: unknown, on: unknown) => {
          call.innerJoin = { table, on }
          return statement
        },
        orderBy: (...order: ReadonlyArray<unknown>) => {
          call.orderBy = order
          return statement
        },
        limit: (count: number) => {
          call.limit = count
          return statement
        },
        then: promise.then.bind(promise),
      } as unknown as DrizzleStatement
      return { from: () => statement }
    },
  }
  return { database, calls }
}

export const fakeDatabase = (rows: ReadonlyArray<Record<string, unknown>>) =>
  makeDatabase(() => rows)

export const fakeDatabaseQueue = (batches: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  makeDatabase(index => batches[index] ?? [])
