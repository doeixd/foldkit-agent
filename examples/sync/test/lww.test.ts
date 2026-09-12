import { Effect, Exit, Schema, Scope } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { defineMessageUnion } from 'foldkit/message'
import {
  actorId as toActorId,
  cursor as toCursor,
  documentId as toDocumentId,
  makeJournal,
  OperationRejectedError,
  opId as toOpId,
  sequence as toSequence,
} from 'foldkit-durable'
import {
  defineSync,
  documentId,
  layerFromPromise,
  lwwRegister,
  openLwwClock,
  replicaId,
  type Operation,
  type TransportClient,
} from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { closeStorages, openStorage } from './helpers.js'

afterEach(closeStorages)

const Title = lwwRegister(Schema.NullOr(Schema.String))
const Shared = Schema.Struct({ title: Title.schema })
type Shared = typeof Shared.Type
const Message = defineMessageUnion({ Renamed: { title: Title.schema } })
type Message = typeof Message.Type
const empty: Shared = {
  title: { stamp: { counter: 0, replicaId: replicaId('initial') }, value: 'Original' },
}
const update = (model: Shared, message: Message): Shared => ({
  ...model,
  title: Title.merge(model.title, message.title),
})
const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: 'error' })
const Sync = defineSync({
  documentId: documentId('titles'),
  message: Message,
  shared: Shared,
  empty,
  durable: () => true,
  replay: update,
})
const rename = (counter: number, replica: string, value: string | null): Message =>
  Message.Renamed({ title: { stamp: { counter, replicaId: replicaId(replica) }, value } })

/** A promise facade over the Effect replica, so the LWW test reads as before. */
const openReplica = async (id: string, storage: Parameters<typeof Sync.openReplica>[1]) => {
  const replica = await Effect.runPromise(Sync.openReplica(replicaId(id), storage))
  return {
    shared: () => Effect.runSync(replica.shared),
    pending: () => Effect.runSync(replica.pending),
    cursor: () => Effect.runSync(replica.cursor),
    submit: (message: Message) => Effect.runPromise(replica.submit(message)),
    synchronize: (transport: TransportClient) =>
      Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport))),
    close: () => Effect.runPromise(replica.close),
  }
}

