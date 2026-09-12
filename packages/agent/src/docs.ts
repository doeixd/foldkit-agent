import type { Definition } from './make.js'
import { contextSchema, messages, resources } from './introspect.js'
import { messageTags } from './tag.js'

/**
 * The agent contract as a self-contained document.
 *
 * Written to `agent.json` and committed, it makes a change to what an
 * application exposes visible in review rather than only at runtime.
 */
export interface Manifest {
  readonly capabilities: ReadonlyArray<{
    readonly name: string
    readonly tag: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
    readonly modelDependent: boolean
    readonly requiresAuthorization: boolean
    readonly completion?: {
      readonly success: ReadonlyArray<string>
      readonly failure?: ReadonlyArray<string>
    }
  }>
  readonly resources: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly schema: Record<string, unknown>
  }>
  readonly context?: Record<string, unknown>
}

/**
 * Describes a contract as data, in declaration order and with nothing derived
 * from the current run.
 *
 * The output is reproducible for a given contract, so it can be committed and
 * diffed. Nothing here reads the Model.
 */
export const toManifest = (definition: Definition<any, any, any, any, any>): Manifest => {
  const context = contextSchema(definition)

  return {
    capabilities: messages(definition).map(capability => {
      const completion = capability.completion

      return {
        name: capability.name,
        tag: capability.tag,
        description: capability.description,
        inputSchema: capability.inputSchema,
        modelDependent: capability.modelDependent,
        requiresAuthorization: capability.requiresAuthorization,
        ...(completion === undefined
          ? {}
          : {
              completion: {
                success: messageTags(completion.success),
                ...(completion.failure === undefined
                  ? {}
                  : { failure: messageTags(completion.failure) }),
              },
            }),
      }
    }),
    resources: resources(definition).map(resource => ({
      name: resource.name,
      description: resource.description,
      schema: resource.schema,
    })),
    ...(context === undefined ? {} : { context }),
  }
}

const jsonBlock = (value: unknown): string => '```json\n' + JSON.stringify(value, null, 2) + '\n```'

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')

/** Escapes the characters that would break out of a Markdown table cell. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * Renders a contract as Markdown, from the same descriptors adapters read.
 *
 * @example
 * ```ts
 * writeFileSync('AGENT.md', Agent.toMarkdown(AppAgent))
 * ```
 */
export const toMarkdown = (definition: Definition<any, any, any, any, any>): string => {
  const manifest = toManifest(definition)
  const lines: Array<string> = ['# Agent contract', '']

  if (manifest.capabilities.length === 0) {
    lines.push('This contract exposes no capabilities.', '')
  } else {
    lines.push(
      '## Capabilities',
      '',
      '| Name | Message | Description | Model-dependent | Authorized |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const capability of manifest.capabilities) {
      lines.push(
        `| \`${cell(capability.name)}\` | \`${cell(capability.tag)}\` | ${cell(
          capability.description,
        )} | ${yesNo(capability.modelDependent)} | ${yesNo(capability.requiresAuthorization)} |`,
      )
    }
    lines.push('')

    for (const capability of manifest.capabilities) {
      lines.push(`### \`${capability.name}\``, '', capability.description, '')
      if (capability.modelDependent) {
        lines.push('Available only in some Model states.', '')
      }
      if (capability.requiresAuthorization) {
        lines.push('Runs an authorization check before dispatching.', '')
      }
      lines.push('Input:', '', jsonBlock(capability.inputSchema), '')
      if (capability.completion !== undefined) {
        const success = capability.completion.success.join(', ')
        const failure = capability.completion.failure?.join(', ')
        lines.push(
          `Completes on \`${success}\`${failure === undefined ? '' : `, fails on \`${failure}\``}.`,
          '',
        )
      }
    }
  }

  if (manifest.resources.length > 0) {
    lines.push('## Resources', '')
    for (const resource of manifest.resources) {
      lines.push(
        `### \`${resource.name}\``,
        '',
        resource.description,
        '',
        jsonBlock(resource.schema),
        '',
      )
    }
  }

  lines.push('## Context', '')
  lines.push(
    manifest.context === undefined
      ? 'This contract projects no Model context.'
      : jsonBlock(manifest.context),
    '',
  )

  return lines.join('\n')
}
