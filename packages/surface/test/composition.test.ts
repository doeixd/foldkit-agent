import { describe, expect, it } from 'vitest'
import { Surface } from '../src/index.js'
import { SignIn } from './storefrontFixture.js'

describe('Surface composition', () => {
  it('rootView projects the Root Model before rendering', () => {
    let seen: unknown
    const render = Surface.view(SignIn, model => {
      seen = model
      return null
    })
    const view = Surface.rootView(SignIn, undefined, render)
    const root = { auth: { email: 'a@b.c', signedIn: false }, cart: { items: [], total: 0 } }

    expect(view(root, null as never)).toBeNull()
    expect(seen).toEqual({ email: 'a@b.c', signedIn: false })
  })

  it('embed hands the parent model to the child renderer', () => {
    let seen: unknown
    const render = Surface.view(SignIn, model => {
      seen = model
      return null
    })
    const embed = Surface.embed(render)

    expect(embed({ email: 'a@b.c', signedIn: true, items: [], total: 0 }, null as never)).toBeNull()
    // The parent model is passed structurally; extra fields are type-invisible.
    expect(seen).toMatchObject({ email: 'a@b.c', signedIn: true })
  })
})
