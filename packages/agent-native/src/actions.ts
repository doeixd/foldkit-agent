import type { Agent } from '@foldkit/agent'
import { Effect, Schema } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'

type AgentRuntime = Agent.AgentRuntime<any, any, any, any, any>

/** What an action reports back. `run` never decides anything itself. */
export interface ActionResult {
  readonly ok: boolean
  /** The Message tag that was dispatched, when one was. */
  readonly tag?: string | undefined
  /** How the operation finished, when the capability declares completion. */
  readonly completion?: 'completed' | 'failed' | undefined
  readonly message: string
}

/**
 * One generated action.
 *
 * The shape Agent Native's `defineAction` takes: a description, a schema, and a
 * `run`. Everything here is derived; nothing is written by hand.
 */
export interface Action {
  readonly name: string
  readonly description: string
  /**
   * The input schema as Standard Schema v1, carrying its JSON Schema.
   *
   * It has to be the JSON-Schema-carrying form. `defineAction` derives a tool's
   * advertised `parameters` from `~standard.jsonSchema`, and a validation-only
   * Standard Schema is accepted without complaint but advertises no parameters
   * at all -- an agent would see a tool that takes no input.
   */
  readonly schema: StandardSchemaV1<unknown, unknown>
  readonly jsonSchema: Record<string, unknown>
  readonly run: (input: unknown) => Promise<ActionResult>
}

/**
 * A Standard Schema that both validates and advertises its shape.
 *
 * Neither Effect helper does both, and the difference is silent:
 *
 * - `toStandardSchemaV1` carries `validate` but no `jsonSchema`, and
 *   `defineAction` accepts it while advertising a tool that takes **no input**.
 * - `toStandardJSONSchemaV1` carries `jsonSchema`, which is what the advertised
 *   `parameters` are derived from, but no `validate`.
 *
 * Copying the two together into a new object also fails: the conversion reads
 * the Effect schema itself, so identity has to be preserved. `validate` is
 * therefore attached to the described schema in place.
 */
const describedSchema = (
  schema: Parameters<typeof Schema.toStandardSchemaV1>[0],
): StandardSchemaV1<unknown, unknown> => {
  const described = Schema.toStandardJSONSchemaV1(schema as never)
  const validating = Schema.toStandardSchemaV1(schema)

  Object.defineProperty(described['~standard'], 'validate', {
    value: validating['~standard'].validate,
    enumerable: true,
    configurable: true,
  })

  return described as unknown as StandardSchemaV1<unknown, unknown>
}

export interface ActionsOptions {
  readonly agent: AgentRuntime
  /** Included in the invocation, so the audit log can tell these apart. */
  readonly transport?: string | undefined
}

/**
 * Compiles the exposed capabilities into Agent Native actions.
 *
 * `run` only dispatches. Application behaviour stays in `update`, which is the
 * whole point of generating these rather than writing a second action layer.
 *
 * Prototype: validated against a stub with the documented `defineAction` shape,
 * not against the framework itself.
 */
export const actions = (options: ActionsOptions): ReadonlyArray<Action> => {
  const { agent } = options
  const transport = options.transport ?? 'agent-native'

  return agent.definition.messages.variants.map(variant => ({
    name: variant.name,
    description: variant.description,
    schema: describedSchema(variant.inputSchema),
    jsonSchema: variant.inputJsonSchema,

    run: async (input: unknown): Promise<ActionResult> => {
      const outcome = await Effect.runPromise(
        Effect.result(agent.messages.dispatchUnknown(variant.name, input, { transport })),
      )

      if (outcome._tag === 'Failure') {
        return { ok: false, message: outcome.failure.message }
      }

      const result = outcome.success
      return {
        ok: result.completion?.status !== 'failed',
        tag: result.tag,
        ...(result.completion === undefined ? {} : { completion: result.completion.status }),
        message:
          result.completion === undefined
            ? `Dispatched ${result.tag}`
            : `${result.completion.status === 'completed' ? 'Completed' : 'Failed'}: ${result.completion.message._tag}`,
      }
    },
  }))
}

/** The subset of `defineAction` this prototype relies on. */
export interface DefineAction {
  (definition: {
    readonly description: string
    readonly schema: unknown
    readonly run: (input: unknown) => Promise<unknown>
  }): unknown
}

/**
 * Registers every capability through a `defineAction`.
 *
 * Kept separate from {@link actions} so the compilation can be tested without
 * the framework present.
 */
export const register = (
  options: ActionsOptions & { readonly defineAction: DefineAction },
): ReadonlyArray<unknown> =>
  actions(options).map(action =>
    options.defineAction({
      description: action.description,
      schema: action.schema,
      run: action.run,
    }),
  )
