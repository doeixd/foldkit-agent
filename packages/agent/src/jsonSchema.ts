import { Schema } from 'effect'

/**
 * A JSON Schema for a payload with no fields.
 *
 * `Schema.toJsonSchemaDocument(Schema.Struct({}))` widens to
 * `{ anyOf: [{ type: 'object' }, { type: 'array' }] }`, which most tool
 * protocols reject. Agent capabilities with empty payloads are common
 * (`ClickedReset`), so normalize them to a closed empty object instead.
 */
const emptyObjectSchema = (): Record<string, unknown> => ({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
})

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

  if (options?.emptyStructIsObject === true && derived['type'] === undefined) {
    return emptyObjectSchema()
  }

  const definitions = document.definitions as Record<string, unknown> | undefined
  return definitions !== undefined && Object.keys(definitions).length > 0
    ? { ...derived, $defs: definitions }
    : { ...derived }
}
