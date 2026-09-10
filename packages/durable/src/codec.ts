/**
 * Encodes a value to JSON-compatible data and decodes it back strictly.
 *
 * Deliberately not tied to a schema library: `foldkit-durable` stores whatever
 * the application's codec produces. A callback that throws means the value is
 * invalid.
 */
export interface Codec<Value> {
  readonly encode: (value: Value) => unknown
  readonly decode: (value: unknown) => Value
}
