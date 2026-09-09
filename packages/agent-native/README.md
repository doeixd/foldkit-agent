# `foldkit-agent-native` — prototype

Compiles a [`foldkit-agent`](../agent) contract into Agent Native actions.

**This is a prototype.** It is not published, and it has never run against Agent
Native itself — only against a stub with the shape the framework's documentation
describes. Read the limits at the bottom before relying on it.

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

The framework's examples use Zod, but `defineAction` types its `schema` field as
`StandardSchemaV1` and validates through it. Effect Schema converts to one, so
there is no conversion layer and no Zod dependency.

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

## Limits

- **Never run against the framework.** Everything here is verified against a
  stub.
- **Only partly verified.** Against the published `@agent-native/core@0.177.1`:
  the imports resolve, `registerPackageActions` accepts what this produces, and
  `defineAction` accepts an Effect-derived Standard Schema and derives its
  parameters from it. What is **not** verified is whether every surface — in-app
  assistant, MCP, A2A, HTTP, CLI — reads the package registry, and whether
  app-local actions win a collision in a running app.
- Agent Native assumes Postgres, Nitro and React. None of that is exercised.
- No HTTP method configuration, no `useActionQuery`, no UI, no deep links.
- The private package flag is deliberate: this should not be published until it
  has been run against the real thing.
