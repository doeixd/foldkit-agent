import { eq } from 'drizzle-orm'
import { text, uuid, pgTable, PgDialect } from 'drizzle-orm/pg-core'
import { Schema } from 'effect'
import { Entity, Selection } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import {
  columnsFor,
  cursorCondition,
  entity,
  queryPlan,
  relationsFor,
  whereIds,
} from '../src/index.js'

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

  it('batches ids into one IN and prunes the column list', () => {
    const dialect = new PgDialect()
    const sql = dialect.sqlToQuery(whereIds(UserBinding, ['a', 'b']))

    expect(sql.sql).toContain('"users"."id" in')
    expect(sql.params).toEqual(['a', 'b'])
    expect(
      queryPlan(UserBinding, Selection.make(User, { id: true, name: true })).columns.map(
        column => column.name,
      ),
    ).toEqual(['id', 'name'])
  })

  it('renders a cursor condition and combines it with the filter', () => {
    const dialect = new PgDialect()
    expect(dialect.sqlToQuery(cursorCondition(projects.id, 'desc', 'c1')).sql).toContain('<')

    const plan = queryPlan(ProjectBinding, Selection.make(Project, { id: true }), {
      where: eq(projects.name, 'x'),
      cursor: cursorCondition(projects.id, 'desc', 'c1'),
      limit: 25,
    })
    expect(plan.limit).toBe(25)
    expect(dialect.sqlToQuery(plan.where as NonNullable<typeof plan.where>).sql).toContain('and')
  })
})
