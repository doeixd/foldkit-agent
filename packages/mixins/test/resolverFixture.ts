/**
 * Test fixtures for the resolver. `inertHtml` is cast to a real Message
 * universe so event attributes can be constructed without a live Foldkit
 * runtime; the tagged shape is the same one `h` builds. See docs/design/mixins-DESIGN.md.
 */
import { Stream } from 'effect'
import type { Attribute, ChildAttribute, HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'

export type TestMessage = { readonly _tag: 'Clicked' } | { readonly _tag: 'Other' }

export const h = inertHtml as unknown as HtmlBuilder<TestMessage>

export const mount = (name: string): MountAction<TestMessage> => ({
  name,
  f: () => Stream.empty,
})

/** A branded value with the shape `childAttributes` produces, without a runtime. */
export const fakeChild = (inner: Attribute<TestMessage> | undefined): ChildAttribute =>
  ({
    __childAttribute: true,
    attribute: inner,
    dispatch: () => {},
    resolveUnmount: () => () => {},
    boundaryMappers: [],
  }) as unknown as ChildAttribute
