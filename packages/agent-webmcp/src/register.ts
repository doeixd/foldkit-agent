import type { Agent } from '@foldkit/agent'
import { Effect } from 'effect'
import {
  type ModelContext,
  type ToolDescriptor,
  type ToolResult,
  documentModelContext,
} from './webmcp.js'

/** A live WebMCP registration. */
export interface Registration {
  /** Re-reads availability from the current Model and reconciles registrations. */
  readonly refresh: () => Promise<void>
  /** Unregisters every tool and stops following the Model. */
  readonly unregister: () => void
  /** The capability names currently registered with WebMCP. */
  readonly registered: () => ReadonlyArray<string>
}

export interface RegisterOptions<Model, Context_, Principal> {
  /** The agent contract bound to a live Foldkit Runtime. */
  readonly agent: Agent.AgentRuntime<Model, Context_, Principal>
  /** Defaults to `document.modelContext`. */
  readonly modelContext?: ModelContext | undefined
  /** Unregisters everything when aborted. */
  readonly signal?: AbortSignal | undefined
  /**
   * Follow the live Model and reconcile registrations as `available(model)`
   * changes. Defaults to `true`, and is inert unless the host supports
   * subscription.
   */
  readonly followModel?: boolean | undefined
  /** Supplies an invocation id. Defaults to `crypto.randomUUID()`. */
  readonly invocationId?: (() => string) | undefined
}

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  isError,
})

/** Renders a dispatch failure as a tool error the calling agent can act on. */
const describeFailure = (error: { readonly _tag: string } & Record<string, unknown>): string => {
  switch (error._tag) {
    case 'AgentUnknownCapabilityError':
      return `No such capability: ${String(error['capability'])}`
    case 'AgentCapabilityUnavailableError':
      return `Capability "${String(error['capability'])}" is not available right now`
    case 'AgentAuthorizationError':
      return `Not authorized to invoke "${String(error['capability'])}"`
    case 'AgentInvalidInputError':
      return `Invalid input for "${String(error['capability'])}"`
    default:
      return `Dispatch failed: ${error._tag}`
  }
}

const defaultInvocationId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `webmcp-${Math.random().toString(36).slice(2)}`

/**
 * Projects an agent contract into `document.modelContext.registerTool(...)`.
 *
 * Each currently available capability becomes one tool: the capability name
 * becomes the tool name, the variant description becomes the description, the
 * derived JSON Schema becomes `inputSchema`, and `execute` validates its input
 * and dispatches into the same live Foldkit Runtime the human is using.
 *
 * Tool availability is itself a projection of Model state. When
 * `available(model)` changes, registrations are reconciled: capabilities that
 * are gone have their registration signal aborted, and capabilities that have
 * appeared are registered.
 *
 * @example
 * ```ts
 * const registration = AgentWebMcp.register({ agent: agentRuntime })
 * ```
 */
export const register = <Model, Context_, Principal>(
  options: RegisterOptions<Model, Context_, Principal>,
): Registration => {
  const modelContext = options.modelContext ?? documentModelContext()
  if (modelContext === undefined) {
    throw new Error(
      'WebMCP is unavailable: no document.modelContext. Pass an explicit modelContext to register().',
    )
  }

  const { agent } = options
  const nextInvocationId = options.invocationId ?? defaultInvocationId

  /** One AbortController per registered tool: aborting it unregisters that tool. */
  const controllers = new Map<string, AbortController>()
  let disposed = false

  const toolFor = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
  ): { readonly controller: AbortController; readonly tool: ToolDescriptor } => {
    const controller = new AbortController()

    const execute = async (
      input: unknown,
      context: { readonly signal?: AbortSignal | undefined },
    ): Promise<ToolResult> => {
      const result = await Effect.runPromise(
        Effect.result(
          agent.messages.dispatch(name, input, {
            id: nextInvocationId(),
            transport: 'webmcp',
            signal: context.signal,
          }),
        ),
      )

      return result._tag === 'Failure'
        ? textResult(describeFailure(result.failure as never), true)
        : textResult(`Dispatched ${result.success.tag}`)
    }

    return {
      controller,
      tool: { name, description, inputSchema, execute, signal: controller.signal },
    }
  }

  const reconcile = async (): Promise<void> => {
    if (disposed) return

    const available = await Effect.runPromise(agent.messages.available)
    const wanted = new Map(available.map(descriptor => [descriptor.name, descriptor]))

    // Unregister capabilities the Model no longer offers.
    for (const [name, controller] of [...controllers]) {
      if (!wanted.has(name)) {
        controller.abort()
        controllers.delete(name)
      }
    }

    // Register capabilities that have appeared.
    for (const [name, descriptor] of wanted) {
      if (controllers.has(name)) continue
      const { controller, tool } = toolFor(name, descriptor.description, descriptor.inputSchema)
      controllers.set(name, controller)
      await modelContext.registerTool(tool)
    }
  }

  let unsubscribe: () => void = () => {}

  const unregister = (): void => {
    disposed = true
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    unsubscribe()
  }

  // The first reconcile is fire-and-forget; callers who need to await it can
  // use the returned `refresh`.
  void reconcile()

  if (options.followModel !== false) {
    unsubscribe = agent.subscribe(() => {
      void reconcile()
    })
  }

  options.signal?.addEventListener('abort', unregister, { once: true })

  return {
    refresh: reconcile,
    unregister,
    registered: () => [...controllers.keys()],
  }
}
