import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { Entity, Remote, Selection, type RemoteData } from '../src/index.js'

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

// --- Selection derives the picked Struct -----------------------------------

const UserSummary = Selection.make(User, { id: true, name: true })
const _userSummary: Selection<{ readonly id: string; readonly name: string }> = UserSummary

// @ts-expect-error `nope` is not a field of User
Selection.make(User, { nope: true })

// --- Remote.make embeds without `any`; Remote.select is RemoteData ---------

const Data = Remote.make({ entities: [User, Project] })
const selectedUser: RemoteData<{ readonly id: string; readonly name: string }> = Remote.select(
  Data,
  UserSummary,
)
void selectedUser

const RemoteModel = Schema.Struct({ remote: Data.Model, route: Schema.String })
const RemoteMessage = defineMessageUnion({ Ping: {} })
const RemoteApp = Surface.make({ Model: RemoteModel, Message: RemoteMessage })
const _entities = RemoteApp.model.remote.entities
// @ts-expect-error `nope` is not a field of the Remote store
RemoteApp.model.remote.nope

// --- Entity.patch rejects unknown and mistyped fields ----------------------

Entity.patch(Project.ref('p1'), { name: 'Renamed' })
Entity.patch(Project.ref('p1'), { status: 'archived' })
// @ts-expect-error `banana` is not a field of Project
Entity.patch(Project.ref('p1'), { banana: 1 })
// @ts-expect-error `status` is a string, not a number
Entity.patch(Project.ref('p1'), { status: 123 })
