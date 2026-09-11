import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { Remote, emptyStore, entityKey, entry, windowKey } from '../src/index.js'

describe('Remote.writeRead', () => {
  it('writes values and records the applied window', () => {
    const store = Remote.writeRead(
      emptyStore,
      [
        {
          entity: 'Project',
          id: 'p1',
          fields: ['comments'],
          windows: { comments: { first: 5 } },
        },
      ],
      { entities: [{ entity: 'Project', id: 'p1', values: { comments: [] } }] },
    )

    const written = Option.getOrThrow(entry(store, entityKey('Project', 'p1')))
    expect(written.values).toEqual({ comments: [] })
    expect(written.windows).toEqual({ comments: windowKey({ first: 5 }) })
  })

  it('records no window for a request without one', () => {
    const store = Remote.writeRead(emptyStore, [{ entity: 'User', id: 'u1', fields: ['name'] }], {
      entities: [{ entity: 'User', id: 'u1', values: { name: 'ada' } }],
    })

    expect(Option.getOrThrow(entry(store, entityKey('User', 'u1'))).windows).toEqual({})
  })
})
