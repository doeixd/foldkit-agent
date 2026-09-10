// @vitest-environment jsdom
import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { Message } from '../src/app.js'
import { mountReplica } from '../src/runtime.js'
import { Sync } from '../src/sync.js'
import { closeStorages, openStorage } from './helpers.js'

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeStorages()
})

it('runs the wrapped Foldkit application and renders durable changes only after storage commits', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const storage = await Effect.runPromise(openStorage('runtime', new IDBFactory()))
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const replica = await Effect.runPromise(
    Sync.openReplica('a', {
      ...storage,
      save: (state, revision) =>
        Effect.gen(function* () {
          if (revision !== null) yield* Effect.promise(() => held)
          yield* storage.save(state, revision)
        }),
    }),
  )
  const container = document.createElement('div')
  container.id = 'sync-runtime'
  document.body.appendChild(container)
  const runtime = mountReplica(replica, container)
  try {
    runtime.send(Message.CreatedTodo({ id: 'a', title: 'Persisted first' }))
    runtime.send(Message.SelectedTodo({ id: 'a' }))
    await vi.waitFor(() => expect(document.body.textContent).toContain('Selection: a'))
    expect(document.body.textContent).not.toContain('Persisted first')
    release()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Persisted first'))
    expect(document.body.textContent).toContain('Selection: a')
    expect(Effect.runSync(replica.pending)).toHaveLength(1)
  } finally {
    release()
    runtime.dispose()
    await Effect.runPromise(replica.close)
    container.remove()
  }
})
