# Runner V2 MCP servers

## Configuration

Register an executable and its literal arguments with the repeatable `--mcp name=command` option. The command is parsed without a shell. Quote an entire argument containing spaces. Shell pipelines, redirection, command substitution, environment-assignment prefixes and ambiguous quotation are rejected. Shell scripts or package-manager batch launchers require an explicit supported executable; there is no implicit shell fallback.

A legacy registration grants no additional filesystem paths, network access or credentials. Use a matching `--mcp-envelope name=JSON` declaration for a fixed access envelope. Declaration order does not matter; duplicate names, duplicate declarations, unknown servers and unsupported fields are rejected.

For example, from PowerShell:

```powershell
npm run runner:v2 -- --project C:\project --state-dir C:\runner-state `
  --mcp 'docs=node "C:\tools\docs-server.mjs"' `
  --mcp-envelope 'docs={"paths":[{"path":".","mode":"read"}],"network":false}'
```

Paths are resolved relative to the configured project directory, not from tool arguments. Modes are `read` or `write`. Network permission defaults to false. Credential names can be declared, but the current host has no configured MCP credential resolver: a server requiring them is refused rather than inheriting secrets or silently omitting its requirement. This is a fixed declared envelope, not a request to combine the permissions of unrelated calls.

## Discovery and live ownership

CLI startup validates and attests configuration without starting a live MCP server. Build initialization performs temporary per-run discovery using a closed Runner-internal identity. Discovery initializes the protocol, lists tools, records executable/configuration/schema digests, and verifies that its owned process tree is closed.

`ready` means configured, attested, discovered and available; it does not mean an idle process is running. The first authorized tool call lazily starts the server for that exact run, actor, agent session, server and immutable envelope. The launching call's grant authorizes its first application request. Each later request needs a fresh ToolBroker grant matching that owner and contained by the adopted envelope. Public tool approval and artifact-backed output semantics remain in effect.

The executable's pinned absolute path and fresh content hash are checked before live acquisition. It is not resolved again through PATH. A live handshake must match the discovered tool schema. Replacing configuration or executable identity requires fresh discovery; a schema-change notification invalidates existing server sessions. Already-pending notifications are handled under the next actual call's authority before another external request is written.

## Limits and failure behavior

The default request deadline is 120 seconds. Protocol frames are limited to 1 MiB, discovery to 1,024 tools, configuration to 128 servers, and fixed envelopes to 64 paths and 64 credential names. The manager defaults to 128 live identity slots and two restarts after the initial launch; no more than 64 calls wait in a single session queue. Restart is attempted only by a later fresh call, never by replaying the failed call.

Partial and coalesced newline frames are parsed with strict UTF-8, exact request IDs and bounded storage. Writes are backpressured through the shared streaming owner. A reply alone is not treated as proof that its request write acknowledged. Interrupted writes, uncertain acknowledgement, cancellation or loss of an active session preserve an unknown outcome; the external call is not replayed. A queued call cancelled before writing remains not sent.

Agent and run termination join owned cleanup. Shutdown first requests EOF and joins the input acknowledgement, then uses shared escalation and exact process-tree emptiness verification. Discovery close also joins an in-flight process acquisition, so a late-returned child cannot escape cleanup. Cleanup failure is retained as a blocker with evidence, not reported as a clean close. Startup recovery can observe or clean an existing owned child; it cannot relaunch it using historical grants.

Isolation is provider-specific. Strict profiles refuse execution when the required provider guarantees are unavailable. Full mode explicitly allows unconfined execution and must not be represented as universal filesystem, network or credential isolation. The fixed envelope is an authorization contract; it does not manufacture operating-system guarantees that the selected provider lacks.
