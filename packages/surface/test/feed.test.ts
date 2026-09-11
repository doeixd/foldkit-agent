import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { Surface } from '../src/index.js'
import { Feed, PostDetail } from './feedFixture.js'

const root = {
  posts: [
    { id: 'p1', title: 'a', likes: 1 },
    { id: 'p2', title: 'b', likes: 2 },
  ],
  composer: '',
}

describe('Feed composition', () => {
  it('projects an array field through select(array(...))', () => {
    expect(Surface.read(Feed, root)).toEqual({
      posts: [
        { title: 'a', likes: 1 },
        { title: 'b', likes: 2 },
      ],
      composer: '',
    })
  })

  it('rootView passes params to a parameterized Surface', () => {
    let seen: unknown
    const render = Surface.view(PostDetail, model => {
      seen = model
      return null
    })
    Surface.rootView(PostDetail, { index: 1 }, render)(root, null as never)
    expect(seen).toEqual({ post: Option.some({ title: 'b', likes: 2 }) })
  })
})
