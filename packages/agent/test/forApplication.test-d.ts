/**
 * `Agent.forApplication` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
import { Agent } from '../src/index.js'
import { Message as MessageUnion, Model, emptyModel, type Message } from './todoApp.js'

const update = (model: Model, _message: Message) => ({ model })
const App = Surface.application({ Model, Message: MessageUnion, initial: emptyModel, update })

const TodoAgent = Agent.forApplication(App)
const definition = TodoAgent.make({
  context: Projection.pick(App.fields.todos),
  messages: TodoAgent.expose(MessageUnion, { RequestedDeleteTodo: 'Delete' }),
})

const _todos: ReadonlyArray<{
  readonly id: string
  readonly title: string
  readonly completed: boolean
}> = definition.context!.read(emptyModel).todos

const Other = Schema.Struct({ count: Schema.Number })
TodoAgent.make({
  // @ts-expect-error the context projection must focus the application's Model
  context: Projection.of(Other)({ count: true }),
  messages: TodoAgent.expose(MessageUnion, {}),
})

const Changes = MessageSet.make(App, [MessageUnion.RequestedCreateTodo])
// @ts-expect-error RequestedDeleteTodo is not in the subset
Agent.exposeSubset(Changes, { RequestedDeleteTodo: 'Delete' })

// `withPrincipal` fixes the principal `authorize` sees; the Model stays inferred.
const AdminAgent = Agent.forApplication(App).withPrincipal<{ readonly role: 'admin' | 'user' }>()
AdminAgent.make({
  context: Projection.pick(App.fields.todos),
  messages: AdminAgent.expose(MessageUnion, {
    RequestedDeleteTodo: {
      description: 'Delete',
      authorize: ({ principal, model }) => principal.role === 'admin' && model.todos.length > 0,
    },
  }),
})
AdminAgent.make({
  messages: AdminAgent.expose(MessageUnion, {
    RequestedDeleteTodo: {
      description: 'Delete',
      // @ts-expect-error `owner` is not a field of the fixed principal
      authorize: ({ principal }) => principal.owner === 'alice',
    },
  }),
})
