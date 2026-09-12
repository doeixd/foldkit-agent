/**
 * The end-to-end example from the root README, type-checked so the proposal
 * document cannot drift from the implementation.
 */
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Agent } from '../src/index.js'
import { Projection } from 'foldkit-surface'

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

declare const currentModel: () => Model
declare const sendToRuntime: (message: Message) => void
declare const onModelChange: (listener: () => void) => () => void

const TodoAgent = Agent.forModel<Model>()

// Quick start.
const QuickStartAgent = TodoAgent.make({
  context: Projection.of(Model)({ selectedTodoId: true, todos: true }),

  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: 'Create a new todo',
    RequestedRenameTodo: 'Rename an existing todo',

    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete a todo',
    },
  }),
})

export const quickStartRuntime = TodoAgent.bind({
  definition: QuickStartAgent,
  host: { model: currentModel, dispatch: sendToRuntime, subscribe: onModelChange },
})

// The v1 API, end to end.
const AppAgent = TodoAgent.make({
  context: Projection.of(Model)({ selectedTodoId: true }),

  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: 'Create a todo',

    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete a todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})

const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: { model: currentModel, dispatch: sendToRuntime },
})

declare const id: string
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id })
agentRuntime.messages.dispatch('delete_todo', { id })

declare const todoId: string
declare const todos: ReadonlyArray<typeof Todo.Type>
// @ts-expect-error wrong payload, as the README states.
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { todoId })
// @ts-expect-error not exposed, as the README states.
agentRuntime.messages.dispatch(Message.ReceivedTodos, { todos })
// @ts-expect-error no such capability, as the README states.
agentRuntime.messages.dispatch('delete_todoo', { id })

// The introspection example.
const names: ReadonlyArray<string> = Agent.messages(AppAgent).map(message => message.name)
void names
