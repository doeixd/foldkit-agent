# Binding `foldkit-sync` to a Foldkit runtime

Status: `Sync.mount` ships in `foldkit-sync`; `examples/sync` runs on it. No
upstream Foldkit change is required. This note records why, what the mount does,
and the two conveniences an upstream handle would still add.

## What Foldkit `0.158.2` exposes

Verified against the installed `foldkit/dist/runtime` declarations.

- `Runtime.makeApplication(config)` returns a configured, not started, runtime.
  `Runtime.embed(program)` returns `{ ports, dispose }`. There is no Model getter
  and no `dispatch` on the handle; inbound Ports are the only way in.
- `config.update` is synchronous: `(model, message) => { model, commands? }`.
- The container element must have an `id`; without one the runtime never starts
  and reports nothing. `Sync.mount` throws up front instead.

## Why the wrapper is enough

An earlier version of this note argued that a wrapper cannot be transparent
because a durable Message had to wait for persistence before it applied, so the
wrapper returned the Model unchanged, persisted in a Command, and re-dispatched a
refresh later. That argument depended on not trusting the local `update` to
match what the replica replays.

The derived replay now *is* the application's `update` on the shared slice, and
it refuses a durable Message that returns a Command or writes outside the
projection. So applying `update` at once is exactly what the replica will hold
after `submit`; there is nothing to wait for. Persist afterwards, and reconcile
only when the replica's state actually differs from the local one.

## What `Sync.mount` does

```ts
const mounted = Sync.mount(App, TodoSync, { replica, container, view })
mounted.dispatch(Message.CreatedTodo({ id, title }))
mounted.model()
await mounted.dispose()
```

- **Apply first, persist after.** A durable Message runs `update` immediately and
  adds one Command that calls `replica.submit`. A refused or failed persist
  re-installs the replica's shared slice, which reverts exactly that edit, then
  hands the Model and the error to `onPersistenceFailure`.
- **Flat union.** The runtime's Message type is the application's union plus
  three private variants (refresh, persisted, persistence failed), so Commands
  returned by `update` already produce valid Messages. Nothing is re-wrapped.
- **Reconcile on change.** The replica's `statusChanges` drive a refresh only
  when the cursor or the rejections move, which is when an exchange or a
  rejection changed the replica's state. A submit only echoes a local edit, so it
  does not refresh; refreshing on it would briefly revert a later local edit
  whose own submit is still in flight.
- **Dispatch and Model.** `dispatch` is one inbound Port carrying the whole
  union. `model()` is read from a subscription entry whose `modelToDependencies`
  runs on every transition; the runtime does not expose the Model otherwise.
- **Dispose waits.** In-flight persists are tracked and awaited before the
  runtime is disposed, so the outbox is left complete and resumable.

`Mounted` is also the host shape `foldkit-agent` binds to: `model` and
`dispatch`.

## What only an upstream handle would add

- `handle.model()`, replacing the subscription stash.
- `handle.dispatch(message)`, replacing the declared Port.

Both are conveniences. Nothing in the acceptance list below depends on them.

## Acceptance

Covered by `packages/sync/test/mount.test.ts` unless noted.

- Failed persistence does not lose the local edit silently: the edit is reverted
  and reported. ✔
- A Command from `update` settles into a durable fact through the same reducer. ✔
- A local edit concurrent with an exchange rebases in the replica; the mount
  installs the rebased slice when the cursor moves. ✔ (exchange) / rebase is the
  replica's own test.
- A rejected operation is reverted. ✔
- A checkpoint installs without resubmitting pending operations: the replica's
  own test; the mount sees it as a cursor move.
- Disposal with pending work completes it. ✔
- Two bound instances of one document do not interleave admittances: not
  supported; one mount per replica.
