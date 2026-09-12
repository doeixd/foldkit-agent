# Releases

What each workspace package is, what version it declares, and whether it ships
to npm. Versions are read from each `packages/*/package.json`; the published
column matches what the npm registry served when this was written.

## Package matrix

| Package | Version | Status | Role |
| --- | --- | --- | --- |
| [`foldkit-agent`](../packages/agent) | 0.1.0 | Published | Protocol-neutral agent contract: projects a Model and Message union into an agent interface. |
| [`foldkit-agent-webmcp`](../packages/agent-webmcp) | 0.1.0 | Published | Browser WebMCP adapter; projects exposed Messages into `document.modelContext`. |
| [`foldkit-agent-mcp`](../packages/agent-mcp) | 0.1.0 | Published | External MCP adapter: a transport-free handler plus stdio and Streamable HTTP. |
| [`foldkit-agent-a2a`](../packages/agent-a2a) | 0.1.0 | Published | A2A adapter: an Agent Card and `message/send` as tasks. |
| [`foldkit-agent-native`](../packages/agent-native) | 0.1.0 | Ready, not on npm | Agent Native adapter: compiles exposed capabilities into framework actions whose `run` only dispatches. |
| [`foldkit-durable`](../packages/durable) | 0.1.1 | Published | Durable, ordered operation log on `effect/unstable/sql`, with snapshots, cursors, compaction, and an effect ledger. |
| [`foldkit-sync`](../packages/sync) | 0.2.0 | Published | Local-first replica: offline outbox, optimistic projection, reconciliation, presence, and a reconnecting WebSocket transport. |
| [`foldkit-surface`](../packages/surface) | 0.0.0 | Private | Observation boundary: pure Model projections, field references, and typed Message subsets. |
| [`foldkit-remote`](../packages/remote) | 0.0.0 | Private | Normalized server state as a Foldkit Submodel: entities, selections, queries, connections, mutations, and live changes. |
| [`foldkit-remote-server`](../packages/remote-server) | 0.0.0 | Private | Server sources and handler compilation for Remote: entities, queries, mutations, live, and selection authorization. |
| [`foldkit-remote-drizzle`](../packages/remote-drizzle) | 0.0.0 | Private | Compiles Remote selections and queries to Drizzle's typed query graph. |
| [`foldkit-mixins`](../packages/mixins) | 0.0.0 | Private | Typed slot contracts and inside-out Style/Behavior attachments for Foldkit views. |
| [`foldkit-mixins-surface`](../packages/mixins-surface) | 0.0.0 | Private | Bridges a Surface projection and Message subset to a `SlotView`. |
| [`foldkit-mixins-ui`](../packages/mixins-ui) | 0.0.0 | Private | `@foldkit/ui` adapters that publish a component's attribute bundles as Slots. |

`Private` means the manifest sets `"private": true`, so `pnpm publish` skips it.
`foldkit-agent-native` is **not** private — it is staged to publish with the next
release — but no version is on npm yet.

## Publish process

- `pnpm release` runs `pnpm build`, then
  `pnpm -r --filter "./packages/*" publish --access public --no-git-checks`.
  Only the non-private packages above are candidates.
- Publishing must use **pnpm**, not npm. The agent adapters declare
  `foldkit-agent` as a `workspace:^` peer, and pnpm rewrites that to a real range
  (`^0.1.0`) as it packs; `npm publish` would ship the `workspace:` protocol
  verbatim.
- The [release workflow](../.github/workflows/release.yml) runs on a `v*` tag or
  a manual dispatch, re-runs `format:check`, `typecheck`, and `test`, and
  publishes with provenance only when the `NPM_TOKEN` secret is set. Without the
  secret it runs the checks and skips the publish step.
- Check the registry (`npm view <name> version`) before relying on what is live;
  the version column is the tree's declaration, not a release guarantee.

## Dependency expectations

Every package peer-depends on `effect@^4.0.0-rc.112`. Every package except the
server and storage four — `foldkit-remote-server`, `foldkit-remote-drizzle`,
`foldkit-durable`, and `foldkit-sync` — also peer-depends on `foldkit@^0.158.2`.

Peer edges between workspace packages, declared as `workspace:^` and rewritten on
publish:

- the four agent adapters (`foldkit-agent-webmcp`, `-mcp`, `-a2a`, `-native`) →
  `foldkit-agent`;
- `foldkit-mixins-surface` → `foldkit-mixins`, `foldkit-surface`;
- `foldkit-mixins-ui` → `foldkit-mixins`;
- `foldkit-agent-native` additionally → `@agent-native/core@0.177.1`;
- `foldkit-mixins-ui` additionally → `@foldkit/ui@^0.158.2`.

Regular `dependencies` also cross into private packages:
`foldkit-agent`, `foldkit-remote`, and `foldkit-sync` depend on `foldkit-surface`
(`workspace:*`), `foldkit-remote-server` and `foldkit-remote-drizzle` depend on
`foldkit-remote`, and `foldkit-remote-drizzle` additionally depends on
`foldkit-remote-server` and `drizzle-orm@1.0.0-rc.4`. Because `foldkit-surface`
is private, that edge cannot resolve from npm until it is published; the live
`foldkit-agent@0.1.0` and `foldkit-sync@0.2.0` manifests do not list it.
`foldkit-durable` depends on `@effect/sql-sqlite-node@4.0.0-rc.112` and requires
Node 22 (`engines.node`).
