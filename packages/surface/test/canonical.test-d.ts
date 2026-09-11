import { Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Surface } from '../src/index.js'
import { Message, Model, TodoList } from './todoFixture.js'

type AppMessage = Schema.Schema.Type<typeof Message>

// No explicit generics and no casts: the renderer derives its Model and Message
// set from the Surface.
const renderTodoList = Surface.view(TodoList, (model, h) => {
  const _todos: ReadonlyArray<{ readonly id: string; readonly title: string }> = model.todos
  const _selection: string | null = model.selection
  h.OnClick(Message.CreatedTodo({ id: 't1', title: 'write' }))
  // @ts-expect-error `SelectedTodo` is not declared on TodoList
  h.OnClick(Message.SelectedTodo({ id: 't1' }))
  return h.empty
})

// The application boundary consumes the Root Model and narrows the app builder.
const appView = Surface.rootView(TodoList, undefined, renderTodoList)
const _view: (model: Schema.Schema.Type<typeof Model>, h: HtmlBuilder<AppMessage>) => Html = appView

void _view
