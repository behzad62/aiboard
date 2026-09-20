# Inspection evidence and limitations

Method: read-only repository inspection and uncommitted-diff review; primary OS documentation. No implementation tests, benchmark, build, CI dispatch, destructive process control, commit or product edit was performed. Planning files are the only new repository changes.

Base/source/dirty identities are authoritative in baseline.json. Current gate status is `docs/runner-v2/task-12-status.md`, not the older ignored plans' historical checkpoints.

Cursor audit: session `5c9589a8-0d26-427a-a64f-6c606cc18b3a`, CLI `2026.09.18-9a7762b`, read-only Ask mode, successful exit. Ask mode refused shell use, so its assertions about uncommitted provenance were provisional. Codex reviewed the actual Git diff and critical code independently. The machine-local original report is `C:/Users/b_a_s/.codex/tmp/runner-v2-architecture-20260919/cursor-code-audit.json`; the durable extracted audit is cursor-code-audit.md. Its recommendations are evidence, not authority.

| Finding | Inspected repository evidence | Disposition |
|---|---|---|
| Broad flat capability contract | `runner-v2/src/execution-safety-contracts.ts:4`, `process-backend.ts:342` | Version scope; do not silently reinterpret old names |
| POSIX overclaim | `runner-v2/src/posix-process-backend.ts:19` | Group termination/emptiness only |
| Four families and internal kernel request the same strong names | `one-shot-command-executor.ts:163`, `execution-host-managed-transport.ts:99`, `execution-host-mcp-transport.ts:56`, `execution-host-lsp-transport.ts:61`, `runner-internal-process-kernel.ts:115` | Central trusted policy; preserve grant binding |
| Full bypass; restricted exact-grant isolation | `execution-isolation-provider.ts:344` and `qualifies`; `docs/runner-v2/security.md` | Preserve security boundary; add explicit full+contained configured route |
| OCI per-invocation lease/container and exact force removal | `oci-execution-isolation-provider.ts:380`, `:516`; `execution-host-streaming.ts:141` | Keep composition; test attach versus container cleanup separately |
| Escape experiment adds PPID census and per-PID signals | Actual diff of `portable-process-posix-control.*`, `portable-process-supervisor.mjs`; new closure test in `posix-process-backend.test.ts` | Remove only those hunks after adoption; preserve old group proofs |
| Claimed Docker/MCP failure includes native invocation | `test/mcp-tools.test.ts:790`, `ownedManager` at `:1360` (`permissionProfile: full`); `test/fixtures/mcp-descendant-server.mjs:13` | Test lane label does not identify the actual execution provider |
| Non-Linux birth witness has precision limits | `portable-process-posix-control.mjs:34` uses `ps ... lstart`; Task 12 status notes limitation | Never make timestamp alone a safe-recovery guarantee |
| Cleanup resources have distinct ordering | `execution-host-streaming.ts:383`, `streaming-process-session-runtime.ts:290` and `:326` | Audit container retirement/output dependency; no observed runtime defect claimed |
| Dirty tree mixes unrelated repairs | Nine-file actual diff, especially recovery smoke, late-birth fixture and qualification workflow | Classify per hunk; preserve before editing; guards need derived budgets |
| Original mandatory portable baseline / optional Job and final negative proofs | Original portable plan doctrine + Tasks 5/12, canonical P6 HVI-6A.4–8, cleanup specification retained constraints | Explicit source conflict/amendment and retained final gates; no silent denominator change |

Controller disagrees with Cursor's suggestion to keep the old broad capability names and simply document weaker native meanings: old requests/records would remain ambiguous. The decision uses a versioned descriptor and conservative compatibility instead. Cursor's shorthand “A–F PASS” is qualified by the actual Gate D Darwin follow-up. The audit is not test evidence.

Primary external references used: Node child-process detached semantics; Microsoft Job Objects (including breakaway/security/service-creation limits); Linux cgroup v2 kill/population/delegation; systemd delegation; Apple setsid. Direct source links appear adjacent to claims in DECISION.md. Provider recommendations are architectural judgments based on those primitives and inspected code, not a guarantee that an untested host qualifies.
