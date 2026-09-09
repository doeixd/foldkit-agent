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

`defineAction` takes Zod; the contract holds Effect Schema. Rather than convert
between them, actions carry **Standard Schema v1**, which Effect and Zod both
implement, so a consumer that accepts the standard needs no conversion at all.

`action.jsonSchema` is there for a consumer that would rather build its own
validator.

## Limits

- **Never run against the framework.** Everything here is verified against a
  stub. If `defineAction` requires Zod's own API rather than Standard Schema, a
  wrapper is needed and this will not work as written.
- Agent Native assumes Postgres, Nitro and React. None of that is exercised.
- No HTTP method configuration, no `useActionQuery`, no UI, no deep links.
- The private package flag is deliberate: this should not be published until it
  has been run against the real thing.
