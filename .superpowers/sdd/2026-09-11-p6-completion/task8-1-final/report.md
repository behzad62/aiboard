# Task8.1 — run-owned Git caller migration

**TASK 8.1 VERIFIED COMPLETE — TASK 8.2 MCP MAY BEGIN**

Accepted2026-09-11 against the original Task8.1 requirements after controller self-review, the complete affected56-file graph, actual Linux contract verification and exact resource reconciliation. This is not P6 completion or a P6.5/P6.6/P7 unlock. Independent external review was removed by the owner; no external approval is fabricated.

## Delivery

The previously verified foundation was committed first as **7e81476561daf917b466885c2a2999561200b824**, `feat(runner-v2): add verified run-owned Git execution foundation`, following C commit7f6fbcb1. This report covers the subsequent completed family migration. The coherent rollback base is the foundation commit, not a partial caller edit.

All product Git callers now receive an explicit host/run/call runner. The old raw spawn, ambient environment merge, output-triggered kill and stateless fallback in git-command.ts are removed. Missing injection fails typed. The public string/binary result and GitCommandError shapes remain compatible, including verified nonzero allowFailure; timeout/cancellation, launch uncertainty, output incompleteness and unverified cleanup cannot become success.

CLI baseline capture binds the already-created real run with its actual profile and closes that binding before returning. Workspace, integration, verification, diagnostic archive, profile, repository intelligence, changeset and worker inspection owners use explicit lifecycle runners. Worker/architect/verifier/subagent tools and nested repository-backed code queries receive original per-call authority. Evidence revision inspection and the evidence command share the original bounded parent scope rather than consuming/reissuing the parent grant twice. No module-global current Git runtime exists.

The host owns historical inspection in a separate transient runtime namespace. Old terminal contracts remain readable without activating an old run or altering its durable state. Cleanup owners remain available until reverse-order consumer cleanup finishes, and falsey primary/cleanup errors remain failures.

The Git adapter requests bounded invocation-local exact output from the shared one-shot/subprocess path. Large binary output survives an unavailable private diagnostic spill without using UTF8 display text as byte authority or pretending disk storage succeeded. Incomplete capture, overflow, lost observation or missing exact evidence fails typed; output is drained without an output-triggered kill. The callback/capture is private and not durable/replayable authority.

## Final verification

| Gate | Actual current result |
| --- | --- |
| Complete affected Windows graph | **605/605 passed across56 full test files;0 failed,0 cancelled,0 skipped,0 todo** |
| Source binding | **367 inputs match before/after the accepted run and live source** |
| Actual Linux portable contracts | **88/88 plus3/3 passed**, in two commands in one isolated cached Node24 Alpine container; no failures/cancellations/skips |
| Current material reversals | **15/15 detected their intended failures; exact restoration returned23/23 selected checks to green** |
| Configured Runner TypeScript check | **exit0** |
| ESLint over complete Runner source and tests | **exit0** |
| Changed-source diff hygiene | **exit0** |
| Controller requirement-to-code/evidence review | **accepted for Task8.1** |

The accepted Windows run ended2026-09-11T14:45:31.502445Z. It includes actual run-owned Git binary/large-output execution; the real baseline, task workspace, commit, changeset, integration, verification and historical-query workflow; CLI strict refusal and restart continuity; live MCP/run isolation; agent/failover/evidence behavior; shared output/store/grant/runtime faults; and Git timeout/descendant cleanup/preflight. These are outcomes in the single accepted affected run, not separate earlier greens combined into an invented run.

The Linux gate exercises portable authority/output/bootstrap/API contracts and memory/real-SQLite results on actual Linux. It does **not** claim a real Linux Git-executable end-to-end run, macOS execution or remote CI. Those platform/package/CI obligations remain in Task12. The complete all-family P6 command sequence is also not claimed by this scoped56-file gate.

## Material guard evidence

The actual current source was reversed for: explicit wrapper delegation; aliased raw launch; missing factory workspace injection; ToolBroker call propagation; per-run async context; same-parent evidence/command composition; live byte observation; captured-buffer ownership; overflow bounds; complete observation; large binary live transport; original baseline permission profile; historical runtime namespace; typed-error anti-spoof/redaction; and durable MCP census release classification.

Each reversal produced a failing test with no cancellation, and each source was restored byte-for-byte in finally. The final restored selection passed. Native workloads were not launched under a deliberately unsafe material-fault implementation. Current actual-source alias mutation supplements the AST snippet tests; source-string matching alone is not the acceptance proof. Foundation binary/grant material evidence remains separately recorded in the prior committed checkpoint.

## Acceptance findings resolved

The first agent compatibility run was152/155 and remains recorded as such. The three findings were resolved without weakening ownership:

- Completed one-shot Git records now share the Job backend with MCP. The MCP test census excludes only records with a valid durable release marker and stopped status, not records whose numeric PID happens to be absent. Unverified ownership remains visible.
- A test-only worker compatibility adapter omitted the executor already supplied by its caller. It now passes that executor; production gained no fallback.
- Unconfigured Project bootstrap previously succeeded through the raw Git bypass. It now refuses before .git creation. Restart continuity explicitly uses Full, and a separate actual request proves strict refusal. The API projects only the trusted typed isolation error with a safe constant message; a spoofed plain-object code remains a redacted internal error.

The earlier native manager newline discrepancy was fixture-specific Git text conversion; an explicit fixture .gitattributes rule preserves its intended LF assertion. No product newline policy or cleanup deadline was relaxed.

## Resource accounting

The accepted Windows graph logged **662 exact acquisitions**: **661 are absent**, and one intentionally retained no-launch diagnostic remains:

`C:/Users/b_a_s/AppData/Local/Temp/aiboard-git-inspection-NC1Ev2`

It belongs to the historical-query test's deliberately thrown undefined primary error. Read-only inspection found **zero durable process, streaming-session, host-launch and output-checkpoint rows**. All six retained files opened exclusively and closed successfully. It is closed diagnostic evidence, not a live or cleanup-uncertain Git workload. No native workload is retained from the accepted run.

The Linux gate logged48 acquisitions;47 were absent in the terminal /tmp copy and one equivalent no-launch diagnostic was copied into the packet. Its process/session tables are also empty. The exact container exited0 without OOM, was label-verified, its /tmp evidence copied, and that exact container removed. Linux paths were not evaluated through Windows filesystem assumptions.

Final Windows and Linux command wrappers/test-process identities are no longer active. Native cleanup claims come from actual owner/finalizer assertions and complete terminal results, not PID/path absence alone. Earlier failed attempts, historical CLI exceptions and unrelated task evidence remain preserved and are not retroactively declared cleaned.

## Repository and phase boundary

All222 protected unrelated files remain byte-identical: benchmark work, existing QuickJS package edits and generated public ZIPs are excluded. No dependency/Node policy change, product-model call, push, publication, unrelated destructive cleanup or later-family implementation occurred.

Task9 still owns hostile Git config/hooks/filters/helpers and indirect execution hardening. Task8.5 still owns the whole non-Git launch audit. MCP/LSP/managed family migration and P6.4f–i/P6 acceptance remain separate. The next eligible task is **8.2 MCP**, not P6.5.

Primary records: task8-1-gate.json; final-verification.json; final-code-manifest.json; self-review.md; task81-material-proof.json; accepted-resource-ledger.json; linux-resource-ledger.json; final-resource-handle-proof.json; final-static-result.json. The accepted Windows terminal/source manifests and complete TAP remain in the parent P6 packet under task81-final-affected-*. Linux receipts and immutable bundle manifest are in this directory. Failing/predecessor logs are retained separately and not overwritten.
