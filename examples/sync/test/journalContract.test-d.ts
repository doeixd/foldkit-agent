import { actorId, opId, type JournalOptions } from 'foldkit-durable'
import type { Operation } from 'foldkit-sync'
import type { Shared } from '../src/app.js'
import type { Principal } from '../src/journal.js'
import { Sync } from '../src/sync.js'

// The Sync journal contract must stay assignable to the durable journal's
// options. A renamed or missing field fails here, not only when the example runs.
const _options: JournalOptions<Operation, Shared, Principal> = {
  ...Sync.journalContract(),
  file: ':memory:',
  opId: operation => opId(operation.opId),
  actorId: principal => actorId(principal.actorId),
}
void _options
