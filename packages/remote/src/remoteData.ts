/** `RemoteData`: the state of a value the store may not hold yet. */
import { Option, Schema } from 'effect'

export interface RemoteError {
  readonly _tag: string
  readonly message: string
}

export type RemoteData<A> =
  | { readonly _tag: 'Initial' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly value: A }
  | { readonly _tag: 'Refreshing'; readonly value: A }
  | { readonly _tag: 'Failed'; readonly error: RemoteError; readonly previous?: A }
  | { readonly _tag: 'NotFound' }

export const remoteErrorSchema = Schema.Struct({ _tag: Schema.String, message: Schema.String })

/** A `RemoteData` schema, so a projection that reads remote state is typed. */
export const remoteDataSchema = <A>(value: Schema.Schema<A>): Schema.Schema<RemoteData<A>> =>
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literal('Initial') }),
    Schema.Struct({ _tag: Schema.Literal('Loading') }),
    Schema.Struct({ _tag: Schema.Literal('Ready'), value }),
    Schema.Struct({ _tag: Schema.Literal('Refreshing'), value }),
    Schema.Struct({
      _tag: Schema.Literal('Failed'),
      error: remoteErrorSchema,
      previous: Schema.optional(value),
    }),
    Schema.Struct({ _tag: Schema.Literal('NotFound') }),
  ]) as unknown as Schema.Schema<RemoteData<A>>

export const RemoteData = {
  /**
   * The `RemoteData` schema for a value schema. Exposed so a `RemoteData` can
   * be embedded in a hand-written Model schema, not only through `Remote.select`.
   */
  schema: <A>(value: Schema.Schema<A>): Schema.Schema<RemoteData<A>> => remoteDataSchema(value),

  /** Exhaustive: omitting a state is a compile error. */
  match: <A, R>(
    data: RemoteData<A>,
    cases: {
      readonly Initial: () => R
      readonly Loading: () => R
      readonly Ready: (value: A) => R
      readonly Refreshing: (value: A) => R
      readonly Failed: (error: RemoteError, previous: Option.Option<A>) => R
      readonly NotFound: () => R
    },
  ): R => {
    switch (data._tag) {
      case 'Initial':
        return cases.Initial()
      case 'Loading':
        return cases.Loading()
      case 'Ready':
        return cases.Ready(data.value)
      case 'Refreshing':
        return cases.Refreshing(data.value)
      case 'Failed':
        return cases.Failed(
          data.error,
          data.previous === undefined ? Option.none() : Option.some(data.previous),
        )
      case 'NotFound':
        return cases.NotFound()
    }
  },

  map: <A, B>(data: RemoteData<A>, f: (value: A) => B): RemoteData<B> => {
    switch (data._tag) {
      case 'Ready':
        return { _tag: 'Ready', value: f(data.value) }
      case 'Refreshing':
        return { _tag: 'Refreshing', value: f(data.value) }
      case 'Failed':
        return data.previous === undefined
          ? { _tag: 'Failed', error: data.error }
          : { _tag: 'Failed', error: data.error, previous: f(data.previous) }
      default:
        return data
    }
  },
}
