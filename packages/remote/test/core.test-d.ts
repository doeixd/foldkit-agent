import { Schema } from 'effect'
import { Entity, RemoteData, Selection, type EntityRef } from '../src/index.js'

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
    owner: Entity.ref(User),
  }),
)

// A relation is a reference codec, so a recursive relation needs no target
// schema inlining and the entity type does not become circular.
const Node = Entity.make(
  'Node',
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    parent: Schema.optional(Entity.refTo('Node')),
  }),
)
const _nodeName: 'Node' = Node.name
const _ref: EntityRef<'User'> = User.ref('u1')

// --- Selection derives the picked Struct -----------------------------------

const UserSummary = Selection.make(User, { id: true, name: true })
const _userSummary: Selection<{ readonly id: string; readonly name: string }> = UserSummary
const _fields: readonly string[] = UserSummary.fields

// @ts-expect-error `nope` is not a field of User
Selection.make(User, { nope: true })

// --- Entity.patch rejects unknown and mistyped fields ----------------------

Entity.patch(Project.ref('p1'), { name: 'Renamed' })
Entity.patch(Project.ref('p1'), { status: 'archived' })
// @ts-expect-error `banana` is not a field of Project
Entity.patch(Project.ref('p1'), { banana: 1 })
// @ts-expect-error `status` is a string, not a number
Entity.patch(Project.ref('p1'), { status: 123 })

// --- RemoteData.match is exhaustive ----------------------------------------

const initial: RemoteData<number> = { _tag: 'Initial' }
// @ts-expect-error `Failed` is a required match case
RemoteData.match(initial, {
  Initial: () => 0,
  Loading: () => 0,
  Ready: () => 0,
  Refreshing: () => 0,
  NotFound: () => 0,
})
