import { Message } from './app.js'
import { indexedDb } from './indexedDb.js'
import { openReplica } from './replica.js'
import { mountReplica } from './runtime.js'

const replica = await openReplica('todos', 'browser', await indexedDb('foldkit-sync-spike'))
const runtime = mountReplica(replica, document.querySelector<HTMLElement>('#sync-app')!)
document.querySelector<HTMLFormElement>('#create')!.addEventListener('submit', event => {
  event.preventDefault()
  const input = document.querySelector<HTMLInputElement>('#title')!
  runtime.send(Message.CreatedTodo({ id: crypto.randomUUID(), title: input.value }))
  input.value = ''
})
document.querySelector('#select')!.addEventListener('click', () => {
  const first = replica.shared().todos[0]
  if (first) runtime.send(Message.SelectedTodo({ id: first.id }))
})
