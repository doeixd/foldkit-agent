import { Option } from 'effect'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Message as MessageUnion, Model, emptyModel, type Message } from './todoApp.js'

const update = (model: Model, _message: Message) => ({ model })

const App = Surface.application({ Model, Message: MessageUnion, initial: emptyModel, update })
const Context = Surface.compose(
  Surface.pick(App.fields.todos),
  Surface.pick(App.fields.selectedTodoId),
)

const TodoAgent = Agent.forApplication(App)

describe('Agent.forApplication', () => {
  it('accepts a Surface projection as context', () => {
    const definition = TodoAgent.make({
      context: Context,
      messages: TodoAgent.expose(MessageUnion, {
        RequestedDeleteTodo: 'Delete the selected todo',
      }),
    })

    expect(definition.context?.read(emptyModel)).toEqual({
      todos: [],
      selectedTodoId: Option.none(),
    })
    expect(Agent.messages(definition).map(message => message.name)).toEqual([
      'requested_delete_todo',
    ])
  })

  it('still accepts a read-only Projection for context', () => {
    const definition = TodoAgent.make({
      context: Projection.of(Model)({ todos: true }),
      messages: TodoAgent.expose(MessageUnion, {}),
    })

    expect(definition.context?.read(emptyModel)).toEqual({ todos: [] })
  })

  it('exposes only the variants of a Surface subset', () => {
    const Changes = Surface.messages(App, [
      MessageUnion.RequestedCreateTodo,
      MessageUnion.RequestedRenameTodo,
    ])

    const messages = TodoAgent.exposeSubset(Changes, {
      RequestedCreateTodo: 'Create a todo',
    })

    expect(messages.variants.map(variant => variant.tag)).toEqual(['RequestedCreateTodo'])
  })

  it('refuses a subset from another application', () => {
    const OtherApp = Surface.application({
      Model,
      Message: MessageUnion,
      initial: emptyModel,
      update,
    })
    const OtherChanges = Surface.messages(OtherApp, [MessageUnion.RequestedCreateTodo])

    expect(() =>
      TodoAgent.exposeSubset(OtherChanges, { RequestedCreateTodo: 'Create a todo' }),
    ).toThrow(/different application/)
  })
})
