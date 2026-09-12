/**
 * `Surface.messages` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from '../src/index.js'
import { App, Message } from './todoFixture.js'

const Changes = Surface.messages(App, [Message.CreatedTodo, Message.RenamedTodo])
type Change = Schema.Schema.Type<typeof Changes.schema>

// `includes` narrows to exactly the subset, so this switch is exhaustive.
const describe = (message: Change): string => {
  switch (message._tag) {
    case 'CreatedTodo':
      return message.title
    case 'RenamedTodo':
      return `${message.id}:${message.title}`
  }
}
void describe

const OtherMessage = defineMessageUnion({ Ping: {} })
const Other = Surface.application({ Model: App.Model, Message: OtherMessage })
// @ts-expect-error `Ping` is not a variant of App's Message union
Surface.messages(App, [Other.Message.Ping])

const All = Surface.unionMessages(
  Surface.messages(App, [Message.CreatedTodo]),
  Surface.messages(App, [Message.RenamedTodo]),
)
// A union of disjoint subsets still narrows exactly.
const describeAll = (message: Schema.Schema.Type<typeof All.schema>): string => {
  switch (message._tag) {
    case 'CreatedTodo':
      return message.title
    case 'RenamedTodo':
      return message.id
  }
}
void describeAll

// The encoded side is preserved through a subset and its union.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const Transforming = defineMessageUnion({ Set: { value: Schema.NumberFromString } })
const TransformingApp = Surface.application({ Model: App.Model, Message: Transforming })
const SetOnly = Surface.messages(TransformingApp, [Transforming.Set])
const _encoded: Equal<
  (typeof SetOnly.schema)['Encoded'],
  { readonly _tag: 'Set'; readonly value: string }
> = true
