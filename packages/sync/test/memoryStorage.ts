import { Effect } from 'effect'
import type { Storage } from '../src/index.js'

/** An in-memory `Storage` for tests. */
export const memoryStorage = (): Storage => {
  let state: unknown
  return {
    load: () => Effect.sync(() => state),
    save: next =>
      Effect.sync(() => {
        state = structuredClone(next)
      }),
    close: Effect.void,
  }
}
