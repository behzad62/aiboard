# Task 8.3 LSP — approved P6 continuation

User authority: "Start and finish Task 8.3 LSP" following accepted Task8.2 commit ccbbb0ee. The existing original Task8.3 family packet is the requirements baseline; controller self-review is explicitly authorized instead of an independent reviewer. Do not repeat the architecture approval or reset earlier phase histories. Work only in the existing isolated codex/runner-v2-robust-build worktree, through Windows MCP.

Canonical requirements: .superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8-brief.md, Family packet8.3; approved portable-execution-safety plan. Task8.2 acceptance and historical cleanup exclusions remain intact. No later Task8.4 migration, product model calls, dependency/configuration/Node policy change, unsafe historical cleanup, account/tool configuration changes or remote publication.

## Ordered work / Definition of Done
1. [x] Trace and freeze actual LSP lifecycle, language callers/router/configuration and execution graph; preserve unrelated current files and staged/index state.
2. [x] Add internal exact language-invocation context from code-tool and filesystem diagnostics to configured provider only. Keep built-in/extension method APIs compatible and do not expose grants to extension providers. Agent/run termination joins only the exact configured LSP owners.
3. [x] Replace LspClient OS lifecycle with injected shared-session transport. Preserve Content-Length parsing, typed codes/retryability, document versions/reopen, diagnostics/stats/bounds and server control replies. Remove direct process creation/termination/bootstrap/environment fallback. No in-flight RPC replay after restart; only a later fresh call can restart.
4. [x] Add a distinct bounded language-request operation to the shared session seam for document notifications plus the requested RPC, with the same exact ToolBroker authorization rechecked at every effect. MCP single-write request invariants remain unchanged. Protocol-owned shutdown/exit uses narrowly bounded owned cleanup, not a fabricated model grant.
5. [x] Prepared central environment is injected into static executable discovery. Configured LSP preflight is static, not an eager unauthorized process. Each run/actor/agent-session/root/server has a fixed non-network, non-credential envelope; strict OCI fails typed before creation for a host-only command. Attested batch launch uses existing verified Job/argv backend only.
6. [x] Test-first causal RED/GREEN and material fault proofs; full LSP compatibility tests, code+filesystem authority tests, exact native Windows/eligible batch and strict-refusal tests, actual Linux portable contracts and relevant affected graph. Reserve full whole-P6 suite for its final exit. Final source-bound resource accounting, configured typecheck/full Runner lint, controller original-requirement audit, durable task gate/next-step records.

## Implementation boundaries

Keep existing LspClient protocol/document logic and inject a transport factory; no replacement private process manager. An optional internal language invocation parameter is forwarded by code/filesystem callers and router only to configured LSP. Other providers receive their original arguments. Configure a per-agent provider and use one compound language request to own document sync, protocol replies and the actual request; it is distinct from MCP's one-write request. Fresh grants authorize fresh calls; reopening documents after a new grant recreates protocol state, never replays the failed application request.

Protocol shutdown remains LSP-owned (shutdown response then exit). Shared runtime owns the bounded graceful I/O and exact quiescence/output/evidence/channel/backend/isolation conjunction. A caller timeout cannot certify an unresolved acquired resource or overlap its effects. Tests use retained capabilities and preserve uncertain roots; no PID-only fallback, broad temp scan or deletion.

Snapshots and before/after hashes bind all claims. A failed command, unavailable environment or older resource exception must not be represented as a pass. Task8.3 completion does not imply P6 completion or permission to start8.4.

## VERIFIED acceptance — 2026-09-13T19:53:22.717Z

User authority permits Windows MCP and Desktop Commander, controller self-review and a selective local commit. All six task steps are verified against the original Family 8.3 requirements. Windows 2,159 passed plus one platform skip; Linux 751 passed plus one platform skip; 26 causal faults; zero unresolved new acceptance resources. Report: report.md. Exact inputs and evidence: acceptance-final-20260913/acceptance.json. Task 8.4 is eligible, not implemented. P6 remains incomplete.
