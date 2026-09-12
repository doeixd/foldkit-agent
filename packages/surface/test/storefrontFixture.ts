import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from '../src/index.js'

export const Model = Schema.Struct({
  auth: Schema.Struct({ email: Schema.String, signedIn: Schema.Boolean }),
  cart: Schema.Struct({
    items: Schema.Array(Schema.Struct({ sku: Schema.String, qty: Schema.Number })),
    total: Schema.Number,
  }),
})

export const Message = defineMessageUnion({
  ChangedEmail: { email: Schema.String },
  ClickedSignIn: {},
  ClickedAddToCart: { sku: Schema.String },
  ClickedCheckout: {},
})

export const App = Surface.application({ Model, Message })

export const SignIn = Surface.make(App, 'SignIn', {
  model: ({ model }) =>
    Projection.struct({ email: model.auth.email, signedIn: model.auth.signedIn }),
  messages: [Message.ChangedEmail, Message.ClickedSignIn],
})

export const CartBadge = Surface.make(App, 'CartBadge', {
  model: ({ model }) => Projection.struct({ items: model.cart.items }),
  messages: [Message.ClickedAddToCart],
})

/** The parent projects everything its children need. */
export const Storefront = Surface.make(App, 'Storefront', {
  model: ({ model }) =>
    Projection.struct({
      email: model.auth.email,
      signedIn: model.auth.signedIn,
      items: model.cart.items,
      total: model.cart.total,
    }),
  messages: [
    Message.ChangedEmail,
    Message.ClickedSignIn,
    Message.ClickedAddToCart,
    Message.ClickedCheckout,
  ],
})

/** A parent whose projected Model omits a child's fields. */
export const MissingFieldParent = Surface.make(App, 'MissingFieldParent', {
  model: ({ model }) => Projection.struct({ total: model.cart.total }),
  messages: [Message.ChangedEmail, Message.ClickedSignIn],
})

/** A parent whose Message set omits one the child declares. */
export const NarrowMessageParent = Surface.make(App, 'NarrowMessageParent', {
  model: ({ model }) =>
    Projection.struct({ email: model.auth.email, signedIn: model.auth.signedIn }),
  messages: [Message.ChangedEmail],
})
