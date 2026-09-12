import { Effect, Fiber, Schema, Stream, type Duration } from 'effect'
import { TestClock } from 'effect/testing'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface, type Requirement } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  Selection,
  addLayer,
  addOverlay,
  emptyOptimistic,
  emptyStore,
  entityKey,
  gc,
  initialRemoteModel,
  segment,
  updateRemote,
  writeEntity,
  type EntityStore,
  type RemoteMessage,
  type RemoteModel,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Project = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    owner: Entity.ref(User),
    members: Schema.Array(Entity.ref(User)),
  }),
)
const Data = Remote.make({ entities: [User, Project] })
const Model = Schema.Struct({ remote: Data.Model, projectId: Schema.String })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)
const UserSummary = Selection.make(User, { id: true, name: true })
const ProjectCard = Selection.make(Project, { name: true, owner: UserSummary })
const ProjectName = Selection.make(Project, { name: true })
const ProjectTeam = Selection.make(Project, { members: true })

const store = (): EntityStore => {
  let current = writeEntity(emptyStore, entityKey('Project', 'p1'), {
    name: 'Apollo',
    owner: 'User:u1',
    members: ['User:u2'],
  })
  current = writeEntity(current, entityKey('Project', 'p2'), { name: 'Borealis', owner: 'User:u3' })
  for (const id of ['u1', 'u2', 'u3', 'u4']) {
    current = writeEntity(current, entityKey('User', id), { id, name: id })
  }
  return current
}

const model = (): RemoteModel => ({
  ...initialRemoteModel,
  entities: store(),
  connections: {
    'Projects()': {
      segments: [
        segment(
          [{ key: 'Project:p2', ref: { entity: 'Project', id: 'p2' } }],
          { _tag: 'Terminal' },
          { _tag: 'Terminal' },
        ),
      ],
      stale: false,
    },
    'Other()': { segments: [], stale: false },
  },
})

const keys = (state: { readonly entities: EntityStore }) => Object.keys(state.entities).sort()
const roots = (
  projections: ReadonlyArray<{ readonly requirements: readonly Requirement[] }>,
  connections: string[] = [],
) => ({
  requirements: projections.flatMap(projection => projection.requirements),
  connections,
})

describe('gc', () => {
  it('keeps the root entity and the targets its retained fields refer to', () => {
    const kept = gc(model(), roots([Remote.select(AppRemote, ProjectCard)('p1')]))
    expect(keys(kept)).toEqual(['Project:p1', 'User:u1'])
  })

  it('does not follow a field the root does not select', () => {
    const kept = gc(model(), roots([Remote.select(AppRemote, ProjectName)('p1')]))
    expect(keys(kept)).toEqual(['Project:p1'])
  })

  it('follows every ref in a selected list field', () => {
    const kept = gc(model(), roots([Remote.select(AppRemote, ProjectTeam)('p1')]))
    expect(keys(kept)).toEqual(['Project:p1', 'User:u2'])
  })

  it('releasing a root makes what only it reached collectible', () => {
    const both = gc(
      model(),
      roots([
        Remote.select(AppRemote, ProjectCard)('p1'),
        Remote.select(AppRemote, ProjectCard)('p2'),
      ]),
    )
    expect(keys(both)).toEqual(['Project:p1', 'Project:p2', 'User:u1', 'User:u3'])
    const one = gc(model(), roots([Remote.select(AppRemote, ProjectCard)('p1')]))
    expect(keys(one)).toEqual(['Project:p1', 'User:u1'])
  })

  it('a retained connection keeps its edges’ targets; another connection is dropped', () => {
    const kept = gc(model(), roots([], ['Projects()']))
    expect(keys(kept)).toEqual(['Project:p2'])
    expect(Object.keys(kept.connections)).toEqual(['Projects()'])
  })

  it('a pending optimistic layer or overlay keeps what it touches', () => {
    const state: RemoteModel = {
      ...model(),
      optimistic: addOverlay(
        addLayer(emptyOptimistic, {
          id: 'req-1',
          patches: [{ entity: 'User', id: 'u4', values: { name: 'temp' } }],
        }),
        {
          id: 'req-2',
          connection: 'Other()',
          edges: [{ key: 'Project:p2', ref: { entity: 'Project', id: 'p2' } }],
          position: 'prepend',
        },
      ),
    }
    const kept = gc(state, roots([]))
    expect(keys(kept)).toEqual(['Project:p2', 'User:u4'])
    expect(Object.keys(kept.connections)).toEqual(['Other()'])
  })

  it('with no roots and nothing pending, everything is collectible', () => {
    const kept = gc(model(), roots([]))
    expect(kept).toEqual({ entities: {}, connections: {} })
  })

  it('a nested relation is followed with its own fields, and a cycle terminates', () => {
    const Node = Entity.make(
      'Node',
      Schema.Struct({ id: Schema.String, next: Entity.refTo('Node'), aside: Entity.refTo('Node') }),
    )
    let current = writeEntity(emptyStore, entityKey('Node', 'a'), {
      next: 'Node:b',
      aside: 'Node:x',
    })
    current = writeEntity(current, entityKey('Node', 'b'), { next: 'Node:a', aside: 'Node:y' })
    current = writeEntity(current, entityKey('Node', 'x'), {})
    current = writeEntity(current, entityKey('Node', 'y'), {})
    const kept = gc(
      { entities: current, connections: {}, optimistic: emptyOptimistic },
      {
        requirements: [
          {
            entity: 'Node',
            id: 'a',
            fields: ['next'],
            relations: { next: { entity: 'Node', fields: ['next', 'aside'] } },
          },
        ],
        connections: [],
      },
    )
    // a selects next → b; b (through the relation) selects next → a and aside → y; x is not reached.
    expect(keys(kept)).toEqual(['Node:a', 'Node:b', 'Node:y'])
  })
})

