import { Schema } from 'effect'
import type { ModelRef } from 'foldkit-surface'
import { Entity, Remote, RemoteData, Selection, type EntityRef } from '../src/index.js'

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
// Selection is a pure codec, so a `Remote.select` decode needs no cast.
const _codec: Schema.Codec<{ readonly id: string; readonly name: string }, unknown, never, never> =
  UserSummary.schema

// --- RemoteData is Schema-backed -------------------------------------------

const NumberData = RemoteData.schema(Schema.Number)
const _dataSchema: Schema.Schema<RemoteData<number>> = NumberData

// @ts-expect-error `nope` is not a field of User
Selection.make(User, { nope: true })

// --- Nested selections take the field's shape ------------------------------

const Comment = Entity.make('Comment', Schema.Struct({ id: Schema.String, body: Schema.String }))
const Board = Entity.make(
  'Board',
  Schema.Struct({
    id: Schema.String,
    owner: Entity.ref(User),
    reviewer: Schema.NullOr(Entity.ref(User)),
    members: Schema.Array(Entity.ref(User)),
    comments: Entity.refPage(Comment),
  }),
)
const CommentBody = Selection.make(Comment, { body: true })
const Card = Selection.make(Board, {
  owner: UserSummary,
  reviewer: UserSummary,
  members: UserSummary,
  comments: Selection.connection(Comment, { first: 3 }, CommentBody),
})
type Card = typeof Card extends Selection<infer V, any, any> ? V : never
const _owner: { readonly id: string; readonly name: string } = ({} as Card).owner
const _reviewer: { readonly id: string; readonly name: string } | null = ({} as Card).reviewer
const _members: ReadonlyArray<{ readonly id: string; readonly name: string }> = ({} as Card).members
const _comments: {
  readonly items: ReadonlyArray<{ readonly body: string }>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
} = ({} as Card).comments
// @ts-expect-error a non-nullable ref never reads null
const _ownerNull: null = ({} as Card).owner

const Refs = Selection.make(Board, { comments: Selection.connection(Comment, { first: 3 }) })
type Refs = typeof Refs extends Selection<infer V, any, any> ? V : never
const _refs: ReadonlyArray<EntityRef<'Comment'>> = ({} as Refs).comments.refs

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

// --- Remote.at requires the Remote model shape ------------------------------

const Data = Remote.make({ entities: [User] })
declare const goodStore: ModelRef<unknown, Schema.Schema.Type<typeof Data.Model>>
Remote.at(Data, goodStore)

declare const wrongStore: ModelRef<unknown, { readonly entities: string }>
// @ts-expect-error a focus without the Remote model shape is not a store
Remote.at(Data, wrongStore)

// --- Nested selections are constrained to the field's target and nullability --

const Nullable = Entity.make(
  'Nullable',
  Schema.Struct({
    id: Schema.String,
    maybe: Schema.optional(Entity.ref(User)),
    members: Schema.NullOr(Schema.Array(Entity.ref(User))),
    comments: Schema.NullOr(Entity.refPage(Comment)),
  }),
)
const NullableCard = Selection.make(Nullable, {
  maybe: UserSummary,
  members: UserSummary,
  comments: Selection.connection(Comment, { first: 1 }, CommentBody),
})
type NullableCard = typeof NullableCard extends Selection<infer V, any, any> ? V : never
const _maybe: { readonly id: string; readonly name: string } | null = ({} as NullableCard).maybe
const _nullMembers: ReadonlyArray<{ readonly id: string; readonly name: string }> | null = (
  {} as NullableCard
).members
const _nullComments: {
  readonly items: ReadonlyArray<{ readonly body: string }>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
} | null = ({} as NullableCard).comments
// @ts-expect-error a nested selection must be of the field's target entity
Selection.make(Board, { owner: CommentBody })
// @ts-expect-error a scalar field takes no nested selection
Selection.make(Board, { id: UserSummary })
// @ts-expect-error a singular ref takes no connection selection
Selection.make(Board, { owner: Selection.connection(User, { first: 1 }) })
// @ts-expect-error Remote.select takes an entity selection, not a bare connection
Remote.select({} as never, Selection.connection(Comment, { first: 1 }))
