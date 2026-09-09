/**
 * The usage example from this package's README, type-checked so the
 * documentation cannot drift from the API.
 */
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Agent } from '../src/index.js'

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.Option(Schema.String),
})

type Model = typeof Model.Type

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedRenameTodo: { id: Schema.String, title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  ReceivedTodos: { todos: Schema.Array(Todo) },
  FailedToLoadTodos: { message: Schema.String },
})

type Message = typeof Message.Type

const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  context: TodoAgent.context({
    schema: Schema.Struct({
      selectedTodoId: Schema.Option(Schema.String),
      todos: Schema.Array(Todo),
    }),
    select: model => ({ selectedTodoId: model.selectedTodoId, todos: model.todos }),
  }),

  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a new todo' },
    RequestedRenameTodo: { name: 'rename_todo', description: 'Rename an existing todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})

declare const currentModel: () => Model
declare const sendToRuntime: (message: Message) => void
declare const onModelChange: (listener: () => void) => () => void

export const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: {
    model: currentModel,
    dispatch: sendToRuntime,
    subscribe: onModelChange,
  },
})
