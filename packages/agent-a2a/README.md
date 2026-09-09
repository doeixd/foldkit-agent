# `@foldkit/agent-a2a`

Serves a [`@foldkit/agent`](../agent) contract as an A2A agent, so another agent
can use the capabilities an application already exposes.

```bash
pnpm add @foldkit/agent @foldkit/agent-a2a
```

## The Agent Card

One exposed capability is one skill:

```ts
import { AgentA2a } from '@foldkit/agent-a2a'

const card = AgentA2a.agentCard(AppAgent, {
  name: 'Todos',
  description: 'A todo list',
  url: 'https://todos.example/a2a',
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  security: [{ bearer: [] }],
})
```

Serve it from `AgentA2a.AGENT_CARD_PATH` (`/.well-known/agent-card.json`).

A card is static while availability is not, so a capability that only exists in
some Model states is tagged `conditional`, and one that runs an authorization
check is tagged `authorized`. Both can still refuse at call time.

## Calling a skill

```ts
const served = AgentA2a.handler({ agent: agentRuntime })

await served.handle({
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      role: 'user',
      messageId: 'm-1',
      parts: [{ kind: 'data', data: { skill: 'delete_todo', input: { id: 'todo-1' } } }],
    },
  },
})
```

`tasks/get` fetches a task afterwards and `tasks/cancel` aborts one still
running. Tasks are held in a bounded buffer.

## Task states

The distinction that matters is **rejected** versus **failed**:

| Outcome | State |
| --- | --- |
| Unknown skill, input that fails the schema, a caller who may not | `rejected` |
| A declared failure Message, or a completion that timed out | `failed` |
| The invocation was cancelled | `canceled` |
| Dispatched, or completed by its success Message | `completed` |

`rejected` means the agent declined the request; `failed` means it accepted the
work and the work did not succeed. A client decides what to do next from that
difference, so collapsing them would be a bug.

A capability with no completion contract finishes at validated dispatch, so its
task is `completed` immediately. One that declares completion finishes when its
Message arrives — which is why completion tracking had to come first.

## Not implemented

`streaming` and `pushNotifications` are declared `false` on the card, and
`message/stream` is refused rather than answered with something a client cannot
consume. Multi-turn conversations, `input-required`, `auth-required`, file parts
and artifacts are also out of scope for now.