describe('RetentionChanged through Remote.update', () => {
  it('collects the model to the roots', () => {
    const next = updateRemote(model(), {
      _tag: 'RetentionChanged',
      roots: roots([Remote.select(AppRemote, ProjectCard)('p1')]),
    })
    expect(keys(next)).toEqual(['Project:p1', 'User:u1'])
    expect(next.connections).toEqual({})
    expect(next.live).toBe(model().live)
  })
})

describe('Remote.retain', () => {
  const Page = Surface.make(App, 'Page', {
    Params: Schema.Struct({ projectId: Schema.String }),
    model: ({ params }) =>
      Projection.struct({ project: Remote.select(AppRemote, ProjectCard)(params.projectId) }),
    messages: [Message.Ping],
  })
  const root = (projectId: string) => ({ remote: model(), projectId })
  const entryFor = (grace?: Duration.Input) => (appModel: ReturnType<typeof root>) =>
    Remote.retain(
      AppRemote,
      [Page.projection({ projectId: appModel.projectId })],
      (message: RemoteMessage) => message,
      { connections: ['Projects()', 'Projects()'], ...(grace === undefined ? {} : { grace }) },
    )

  it('its dependencies are the merged, sorted roots', () => {
    const entry = entryFor()(root('p1'))
    expect(entry.modelToDependencies(root('p1'))).toEqual({
      requirements: [
        {
          entity: 'Project',
          id: 'p1',
          fields: ['name', 'owner'],
          relations: { owner: { entity: 'User', fields: ['id', 'name'] } },
        },
      ],
      connections: ['Projects()'],
    })
  })

  it('emits one RetentionChanged that the reducer applies', async () => {
    const entry = entryFor()(root('p1'))
    const dependencies = entry.modelToDependencies(root('p1'))
    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)),
    )
    expect([...messages]).toEqual([{ _tag: 'RetentionChanged', roots: dependencies }])
    const next = updateRemote(model(), [...messages][0]!)
    expect(keys(next)).toEqual(['Project:p1', 'Project:p2', 'User:u1'])
  })

  it('waits for the grace period before collecting', async () => {
    const entry = entryFor('5 seconds')(root('p1'))
    const dependencies = entry.modelToDependencies(root('p1'))
    const collected: RemoteMessage[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(entry.dependenciesToStream(dependencies), message =>
            Effect.sync(() => void collected.push(message)),
          ),
        )
        yield* TestClock.adjust('4 seconds')
        expect(collected).toEqual([])
        yield* TestClock.adjust('2 seconds')
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(collected.map(message => message._tag)).toEqual(['RetentionChanged'])
  })

  it('changing roots changes the dependencies, so Foldkit restarts the wait', () => {
    const a = entryFor()(root('p1')).modelToDependencies(root('p1'))
    const b = entryFor()(root('p2')).modelToDependencies(root('p2'))
    expect(a).not.toEqual(b)
  })
})
