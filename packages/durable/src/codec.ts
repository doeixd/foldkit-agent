/**
 * Encodes a value to JSON-compatible data and decodes it back strictly.
 *
 * Deliberately not tied to a schema library: `foldkit-durable` stores whatever
 * the application's codec produces. A callback that throws means the value is
 * invalid. `Encoded` is the wire/storage side, so `Journal.append` can require
 * it instead of accepting `unknown`.
 */
export interface Codec<Value, Encoded = unknown> {
  readonly encode: (value: Value) => Encoded
  readonly decode: (value: Encoded) => Value
}
