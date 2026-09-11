import { describe, expect, it } from 'vitest'
import { Theme } from '../src/index.js'

const Brand = Theme.define({
  color: { text: '#161616', accent: '#625cff' },
  spacing: { sm: '0.5rem', md: '1rem' },
})

describe('Theme', () => {
  it('exposes token values by path', () => {
    expect(Brand.color.text).toBe('#161616')
    expect(Brand.spacing.md).toBe('1rem')
  })

  it('is frozen', () => {
    expect(Object.isFrozen(Brand)).toBe(true)
    expect(Object.isFrozen(Brand.color)).toBe(true)
  })

  it('builds a css var reference', () => {
    expect(Theme.variable(Brand, 'color', 'accent')).toBe('var(--fk-color-accent)')
  })

  it('compiles all tokens to one inline StyleValue', () => {
    const variables = Theme.variables(Brand)
    expect(variables.style).toEqual({
      '--fk-color-text': '#161616',
      '--fk-color-accent': '#625cff',
      '--fk-spacing-sm': '0.5rem',
      '--fk-spacing-md': '1rem',
    })
    expect(variables.classes).toEqual([])
  })
})
