/**
 * Normalizes a Foldkit Message tag into a default protocol-facing name.
 *
 * `RequestedDeleteTodo` becomes `requested_delete_todo`. A variant can override
 * this with an explicit `name`. The internal Message tag never changes.
 */
export const defaultName = (tag: string): string =>
  tag
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()

/**
 * The character set MCP and WebMCP accept for a tool name.
 *
 * A capability name becomes a protocol-facing tool name, so an invalid one
 * should fail where it is written rather than at registration time, where the
 * browser or client would reject it with no reference back to the contract.
 */
const VALID_NAME = /^[a-zA-Z0-9_-]{1,128}$/

/** Throws when a capability name cannot be used as a protocol tool name. */
export const assertValidName = (name: string, tag: string): void => {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Cannot expose "${tag}": "${name}" is not a valid capability name. ` +
        'Use 1-128 characters of [a-zA-Z0-9_-].',
    )
  }
}
