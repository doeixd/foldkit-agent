# Binding `foldkit-sync` to a Foldkit runtime

Status: design note, 2026-09-11. The supported state-only subset ships in
`examples/sync/src/runtime.ts`; transparent integration for an arbitrary Foldkit
application needs an upstream hook. This note records exactly which guarantees
are missing, so the subset is not mistaken for the general solution.

The goal is a synced application with **one reducer**: UI events, subscriptions,
Command-result Messages, agent submissions, and the replica's replay all flow
through the application's own `update`, with durable Messages persisted and the
shared projection installed without a second state loop.

## What Foldkit `0.158.2` exposes

Verified against the installed `foldkit/dist/runtime` declarations.

- `Runtime.makeApplication(config)` returns a `MakeRuntimeReturn`: a configured
  (not started) runtime with `runtimeId`, `start`/`startWith`, `ports`, `kind`,
  `isEmbedActive`, and `maybeActiveFiber`. It is **not** a live Model handle.
- `Runtime.embed(program)` returns an `EmbedHandle`: `{ ports, dispose }`.
  `dispose` is idempotent; it interrupts the runtime and runs Subscription,
  ManagedResource, Mount, listener, and in-flight Command cleanup, then clears
  the container.
- `config.update` is **synchronous**:
  `(model, message) => { model, commands? }`. The runtime applies the returned
  Model and runs the Commands after.
- `config.init`, `config.subscriptions`, `config.resources` (a `Layer`), and
  `config.managedResources` (model-driven acquire/release) are the only effect
  seams around the transition.
- Ports are the host boundary. An inbound `send(value)` decodes against the
  Port's Schema and returns `Exit<void, SchemaError>`; an outbound
  `subscribe(listener)` returns an unsubscribe. There is **no** `dispatch` on
  the handle and no Model getter.

## Why a wrapper is not transparent

`examples/sync/src/runtime.ts` wraps the application in a private `RuntimeMessage`
union (`ApplicationMessage | RefreshShared | PersistenceFailed`) and declares
inbound ports for it. That works for the state-only subset, at a cost:

1. **The durable transition is delayed, not admitted.** `update` cannot return an
   effect, so a durable Message returns the Model unchanged and a
   `PersistOperation` Command whose effect calls `replica.submit`. The visible
   change arrives only when that effect emits `RefreshShared`, which merges the
   replica's optimistic projection into the Model. Local Messages take a second
   path that calls the application `update` directly. The two paths must agree,
   and the first is not atomic with persistence.
2. **Every Command result must be re-wrapped.** A durable transition's Commands
   produce application Messages; each effect is mapped back into
   `RuntimeMessage.ApplicationMessage` by hand. A broad application must audit
   every Command for this, and a missed one is a Message that bypasses admission.
3. **Concurrent edits are not serialized against the exchange.** A local edit
   during an in-flight `synchronize` is resolved by the replica's rebase, but the
   runtime has no seam to order the UI transition against persistence.
4. **The host cannot read the live Model.** `MakeRuntimeReturn` exposes no Model,
   so a projection (agent context, DevTools, a server document) can only be read
   after a `RefreshShared` round trip, and a host cannot dispatch except through
   an inbound Port.
5. **`dispose` is unrelated to pending persistence.** `dispose` interrupts
   in-flight Commands, so a `replica.submit` started by a durable Message can be
   cut off. Ordering disposal against the outbox is the wrapper's problem.

None of these is a bug in Foldkit; they are the difference between "wrap the
ports" and "own the transition".

## The missing guarantee

Two hooks make the binding transparent; a third makes it ergonomic.

1. **Asynchronous, serialized admission before `update`.** A per-Message hook in
   which the runtime awaits a mount-provided effect (persist, authorize, order)
   *before* applying the transition, with overlapping admissions serialized. The
   mount decides whether the Message is durable; the runtime guarantees the
   ordering. This replaces the delayed `RefreshShared` round trip and makes the
   UI transition atomic with the durable enqueue.
2. **Install a shared projection without redispatching it.** After a commit,
   rebase, or checkpoint adoption, the mount must set the shared slice of the
   Model as a runtime action — not as an application Message. Without it, an
   install re-enters admission and looks like a fresh user edit (or, in the
   server document, a new operation).
3. **Optional: read the live Model and imperative `dispatch`.** A `model()`
   getter and a `dispatch(message)` on the handle (or the same admission hook
   exposed imperatively) let a host compute projections and submit agent
   Messages without declaring a Port per Message.

A minimal hook shape, to be refined against Foldkit's internals:

```ts
type Admission<Model, Message> = (request: {
  readonly model: Model
  readonly message: Message
  readonly origin: 'ui' | 'port' | 'command' | 'external'
}) => Effect.Effect<
  | { readonly _tag: 'Admit' }
  | { readonly _tag: 'Install'; readonly model: Model }, // projection install
  AdmissionError
>
```

`Admit` runs the application `update`; `Install` replaces the Model without a
transition. Both are serialized with other admissions, and disposal waits for the
in-flight admission (or cancels it explicitly).

## What can be supported today

Without the hook, a binding is honest only for a **state-only subset**:

- The application's durable Messages are identified by tag, and their effect on
  shared state is deterministic and mirrored by `replay`.
- A durable transition's optimistic result equals the replica's projection, so
  the delayed `RefreshShared` is only a latency, not a divergence.
- Commands produced by durable transitions are non-durable side effects and are
  routed back through admission deliberately.
- Disposal may interrupt an in-flight submit; the application tolerates a
  retried operation (the outbox is idempotent by `opId`).

The server-side document (a document already held on the server) is the cleaner
first target: it has no UI Command mapping and the journal is authoritative.

## Acceptance for a real binding

- Failed persistence does not apply a durable transition, or applies it and
  reports the failure without losing the local edit.
- A Message that completes synchronously does not lose its completion (subscribe
  before dispatch).
- A local edit concurrent with an exchange rebases, and an observer cannot
  mistake replayed history for fresh execution.
- A checkpoint installs without resubmitting pending operations.
- Two bound instances of one document do not interleave admittances.
- Disposal with pending work either completes or is explicitly abandoned, with
  the outbox left resumable.
