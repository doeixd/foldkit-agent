import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Query,
  edge,
  emptyConnection,
  emptyStore,
  entityKey,
  items,
  merge,
  readField,
  segment,
  terminal,
  writeEntity,
} from '../src/index.js'

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String, sort: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
})

describe('Query and QueryRef', () => {
  it('connection identity excludes the pagination window', () => {
    const base = ProjectsByOwner.ref({ ownerId: 'u1', sort: 'newest' })
    const latest = Query.first(25)(base)
    const older = Query.after('c1')(Query.first(25)(base))

    expect(latest.identity).toBe(base.identity)
    expect(older.identity).toBe(base.identity)
    expect(older.window).toEqual({ first: 25, after: 'c1' })
  })

  it('canonicalises input so key order does not change identity', () => {
    const a = ProjectsByOwner.ref({ ownerId: 'u1', sort: 'newest' })
    const b = ProjectsByOwner.ref({ sort: 'newest', ownerId: 'u1' })
    expect(a.identity).toBe(b.identity)
  })

  it('a different filter or sort is a different connection', () => {
    expect(ProjectsByOwner.ref({ ownerId: 'u1', sort: 'newest' }).identity).not.toBe(
      ProjectsByOwner.ref({ ownerId: 'u2', sort: 'newest' }).identity,
    )
    expect(ProjectsByOwner.ref({ ownerId: 'u1', sort: 'oldest' }).identity).not.toBe(
      ProjectsByOwner.ref({ ownerId: 'u1', sort: 'newest' }).identity,
    )
  })

  it('connection spec records the entity and optional edgeKey/live', () => {
    const Project = Entity.make('Project', Schema.Struct({ id: Schema.String }))
    const spec = Query.connection(Project, {
      edgeKey: Schema.String,
      live: { prepend: 'visible' },
    })
    expect(spec.entity).toBe('Project')
    expect(spec.live).toEqual({ prepend: 'visible' })
    expect(spec.edgeKey).toBe(Schema.String)
  })

  it('an entity write propagates to every connection that references it', () => {
    let store = writeEntity(emptyStore, entityKey('E', 'a'), { label: 'old' })
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, terminal),
    )
    const labels = () =>
      items(connection).map(value =>
        readField(store, entityKey(value.ref.entity, value.ref.id), 'label'),
      )

    expect(labels()).toEqual([Option.some('old')])
    store = writeEntity(store, entityKey('E', 'a'), { label: 'new' })
    expect(labels()).toEqual([Option.some('new')])
  })
})
