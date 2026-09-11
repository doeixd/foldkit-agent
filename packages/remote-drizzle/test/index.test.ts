import { text, uuid, pgTable } from 'drizzle-orm/pg-core'
import { Schema } from 'effect'
import { Entity, Selection } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { columnsFor, entity, relationsFor } from '../src/index.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
})
const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull(),
})

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, name: Schema.String, owner: User.schema }),
)

const UserBinding = entity('User', users)
const ProjectBinding = entity('Project', projects, {
  relations: { owner: { entity: UserBinding, field: projects.ownerId } },
})

describe('RemoteDrizzle', () => {
  it('derives an Entity Schema from the table', () => {
    expect(UserBinding.Schema).toBeDefined()
  })

  it('prunes a Selection to its scalar columns', () => {
    const selection = Selection.make(User, { id: true, name: true })
    expect(columnsFor(UserBinding, selection).map(column => column.name)).toEqual(['id', 'name'])
  })

  it('separates relation fields from scalar columns', () => {
    const selection = Selection.make(Project, {
      id: true,
      owner: Selection.make(User, { id: true, name: true }),
    })

    expect(columnsFor(ProjectBinding, selection).map(column => column.name)).toEqual(['id'])
    expect(relationsFor(ProjectBinding, selection).map(relation => relation.entity.name)).toEqual([
      'User',
    ])
  })
})
