import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Message } from './todoApp.js'

describe('Agent.expose', () => {
  it('derives a descriptor from the existing Message union', () => {
    const messages = Agent.expose(Message, {
      RequestedDeleteTodo: { name: 'delete_todo', description: 'Delete a todo' },
    })

    expect(messages.variants).toHaveLength(1)
    const [variant] = messages.variants
    expect(variant?.tag).toBe('RequestedDeleteTodo')
    expect(variant?.name).toBe('delete_todo')
    expect(variant?.description).toBe('Delete a todo')
  })

  it('normalizes the Message tag when no name is given', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: { description: 'Rename a todo' },
    })

    expect(messages.variants[0]?.name).toBe('requested_rename_todo')
    // The internal tag is never renamed.
    expect(messages.variants[0]?.tag).toBe('RequestedRenameTodo')
  })

  it('strips _tag from the derived input schema', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: { name: 'rename_todo', description: 'Rename a todo' },
    })

    expect(messages.variants[0]?.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
    })
    expect(messages.variants[0]?.inputJsonSchema).not.toHaveProperty('properties._tag')
  })

  it('gives a payload-free Message a closed empty object schema', () => {
    const messages = Agent.expose(Message, {
      ClearedSelection: { name: 'clear_selection', description: 'Clear the selection' },
    })

    expect(messages.variants[0]?.inputJsonSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('uses the external input schema when one is supplied', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: {
        name: 'rename_todo',
        description: 'Rename a todo',
        input: Schema.Struct({ id: Schema.String }),
        toMessage: ({ id }) => ({ id, title: 'Untitled' }),
      },
    })

    expect(messages.variants[0]?.inputJsonSchema).toMatchObject({
      type: 'object',
      required: ['id'],
    })
    expect(messages.variants[0]?.inputJsonSchema).not.toHaveProperty('properties.title')
  })

  it('rejects a tag that is not part of the union', () => {
    expect(() =>
      // @ts-expect-error NotAMessage is not a variant of this Message union.
      Agent.expose(Message, { NotAMessage: { description: 'nope' } }),
    ).toThrow(/not a variant/)
  })

  it('rejects input without toMessage', () => {
    expect(() =>
      Agent.expose(Message, {
        // @ts-expect-error toMessage is required whenever input is provided.
        RequestedDeleteTodo: { description: 'Delete a todo', input: Schema.Struct({}) },
      }),
    ).toThrow(/without "toMessage"/)
  })

  it('rejects two capabilities sharing a name', () => {
    expect(() =>
      Agent.expose(Message, {
        RequestedCreateTodo: { name: 'todo', description: 'Create' },
        RequestedDeleteTodo: { name: 'todo', description: 'Delete' },
      }),
    ).toThrow(/Duplicate exposed capability name/)
  })
})
