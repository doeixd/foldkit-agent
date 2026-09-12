/**
 * `Projection.compose` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { Projection, Surface } from '../src/index.js'
import { App, Model as TodoModel } from './todoFixture.js'

type TodoModelValue = typeof TodoModel.Type
declare const model: TodoModelValue

const Composed = Projection.compose(
  Projection.pick(App.model.todos),
  Projection.pick(App.model.selectedTodoId),
)
const value = Composed.get(model)
const _todos: ReadonlyArray<{ readonly id: string; readonly title: string }> = value.todos
const _selection: string | null = value.selectedTodoId

// @ts-expect-error `missing` is not a selected field
void value.missing

const OtherModel = Schema.Struct({ route: Schema.String, extra: Schema.Number })
const Other = Surface.application({ Model: OtherModel, Message: App.Message })
Projection.compose(
  // @ts-expect-error projections must share one Model
  Projection.pick(App.model.todos),
  Projection.pick(Other.model.route, Other.model.extra),
)
