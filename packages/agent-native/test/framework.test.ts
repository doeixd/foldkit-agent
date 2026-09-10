import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineAction } from '@agent-native/core/action'
import { closeDbExec } from '@agent-native/core/db'
import { appStateGet } from '@agent-native/core/application-state'
import {
  actionsToEngineTools,
  autoDiscoverActions,
  executeAgentToolCall,
  registerPackageActions,
  type ActionEntry,
} from '@agent-native/core/server'
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Agent } from 'foldkit-agent'
import { AgentNative } from 'foldkit-agent-native'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const Message = defineMessageUnion({ SetLimit: { value: Schema.Number } })
const LimitAgent = Agent.forModel<{ limit: number }, { canEdit: boolean }>()
const definition = LimitAgent.define({
  messages: LimitAgent.expose(Message, {
    SetLimit: {
      name: 'foldkit_spike_set_limit',
      description: 'Set the limit',
      input: Schema.Struct({ value: Schema.NumberFromString }),
      toMessage: ({ value }) => ({ value }),
      authorize: ({ principal }) => principal.canEdit,
    },
  }),
})
let limit = 0
const actions = AgentNative.actions({
  definition,
  resolveRuntime: context =>
    LimitAgent.bind({
      definition,
      host: {
        model: () => ({ limit }),
        principal: () => ({ canEdit: context.userEmail === 'owner@example.test' }),
        dispatch: (message: typeof Message.Type) => {
          limit = message.value
        },
      },
    }),
})
let directory: string
let registry: Record<string, ActionEntry>

beforeAll(async () => {
  // The tool loop can query framework metadata even when action auditing is disabled.
  vi.stubEnv('DATABASE_URL', 'pglite:memory')
  directory = await mkdtemp(join(tmpdir(), 'foldkit-native-'))
  await mkdir(join(directory, 'actions'))
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(directory, 'actions', 'foldkit_spike_override.js'),
    'export default { tool: { description: "Local override", parameters: { type: "object", properties: {} } }, run: async () => "local" }',
  )
  registerPackageActions({
    ...actions,
    foldkit_spike_override: actions['foldkit_spike_set_limit']!,
  })
  registry = await autoDiscoverActions(join(directory, 'actions'))
}, 30_000)

afterAll(async () => {
  await closeDbExec()
  vi.unstubAllEnvs()
  if (directory) await rm(directory, { recursive: true, force: true })
})

beforeEach(() => {
  limit = 0
})

it('discovers the package action with its encoded tool schema', () => {
  expect(
    actionsToEngineTools(registry).find(tool => tool.name === 'foldkit_spike_set_limit'),
  ).toMatchObject({ inputSchema: { properties: { value: { type: 'string' } } } })
})

it('lets an app-local action override a package action', async () => {
  expect(await registry['foldkit_spike_override']!.run({})).toBe('local')
  expect(limit).toBe(0)
})

it.each([
  ['owner@example.test', 42],
  ['reader@example.test', 0],
])(
  'executes through the real framework as %s',
  async (ownerEmail, expectedLimit) => {
    const result = await executeAgentToolCall({
      actions: registry,
      name: 'foldkit_spike_set_limit',
      input: { value: '42' },
      callId: 'foldkit-spike-call',
      ownerEmail,
    })
    expect(result.status).toBe('completed')
    expect(JSON.parse(result.output)).toMatchObject({ ok: expectedLimit !== 0 })
    expect(limit).toBe(expectedLimit)
    // Wait for the framework's background change marker before closing its database.
    await vi.waitFor(
      async () => {
        expect(await appStateGet(ownerEmail, '__action_change__')).toMatchObject({
          actionName: 'foldkit_spike_set_limit',
          owner: ownerEmail,
        })
      },
      { timeout: 10_000 },
    )
  },
  30_000,
)

it('preserves encoded values through defineAction validation', async () => {
  const entry = actions['foldkit_spike_set_limit']!
  const wrapped = defineAction({
    description: entry.tool.description,
    schema: entry.schema,
    run: entry.run,
    audit: { enabled: false },
  })
  expect(wrapped.tool.parameters).toMatchObject({ properties: { value: { type: 'string' } } })
  expect(
    await wrapped.run({ value: '12' }, { userEmail: 'owner@example.test', caller: 'tool' }),
  ).toMatchObject({
    ok: true,
  })
  expect(limit).toBe(12)
  await expect(wrapped.run({ value: '99', extra: true })).rejects.toThrow()
  expect(limit).toBe(12)
})
