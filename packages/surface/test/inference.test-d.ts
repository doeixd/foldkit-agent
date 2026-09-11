/**
 * Phase 0 inference contract. These assertions run under `pnpm typecheck`
 * (`*.test-d.ts` is type-checked but not executed). Every `@ts-expect-error`
 * must fail `tsc` when the rejected expression is made legal.
 */
import { Optic, Schema } from 'effect'
import type { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import {
  Entity,
  ModelRef,
  Projection,
  Remote,
  Selection,
  Surface,
  type RemoteData,
} from '../src/index.js'

// --- fixtures --------------------------------------------------------------

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, avatarUrl: Schema.String }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    owner: User.schema,
  }),
)

const Model = Schema.Struct({
  session: Schema.Struct({ user: Schema.Struct({ name: Schema.String }) }),
  projects: Schema.Record(Schema.String, Project.schema),
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
})
type ModelValue = Schema.Schema.Type<typeof Model>

const Message = defineMessageUnion({
  ChangedProjectName: { name: Schema.String },
  ClickedArchiveProject: {},
})
type AppMessage = Schema.Schema.Type<typeof Message>

const App = Surface.make({ Model, Message })

// --- case 1: App.model tree is typed, optional accesses are Option ---------

const _name: ModelRef<ModelValue, string> = App.model.session.user.name

const fromOpticRef = ModelRef.fromOptic(Schema.String, Optic.id<{ name: string }>().key('name'))
const _fromOpticName: string = fromOpticRef.get({ name: 'ada' })
const _fromOpticNext: { readonly name: string } = fromOpticRef.set({ name: 'ada' }, 'grace')

const _todos: ModelRef<
  ModelValue,
  ReadonlyArray<{ readonly id: string; readonly title: string }>
> = App.model.todos

const _project: ModelRef<
  ModelValue,
  Option.Option<Schema.Schema.Type<typeof Project.schema>>
> = App.model.projects.at('p1')
const _todo: ModelRef<
  ModelValue,
  Option.Option<{ readonly id: string; readonly title: string }>
> = App.model.todos.index(0)

// @ts-expect-error `nope` is not a field of the Model
App.model.nope

// --- case 2: Projection.of checks keys and nested Projection roots ---------

const UserSummary = Projection.of(User.schema)({ id: true, name: true })
const _userSummary: Projection<
  Schema.Schema.Type<typeof User.schema>,
  { readonly id: string; readonly name: string }
> = UserSummary

const emptySelection = Projection.of(User.schema)({})
const _emptySelection: Projection<Schema.Schema.Type<typeof User.schema>, {}> = emptySelection

const ProjectSummary = Projection.of(Project.schema)({
  id: true,
  name: true,
  owner: UserSummary,
})
const _projectSummary: Projection<
  Schema.Schema.Type<typeof Project.schema>,
  {
    readonly id: string
    readonly name: string
    readonly owner: { readonly id: string; readonly name: string }
  }
> = ProjectSummary

// @ts-expect-error `nope` is not a field of User
Projection.of(User.schema)({ nope: true })

// @ts-expect-error the nested Projection must focus the field's own Schema (User), not Project
Projection.of(Project.schema)({ owner: Projection.of(Project.schema)({ id: true }) })

const listProjection = Projection.struct({
  todos: App.model.todos,
  selected: App.model.session.user.name,
})
const _listProjection: Projection<
  ModelValue,
  {
    readonly todos: ReadonlyArray<{ readonly id: string; readonly title: string }>
    readonly selected: string
  }
> = listProjection

const projectCards = Projection.array(ProjectSummary)
const _projectCards: Projection<
  ReadonlyArray<Schema.Schema.Type<typeof Project.schema>>,
  ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly owner: { readonly id: string; readonly name: string }
  }>
> = projectCards

const maybeUser = Projection.option(UserSummary)
const _maybeUser: Projection<
  Option.Option<Schema.Schema.Type<typeof User.schema>>,
  Option.Option<{ readonly id: string; readonly name: string }>
> = maybeUser

