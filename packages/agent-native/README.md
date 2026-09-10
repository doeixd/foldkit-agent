# `foldkit-agent-native` — prototype

Compiles a [`foldkit-agent`](../agent) contract into Agent Native actions.

**This is an unpublished prototype**, checked against `@agent-native/core@0.177.1`.
The integration suite uses the real package registry, tool runtime, and schema
wrapper. Full HTTP/MCP/A2A deployments remain outside this spike.

## What it does

```ts
import { AgentNative } from 'foldkit-agent-native'
import { registerPackageActions } from '@agent-native/core/server'

registerPackageActions(
  AgentNative.actions({
    definition: AppAgent,
    resolveRuntime: ctx => runtimeFor(ctx),
  }),
)
```

One exposed capability becomes one entry, keyed by capability name, with its
description, advertised parameters and schema taken from the contract. Each
entry states `http: POST`, `requiresAuth: true`, and `readOnly: false` — a
capability dispatches a Message, so it is a write, and claiming otherwise would
let plan mode run it for real.

Nothing is written to disk. A registry has no file to go stale, so a removed
capability cannot leave behind an action that is still callable.

`resolveRuntime` is called **per invocation**, not once at registration, because
which Model a caller means depends on who is calling. The Runtime it returns must
already be bound for that caller: when a contract declares `authorize`,
`Agent.bind` requires a `principal` provider, so the identity mapping stays with
the application rather than being guessed from `userEmail`.

## The dependency direction

Foldkit stays the source of truth. A generated `run` **only dispatches** —
application behaviour stays in `update`, which is the entire reason for
generating these rather than writing a second action layer beside the state
machine.

The action layer adds no authority of its own either. Availability,
authorization and input validation all still happen in the contract, and the
tests assert that an action refuses exactly what the contract refuses.

## The schema bridge

The adapter exposes the encoded input schema as a Standard Schema validator,
rejecting undeclared fields. It preserves encoded values for `dispatchUnknown`
to decode once, including transforming schemas such as `NumberFromString`.

The subtlety is which conversion, and it fails silently:

| | `validate` | advertised parameters |
| --- | --- | --- |
| `toStandardSchemaV1` | yes | **empty** |
| `toStandardJSONSchemaV1` | no | full |
| the two copied together | yes | **empty** |
| both, called in turn on the same schema | yes | full |

All four are accepted without complaint, and three produce a tool an agent sees
as taking no input. Copying fails because the conversion reads the Effect schema
itself, so identity has to survive — and both helpers return that same schema,
sharing one `~standard`, so calling them in turn leaves a single object carrying
`jsonSchema` and `validate` alike. That is what this package does.

## What the spike proves

Run `pnpm exec vitest run packages/agent-native/test/framework.test.ts` at the
repository root. No LLM credentials, database, or network server are needed.

| Framework surface | Executable evidence |
| --- | --- |
| Package registry | `registerPackageActions` + `autoDiscoverActions` discovers the adapter entry. An actual app-local action file wins a name collision. |
| Agent tool runtime | `actionsToEngineTools` advertises the encoded schema; `executeAgentToolCall` changes the Foldkit Model for an authorized caller and refuses another caller. |
| Schema wrapper | `defineAction` derives parameters, preserves transforming input for one decode in Foldkit, and rejects extra fields. |

The framework is a development dependency and a pinned peer of this adapter.
It is not a dependency of `foldkit-agent`. The public adapter types are checked
against the real `ActionTool` type; only object input schemas are supported,
because the framework omits other input shapes from its tool list.

## Limits and reuse decision

The registry and agent tool runtime can be reused without replacing Foldkit's
state machine. HTTP, MCP, A2A, CLI, UI queries, auth sessions, and deep links
still need their framework host and deployment wiring; this suite does not
claim an end-to-end test of those surfaces. Keep the independent MCP/A2A
adapters and direct WebMCP adapter.

The registry is static: it describes all declared capabilities, while Foldkit
checks availability at invocation time. The application maps a verified caller
to a principal when binding a server-held Runtime. Page-local state still belongs
to WebMCP; no browser RPC bridge is introduced.

The framework's package registry retains the first registration of a name and
skips names inherited from `Object.prototype`, including `__proto__`. Avoid
those names and restart the host after changing a registered contract. The
adapter's own returned record preserves these keys, but cannot fix that
downstream registry behavior.

The package stays private pending a deployment test. This completes the bounded
proof of concept in [issue #22](https://github.com/doeixd/foldkit-agent/issues/22),
not a claim that every Agent Native subsystem is independently reusable.
