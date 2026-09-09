/**
 * The slice of Chrome's experimental WebMCP Imperative API this adapter uses.
 *
 * These types are declared locally rather than imported: the API is still
 * experimental, and Foldkit should not be coupled to a browser proposal that is
 * still changing.
 */

/** Metadata passed to a tool's `execute` function. */
export interface ToolExecutionContext {
  /** Cancellation for this invocation: is this call still wanted? */
  readonly signal?: AbortSignal | undefined
}

/** The value a WebMCP tool returns. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: boolean
}

/** A tool registration as accepted by `document.modelContext.registerTool`. */
export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly execute: (input: any, context: ToolExecutionContext) => Promise<ToolResult>
}

/**
 * Options accepted alongside a tool registration.
 *
 * The registration signal belongs here, not on the descriptor: aborting it is
 * how the documented API unregisters a tool.
 */
export interface RegisterToolOptions {
  readonly signal?: AbortSignal | undefined
}

/** The producer surface exposed on `document.modelContext`. */
export interface ModelContext {
  readonly registerTool: (
    tool: ToolDescriptor,
    options?: RegisterToolOptions,
  ) => void | Promise<unknown>
}

/** Reads `document.modelContext`, when the page provides it. */
export const documentModelContext = (): ModelContext | undefined => {
  if (typeof document === 'undefined') return undefined
  return (document as unknown as { modelContext?: ModelContext }).modelContext
}
