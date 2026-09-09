# Todo example

A worked example of `@foldkit/agent`: one state machine, driven by a human and
by an agent, exposed to a browser agent through WebMCP.

```bash
pnpm build   # the example imports the packages by their published entry points
pnpm demo
```

## What is here

| File | What it shows |
| --- | --- |
| [`src/app.ts`](./src/app.ts) | An ordinary Foldkit Model, Message union, and `update`. No agent code. |
| [`src/agent.ts`](./src/agent.ts) | The contract: what an agent may see, and what it may do. |
| [`src/store.ts`](./src/store.ts) | The host seam — how to wire the contract to a running app. |
| [`src/demo.ts`](./src/demo.ts) | The whole thing end to end, as an assertable transcript. |

## The host seam

This is the part you have to write yourself, and the reason it is spelled out
here. Foldkit `0.158.2` accepts no `agent` option on `makeApplication` and
exposes no Model or dispatch handle, so the application supplies both:

```ts
const agent = Agent.bind({
  definition: AppAgent,
  host: {
    model: () => currentModel,
    dispatch: message => sendIntoTheRuntime(message),
    subscribe: listener => onModelChange(listener), // optional
    principal: () => currentPrincipal,              // optional
  },
})
```

`src/store.ts` is a small loop over the same `update` the UI uses. In a real
application these two functions read and write the live Foldkit Runtime.

## What the demo walks through

1. **The contract is data.** `Agent.messages(AppAgent)` lists every capability
   with its name, tag, and description — no LLM involved.
2. **One state machine.** A todo added from the UI shows up in the agent's
   projected context.
3. **The agent originates the same transition**, naming the capability by
   Message reference rather than by string.
4. **Availability follows the Model.** `delete_todo` does not exist until a todo
   is selected.
5. **Availability is not authorization.** With the capability available, a
   principal that may not delete is still refused, and no Message is dispatched.
6. **Through WebMCP.** The same contract registered as tools, with the input
   schema derived rather than written by hand.
7. **Registrations follow the Model.** Deleting the selected todo clears the
   selection in `update`, so `delete_todo` is unregistered.
8. **Untrusted input is refused** at the Schema boundary, before `update`.

## Notes

`update` here returns only the Model. A real Foldkit `update` returns Commands
alongside it; that difference does not touch the agent layer, which dispatches
Messages and lets `update` decide what they mean.

`RequestedCreateTodo` is written with the description shorthand, so its
capability name is the normalized tag, `requested_create_todo`. Variants that
want a shorter protocol name give one explicitly, as `delete_todo` does.
