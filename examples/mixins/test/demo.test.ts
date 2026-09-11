import { describe, expect, it } from 'vitest'
import { runDemo } from '../src/demo.js'

describe('foldkit-mixins example', () => {
  const lines = runDemo()
  const matching = (pattern: RegExp): string | undefined => lines.find(line => pattern.test(line))

  it('traces the surface, slots, mixins and resolved attributes', () => {
    expect(lines).toContain('surface: ProjectCard')
    expect(lines).toContain('observes: project, selection')
    expect(lines).toContain(
      'slots: root(Container), title(Container), status(Container), archive(Interactive)',
    )
    expect(lines).toContain('mixins: ProjectCardStyle, ArchiveBehavior')
    expect(lines).toContain(
      'projected: {"project":{"name":"Apollo","archived":true},"selection":"p1"}',
    )
    expect(matching(/^root classes: card style-[a-z0-9]+$/)).toBeDefined()
    expect(lines).toContain('root style: {"display":"grid","gap":"0.5rem"}')
    expect(lines).toContain('status classes: archived')
    expect(lines).toContain('archive aria-disabled: true')
  })

  it('prints the compiled stylesheet', () => {
    expect(matching(/^stylesheet: \.style-[a-z0-9]+:hover\{box-shadow:0 1px 2px\}$/)).toBeDefined()
  })
})
