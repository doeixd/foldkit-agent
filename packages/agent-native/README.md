# `@foldkit/agent-native` — prototype

Compiles a [`@foldkit/agent`](../agent) contract into Agent Native actions.

**This is a prototype.** It is not published, and it has never run against Agent
Native itself — only against a stub with the shape the framework's documentation
describes. Read the limits at the bottom before relying on it.

## What it does

```ts
import { AgentNative } from '@foldkit/agent-native'
import { defineAction } from 'agent-native'

AgentNative.register({ agent: agentRuntime, defineAction })
```

One exposed capability becomes one action, with its description and schema taken
from the contract. Or take the actions and register them yourself:

```ts
for (const action of AgentNative.actions({ agent: agentRuntime })) {
  action.name // 'delete_todo'
  action.description // 'Delete the selected todo'
  action.schema // Standard Schema v1
  action.jsonSchema // the same schema as JSON Schema
  await action.run({ id: 'todo-1' })
}
```

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
`StandardSchemaV1` from `@standard-schema/spec` and validates through it. Effect
Schema converts to one, so there is no conversion layer and no Zod dependency.

`action.jsonSchema` is there for a consumer that would rather build its own
validator.

## Limits

- **Never run against the framework.** Everything here is verified against a
  stub.
- **`register` is close, but not the real extension point.** Beside file-based
  discovery, `@agent-native/core/server` exports `registerPackageActions`, which
  is how a published package contributes actions: they merge into the same
  registry every surface reads, and app-local actions win a name collision. That
  is what this should build on, so there is no generated file to go stale.
- Agent Native assumes Postgres, Nitro and React. None of that is exercised.
- No HTTP method configuration, no `useActionQuery`, no UI, no deep links.
- The private package flag is deliberate: this should not be published until it
  has been run against the real thing.
