/**
 * `Surface.compose` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { Surface } from '../src/index.js'
import { App, Model as TodoModel } from './todoFixture.js'

type TodoModelValue = typeof TodoModel.Type
declare const model: TodoModelValue

const Composed = Surface.compose(
  Surface.pick(App.model.todos),
  Surface.pick(App.model.selectedTodoId),
)
const value = Composed.get(model)
const _todos: ReadonlyArray<{ readonly id: string; readonly title: string }> = value.todos
const _selection: string | null = value.selectedTodoId

// @ts-expect-error `missing` is not a selected field
void value.missing

const OtherModel = Schema.Struct({ route: Schema.String, extra: Schema.Number })
const Other = Surface.application({ Model: OtherModel, Message: App.Message })
// @ts-expect-error projections must share one Model
Surface.compose(Surface.pick(App.model.todos), Surface.pick(Other.model.route, Other.model.extra))
