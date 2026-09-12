import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, it } from 'vitest'
import { MessageSet, Module, Projection, Surface, type Contract } from '../src/index.js'

const Model = Schema.Struct({
  route: Schema.String,
  selectedNoteId: Schema.NullOr(Schema.String),
  notes: Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.String })),
  remote: Schema.Struct({ entities: Schema.Unknown }),
})
const Message = defineMessageUnion({
  CreatedNote: { id: Schema.String, body: Schema.String },
  SelectedNote: { id: Schema.String },
})
const App = Surface.application({ Model, Message })
const Other = Surface.application({ Model, Message })

const Board = Surface.make(App, 'Board', {
  model: ({ model }) => Projection.struct({ notes: model.notes, selected: model.selectedNoteId }),
  messages: [Message.CreatedNote, Message.SelectedNote],
})

/** What `Sync.forApplication(App).make` attaches: it owns the shared projection. */
const notesSync: Contract = {
  kind: 'sync',
  name: 'notes',
  owner: App.owner,
  owns: Projection.pick(App.fields.notes).dependencies,
  observes: Projection.pick(App.fields.notes).dependencies,
  messages: [...MessageSet.make(App, [Message.CreatedNote]).tags],
  requirements: [],
}
/** What `Remote.at` attaches: it owns the store field. */
const remote: Contract = {
  kind: 'remote',
  name: 'remote',
  owner: App.owner,
  owns: [['remote']],
  observes: [['remote']],
  messages: [],
  requirements: [],
}

describe('Module', () => {
  const Project = Module.make(App, [Board, notesSync, remote])

  it('is data: the contracts in declaration order, Surfaces described in place', () => {
    expect(Project.contracts.map(contract => `${contract.kind}:${contract.name}`)).toEqual([
      'surface:Board',
      'sync:notes',
      'remote:remote',
    ])
    expect(Project.contracts[0]).toEqual({
      kind: 'surface',
      name: 'Board',
      owner: App.owner,
      owns: [],
      observes: [['notes'], ['selectedNoteId']],
      messages: ['CreatedNote', 'SelectedNote'],
      requirements: [],
    })
    expect(Module.add(Project).contracts).toEqual(Project.contracts)
  })

  it('reports who owns each Model field, local when nobody does', () => {
    expect(Module.manifest(Project).ownership).toEqual([
      { path: ['route'], owner: undefined },
      { path: ['selectedNoteId'], owner: undefined },
      { path: ['notes'], owner: { kind: 'sync', name: 'notes' } },
      { path: ['remote'], owner: { kind: 'remote', name: 'remote' } },
    ])
    expect(Module.validate(Project)).toEqual([])
  })

  it('shows a partially owned field as local with its owned paths beneath', () => {
    const nested: Contract = { ...remote, name: 'entities', owns: [['remote', 'entities']] }
    const rows = Module.manifest(Module.make(App, [nested])).ownership
    expect(rows).toContainEqual({ path: ['remote'], owner: undefined })
    expect(rows).toContainEqual({
      path: ['remote', 'entities'],
      owner: { kind: 'remote', name: 'entities' },
    })
  })

  it('finds two owners of overlapping paths, including a nested one', () => {
    const again: Contract = { ...notesSync, name: 'notes-again' }
    const nested: Contract = { ...remote, name: 'inner', owns: [['remote', 'entities']] }
    const findings = Module.validate(Module.add(Project, again, nested))
    expect(findings.map(finding => [finding.rule, ...finding.contracts])).toEqual([
      ['ownership-overlap', 'sync:notes', 'sync:notes-again'],
      ['ownership-overlap', 'remote:remote', 'remote:inner'],
      ['message-claimed-twice', 'sync:notes', 'sync:notes-again'],
    ])
  })

  it('finds a contract from another application and a duplicate name', () => {
    const foreign = Surface.make(Other, 'Board', {
      model: ({ model }) => Projection.struct({ route: model.route }),
    })
    const findings = Module.validate(Module.add(Project, foreign as never))
    expect(findings.map(finding => finding.rule)).toEqual(['foreign-contract', 'duplicate-name'])
  })

  it('finds a path or Message the application does not declare', () => {
    const stray: Contract = {
      kind: 'agent',
      name: 'assistant',
      owner: App.owner,
      owns: [],
      observes: [['nope']],
      messages: ['Missing'],
      requirements: [],
    }
    expect(Module.validate(Module.make(App, [stray])).map(finding => finding.message)).toEqual([
      'agent:assistant references "nope", which is not a Model field',
      'agent:assistant names "Missing", which is not a Message of this application',
    ])
  })

  it('renders the ownership tree and contracts as Markdown', () => {
    const markdown = Module.toMarkdown(Module.add(Project, { ...notesSync, name: 'dup' }))
    expect(markdown).toContain('├── route           LOCAL')
    expect(markdown).toContain('├── notes           SYNC notes')
    expect(markdown).toContain('└── remote          REMOTE remote')
    expect(markdown).toContain(
      '| surface:Board |  | notes, selectedNoteId | CreatedNote, SelectedNote |  |',
    )
    expect(markdown).toContain(
      '- **ownership-overlap** sync:notes owns "notes" and sync:dup owns "notes"',
    )
  })
})
