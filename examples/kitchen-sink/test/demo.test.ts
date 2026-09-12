import { describe, expect, it } from 'vitest'
import { runDemo } from '../src/demo.js'

describe('kitchen sink', () => {
  it('drives every package through one application', async () => {
    const lines = await runDemo()
    for (const line of lines) console.log(line)

    // foldkit-remote + foldkit-remote-server + foldkit-remote-drizzle
    expect(lines).toContain('after fetch (Drizzle SQLite): Ready Apollo')
    expect(lines).toContain('nested selection (one read): owner Ada')
    expect(lines).toContain('mutation: {"id":"p1"} -> Ready Apollo II')
    expect(lines).toContain('query connection: Project:p2, Project:p1')

    // foldkit-durable + foldkit-sync
    expect(lines).toContain('replicated (durable journal): First note')

    // foldkit-agent, driven by the agent and by a human
    expect(lines).toContain('capabilities: requested_create_note, rename_note, selected_note')
    expect(lines).toContain('notes after agent: First note, From the agent')

    // The adapters project the same contract
    expect(lines).toContain('webmcp call: Dispatched RequestedCreateNote')
    expect(lines).toContain('mcp tools: requested_create_note, rename_note, selected_note')
    expect(lines).toContain('a2a card: Kitchen Sink (3 skills)')
    expect(lines).toContain('native actions: requested_create_note, rename_note, selected_note')

    // foldkit-mixins + foldkit-mixins-surface + foldkit-mixins-ui
    expect(lines).toContain('rendered classes: board')
    expect(lines).toContain('mixins-ui button classes: save')
  })
})
