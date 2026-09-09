import { Schema } from 'effect'

/**
 * Derives a JSON Schema document from an Effect Schema.
 *
 * Definitions produced during derivation are inlined under `$defs` so the
 * result is a single self-contained schema an adapter can hand to a protocol.
 */
export const toJsonSchema = (
  schema: Schema.Codec<any, any, never, never>,
  options?: { readonly emptyStructIsObject?: boolean },
): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema as never)
  const derived = document.schema as Record<string, unknown>

  // Schema.Struct({}) widens to { anyOf: [{object}, {array}] }, which tool
  // protocols reject. Payload-free Messages are common, so close it up.
  if (options?.emptyStructIsObject === true && derived['type'] === undefined) {
    return { type: 'object', properties: {}, required: [], additionalProperties: false }
  }

  const definitions = document.definitions as Record<string, unknown> | undefined
  return definitions !== undefined && Object.keys(definitions).length > 0
    ? { ...derived, $defs: definitions }
    : { ...derived }
}
