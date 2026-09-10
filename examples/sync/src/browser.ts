import { Effect } from 'effect'
import { indexedDb } from 'foldkit-sync'
import { Message } from './app.js'
import { mountReplica } from './runtime.js'
import { Sync } from './sync.js'

const replica = await Effect.runPromise(
  Sync.openReplica('browser', await indexedDb('foldkit-sync-spike')),
)
const runtime = mountReplica(replica, document.querySelector<HTMLElement>('#sync-app')!)
document.querySelector<HTMLFormElement>('#create')!.addEventListener('submit', event => {
  event.preventDefault()
  const input = document.querySelector<HTMLInputElement>('#title')!
  runtime.send(Message.CreatedTodo({ id: crypto.randomUUID(), title: input.value }))
  input.value = ''
})
document.querySelector('#select')!.addEventListener('click', () => {
  const first = Effect.runSync(replica.shared).todos[0]
  if (first) runtime.send(Message.SelectedTodo({ id: first.id }))
})
