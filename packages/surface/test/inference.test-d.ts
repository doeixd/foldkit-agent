/**
 * Surface inference contract. These assertions run under `pnpm typecheck`
 * (`*.test-d.ts` is type-checked but not executed). Every `@ts-expect-error`
 * must fail `tsc` when the rejected expression is made legal.
 */
import { Optic, Schema } from 'effect'
import type { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { ModelRef, Projection, Surface } from '../src/index.js'

// --- fixtures --------------------------------------------------------------

const UserSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.String,
})
const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  owner: UserSchema,
})

const Model = Schema.Struct({
  session: Schema.Struct({ user: Schema.Struct({ name: Schema.String }) }),
  projects: Schema.Record(Schema.String, ProjectSchema),
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
  Option.Option<Schema.Schema.Type<typeof ProjectSchema>>
> = App.model.projects.at('p1')
const _todo: ModelRef<
  ModelValue,
  Option.Option<{ readonly id: string; readonly title: string }>
> = App.model.todos.index(0)

// @ts-expect-error `nope` is not a field of the Model
App.model.nope

// --- case 2: Projection.of checks keys and nested Projection roots ---------

const UserSummary = Projection.of(UserSchema)({ id: true, name: true })
const _userSummary: Projection<
  Schema.Schema.Type<typeof UserSchema>,
  { readonly id: string; readonly name: string }
> = UserSummary

const emptySelection = Projection.of(UserSchema)({})
const _emptySelection: Projection<Schema.Schema.Type<typeof UserSchema>, {}> = emptySelection

const ProjectSummary = Projection.of(ProjectSchema)({ id: true, name: true, owner: UserSummary })
const _projectSummary: Projection<
  Schema.Schema.Type<typeof ProjectSchema>,
  {
    readonly id: string
    readonly name: string
    readonly owner: { readonly id: string; readonly name: string }
  }
> = ProjectSummary

// @ts-expect-error `nope` is not a field of User
Projection.of(UserSchema)({ nope: true })

// @ts-expect-error the nested Projection must focus the field's own Schema (User), not Project
Projection.of(ProjectSchema)({ owner: Projection.of(ProjectSchema)({ id: true }) })

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
  ReadonlyArray<Schema.Schema.Type<typeof ProjectSchema>>,
  ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly owner: { readonly id: string; readonly name: string }
  }>
> = projectCards

const maybeUser = Projection.option(UserSummary)
const _maybeUser: Projection<
  Option.Option<Schema.Schema.Type<typeof UserSchema>>,
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

// --- registry: explicit collection, duplicate and cross-App rejection ------

const CardA = Surface.define(App, 'CardA', {
  model: ({ model }) => Projection.struct({ name: model.session.user.name }),
  messages: [Message.ChangedProjectName],
})
const _registry = Surface.registry(App, [ProjectCard, CardA])

const OtherModel = Schema.Struct({ route: Schema.String })
const OtherMessage = defineMessageUnion({ Ping: {} })
const OtherApp = Surface.make({ Model: OtherModel, Message: OtherMessage })
const OtherCard = Surface.define(OtherApp, 'OtherCard', {
  model: ({ model }) => Projection.struct({ route: model.route }),
  messages: [OtherMessage.Ping],
})
// @ts-expect-error `OtherCard` belongs to a different App Root
Surface.registry(App, [OtherCard])

Surface.define(App, 'BadCard', {
  model: ({ model }) => Projection.struct({ name: model.session.user.name }),
  // @ts-expect-error `OtherMessage.Ping` is not part of App.Message
  messages: [OtherMessage.Ping],
})
