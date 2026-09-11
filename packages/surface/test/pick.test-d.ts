/**
 * `Surface.pick` inference contract. Type-checked but not executed.
 */
import { Optic, Schema } from 'effect'
import { ModelRef, Surface } from '../src/index.js'
import { App } from './todoFixture.js'

const model = {
  todos: [{ id: 'a', title: 'A' }],
  selectedTodoId: 'a' as string | null,
}

const Pick = Surface.pick(App.model.todos, App.model.selectedTodoId)
const _todos: ReadonlyArray<{ readonly id: string; readonly title: string }> = Pick.get(model).todos
const _selection: string | null = Pick.get(model).selectedTodoId

// @ts-expect-error a raw optic has no field key and is not a field reference
Surface.pick(ModelRef.fromOptic(Schema.String, Optic.id<{ name: string }>().key('name')))

const OtherModel = Schema.Struct({ route: Schema.String })
const Other = Surface.make({ Model: OtherModel, Message: App.Message })
// @ts-expect-error references must share one Root
Surface.pick(App.model.todos, Other.model.route)

const Recorded = Schema.Struct({
  byId: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String })),
})
const RecordedApp = Surface.make({ Model: Recorded, Message: App.Message })
// @ts-expect-error `.at` is a dynamic selection, not a static field reference
Surface.pick(RecordedApp.model.byId.at('a'))

const Indexed = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) })
const IndexedApp = Surface.make({ Model: Indexed, Message: App.Message })
// @ts-expect-error `.index` is a dynamic selection, not a static field reference
Surface.pick(IndexedApp.model.items.index(0))

// The encoded side is preserved through the reference tree.
const Transforming = Schema.Struct({ count: Schema.NumberFromString })
const TransformingApp = Surface.application({
  Model: Transforming,
  Message: App.Message,
  initial: { count: 0 },
  update: (model: { readonly count: number }) => ({ model }),
})
const Count = Surface.pick(TransformingApp.fields.count)
// The encoded side is exactly the field's encoded type, not `unknown` or `any`.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const _encoded: Equal<(typeof Count.schema)['Encoded'], { readonly count: string }> = true
const _notUnknown: Equal<(typeof Count.schema)['Encoded'], { readonly count: unknown }> = false
