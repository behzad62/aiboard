# Task 8 specification review — round 1

Verdict: **NOT APPROVED**

The first Task 8 brief covered the canonical families but was not executable.
The reviewer identified these load-bearing specification gaps:

- terminal one-call grants conflicted with persistent child ownership;
- no nonblocking durable duplex session state machine/backend channel SPI existed;
- CLI Git/MCP and per-run LSP construction order was circular;
- migrating the managed facade would recurse through the Windows Job backend;
- strict OCI had no attested interactive stdin path;
- MCP authority, attestation, framing, restart, and shutdown controls were
  underspecified and partly described as existing when they are new;
- exact LSP call authority did not propagate from code/filesystem tools;
- static guard, schema downgrade, rollback, and crash/write/transfer faults were
  incomplete.

Required resolution: a CLI-owned host kernel with isolated per-run bindings; a
durable immutable SessionAuthority transfer; a separate versioned streaming
session store/runtime and optional interactive backend capability; mandatory
low-level Job-host extraction; explicit MCP discovery/live-call lifecycle;
strict OCI interactive attestation; complete LSP context propagation and batch
compatibility; managed startup adoption/portable facade; and expanded whole-tree
guard/fault/rollback requirements.

The defects were technically repairable and required no user decision. The
brief was amended and must pass scoped re-review before implementation.
