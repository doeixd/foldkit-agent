/**
 * Compile-time expectations. This file is type-checked, not executed: every
 * `@ts-expect-error` below must stay an error for the contract to hold.
 */
import { Option, Schema } from 'effect'
import { Agent } from '../src/index.js'
import { type Model, Message } from './todoApp.js'

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
