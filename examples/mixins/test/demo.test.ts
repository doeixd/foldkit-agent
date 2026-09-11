import { describe, expect, it } from 'vitest'
import { runDemo } from '../src/demo.js'

describe('foldkit-mixins example', () => {
  const lines = runDemo()

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
    expect(lines).toContain('root classes: card')
    expect(lines).toContain('root style: {"display":"grid","gap":"0.5rem"}')
    expect(lines).toContain('status classes: archived')
    expect(lines).toContain('archive aria-disabled: true')
  })
})
