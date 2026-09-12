# foldkit-remote example

The worked `foldkit-remote` → `foldkit-surface` → `foldkit-mixins` trace that the
[remote guide](../../docs/remote.md) points at. It runs the real path against an
in-process `RemoteClient` — no server, but plan, prefetch, select, render, mutate
and a decode failure all go through the real code.

```
pnpm --filter foldkit-remote-example demo
```

```
surface: ProjectPage
plan: Project:p1 [id,name,status]
before fetch: Initial
after fetch: Ready {"id":"p1","name":"Apollo","status":"active"}
query connection: Project:p1
inspect: 1 entities, 1 connection, 1 registered queries
rendered classes: project-card
rendered status: active
mutation RenameProject: output {"id":"p1"}
after mutation: Ready {"id":"p1","name":"Apollo II","status":"active"}
corrupt store: Failed DecodeError
```

Read it as:

- **`plan`** — the Surface's selection declares a requirement (`Project:p1`, the
  three fields it reads). The planner is pure; it is the only thing that decides
  what the client asks for.
- **`before fetch` / `after fetch`** — the projected field is a `RemoteData`:
  `Initial` until its fields are present, `Ready` once they are. Fetching is
  `Remote.prefetch` here; in an application it is the `Remote.observe`
  Subscription.
- **`query`** — `Remote.query(ref)` runs a list query and `Remote.queryMessage`
  merges the page into a connection keyed by the ref's identity.
- **`inspect`** — `Remote.inspect` summarizes the cache, and the domain's
  `registry` counts the declared queries.
- **render** — the SurfaceView styles the card and a Behavior reads the projected
  `RemoteData`, both over a Surface that only exposes `Ping`.
- **mutation** — `Remote.mutateInto` returns the typed `Output` and the new Model;
  the renamed field is visible through the same projection.
- **decode failure** — a stored value that does not match the Selection surfaces
  as `Failed`, not as an asserted value.

`test/demo.test.ts` asserts every line; the trace is mutation-verified.
