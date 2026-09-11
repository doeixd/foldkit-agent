/**
 * Compile-time expectations for `pick`. Type-checked, not executed; every
 * `@ts-expect-error` must stay an error.
 */
import { Schema } from 'effect'
import { pick } from '../src/index.js'

const Model = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, done: Schema.Boolean })),
  selected: Schema.NullOr(Schema.String),
})
type Model = typeof Model.Type

const shared = pick(Model, ['todos'])

// `get` returns exactly the picked shape, inferred from the Model.
const projected: { todos: ReadonlyArray<{ id: string; done: boolean }> } = shared.get({
  todos: [],
  selected: null,
})

// `set` returns the full Model, local fields intact.
const updated: Model = shared.set({ todos: [], selected: 'a' }, { todos: [] })

// @ts-expect-error a key that is not in the Model is rejected
pick(Model, ['missing'])

// @ts-expect-error the projection has no `selected` field
const wrongRead: { selected: string | null } = shared.get({ todos: [], selected: null })

// @ts-expect-error the shared value must match the projection
shared.set({ todos: [], selected: null }, { selected: 'a' })
