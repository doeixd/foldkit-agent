import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from '../src/index.js'

const Post = Schema.Struct({ id: Schema.String, title: Schema.String, likes: Schema.Number })

export const PostSummary = Projection.of(Post)({ title: true, likes: true })

export const Model = Schema.Struct({
  posts: Schema.Array(Post),
  composer: Schema.String,
})

export const Message = defineMessageUnion({
  ChangedComposer: { text: Schema.String },
  ClickedPost: { index: Schema.Number },
  ClickedLike: { index: Schema.Number },
})

export const App = Surface.application({ Model, Message })

/** A child Surface over an array slice of the parent's Model. */
export const PostList = Surface.make(App, 'PostList', {
  model: ({ model }) =>
    Projection.struct({ posts: model.posts.select(Projection.array(PostSummary)) }),
  messages: [Message.ClickedPost, Message.ClickedLike],
})

/** The parent projects the child's array plus its own field. */
export const Feed = Surface.make(App, 'Feed', {
  model: ({ model }) =>
    Projection.struct({
      posts: model.posts.select(Projection.array(PostSummary)),
      composer: model.composer,
    }),
  messages: [Message.ChangedComposer, Message.ClickedPost, Message.ClickedLike],
})

/** A parameterized Surface, used at the application boundary. */
export const PostDetail = Surface.make(App, 'PostDetail', {
  Params: Schema.Struct({ index: Schema.Number }),
  model: ({ model, params }) =>
    Projection.struct({ post: model.posts.index(params.index).select(PostSummary) }),
  messages: [Message.ClickedLike],
})
