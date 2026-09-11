import { Surface } from '../src/index.js'
import { Feed, Message, PostList } from './feedFixture.js'

const postListView = Surface.view(PostList, (model, h) => {
  const _posts: ReadonlyArray<{ readonly title: string; readonly likes: number }> = model.posts
  h.OnClick(Message.ClickedLike({ index: 0 }))
  return h.empty
})

// A parent whose Model and Message set are supersets of the child's.
export const feedView = Surface.view(Feed, (model, h) =>
  h.div([], [Surface.embed(postListView)(model, h)]),
)
