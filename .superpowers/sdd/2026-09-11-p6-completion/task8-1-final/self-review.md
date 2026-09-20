# Task8.1 controller source review

Original authority: Task8.1 in the portable-execution plan and task-8-brief.md. Foundation committed first as7e81476561daf917b466885c2a2999561200b824. Independent external review is not required by the owner; this is controller review, not an external approval.

Final status: **accepted for Task8.1**. The complete current56-file graph passed605/605;91/91 Linux contracts passed;367 source hashes,15 material guards, static checks and exact resource accounting were verified. Task8.2 may begin; P6 remains incomplete.

## Requirement traceability

| Task8.1 requirement | Current implementation | Verification boundary |
| --- | --- | --- |
| Explicit runner; no stateless/global/raw fallback | git-command compatibility functions require a runner; absent composition fails git_unavailable. Managers accept explicit execute/runBytes. git-runtime-runner delegates only to its supplied shared executor. | Five original caller guards failed against the raw implementation. Current behavioral delegation/refusal checks; actual aliased-launch material guard; whole production caller AST audit. |
| Original text/binary/result/error/allowFailure shapes | Public Git options/results/error codes preserved. Only a successful exited process with verified_empty cleanup can return a result. Normal verified nonzero errors/allowFailure remain distinct from timeout/cancel/cleanup/launch failure. | git-runtime-runner and caller suites; actual Git binary round trip; old manager/repository/tool compatibility tests. |
| Bounded complete output beyond display tail | Invocation-local capture runs through the shared subprocess output callback. Bounded copied raw bytes are independent of diagnostic storage loss; incomplete/overflow capture is typed output_limit, never partial success. Callback/capture is not persisted or replayed as live output. | one-shot-output-capture; subprocess live observation; actual192KiB-plus binary Git object; material missing observer, borrowed buffer, overflow/completeness and missing live path. |
| Exact per-run and original call authority | RunGitExecutionContext contains per-instance AsyncLocalStorage and per-grant WeakMap. withCall copies identity; nested repository reads and evidence command share bounded same-parent child grants. No global current runtime. ToolBroker retains its own approval profile while grants carry owner-selected isolation profile. | Exact run/call/actor/refusal, concurrent async interleaving, parent revocation/expiry, original scope grants, actual ToolBroker and evidence-command tests; material context and command-sequence reversals. |
| Complete owner wiring | CLI baseline -> captureRunGitBaseline -> actual host binding. Workspace, integration, verification, diagnostic archive, profile, changeset and worker snapshots receive lifecycle runners. Worker/architect/verifier/subagent tools and repository-backed language queries receive call-scoped runners; non-CLI embeddings require explicit injection. | Static inventory plus real baseline/task/changeset/integration/verification workflow, real factory/MCP two-run cleanup and agent behavior suites. External scripts/lib/app/components inventory found no omitted imports of these internal APIs. |
| Pre-run Git and no fabricated model actors | checkGit is supplied by the explicit RunnerInternalExecutionContext. Baseline belongs to an already-created real run with its requested profile. Trusted lifecycle mechanics use closed run-owned internal identity, not a fabricated architect/worker. | Git absence/no-install/pre-model tests, closed purpose/run-root tests, baseline profile matrix and actual CLI strict refusal before .git creation. |
| Reverse cleanup remains owned | Workspace cleanup completes while the host/grants remain usable. Host closes afterward. Async historical query owners are joined and retried by the host; failures retain their evidence. | Native factory ownership conjunction and native manager end-to-end tests; cancellation and failure-retention suites. |
| Historical read compatibility without original-state writes | withGitInspection owns a fresh transient runtime/artifact namespace, keeps real run/profile, exposes only an inspection runner and never requires an old terminal Build to possess a current active capability contract. | Actual historical rev-parse preserves all original state hashes; synthetic legacy/no-writer/undefined-rejection checks; material runtime-namespace reversal. |
| Scope exclusions | No Task9 hook/filter/helper/config hardening in product; no MCP/LSP/managed family migration; no provider-model call, Node/dependency change or package publication. | Git diff, exact source inventory and protected222-file hash reconciliation at acceptance. |

## Findings corrected during acceptance preparation

- Real Git now shares the Job host with MCP, so the old test census included already released Git records. The census now excludes only a valid durable backendOwnershipReleasedAt marker paired with stopped status, not current PID liveness. Unverified stopped/unknown records remain visible; contradictory release fails. A synthetic record-set test and material reversal guard this distinction.
- The test-only NativeWorkerDriver compatibility adapter initially omitted its injected one-shot executor. That made the new evidence revision/command composition fail in the scripted worker failover test. Passing the existing executor fixed the fixture; no production fallback was added. The original failover/session/tool/evidence assertions pass.
- Restart smoke previously created an unconfigured Project run through the raw Git baseline bypass. The updated smoke first verifies strict412 refusal without creating .git, then explicitly requests Full for the continuity scenario. Real CLI continuity and refusal pass. Only the actual ExecutionIsolationError class maps to the public typed refusal; a plain object with a matching code remains redacted500. No profile downgrade or raw retry.

## Adversarial review notes

The fifteen current material reversals all produced failing assertions, without cancellation/skips, and captured source bytes were restored exactly in finally. The restored23-case selection is green. Snippet-only AST tests are not substituted for the actual-source alias mutation. Missing-interface RED logs are labelled interface evidence, not claimed as a behavioral defect reproduction.

Diagnostic spool unavailability is not relabelled success. Complete live bytes can satisfy Git while existing storage-loss metadata stays truthful. On recovery with no matching live observation, an incomplete capture refuses success. Bounds are checked before large result assembly; the callback cannot become durable authority.

The inspection/lifecycle command grammar is a trusted composition boundary, not a claim of complete hostile Git option/config hardening. Task9 remains responsible for indirect programs, hooks, filters, repository config and all broader hostile-repository execution policy. Whole-family non-Git spawn/ambient closure remains Task8.5, not this Git-specific audit.

Test compatibility adapters are explicitly test-only; their finite temp-repository Git commands validate caller semantics rather than pretending to prove production process ownership. Separate actual ExecutionHost, grant, large-output, manager, CLI and two-run tests exercise the production route. No source imports a test adapter.

Historical failed roots and the pre-existing exceptional CLI ownership cases remain excluded from mutation. Only resources positively acquired by this task's test commands are eligible for final accounting; absence is not by itself a cleanup certificate.

## Final acceptance

The accepted56-file command finished with605/605, zero failure/cancellation/skip/todo; its367 inputs remain byte-identical. Linux ran88 plus3 portable authority/output/API/memory-SQLite checks in an isolated cached container, all passing. No real Linux Git or remote CI result is invented.

Windows resource ledger:662 exact acquisitions,661 absent, one intentionally retained historical-query no-launch diagnostic. Its four process/session/output tables are empty; all six files opened exclusively and closed. No native workload is retained by the accepted graph. Linux terminal /tmp was copied, its equivalent empty diagnostic preserved, and the exact stopped label-verified container removed. Accepted command processes are no longer active. Historical exceptions remain separate.

Configured typecheck, complete Runner source/test ESLint and source diff hygiene pass. All222 protected files match. Current verdict: **TASK 8.1 VERIFIED COMPLETE — TASK 8.2 MCP MAY BEGIN**. This is controller self-review under the owner's direction, not external approval and not P6 completion.
