import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, it } from 'vitest'
import { MessageSet, Surface } from '../src/index.js'
import { App, Message } from './todoFixture.js'

describe('MessageSet.make', () => {
  it('selects a typed subset by constructor', () => {
    const Changes = MessageSet.make(App, [Message.CreatedTodo, Message.RenamedTodo])

    expect([...Changes.tags]).toEqual(['CreatedTodo', 'RenamedTodo'])
    expect(Changes.includes(Message.CreatedTodo({ id: 'a', title: 'A' }))).toBe(true)
    expect(Changes.includes(Message.SelectedTodo({ id: 'a' }))).toBe(false)
    expect(
      Schema.decodeUnknownSync(Changes.schema)({
        _tag: 'CreatedTodo',
        id: 'a',
        title: 'A',
      }),
    ).toEqual({ _tag: 'CreatedTodo', id: 'a', title: 'A' })
  })

  it('rejects a variant from another application with an identical Message union', () => {
    const Other = Surface.application({
      Model: App.Model,
      Message: defineMessageUnion({
        CreatedTodo: { id: Schema.String, title: Schema.String },
        RenamedTodo: { id: Schema.String, title: Schema.String },
        SelectedTodo: { id: Schema.String },
      }),
    })

    expect(() => MessageSet.make(App, [Other.Message.CreatedTodo])).toThrow('not a variant')
  })

  it('rejects a duplicate variant', () => {
    expect(() => MessageSet.make(App, [Message.CreatedTodo, Message.CreatedTodo])).toThrow(
      'duplicate',
    )
  })

  it('unions disjoint subsets', () => {
    const Created = MessageSet.make(App, [Message.CreatedTodo])
    const Rest = MessageSet.make(App, [Message.RenamedTodo, Message.SelectedTodo])
    const All = MessageSet.union(Created, Rest)

    expect([...All.tags]).toEqual(['CreatedTodo', 'RenamedTodo', 'SelectedTodo'])
    expect(All.includes(Message.SelectedTodo({ id: 'a' }))).toBe(true)
    expect(All.constructors).toHaveLength(3)
  })

  it('rejects a duplicate tag across subsets', () => {
    const Created = MessageSet.make(App, [Message.CreatedTodo])
    expect(() => MessageSet.union(Created, Created)).toThrow('duplicate')
  })

  it('rejects subsets from different applications with an identical union', () => {
    const Other = Surface.application({
      Model: App.Model,
      Message: defineMessageUnion({
        CreatedTodo: { id: Schema.String, title: Schema.String },
      }),
    })
    const Mine = MessageSet.make(App, [Message.CreatedTodo])
    const Theirs = MessageSet.make(Other, [Other.Message.CreatedTodo])

    expect(() => MessageSet.union(Mine, Theirs)).toThrow('different applications')
  })
})
