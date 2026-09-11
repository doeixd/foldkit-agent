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
