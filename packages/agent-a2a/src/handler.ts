import { Effect, Schema } from 'effect'
import {
  type AgentRuntime,
  type Id,
  type Message,
  RequestSchema,
  type Response,
  SendParamsSchema,
  type Task,
  type TaskState,
  code,
  failure,
  success,
  terminal,
  text,
} from './types.js'

export interface HandlerOptions {
  readonly agent: AgentRuntime
  /** Tasks kept for `tasks/get`. Defaults to 200. */
  readonly capacity?: number | undefined
  /** Injected for tests. */
  readonly newId?: (() => string) | undefined
  readonly clock?: (() => Date) | undefined
}

export interface Handler {
  readonly handle: (message: unknown) => Promise<Response | undefined>
  readonly close: () => void
}

const randomId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `a2a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/**
 * How a refused or finished dispatch reads as a task state.
 *
 * `rejected` is for a request the agent declined outright -- an unknown skill,
 * bad input, a caller who may not. `failed` is for work that was accepted and
 * did not succeed, which is a different thing to a client deciding what to do
 * next.
 */
const stateFor = (failureTag: string): TaskState => {
  switch (failureTag) {
    case 'AgentCancelledError':
      return 'canceled'
    case 'AgentCompletionTimeoutError':
      return 'failed'
    default:
      return 'rejected'
  }
}

/** The capability and input a client asked for, carried in a data part. */
const skillFrom = (
  message: Message,
): { readonly skill: string; readonly input: unknown } | undefined => {
  const part = message.parts.find(candidate => candidate.kind === 'data')
  if (part === undefined) return undefined
  const skill = part.data['skill']
  return typeof skill === 'string' ? { skill, input: part.data['input'] ?? {} } : undefined
}

const decodeRequest = Schema.decodeUnknownResult(RequestSchema)
const decodeSendParams = Schema.decodeUnknownResult(SendParamsSchema)

/**
 * Serves a contract as an A2A agent, with no transport attached.
 *
 * One exposed capability is one skill. A capability with no completion contract
 * finishes at validated dispatch, so its task is `completed` immediately; one
 * that declares completion finishes when its Message arrives.
 */
export const handler = (options: HandlerOptions): Handler => {
  const { agent } = options
  const capacity = Math.max(1, options.capacity ?? 200)
  const newId = options.newId ?? randomId
  const clock = options.clock ?? (() => new Date())

  const tasks = new Map<string, Task>()
  const running = new Map<string, AbortController>()

  const remember = (task: Task): Task => {
    tasks.set(task.id, task)
    if (tasks.size > capacity) {
      const oldest = tasks.keys().next().value
      if (oldest !== undefined) tasks.delete(oldest)
    }
    return task
  }

  /**
   * Records how a task finished, unless it already finished.
   *
   * A cancel lands while the dispatch is still unwinding, so the settling write
   * arrives second and must not undo it. The task that stands is returned, so
   * the pending `message/send` answers with the same outcome `tasks/get` shows.
   */
  const settle = (task: Task): Task => {
    const current = tasks.get(task.id)
    return current !== undefined && terminal.has(current.status.state) ? current : remember(task)
  }

  const agentMessage = (body: string, taskId: string, contextId: string): Message => ({
    kind: 'message',
    role: 'agent',
    parts: [text(body)],
    messageId: newId(),
    taskId,
    contextId,
  })

  const send = async (id: Id, params: unknown): Promise<Response> => {
    const decoded = decodeSendParams(params)
    if (decoded._tag === 'Failure') {
      return failure(
        id,
        code.INVALID_PARAMS,
        'message/send needs params as { message } with kind "message", a role, a messageId, and parts',
      )
    }

    const { message } = decoded.success
    const asked = skillFrom(message)

    if (asked === undefined) {
      return failure(
        id,
        code.INVALID_PARAMS,
        'message/send needs a data part naming a skill, as { skill, input }',
      )
    }

    const taskId = newId()
    const contextId = message.contextId ?? newId()
    const history: ReadonlyArray<Message> = [message]

    const controller = new AbortController()
    running.set(taskId, controller)

    // Recorded before the work starts: a task a client cannot address while it
    // runs is a task it cannot get or cancel.
    remember({
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'working', timestamp: clock().toISOString() },
      history,
    })

    try {
      // The signal reaches the run, not just the invocation: the runtime checks
      // it before dispatch but does not observe it while awaiting completion,
      // so interrupting the fiber is what actually settles the wait and
      // releases its listener.
      const outcome = await Effect.runPromise(
        Effect.result(
          agent.messages.dispatchUnknown(asked.skill, asked.input, {
            id: taskId,
            transport: 'a2a',
            signal: controller.signal,
          }),
        ),
        { signal: controller.signal },
      )

      if (outcome._tag === 'Failure') {
        const error = outcome.failure
        return success(
          id,
          settle({
            kind: 'task',
            id: taskId,
            contextId,
            status: {
              state: stateFor(error._tag),
              timestamp: clock().toISOString(),
              message: agentMessage(error.message, taskId, contextId),
            },
            history,
          }),
        )
      }

      const result = outcome.success
      // A declared failure Message is work that ran and did not succeed.
      const state: TaskState = result.completion?.status === 'failed' ? 'failed' : 'completed'

      return success(
        id,
        settle({
          kind: 'task',
          id: taskId,
          contextId,
          status: {
            state,
            timestamp: clock().toISOString(),
            message: agentMessage(
              result.completion === undefined
                ? `Dispatched ${result.tag}`
                : `${result.completion.status === 'failed' ? 'Failed' : 'Completed'}: ${result.completion.message._tag}`,
              taskId,
              contextId,
            ),
          },
          history,
        }),
      )
    } catch {
      return success(
        id,
        settle({
          kind: 'task',
          id: taskId,
          contextId,
          status: {
            state: 'failed',
            timestamp: clock().toISOString(),
            message: agentMessage(`Skill "${asked.skill}" failed unexpectedly`, taskId, contextId),
          },
          history,
        }),
      )
    } finally {
      running.delete(taskId)
    }
  }

  const handleRequest = async (id: Id, method: string, raw: unknown): Promise<Response> => {
    const params: Record<string, unknown> =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}

    switch (method) {
      case 'message/send':
        return send(id, raw)

      case 'tasks/get': {
        const taskId = params['id']
        const task = typeof taskId === 'string' ? tasks.get(taskId) : undefined
        return task === undefined
          ? failure(id, code.TASK_NOT_FOUND, 'No such task')
          : success(id, task)
      }

      case 'tasks/cancel': {
        const taskId = params['id']
        const task = typeof taskId === 'string' ? tasks.get(taskId) : undefined
        if (task === undefined) return failure(id, code.TASK_NOT_FOUND, 'No such task')

        if (terminal.has(task.status.state)) {
          return failure(id, code.TASK_NOT_CANCELABLE, 'Task cannot be canceled')
        }

        // The canceled state is recorded before the abort, so the dispatch it
        // interrupts cannot settle over it on its way out. Cancelling stops the
        // waiting, not the Messages already dispatched.
        const canceled = remember({
          ...task,
          status: {
            state: 'canceled',
            timestamp: clock().toISOString(),
            message: agentMessage('Canceled by the client', task.id, task.contextId),
          },
        })
        running.get(task.id)?.abort()

        return success(id, canceled)
      }

      // Streaming is declared unsupported on the card, so it is refused here
      // rather than answered with something a client cannot consume.
      case 'message/stream':
        return failure(id, code.METHOD_NOT_FOUND, 'This agent does not support streaming')

      default:
        return failure(id, code.METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  }

  return {
    handle: async (incoming: unknown): Promise<Response | undefined> => {
      if (Array.isArray(incoming)) {
        return failure(null, code.INVALID_REQUEST, 'Batched requests are not supported')
      }

      const decoded = decodeRequest(incoming)
      if (decoded._tag === 'Failure') {
        return failure(null, code.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message')
      }

      const request = decoded.success
      // A notification carries no id and expects no reply.
      if (request.id === undefined) return undefined

      return handleRequest(request.id, request.method, request.params)
    },

    close: () => {
      for (const controller of running.values()) controller.abort()
      running.clear()
      tasks.clear()
    },
  }
}
