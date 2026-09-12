# Remote example

A worked trace of `foldkit-remote` with `foldkit-surface` and `foldkit-mixins`:
one Surface selects a project out of the normalized cache, a `SurfaceView` renders
its `RemoteData` through a Style and a Behavior, and the demo runs the real path
against an in-process `RemoteClient`. No server is needed.

```bash
pnpm build   # the example imports the packages by their entry points
pnpm --filter foldkit-remote-example demo
```

`pnpm demo` at the repository root runs it with the other examples.

## What is here

| File | What it shows |
| --- | --- |
| [`src/demo.ts`](./src/demo.ts) | The whole trace: domain, Surface, plan, prefetch, select, render, mutate, decode failure. |
| [`src/main.ts`](./src/main.ts) | Prints the transcript. |
| [`test/demo.test.ts`](./test/demo.test.ts) | Asserts every line. |

## The trace

1. **Declare the domain.** `Project` is an entity, `ProjectSummary` a selection,
   `RenameProject` a mutation, and `Remote.make` returns the submodel the
   application embeds (`Data.Model`, `Data.initial`, `Data.update`, `Data.Message`).
2. **Project it.** `ProjectPage` is a `Surface.define` that selects the project
   with `Remote.select(AppRemote, ProjectSummary)(id)`, so its model is
   `RemoteData<ProjectSummary>`.
3. **Plan before fetching.** `Remote.planSurface` derives the requirement
   (`Project:p1 [id,name,status]`) and `Remote.read`/`projection.read` renders
   `Initial` — reading performs no I/O.
4. **Prefetch.** `Remote.prefetch` runs the plan through `RemoteClient` and returns
   a populated store; the projection now renders `Ready`.
5. **Render.** A `SurfaceView` binds the projected model and Message subset to a
   `SlotView`; a Style adds classes and a Behavior reads the `RemoteData` to set
   an attribute.
6. **Mutate.** `Remote.mutateInto` returns the typed output and the reconciled
   model; the projection renders the renamed value.
7. **Decode failure.** A corrupt store value that does not match the Selection
   renders `Failed` instead of being asserted into the projection's type.

## Notes

The `RemoteClient` here is a fake layer; a real application provides the Effect
RPC client layer. The example shows the cache-observation path, not a transport.
