/**
 * The type-level twin of {@link defaultName}.
 *
 * A capability's name is part of its type, so the two must agree exactly. Both
 * lowercase the first character and prefix every later capital with `_`.
 */
export type SnakeCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? `${Lowercase<Head>}${SnakeCaseTail<Tail>}`
  : S

type SnakeCaseTail<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Uppercase<Head>
    ? // A digit or separator is both its own upper and lower case.
      Head extends Lowercase<Head>
      ? `${Head}${SnakeCaseTail<Tail>}`
      : `_${Lowercase<Head>}${SnakeCaseTail<Tail>}`
    : `${Head}${SnakeCaseTail<Tail>}`
  : S

/**
 * Normalizes a Foldkit Message tag into a default protocol-facing name.
 *
 * `RequestedDeleteTodo` becomes `requested_delete_todo`. A variant can override
 * this with an explicit `name`. The internal Message tag never changes.
 *
 * Each capital starts a new word, with no special case for runs of them, so
 * `LoadedHTTPCache` becomes `loaded_h_t_t_p_cache`. That is deliberate: the
 * rule has to be expressible as a template literal type, and a tag with an
 * acronym is better served by an explicit `name`.
 */
export const defaultName = (tag: string): string =>
  [...tag]
    .map((character, index) => {
      const lower = character.toLowerCase()
      if (index === 0) return lower
      return character === lower ? character : `_${lower}`
    })
    .join('')

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
