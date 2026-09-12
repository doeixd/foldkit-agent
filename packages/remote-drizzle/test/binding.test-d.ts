import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Schema } from 'effect'
import { Remote, Selection } from 'foldkit-remote'
import { entity, many, one } from '../src/index.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})
const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id'),
  createdAt: text('created_at').notNull(),
})
const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  body: text('body').notNull(),
  projectId: uuid('project_id').notNull(),
})

const UserBinding = entity('User', users)
const CommentBinding = entity('Comment', comments)
const ProjectBinding = entity('Project', projects, {
  relations: {
    owner: one(UserBinding, { field: projects.ownerId, nullable: true }),
    comments: many(CommentBinding, { foreignKey: comments.projectId, localKey: projects.id }),
  },
  computed: { commentCount: { relation: 'comments' } },
})

// A binding is an EntityDescriptor: one declaration serves both the table and
// the Remote selection, and relation and computed fields sit beside the columns.
const _name: 'Project' = ProjectBinding.name
Selection.make(ProjectBinding, {
  id: true,
  name: true,
  owner: true,
  comments: true,
  commentCount: true,
})

// The bindings are the Remote entities, so the domain is declared once.
Remote.make({ entities: [UserBinding, ProjectBinding] })

// @ts-expect-error `nope` is not a field of the table
Selection.make(ProjectBinding, { nope: true })

// `fields` overrides the derived field map, dropping `email` here.
const SlimUser = entity('User', users, {
  fields: { id: Schema.String, name: Schema.String },
})
Selection.make(SlimUser, { id: true, name: true })

// @ts-expect-error the override dropped `email`
Selection.make(SlimUser, { email: true })