const selectedProject = App.model.projects.at('p1').select(ProjectSummary)
const _selectedProject: Projection<
  ModelValue,
  Option.Option<{
    readonly id: string
    readonly name: string
    readonly owner: { readonly id: string; readonly name: string }
  }>
> = selectedProject

// --- non-string record keys are enforced by `.at` --------------------------

const Keyed = Schema.Struct({
  byLetter: Schema.Record(Schema.Literal('a'), Schema.Struct({ name: Schema.String })),
})
const KeyedApp = Surface.make({ Model: Keyed, Message })
const _byLetter = KeyedApp.model.byLetter.at('a')
// @ts-expect-error only the record's literal key `'a'` is valid
KeyedApp.model.byLetter.at('b')

const ProjectId2 = Schema.String.pipe(Schema.brand('ProjectId2'))
const ByProject = Schema.Struct({
  byProject: Schema.Record(ProjectId2, Schema.Struct({ name: Schema.String })),
})
const ByProjectApp = Surface.make({ Model: ByProject, Message })
const _byProject = ByProjectApp.model.byProject.at(Schema.decodeSync(ProjectId2)('p1'))
// @ts-expect-error a plain string is not a branded ProjectId2
ByProjectApp.model.byProject.at('p1')

// --- case 3: Surface.view narrows the projected Model and Message set ------

const ProjectCard = Surface.define(App, 'ProjectCard', {
  model: ({ model }) => Projection.struct({ name: model.session.user.name }),
  messages: [Message.ChangedProjectName],
})

const cardView = Surface.view(ProjectCard, (model, h) => {
  const _cardName: string = model.name
  h.OnClick(Message.ChangedProjectName({ name: 'x' }))
  // @ts-expect-error `ClickedArchiveProject` is not in this Surface's Message set
  h.OnClick(Message.ClickedArchiveProject())
  return h.empty
})

// The application boundary consumes the superset App builder.
const _appView: (model: ModelValue, h: HtmlBuilder<AppMessage>) => Html = Surface.rootView(
  ProjectCard,
  undefined,
  cardView,
)

// --- case 4: Remote.make embeds without `any`; Remote.select is RemoteData --

const Data = Remote.make({ entities: [User, Project] })
const SelectedUser = Selection.make(User, { id: true, name: true })
const selectedUser: RemoteData<{ readonly id: string; readonly name: string }> = Remote.select(
  Data,
  SelectedUser,
)
void selectedUser

const RemoteModel = Schema.Struct({ remote: Data.Model, route: Schema.String })
const RemoteMessage = defineMessageUnion({ Ping: {} })
const RemoteApp = Surface.make({ Model: RemoteModel, Message: RemoteMessage })
const _entities = RemoteApp.model.remote.entities
// @ts-expect-error `nope` is not a field of the Remote store
RemoteApp.model.remote.nope

const CardA = Surface.define(App, 'CardA', {
  model: ({ model }) => Projection.struct({ name: model.session.user.name }),
  messages: [Message.ChangedProjectName],
})
const _registry = Surface.registry(App, [ProjectCard, CardA])

const RemoteCard = Surface.define(RemoteApp, 'RemoteCard', {
  model: ({ model }) => Projection.struct({ route: model.route }),
  messages: [RemoteMessage.Ping],
})
// @ts-expect-error `RemoteCard` belongs to a different App Root
Surface.registry(App, [RemoteCard])

Surface.define(App, 'BadCard', {
  model: ({ model }) => Projection.struct({ name: model.session.user.name }),
  // @ts-expect-error `RemoteMessage.Ping` is not part of App.Message
  messages: [RemoteMessage.Ping],
})

// --- case 5: Entity.patch rejects unknown and mistyped fields --------------

Entity.patch(Project.ref('p1'), { name: 'Renamed' })
Entity.patch(Project.ref('p1'), { status: 'archived' })
// @ts-expect-error `banana` is not a field of Project
Entity.patch(Project.ref('p1'), { banana: 1 })
// @ts-expect-error `status` is a string, not a number
Entity.patch(Project.ref('p1'), { status: 123 })
