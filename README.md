# foldkit-plus

[![CI](https://github.com/doeixd/foldkit-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/doeixd/foldkit-plus/actions/workflows/ci.yml)

> A home for Foldkit ecosystem packages, built on Foldkit's
> Model-·-Message-·-`update` architecture and Effect.

Foldkit keeps an application's behavior in one place: a Schema-typed **Model**, a
**Message** union, and an **`update`** function. Everything here extends that one
state machine rather than introducing a second place for application behavior to
live — an agent contract projected from the same Model and Messages, and a
durable log that replicates the same Messages.

## Packages

| Package | What it is |
| --- | --- |
| [`foldkit-agent`](./packages/agent) | The protocol-neutral agent contract: project a Model and Message union into a deliberate agent interface. [Design rationale](./packages/agent/DESIGN.md). |
| [`foldkit-agent-webmcp`](./packages/agent-webmcp) | The browser adapter, projecting exposed Messages into `document.modelContext`. |
| [`foldkit-agent-mcp`](./packages/agent-mcp) | The external MCP adapter: a transport-free protocol handler, plus stdio and Streamable HTTP. |
| [`foldkit-agent-a2a`](./packages/agent-a2a) | The A2A adapter: an Agent Card and `message/send` as tasks. |
| [`foldkit-durable`](./packages/durable) | A durable, ordered operation log on `effect/unstable/sql`, with migrations, compaction, change streams, a durable effect ledger, and metrics. |
| [`foldkit-sync`](./packages/sync) | A local-first replica: offline outbox, optimistic projection, reconciliation, presence, and a reconnecting WebSocket transport. |

`packages/agent-native` is a private prototype and is not published.

## Install

```bash
pnpm add foldkit-agent                       # the contract
pnpm add foldkit-agent foldkit-agent-webmcp  # browser (WebMCP)
pnpm add foldkit-agent foldkit-agent-mcp     # external MCP
pnpm add foldkit-agent foldkit-agent-a2a     # A2A
pnpm add foldkit-durable foldkit-sync        # offline, multiplayer, remote-agent state
```

`foldkit` and `effect` are peer dependencies. Foldkit `0.158.2` peer-depends on
`effect@4.0.0-rc.112`, so these packages target Effect 4. `foldkit-durable`
requires Node 22 for `node:sqlite`.

## How they fit together

```text
                  Foldkit application
          Model · Message · update · Commands
                      │             │
        project/expose│             │replicate
                      ▼             ▼
               foldkit-agent   foldkit-durable
                      │             │
          ┌───────────┼──────┐      └── foldkit-sync
          ▼           ▼      ▼          (local replica)
        webmcp       mcp     a2a
```

The agent contract projects *what an agent may see and do* from the application;
the durable log orders and persists *the same Messages* so replicas converge.
Neither reimplements `update`.

Each package has its own README for its API. `foldkit-agent` also has a long
[design rationale](./packages/agent/DESIGN.md).

## Repository layout

```text
packages/agent          foldkit-agent
packages/agent-webmcp   foldkit-agent-webmcp
packages/agent-mcp      foldkit-agent-mcp
packages/agent-a2a      foldkit-agent-a2a
packages/agent-native   foldkit-agent-native (prototype, private)
packages/durable        foldkit-durable
packages/sync           foldkit-sync
examples/todo           a worked example, end to end
examples/sync           durable messages and ordered replication
```

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc -b
pnpm build       # tsdown
pnpm demo        # run the todo and sync examples
pnpm pack:check  # verify every package packs
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the checks before a commit, and
[AGENTS.md](./AGENTS.md) for the working agreements.

## Releasing

`v0.1.0` is published. `pnpm release` builds, then publishes every non-private
package. Publishing must use **pnpm**, not npm: the adapters declare
`foldkit-agent` as a `workspace:^` peer dependency, which pnpm rewrites to a real
range (`^0.1.0`) when it packs.

Bump the versions, add a [CHANGELOG.md](./CHANGELOG.md) entry, run the four
checks, then push a `vX.Y.Z` tag. The
[release workflow](./.github/workflows/release.yml) re-runs the checks. It
publishes with provenance when the `NPM_TOKEN` repository secret is set, and
otherwise runs the checks and skips publishing.
`foldkit-agent-native` is `private`, so it is skipped.

## License

MIT. These are community packages, published unscoped as Foldkit itself is. They
are not affiliated with or endorsed by the Foldkit maintainers, and the names are
theirs for the asking.

## References

- Foldkit — <https://foldkit.dev/> · <https://github.com/foldkit/foldkit>
- WebMCP — <https://github.com/webmachinelearning/webmcp>
- Agent Native — <https://github.com/BuilderIO/agent-native>
