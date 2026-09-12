import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Selection,
  coalesceReads,
  emptyOptimistic,
  emptyStore,
  entityKey,
  gc,
  requirementKey,
  writeEntity,
  type BatchRead,
} from '../src/index.js'

describe('retention follows a nested relation even when its target was reached first as a plain ref', () => {
  const Team = Entity.make('Team', Schema.Struct({ id: Schema.String, name: Schema.String }))
  const User = Entity.make(
    'User',
    Schema.Struct({ id: Schema.String, name: Schema.String, team: Entity.ref(Team) }),
  )
  const Project = Entity.make(
    'Project',
    Schema.Struct({ id: Schema.String, owner: Entity.ref(User), reviewer: Entity.ref(User) }),
  )
  const Owner = Selection.make(Project, { owner: true })
  const Reviewer = Selection.make(Project, {
    reviewer: Selection.make(User, { name: true, team: Selection.make(Team, { name: true }) }),
  })

  it('keeps the team the reviewer relation selects', () => {
    let store = writeEntity(emptyStore, entityKey('Project', 'p1'), {
      owner: 'User:u1',
      reviewer: 'User:u1',
    })
    store = writeEntity(store, entityKey('User', 'u1'), { name: 'ada', team: 'Team:t1' })
    store = writeEntity(store, entityKey('Team', 't1'), { name: 'core' })
    const kept = gc(
      { entities: store, connections: {}, optimistic: emptyOptimistic },
      {
        requirements: [
          { ...Owner, id: 'p1', fields: Owner.fields },
          { entity: 'Project', id: 'p1', fields: Reviewer.fields, relations: Reviewer.relations },
        ],
        connections: [],
      },
    )
    expect(Object.keys(kept.entities).sort()).toEqual(['Project:p1', 'Team:t1', 'User:u1'])
  })
})

describe('coalescing keys and windows', () => {
  it('keys a requirement independently of window and relation key order', () => {
    const a = {
      entity: 'P',
      id: '1',
      fields: ['c', 'd'],
      windows: { c: { first: 1 }, d: { first: 2 } },
      relations: { c: { entity: 'C', fields: ['x'] }, d: { entity: 'D', fields: ['y'] } },
    }
    const b = {
      entity: 'P',
      id: '1',
      fields: ['d', 'c'],
      windows: { d: { first: 2 }, c: { first: 1 } },
      relations: { d: { entity: 'D', fields: ['y'] }, c: { entity: 'C', fields: ['x'] } },
    }
    expect(requirementKey(a)).toBe(requirementKey(b))
  })

  it('does not merge two requirements whose windows differ for the same field', async () => {
    const batches: Array<Parameters<BatchRead>[0]> = []
    const read: BatchRead = batch =>
      Effect.sync(() => {
        batches.push(batch)
        return { entities: [] }
      })
    await Effect.runPromise(
      Effect.gen(function* () {
        const coalesced = yield* coalesceReads(read)
        yield* Effect.all(
          [
            coalesced({
              version: 3,
              requests: [{ entity: 'P', id: '1', fields: ['c'], windows: { c: { first: 1 } } }],
            }),
            coalesced({
              version: 3,
              requests: [{ entity: 'P', id: '1', fields: ['c'], windows: { c: { first: 5 } } }],
            }),
          ],
          { concurrency: 'unbounded' },
        )
      }),
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]!.requests).toHaveLength(2)
    expect(batches[0]!.requests.map(request => request.windows?.c?.first).sort()).toEqual([1, 5])
  })
})
