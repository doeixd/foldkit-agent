/**
 * Structured diagnostics for attachment conflicts. Codes are stable so tests,
 * DevTools, and editor tooling can share them. Resolution failures are
 * programming errors (a definition attaches something a slot does not allow),
 * so `resolve` throws a `DiagnosticError` carrying one.
 */
export type DiagnosticCode =
  | 'mixins:protected-event'
  | 'mixins:protected-attribute'
  | 'mixins:protected-style-property'
  | 'mixins:event-conflict'
  | 'mixins:attribute-conflict'
  | 'mixins:structural-override'
  | 'mixins:duplicate-mount-name'

export interface Diagnostic {
  readonly source: 'mixins'
  readonly code: DiagnosticCode
  readonly severity: 'error'
  readonly message: string
  readonly slot?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export class DiagnosticError extends Error {
  readonly diagnostic: Diagnostic

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message)
    this.name = 'DiagnosticError'
    this.diagnostic = diagnostic
  }
}
