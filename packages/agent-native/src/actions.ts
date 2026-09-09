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
   * The input schema as Standard Schema v1.
   *
   * Effect and Zod both implement it, so a consumer that accepts the standard
   * needs no conversion. `jsonSchema` is there for one that wants to build its
   * own validator instead.
   */
  readonly schema: StandardSchemaV1<unknown, unknown>
  readonly jsonSchema: Record<string, unknown>
  readonly run: (input: unknown) => Promise<ActionResult>
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
    schema: Schema.toStandardSchemaV1(variant.inputSchema) as StandardSchemaV1<unknown, unknown>,
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
