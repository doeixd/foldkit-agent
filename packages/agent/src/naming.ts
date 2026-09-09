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
