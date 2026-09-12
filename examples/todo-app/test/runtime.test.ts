// @vitest-environment jsdom
import { Effect } from 'effect'
import { replicaId, type Storage } from 'foldkit-sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Message } from '../src/app.js'
import { mountApp } from '../src/runtime.js'
import { Sync } from '../src/sync.js'

/** A storage double, so the runtime can be mounted without IndexedDB. */
const memoryStorage = (): Storage => {
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the mounted app', () => {
  it('renders the shared slice and applies a durable todo through the replica', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)

    const container = document.createElement('div')
    // The runtime fails before rendering when its container has no id.
    container.id = 'todo-app-runtime'
    document.body.appendChild(container)

    const replica = await Effect.runPromise(Sync.openReplica(replicaId('test'), memoryStorage()))
    const mounted = mountApp(replica, container)
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain('0 active'))

      mounted.send(Message.SubmittedTodo({ id: 't1', title: 'From the UI' }))
      await vi.waitFor(() => expect(document.body.textContent).toContain('From the UI'))
      expect(document.body.textContent).toContain('1 active')
    } finally {
      mounted.dispose()
      await Effect.runPromise(replica.close)
      container.remove()
    }
  })
})
