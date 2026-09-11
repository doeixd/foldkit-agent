# foldkit-mixins example

A worked trace of the `foldkit-surface` → `foldkit-mixins` bridge. It defines a
`ProjectCard` Surface that projects only the fields it needs and exposes only two
of the application's Messages, then styles and decorates it with a `SlotView`.

```
pnpm --filter foldkit-mixins-example demo
```

The output is the point:

```
surface: ProjectCard
observes: project, selection
slots: root(Container), title(Container), status(Container), archive(Interactive)
mixins: ProjectCardStyle, ArchiveBehavior
projected: {"project":{"name":"Apollo","archived":true},"selection":"p1"}
root classes: card style-yow16s
root style: {"display":"grid","gap":"0.5rem"}
status classes: archived
archive aria-disabled: true
stylesheet: .style-yow16s:hover{box-shadow:0 1px 2px}
```

Read it as: the Surface decides what the card may observe (`project`,
`selection`) and emit; the SlotView decides where appearance and behavior attach;
`Style.whenInput` reads the projected input; and the Behavior reads the projected
input, not the root Model. The root-only `internalNotes` field never reaches the
renderer, and `DeleteProject` is not in the Surface's Message set, so a `toView`
cannot emit it.

`Style.pseudo(':hover', …)` compiles to one deterministic class
(`style-yow16s`) plus CSS text; `Style.stylesheet(ProjectCardStyle)` is the
`<style>` block the application would inject. The class is a hash of the rule, so
it is identical on the server and the client.

The demo then prints the serializable `SurfaceView.describe(...)` value and its
`toMarkdown` rendering — the same data DevTools or agent tooling would consume:

```md
# ProjectCard

## Observes

- `project`
- `selection`

## May emit

- `ArchiveProject`
- `SelectProject`

## Slots

- `root` — Container
- `archive` — Interactive (events: click)

## Mixins

- `ProjectCardStyle`
- `ArchiveBehavior`
```

`test/demo.test.ts` asserts every line, so the trace cannot silently drift.
