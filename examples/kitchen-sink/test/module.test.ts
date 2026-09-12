import { Module, Surface } from 'foldkit-surface'
import { documentId, forApplication } from 'foldkit-sync'
import { describe, expect, it } from 'vitest'
import { AppAgent } from '../src/agent.js'
import { App, AppRemote, BoardSurface, NoteChanges, Notes } from '../src/stack.js'

// `KitchenSync` is annotated with the low-level `Sync` type for declaration
// emit, so the contract is made again here from the same declaration.
const NotesSync = forApplication(App).make({
  documentId: documentId('kitchen'),
  shared: Notes,
  durable: NoteChanges,
})

describe('the kitchen-sink application as a Module', () => {
  const Kitchen = Module.make(App, [BoardSurface, NotesSync, AppRemote, AppAgent])

  it('composes every package contract and validates clean', () => {
    expect(Module.validate(Kitchen)).toEqual([])
  })

  it('shows one owner per datum', () => {
    const manifest = Module.manifest(Kitchen)
    const owner = (field: string) => manifest.ownership.find(row => row.path[0] === field)?.owner
    expect(owner('notes')).toEqual({ kind: 'sync', name: 'kitchen' })
    expect(owner('remote')).toEqual({ kind: 'remote', name: 'remote' })
    expect(owner('selectedNoteId')).toBeUndefined()
    expect(manifest.contracts.map(contract => contract.kind)).toEqual([
      'surface',
      'sync',
      'remote',
      'agent',
    ])
  })

  it('catches a second replication contract over the same field', () => {
    const Again = forApplication(App).make({
      documentId: documentId('kitchen-again'),
      shared: Notes,
      durable: NoteChanges,
    })
    const findings = Module.validate(Module.add(Kitchen, Again))
    expect([...new Set(findings.map(finding => finding.rule))]).toEqual([
      'ownership-overlap',
      'message-claimed-twice',
    ])
    expect(findings[0]!.contracts).toEqual(['sync:kitchen', 'sync:kitchen-again'])
    expect(Module.toMarkdown(Kitchen)).toContain(Surface.inspect(BoardSurface, undefined).name)
  })
})
