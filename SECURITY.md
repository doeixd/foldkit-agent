# Security

## Reporting a vulnerability

Use a private GitHub security advisory
(<https://github.com/doeixd/foldkit-plus/security/advisories/new>), or email the
maintainer, rather than opening a public issue. Include the affected package and
version, a minimal reproduction, and the impact.

## What the project guarantees

`foldkit-agent` treats everything an agent supplies as untrusted. The invariants
that matter, and where they live:

- agent-facing input crosses an Effect `Schema` boundary before dispatch, with
  excess properties rejected;
- `available` is checked before `authorize`, and both before dispatch, so an
  unavailable capability never leaks whether the caller would have been
  permitted;
- the principal comes from the authenticated transport, never from request
  parameters;
- adapters never reach past `AgentRuntime` into `update`;
- MCP over HTTP validates `Origin` and binds sessions to one principal.

`foldkit-durable` binds every SQL value as a parameter and validates the
operation codec at the storage boundary. `foldkit-sync` validates every
operation, presence value, and committed operation it receives, and rejects
excess properties. `serveSocket` validates an untrusted frame before application
code sees it.

Backend/domain authorization remains authoritative; the agent layer supplements
it rather than replacing it.
