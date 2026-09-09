/**
 * Reads the tag off a Foldkit Message constructor.
 *
 * `defineMessageUnion` builds each variant as a tagged struct whose `_tag`
 * field is a literal schema, so the tag is available without constructing a
 * Message. Used to name an unexposed capability in an error, and to record a
 * completion contract as data.
 */
export const messageTag = (constructor: unknown): string | undefined => {
  const literal = (constructor as { fields?: { _tag?: { ast?: { literal?: unknown } } } }).fields
    ?._tag?.ast?.literal
  return typeof literal === 'string' ? literal : undefined
}

/** The tags of a completion contract's `success` or `failure`, which accept one or many. */
export const messageTags = (constructors: unknown): ReadonlyArray<string> => {
  const many = Array.isArray(constructors) ? constructors : [constructors]
  return many.map(messageTag).filter((tag): tag is string => tag !== undefined)
}
