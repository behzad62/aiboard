# Task 11 / P6.4h acceptance report

Accepted source boundary: Task 10 HEAD `284743e980514ecebc1d3143d427f4f3abf86225` plus this Task-11-only change set on `codex/runner-v2-robust-build`.
Task 12 remains pending. No push or publication is part of this acceptance.

## Delivered boundary

Exceptional AI recovery is restricted to `orphaned`, `identity_mismatch`, `backend_unavailable`, and `outcome_unknown`. Routine launch, stop, timeout, cancellation, crash cleanup, lease handling, and restart reconciliation remain model-free.

Runner owns proposal scope, call identity, target, expiry, exact user decision, one-use recovery grant, backend/birth identity checks, ownership/fencing, and capability validation. Model output is a closed proposal fragment only; unsupported artifact removal is not offered or accepted.

Both subprocess and streaming exceptional recovery reuse existing native lifecycle/cleanup engines. Streaming cleanup rechecks recovery authority between owned-resource effects. Read-only inspection is explicitly nonblocking; destructive post-dispatch ambiguity remains conservative `outcome_unknown` until later exact verified cleanup proves resolution.

Durable audit records store closed fingerprints and categorical outcomes instead of raw model rationale, arguments, credentials, native tokens, or grant material. Terminal Builds reject later recovery mutations.

Observability/API/client expose redacted backend/provider identity, semantic capability states, explicit Full bypass, active isolation/lease state, current grant state, output loss, cleanup proof/blockers, and exceptional recovery state. Historical live-authority facts are reported unavailable rather than inferred. Partial/unavailable/unverified is never labeled confined.
## Verification

- Final affected graph: **603/603 tests passed across 17 affected test files**. Evidence: `final-acceptance/affected-tests.log` and `affected-test-summary.json`.
- Real Windows native factory acceptance: **1/1 passed**, including process semantic probes, runtime/browser verification, and owned-root teardown. Evidence: `final-acceptance/factory.log`.
- Client contract script: PASS. Observability/UI script: PASS.
- Runner TypeScript: exit 0. Targeted ESLint over Task 11 source/tests/client/UI/scripts: exit 0.
- Final source freeze: 19 core Task 11 source/client/UI/script files hash-bound in `final-acceptance/source-freeze.json`.
- Final causal reversals on that frozen source: routine-state guard RED then GREEN; PID-only scope validation RED then GREEN; exact SHA-256 restoration verified. Evidence: `final-acceptance/fault-reversal-summary.json` and `fault-final-source-*`.
- Model-free lifecycle audit passes. Streaming authority is rechecked between cleanup resources.
- Final Task 11 temp-root audit found no live Task11/test/review process, removed 45 deliberate/failed Task11 diagnostic roots, and left 0 Task11 temp roots. Evidence: `final-acceptance/pre-cleanup-process-audit.json` and `resource-cleanup.json`.

## Independent review

Four independent read-only review passes were performed against frozen Task 11 bundles. Verified findings were repaired test-first. The final review verdict is: **No Critical or Important findings remain.**

Review repairs included terminal-Build immutability; resolvable destructive `outcome_unknown`; pre-dispatch failure classification; persistent isolation blockers; streaming recovery/disclosure; authorized destructive UI blocking; nonblocking inspect semantics; restart-stable backend identity; and exact inspect restart behavior.

## Scope / limitations

This Task 11 acceptance is Windows-native evidence plus portable contract coverage. Cross-platform package/CI proof, reverse-cleanup whole-P6 gate, reproducible archives, Node 22/24 installed-package smoke, and Windows/Linux/macOS CI are Task 12.

A destructive effect that was dispatched but whose result is lost remains `outcome_unknown`; it is not replayed. It clears only after a later exact same-identity verified cleanup proof. Historical views do not reconstruct live grants/leases that were never durably recorded; they report execution-safety authority as unavailable.

The existing execution isolation contract remains provider-specific rather than a universal security boundary, and Full mode is explicitly disclosed as unconfined. No Task 12 work or remote publication was performed.

## Exact commit-byte closeout
Before commit, Git clean-filter differences were audited: every staged/working source mismatch was CRLF-to-LF only. The affected working files were normalized to the staged blobs, leaving all 31 Task 11 code/test/ledger paths byte-identical to the index. On those exact bytes, the complete affected graph reran 603/603 GREEN across 17 files; the real Windows NativeBuildFactory acceptance reran 1/1 GREEN; Runner typecheck, ESLint over 30 authored files, client, and observability checks all exited 0. The final routine-state and PID-only source reversals each produced RED, restored the original SHA-256 exactly, then returned GREEN. Final protected audit: 5,120 non-Task11 baseline files unchanged, zero missing/drift, and all 1,708 unrelated status entries preserved. No push was performed; Task 12 remains unstarted.
