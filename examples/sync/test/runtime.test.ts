// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { Message } from '../src/app.js'
import { indexedDb } from '../src/indexedDb.js'
import { mountReplica } from '../src/runtime.js'
import { openReplica } from '../src/replica.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('runs the wrapped Foldkit application and renders durable changes only after storage commits', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  )
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const storage = await indexedDb('runtime', new IDBFactory())
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const replica = await openReplica('todos', 'a', {
    ...storage,
    save: async (state, revision) => {
      if (revision !== null) await held
      await storage.save(state, revision)
    },
  })
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
    expect(replica.pending()).toHaveLength(1)
  } finally {
    release()
    runtime.dispose()
    await replica.close()
    container.remove()
  }
})
