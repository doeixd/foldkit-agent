import { Agent } from 'foldkit-agent'
import type { ActionTool } from '@agent-native/core/server'
import { Effect, Schema } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'

type AgentRuntime = Agent.AgentRuntime<any, any, any, any, any>

/**
 * The request context Agent Native hands an action.
 *
 * Deliberately narrower than the framework's own `ActionRunContext`: the
 * adapter promises only the identity a principal mapper needs, so its public
 * surface does not grow with the framework's context. The framework still
 * passes its full context through at runtime.
 */
export interface ActionRunContext {
  readonly userEmail?: string | undefined
  readonly orgId?: string | null | undefined
}

/** What an action reports back. `run` never decides anything itself. */
export interface ActionResult {
  readonly ok: boolean
  /** The Message tag that was dispatched, when one was. */
  readonly tag?: string | undefined
  /** How the operation finished, when the capability declares completion. */
  readonly completion?: 'completed' | 'failed' | undefined
  readonly message: string
}

/** One entry of the record `registerPackageActions` takes. */
export interface ActionEntry {
  readonly tool: {
    readonly description: string
    readonly parameters: NonNullable<ActionTool['parameters']>
  }
  readonly run: (args: unknown, context?: ActionRunContext) => Promise<ActionResult>
  readonly schema: StandardSchemaV1<unknown, unknown>
  readonly http: { readonly method: 'POST' }
  /** Defaults to true in the framework; stated so it is not left to a default. */
  readonly requiresAuth: boolean
  /**
   * Always false. A capability dispatches a Message into `update`, so it is a
   * write however little it changes.
   *
   * This feeds plan-mode classification, where the dangerous direction is
   * claiming read-only: plan mode would then run it for real. A resource read
   * would be the read-only case, and resources are not exposed as actions yet.
   */
  readonly readOnly: false
}

/**
 * A Standard Schema that both validates and advertises its shape.
 *
 * Neither Effect helper does both alone, and the difference is silent:
 * `toStandardSchemaV1` carries `validate` but no `jsonSchema`, and
 * `defineAction` accepts it while advertising a tool that takes **no input**;
 * `toStandardJSONSchemaV1` carries the `jsonSchema` those parameters come from
 * but no `validate`.
 *
 * Both return the schema itself and share one `~standard`, so calling them in
 * turn leaves a single object carrying both. Copying them into a new object
 * would not work: the conversion reads the Effect schema, so identity matters.
 */
const describedSchema = (
  schema: Parameters<typeof Schema.toStandardSchemaV1>[0],
): StandardSchemaV1<unknown, unknown> => {
  const described = Schema.toStandardJSONSchemaV1(schema as never)
  // Stripping fields here would hide invalid input from dispatch's strict decoder.
  Schema.toStandardSchemaV1(schema, { parseOptions: { onExcessProperty: 'error' } })

  return described as unknown as StandardSchemaV1<unknown, unknown>
}

export interface ActionsOptions {
  readonly definition: Agent.Definition<any, any, any, any, any>

  /**
   * Resolves the Runtime for one request.
   *
   * Called per invocation, because which Model a caller means depends on who is
   * calling. The Runtime it returns must already be bound for that caller: when
   * a contract declares `authorize`, `Agent.bind` requires a `principal`
   * provider, so the identity mapping stays with the application instead of
   * being guessed here from `userEmail`.
   */
  readonly resolveRuntime: (context: ActionRunContext) => AgentRuntime | Promise<AgentRuntime>

  /** Recorded on the invocation, so an audit log can tell these apart. */
  readonly transport?: string | undefined
}

/**
 * Compiles the exposed capabilities into a package action registry.
 *
 * Hand the result to `registerPackageActions` from `@agent-native/core/server`,
 * which merges it into the registry every surface reads. Nothing is written to
 * disk, so no generated action can outlive the capability it came from.
 *
 * `run` only dispatches. Application behaviour stays in `update`, and the action
 * adds no authority of its own: availability, authorization and input
 * validation all still happen in the contract.
 *
 * @example
 * ```ts
 * registerPackageActions(
 *   AgentNative.actions({
 *     definition: AppAgent,
 *     resolveRuntime: ctx => runtimeFor(ctx),
 *   }),
 * )
 * ```
 */
export const actions = (options: ActionsOptions): Record<string, ActionEntry> => {
  const transport = options.transport ?? 'agent-native'
  const entries: Record<string, ActionEntry> = Object.create(null)

  for (const variant of options.definition.messages.variants) {
    if (variant.inputJsonSchema.type !== 'object') {
      throw new Error(`Agent Native capability "${variant.name}" requires an object input schema`)
    }
    entries[variant.name] = {
      tool: {
        description: variant.description,
        parameters: {
          properties: {},
          ...variant.inputJsonSchema,
        } as NonNullable<ActionTool['parameters']>,
      },
      // Validated on the *encoded* side. The framework hands `run` whatever
      // this schema parsed, and `run` hands that to `dispatchUnknown`, which
      // decodes. A decoding schema here would decode a transforming input
      // twice, so the contract would then reject its own validated value.
      schema: describedSchema(Schema.toEncoded(variant.inputSchema)),
      http: { method: 'POST' },
      requiresAuth: true,
      readOnly: false,

      run: async (args: unknown, context?: ActionRunContext): Promise<ActionResult> => {
        // Resolution is the application's code, and its throw is deliberate --
        // a principal mapper refusing an unauthenticated caller, say. Let it
        // through rather than reporting it as this capability failing.
        const agent = await options.resolveRuntime(context ?? {})

        let outcome
        try {
          outcome = await Effect.runPromise(
            Effect.result(agent.messages.dispatchUnknown(variant.name, args, { transport })),
          )
        } catch {
          // `Effect.result` captures expected failures but not defects, and a
          // defect's text may carry application internals.
          return { ok: false, message: `Capability "${variant.name}" failed unexpectedly` }
        }

        if (outcome._tag === 'Failure') {
          return { ok: false, message: outcome.failure.message }
        }

        const result = outcome.success
        const summary = Agent.summarize(result)
        return {
          ok: summary.ok,
          tag: result.tag,
          ...(result.completion === undefined ? {} : { completion: result.completion.status }),
          message: summary.text,
        }
      },
    }
  }

  return entries
}
