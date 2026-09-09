/**
 * Compile-time expectations. This file is type-checked, not executed: every
 * `@ts-expect-error` below must stay an error for the contract to hold.
 */
import { Option, Schema } from 'effect'
import { Agent } from '../src/index.js'
import { type Model, Message, Model as ModelSchema } from './todoApp.js'

const TodoAgent = Agent.forModel<Model>()

// A tag that is not part of the union is rejected.
Agent.expose(Message, {
  // @ts-expect-error NotAMessage is not a variant of this Message union.
  NotAMessage: { description: 'nope' },
})

// `input` without `toMessage` is rejected.
Agent.expose(Message, {
  // @ts-expect-error toMessage is required whenever input is provided.
  RequestedDeleteTodo: { description: 'Delete a todo', input: Schema.Struct({ id: Schema.String }) },
})

// `toMessage` must produce the internal Message payload.
Agent.expose(Message, {
  RequestedDeleteTodo: {
    description: 'Delete a todo',
    input: Schema.Struct({ id: Schema.String }),
    // @ts-expect-error the RequestedDeleteTodo payload requires `id`, not `todoId`.
    toMessage: ({ id }: { id: string }) => ({ todoId: id }),
  },
})

// A description is always required.
Agent.expose(Message, {
  // @ts-expect-error description is required.
  RequestedCreateTodo: { name: 'create_todo' },
})

// With the Model fixed, unannotated callbacks are checked against it.
TodoAgent.expose(Message, {
  RequestedDeleteTodo: {
    description: 'Delete the selected todo',
    available: model => Option.isSome(model.selectedTodoId),
  },
})

TodoAgent.expose(Message, {
  RequestedDeleteTodo: {
    description: 'Delete the selected todo',
    // @ts-expect-error `notAField` does not exist on the Model.
    available: model => model.notAField,
  },
})

TodoAgent.context({
  schema: Schema.Struct({ todos: Schema.Array(Schema.Unknown) }),
  select: model => ({ todos: model.todos }),
})

// The description shorthand is accepted wherever a variant config is.
Agent.expose(Message, {
  RequestedCreateTodo: 'Create a todo',
  RequestedDeleteTodo: { description: 'Delete a todo' },
})

// The shorthand does not weaken the tag check.
Agent.expose(Message, {
  // @ts-expect-error NotAMessage is not a variant of this Message union.
  NotAMessage: 'nope',
})

// A non-string, non-config value is still rejected.
Agent.expose(Message, {
  // @ts-expect-error a variant is a description or a config object, not a number.
  RequestedCreateTodo: 42,
})

// With the Model fixed, an unannotated authorize still resolves its request.
TodoAgent.expose(Message, {
  RequestedDeleteTodo: {
    description: 'Delete a todo',
    authorize: ({ model, transport }) => transport === 'webmcp' && model.todos.length > 0,
  },
})

// Agent.pick rejects a field the Model does not declare.
// @ts-expect-error 'missing' is not a field of the Model.
Agent.pick(ModelSchema, ['missing'])

// Agent.pick types the projection from the picked keys.
const picked = Agent.pick(ModelSchema, ['todos'])
const projection: { readonly todos: ReadonlyArray<{ readonly id: string }> } = picked.select({
  todos: [],
  selectedTodoId: Option.none(),
})
void projection

// @ts-expect-error selectedTodoId was not picked.
void picked.select({ todos: [], selectedTodoId: Option.none() }).selectedTodoId
