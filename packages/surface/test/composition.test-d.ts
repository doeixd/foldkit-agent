import { Surface } from '../src/index.js'
import {
  CartBadge,
  Message,
  MissingFieldParent,
  NarrowMessageParent,
  SignIn,
  Storefront,
} from './storefrontFixture.js'

const signInView = Surface.view(SignIn, (model, h) => {
  const _email: string = model.email
  const _signedIn: boolean = model.signedIn
  h.OnClick(Message.ChangedEmail({ email: 'a@b.c' }))
  h.OnClick(Message.ClickedSignIn())
  return h.empty
})

const cartView = Surface.view(CartBadge, (model, h) => {
  const _items: ReadonlyArray<{ readonly sku: string; readonly qty: number }> = model.items
  h.OnClick(Message.ClickedAddToCart({ sku: 'x' }))
  return h.empty
})

// Both children compose into a parent whose Model and Message set are supersets.
export const storefrontView = Surface.view(Storefront, (model, h) =>
  h.div([], [Surface.embed(signInView)(model, h), Surface.embed(cartView)(model, h)]),
)

// @ts-expect-error the parent's Model omits `email` and `signedIn`
Surface.view(MissingFieldParent, (model, h) => Surface.embed(signInView)(model, h))

// @ts-expect-error the parent's Message set cannot route `ClickedSignIn`
Surface.view(NarrowMessageParent, (model, h) => Surface.embed(signInView)(model, h))
