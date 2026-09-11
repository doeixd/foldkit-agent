import type { Attribute, ChildAttribute, HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import type { MixinValue, SlotAttributes, StaticMixin } from 'foldkit-mixins'

export type TestMessage = { readonly _tag: 'Clicked' } | { readonly _tag: 'Other' }

export type Mixins = ReadonlyArray<MixinValue<TestMessage> | StaticMixin<TestMessage>>

/** `inertHtml` cast to a real Message universe; the tagged shape `h` builds. */
export const h = inertHtml as unknown as HtmlBuilder<TestMessage>

export const message = (tag: TestMessage['_tag']): TestMessage => ({ _tag: tag })

export const tagOf = <Message>(attribute: SlotAttributes<Message>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

export const tagsOf = <Message>(attributes: SlotAttributes<Message>): ReadonlyArray<string> =>
  attributes.map(tagOf)

export const attributeOf = <Message>(
  attributes: SlotAttributes<Message>,
  tag: string,
): Record<string, unknown> | undefined => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === tag) return attribute as Record<string, unknown>
  }
  return undefined
}

/** A branded value with the shape `childAttributes` produces, without a runtime. */
export const fakeChild = (inner: Attribute<TestMessage> | undefined): ChildAttribute =>
  ({
    __childAttribute: true,
    attribute: inner,
    dispatch: () => {},
    resolveUnmount: () => () => {},
    boundaryMappers: [],
  }) as unknown as ChildAttribute
