import { describe, expect, it } from 'vitest'
import { runDemo } from '../src/demo.js'

describe('foldkit-remote example', () => {
  it('traces plan, load, render, mutate and a decode failure', async () => {
    const lines = await runDemo()
    expect(lines).toContain('surface: ProjectPage')
    expect(lines).toContain('plan: Project:p1 [id,name,status]')
    expect(lines).toContain('before fetch: Initial')
    expect(lines).toContain('after fetch: Ready {"id":"p1","name":"Apollo","status":"active"}')
    expect(lines).toContain('rendered classes: project-card')
    expect(lines).toContain('rendered status: active')
    expect(lines).toContain('mutation RenameProject: output {"id":"p1"}')
    expect(lines).toContain('after mutation: Ready {"id":"p1","name":"Apollo II","status":"active"}')
    expect(lines).toContain('corrupt store: Failed DecodeError')
  })
})