const openJournal = () => {
  const scope = Effect.runSync(Scope.make())
  const durable = Effect.runSync(
    makeJournal<Operation, Shared, { actorId: string; canWrite: boolean }>({
      file: ':memory:',
      operation: { encode: value => value, decode: Sync.codec.normalizeOperation },
      snapshot: {
        encode: Schema.encodeSync(Shared),
        decode: Schema.decodeUnknownSync(Shared, { onExcessProperty: 'error' }),
      },
      empty: () => empty,
      reduce: (model, operation) => update(model, decodeMessage(operation.message)),
      opId: operation => toOpId(operation.opId),
      actorId: principal => toActorId(principal.actorId),
      authorize: ({ principal }) => principal.canWrite,
      validate: ({ key, operation }) => {
        if (String(operation.documentId) !== String(key)) throw new Error('Wrong document')
      },
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  // The test drives the journal synchronously; `node:sqlite` is synchronous.
  const journal = {
    append: (key: string, input: unknown, principal: { actorId: string; canWrite: boolean }) =>
      Effect.runSync(durable.append(toDocumentId(key), input, principal)),
    floor: (key: string) => Effect.runSync(durable.floor(toDocumentId(key))),
    load: (key: string) => Effect.runSync(durable.load(toDocumentId(key))),
    read: (key: string, after: number) =>
      Effect.runSync(durable.read(toDocumentId(key), toCursor(after))),
    compact: (key: string, through: number) =>
      Effect.runSync(durable.compact(toDocumentId(key), toSequence(through))),
    close: () => Effect.runSync(Scope.close(scope, Exit.void)),
  }
  const transport = (canWrite = true): TransportClient => ({
    exchange: async (cursor, pending) => {
      const acknowledged: string[] = []
      const rejected: string[] = []
      for (const operation of pending) {
        try {
          journal.append('titles', operation, { actorId: 'owner', canWrite })
          acknowledged.push(operation.opId)
        } catch (error) {
          if (!(error instanceof OperationRejectedError)) throw error
          rejected.push(operation.opId)
        }
      }
      if (cursor < journal.floor('titles')) {
        const state = journal.load('titles')
        return {
          operations: [],
          acknowledged,
          rejected,
          checkpoint: { cursor: state.cursor, model: state.snapshot },
        }
      }
      return {
        operations: journal.read('titles', cursor).map(row => ({
          ...row.operation,
          serverSequence: row.sequence,
          actorId: row.actorId,
        })),
        acknowledged,
        rejected,
      }
    },
  })
  return { journal, transport }
}

it.each(['a', 'b'])(
  'converges offline edits when %s reconnects first, including reload and compaction',
  async first => {
    const factory = new IDBFactory()
    const { journal, transport } = openJournal()
    let a = await openReplica('a', await Effect.runPromise(openStorage('a', factory)))
    const b = await openReplica('b', await Effect.runPromise(openStorage('b', factory)))
    try {
      await a.submit(rename(1, 'a', 'Draft'))
      await a.submit(rename(2, 'a', 'Newer edit'))
      await b.submit(rename(1, 'b', 'Stale offline edit'))
      expect(a.shared().title.value).toBe('Newer edit')
      expect(b.shared().title.value).toBe('Stale offline edit')

      await a.close()
      a = await openReplica('a', await Effect.runPromise(openStorage('a', factory)))
      expect(a.shared().title).toEqual(rename(2, 'a', 'Newer edit').title)
      expect(a.pending()).toHaveLength(2)

      const ordered = first === 'a' ? [a, b] : [b, a]
      for (const replica of ordered) await replica.synchronize(transport())
      await a.synchronize(transport())
      await b.synchronize(transport())
      const winner = rename(2, 'a', 'Newer edit').title
      expect(a.shared().title).toEqual(winner)
      expect(b.shared().title).toEqual(winner)
      expect(journal.load('titles')).toEqual({ cursor: 3, snapshot: { title: winner } })
      expect(a.pending()).toEqual([])
      expect(b.pending()).toEqual([])

      journal.compact('titles', 3)
      const late = await openReplica('late', await Effect.runPromise(openStorage('late', factory)))
      try {
        await late.submit(rename(1, 'late', 'Late offline edit'))
        await late.synchronize(transport())
        expect(late.shared().title).toEqual(winner)
        expect(late.cursor()).toBe(4)
        expect(late.pending()).toEqual([])
      } finally {
        await late.close()
      }
    } finally {
      await a.close()
      await b.close()
      journal.close()
    }
  },
)

it('authorization still rejects a winning write and tombstones survive delayed edits', async () => {
  const { journal, transport } = openJournal()
  const replica = await openReplica(
    'a',
    await Effect.runPromise(openStorage('a', new IDBFactory())),
  )
  try {
    await replica.submit(rename(2, 'a', null))
    await replica.synchronize(transport())
    await replica.submit(rename(1, 'a', 'Delayed'))
    await replica.synchronize(transport())
    expect(replica.shared().title).toEqual(rename(2, 'a', null).title)

    await replica.submit(rename(3, 'a', 'Unauthorized resurrection'))
    expect(replica.shared().title.value).toBe('Unauthorized resurrection')
    await replica.synchronize(transport(false))
    expect(replica.shared().title).toEqual(rename(2, 'a', null).title)
    expect(replica.pending()).toEqual([])
    expect(journal.load('titles').cursor).toBe(2)

    await replica.submit(rename(4, 'a', 'Intentional restoration'))
    await replica.synchronize(transport())
    expect(journal.load('titles').snapshot.title.value).toBe('Intentional restoration')
  } finally {
    await replica.close()
    journal.close()
  }
})

it('allocates beyond rejected and unsubmitted writes after IndexedDB reload', async () => {
  const factory = new IDBFactory()
  const openClock = async () =>
    Effect.runPromise(
      openLwwClock({
        documentId: documentId('titles'),
        replicaId: replicaId('a'),
        storage: await Effect.runPromise(openStorage('a-clock', factory)),
      }),
    )
  const { journal, transport } = openJournal()
  let clock = await openClock()
  let replica = await openReplica('a', await Effect.runPromise(openStorage('a', factory)))
  try {
    const refused = await Effect.runPromise(clock.next(20))
    await replica.submit(Message.Renamed({ title: { stamp: refused, value: 'Refused' } }))
    await replica.synchronize(transport(false))
    expect(replica.shared()).toEqual(empty)
    expect(replica.pending()).toEqual([])
    expect(journal.load('titles').cursor).toBe(0)

    const unsubmitted = await Effect.runPromise(clock.next())
    expect(unsubmitted.counter).toBe(22)
    await Effect.runPromise(clock.close)
    await replica.close()
    clock = await openClock()
    replica = await openReplica('a', await Effect.runPromise(openStorage('a', factory)))

    const stamp = await Effect.runPromise(clock.next(replica.shared().title.stamp.counter))
    expect(stamp).toEqual({ counter: 23, replicaId: 'a' })
    await replica.submit(Message.Renamed({ title: { stamp, value: 'Accepted' } }))
    await replica.synchronize(transport())
    expect(journal.load('titles')).toEqual({
      cursor: 1,
      snapshot: { title: { stamp, value: 'Accepted' } },
    })
  } finally {
    await Effect.runPromise(clock.close)
    await replica.close()
    journal.close()
  }
})

it('IndexedDB admits only one clock writer at a saved revision', async () => {
  const factory = new IDBFactory()
  const openClock = async () =>
    Effect.runPromise(
      openLwwClock({
        documentId: documentId('titles'),
        replicaId: replicaId('a'),
        storage: await Effect.runPromise(openStorage('clock', factory)),
      }),
    )
  const first = await openClock()
  const second = await openClock()
  try {
    const results = await Promise.allSettled([
      Effect.runPromise(first.next()),
      Effect.runPromise(second.next()),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toEqual([
      { status: 'fulfilled', value: { counter: 1, replicaId: 'a' } },
    ])
    const failures = results.filter(result => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toMatchObject({
      message: expect.stringContaining('another writer'),
    })
  } finally {
    await Effect.runPromise(first.close)
    await Effect.runPromise(second.close)
  }
  const reopened = await openClock()
  try {
    expect(await Effect.runPromise(reopened.next())).toEqual({ counter: 2, replicaId: 'a' })
  } finally {
    await Effect.runPromise(reopened.close)
  }
})
