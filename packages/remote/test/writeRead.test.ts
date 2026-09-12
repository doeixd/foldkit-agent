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

  const page = (refs: ReadonlyArray<string>, hasNext: boolean, hasPrevious: boolean) => ({
    refs,
    hasNext,
    hasPrevious,
  })

  const commentsOf = (store: ReturnType<typeof Remote.writeRead>) =>
    Option.getOrThrow(entry(store, entityKey('Project', 'p1'))).values.comments

  const writePage = (
    store: ReturnType<typeof Remote.writeRead>,
    window: { first?: number; last?: number; after?: string; before?: string },
    comments: ReturnType<typeof page>,
  ) =>
    Remote.writeRead(
      store,
      [{ entity: 'Project', id: 'p1', fields: ['comments'], windows: { comments: window } }],
      { entities: [{ entity: 'Project', id: 'p1', values: { comments } }] },
    )

  it('appends an after page onto the stored page', () => {
    const first = writePage(
      emptyStore,
      { first: 2 },
      page(['Comment:c1', 'Comment:c2'], true, false),
    )
    const second = writePage(
      first,
      { first: 2, after: 'Comment:c2' },
      page(['Comment:c3'], false, true),
    )

    expect(commentsOf(second)).toEqual(
      page(['Comment:c1', 'Comment:c2', 'Comment:c3'], false, true),
    )
  })

  it('prepends a before page ahead of the stored page', () => {
    const stored = writePage(
      emptyStore,
      { first: 2, after: 'x' },
      page(['Comment:c3', 'Comment:c4'], false, true),
    )
    const prepended = writePage(
      stored,
      { last: 2, before: 'Comment:c3' },
      page(['Comment:c1', 'Comment:c2'], true, false),
    )

    expect(commentsOf(prepended)).toEqual(
      page(['Comment:c1', 'Comment:c2', 'Comment:c3', 'Comment:c4'], true, false),
    )
  })

  it('replaces rather than merges when the window has no cursor', () => {
    const first = writePage(emptyStore, { first: 2 }, page(['Comment:c1'], true, false))
    const second = writePage(first, { first: 2 }, page(['Comment:c1'], false, false))

    expect(commentsOf(second)).toEqual(page(['Comment:c1'], false, false))
  })

  it('replaces rather than merges a malformed ref page', () => {
    const stored = writePage(emptyStore, { first: 2 }, page(['Comment:c1'], true, false))
    const malformed = [
      { refs: ['Comment:c2', 42], hasNext: false, hasPrevious: true },
      { refs: ['Comment:c2'], hasNext: 'no', hasPrevious: true },
      { refs: ['Comment:c2'], hasNext: false, hasPrevious: 'yes' },
    ]

    for (const value of malformed) {
      const written = writePage(
        stored,
        { first: 2, after: 'Comment:c1' },
        value as unknown as ReturnType<typeof page>,
      )
      expect(commentsOf(written)).toEqual(value)
    }
  })
})
