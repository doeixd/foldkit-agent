import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { Entity, Selection } from 'foldkit-remote'
import { entity } from '../src/index.js'

const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
})

const UserBinding = entity('User', users)

// A binding's derived Schema can seed the Remote Entity, so the table is
// declared once and the Entity still checks field names at the call site.
const User = Entity.make('User', UserBinding.Schema)

const _name: 'User' = User.name
Selection.make(User, { id: true, name: true })

// @ts-expect-error `nope` is not a field of the table
Selection.make(User, { nope: true })
