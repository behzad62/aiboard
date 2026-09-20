# Runner V2 Task 12 — Durable Gate Status

> **Authoritative continuation state.** Update this file whenever a gate changes status. Do not infer completion from chat summaries.

Plan: `docs/runner-v2/task-12-bounded-gates.md`

- Gate 0 baseline: PASS
- Gate A fencing: PASS
- Gate B POSIX: PASS (amended 2026-09-20 — authenticated process-group ownership; not arbitrary-descendant containment)
- Gate C Windows: PASS
- Gate D macOS/config: IMPLEMENTED / DARWIN_MATRIX_FOLLOWUP
- Gate E lifecycle/Docker: PASS (amended 2026-09-20 — scope-honest emptiness; process_group ≠ contained_workload)
- Gate F benchmark: PASS
- Gate G final acceptance: IN_PROGRESS (not PASS)

## 2026-09-20 scoped-lifecycle amendment

Adopted architecture: `docs/runner-v2/architecture-reassessment-2026-09-19/DECISION.md` (user-accepted via M0 on 2026-09-20). Migration packets: M0 accepted; M1/M2/M3 LOCAL_ACCEPTED / READY-for-M4 after repair + final independent READY review; M4 IN_PROGRESS / PENDING_FRESH_REMOTE_EVIDENCE (exact-candidate commit/push and fresh remote CI/qualification outstanding). Packet evidence: `docs/runner-v2/architecture-reassessment-2026-09-19/evidence/M0.md` … `M4.md`.

Contract summary now binding on Gates B/E/G:

- Lifecycle proof is versioned with explicit scope `process_group` | `contained_workload`.
- Ordinary full/native POSIX operation is authenticated process-group ownership/control, not containment or security isolation.
- Known group-member witnesses after anchor exit remain valid continuity evidence; PPID/ancestry discovery does not authorize control or universal cleanup.
- POSIX group emptiness is scoped evidence only. Strong detached-descendant containment is Windows Job and/or configured OCI (future cgroup optional; not a Gate G prerequisite).
- Strict/non-full requires `contained_workload` plus confinement. OCI workload lease and host attach lifecycle are separate. Legacy/missing scope never upgrades authority.

Ancestry-reconstruction / native POSIX arbitrary-descendant containment is **not** accepted behavior. Experimental PPID/escaped-descendant control was removed under M0/M2 disposition. Gate G remains open until M4 exact-candidate evidence closes the amended matrix; do not treat this amendment as Gate G PASS.

## Current gate

2026-09-20 qualification continuation: pushed architecture SHA `2ffb8054` has green required PR CI; qualification run `35492714608` failed. The user authorized small isolated real-host qualification entrypoints, preservation of the diagnosed bootstrap/CLI/POSIX repairs, targeted local checks, fresh independent Cursor review, commit/push, and final-SHA hosted acceptance. Current execution and per-hunk dispositions are recorded in `architecture-reassessment-2026-09-19/evidence/M4-qualification-refactor.md`. Gate G remains open. Do not run the global Runner V2 suite or merge PR #95.

T12-G / M4 — final integrated acceptance remains open. Pre-freeze IMPORTANT review findings are repaired and closed (`evidence/implementation-review-after-repair.txt` = READY, findings none); that is not Gate G PASS. Freeze the exact candidate, commit/push, then run fresh required CI and Windows/Linux/macOS + configured OCI qualification. Repair only actual blockers; finalize evidence/clean tree; leave merge for explicit user approval. Keep the PR unmerged. Retained Darwin matrix follow-up from Gate D is still required before claiming full platform acceptance. Do not casually rerun the historical broad `npm run test:runner-v2` suite; that one earlier full run was already consumed, repaired with targeted validation and later required CI, and must not be represented as newly rerun in the Finding 1–3 / MCP follow-up repairs unless explicitly authorized.

Gate F benchmark acceptance remains complete as recorded below. Product support remains Node.js 24.x only.

## Clean repair workspace

- Worktree: `D:\repos\ai-discussion-board\.worktrees\runner-v2-task12-bounded`
- Branch: `codex/runner-v2-task12-bounded`
- Canonical Task-12 PR head used as repair base: `cb5320b60ffa6130950db49c59263b4b4501977b`
- Plan/docs replay commit: `3bcb40b0`
- Extracted POSIX safety commit: `7317fa49`
- Extracted capabilities-config confinement commit: `99b4cfb2`
- Scoped-lifecycle amendment base (M0): `6e33354e7e3bed9e16ad9cb0416ef5e9f4b75940`

## Baseline provenance

The previous local branch remains available for forensic reference, but its checkpoint history is deliberately excluded from this repair branch:

- `9878a12b9ed1cffe317145a9fa9d465370a03df1` — 1,716 files / ~12.6M inserted lines; contaminated checkpoint.
- `bf57a2de71fe5eea8b88fe53764900264c764603` — mixed 10-file Runner runtime checkpoint layered on `9878a12b`.

Neither checkpoint is in `codex/runner-v2-task12-bounded` ancestry.

Legitimate reviewed fixes extracted from `9878a12b`:
- POSIX membership parser fails closed for PID 0 / invalid non-positive rows except positive PID + PGID 0 kernel-thread rows.
- POSIX post-anchor force control re-attests recorded **group-member** birth witnesses before group signaling.
- Capabilities config canonical confinement rejects parent-alias escape into the project while preserving host-native aliases.

## Quarantined local-only patches

Do not copy these into the repair branch without the owning gate's review:
- `9878a12b` managed-stop/session-runtime attempt remains quarantined; Gate A was reimplemented and reviewed independently on the bounded repair branch instead of copying that checkpoint.
- `bf57a2de` Windows/portable/MCP coordination patch was independently reviewed during Gate C and deliberately not copied wholesale; Gate C reimplemented only the bounded Windows/portable coordination behavior justified by fresh RED/GREEN evidence.
- Benchmark/calibration/generated artifacts contained in `9878a12b`: excluded from Task-12 repair history.
- Experimental PPID/escaped-descendant reconstruction (pre-amendment dirty hunks): removed under M0/M2; preserved only as `evidence/dirty-before-scope-review.patch` for forensics.

## Targeted tests/evidence

RED before extraction:
- `npx tsx --test --test-concurrency=1 runner-v2/test/posix-process-backend.test.ts runner-v2/test/runner-capabilities-config.test.ts`
- Result: 44 pass, 7 fail, 1 skip. Failures were the intended stale-PGID/parser/config regressions.

GREEN after extraction:
- Same command.
- Result: 55 pass, 0 fail, 1 skip; POSIX native fixture skipped on Windows by design.

Baseline hygiene evidence:
- clean repair branch forked directly from `cb5320b6`;
- no `9878a12b` or `bf57a2de` in repair ancestry;
- no competing process was found using the new repair worktree;
- dependency reuse is an ignored local `node_modules` junction only, not repository content.

Gate A RED/GREEN evidence:
- The takeover-between-authorization-and-renewal regression failed before the fix because the stale stop mutated the replacement owner; replacement revision changed from 2 to 7.
- A stale facade was also proven able to mint under a replacement fence before the fence-scoped facade renewal fix.
- Final focused Gate-A invariant run: 6 pass, 0 fail. It covers normal stop, takeover before renewal, takeover after renewal before `begin_stopping`, stale/expired operation authorization, same owner/new fence, stale facade renewal, and preserves the established exact-owner long-idle renewal behavior.
- Final bounded Gate-A suite: 353 pass, 0 fail across `session-authority`, `streaming-session-store`, full streaming-session runtime, and streaming execution-host quiescence coverage.
- `npx tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- The accepted implementation carries an exact owner/fence through authorization validation, lease renewal, durable `begin_stopping`, cleanup admission, compound request retention, graceful cleanup, and recovery cleanup; required fence arguments are compile-time mandatory on the renewal/cleanup primitives.

Gate B RED/GREEN evidence (historical; reinterpreted under 2026-09-20 amendment as authenticated **process-group** ownership, not all-descendant containment):
- The extracted `7317fa49` stale-PGID repair was independently re-audited rather than accepted from checkpoint history.
- The shared POSIX membership parser now fails closed for malformed/nonpositive rows and for a blank successful `ps` snapshot; the native backend reuses that parser so junk evidence cannot become false emptiness/release proof.
- Every negative-PGID signal in `runner-v2/src` is centralized in `signalOwnedPosixGroup`; its two supervisor call sites perform a fresh exact inner-fence re-attestation immediately before signaling.
- Before anchor exit, the exact anchor PID/group/birth witness is re-attested. After anchor exit, force control requires at least one exact recorded live **group-member** birth witness and refuses recycled, mismatched, empty, or unprovable groups without blind signaling.
- Exact **group-member** witnesses are learned only while the authenticated anchor remains live; witness discovery stops after real anchor exit so a recycled PGID cannot manufacture new ownership evidence.
- Transient control inspection preserves the exact request and is bounded to three attempts for one owner/fence/sequence/action. During the retry window status remains non-terminal; at exhaustion the tick publishes `outcome_unknown` and stops launching further control inspections for that exact request.
- Workload retirement/output settlement runs before polling new control once retirement is durable. Graceful requests after real anchor exit are stale no-ops; only force may address birth-attested surviving **group members**.
- Final Windows focused POSIX suite: 56 pass, 0 fail, 1 POSIX-host skip.
- Final Linux Node 24 suite: 57 pass, 0 fail, 0 skip, including the real immediate-launcher-exit/surviving-group-member fixture.
- Shared portable protocol/contract validation: 33 pass, 0 fail. Targeted Windows destructive-control compatibility: 2 pass, 0 fail. `npx tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- `ps -e -o pid=,pgid=` was verified to emit the expected numeric format in both `node:24-bookworm` and `node:24-alpine` target-style containers.
- Post-amendment M2: PPID/escaped-descendant authority removed; negative architecture guard retained. See `evidence/M2.md`.

Gate C RED/GREEN evidence:
- The mixed `bf57a2de` checkpoint was used only as forensic input; its MCP/session/debug changes were excluded and the Windows/portable coordination behavior was re-derived on the clean repair branch.
- Deterministic REDs proved transient settlement coordination was immediately poisoned, transient ACK fence contention permanently poisoned the channel, post-effect ACK contention could replay an already-durable acknowledgement, and a transient `lock-holder.json` read could become permanent authority loss.
- Settlement now retries only typed owned-fence contention within both caller and real wall-clock deadlines; permanent/corrupt protocol failures fail fast, including the final pre-`settled` re-attestation.
- An ACK already made durable by the same channel attempt is recognized after a post-effect contention without replay, while a fresh reattach still preserves at-least-once retained-output replay.
- Owned-fence classification now requires exact typed contention; mixed terminal+busy aggregates remain terminal, raw effect-body errno is not upgraded to fence contention, and replaced/disappeared coordination-file identity is terminal rather than retryable.
- Windows `lock-holder.json` publication is atomic. Effect-time reads retry only bounded `EBUSY`; missing or readable-mismatched holder evidence remains terminal. A startup-only readiness barrier retries `ENOENT`/`EBUSY`/`EPERM`/`EACCES` within the existing 15-second parent birth-discovery window and rejects readable foreign/malformed authority immediately.
- Windows startup preserves the specific readiness/birth/startup failure reason across initial publication and later ticks; this diagnostic-only follow-up received its own RED/GREEN test and a narrow post-READY review.
- Final owned-fence suite: 35 pass, 0 fail. Final process backend/protocol contract suite: 29 pass, 0 fail. Final portable channel suite: 76 pass, 0 fail. Final Windows backend suite: 95 pass, 0 fail.
- `npx tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. `git diff --check`: exit 0.

Gate D implementation/evidence:
- Added one exact Darwin host-alias predicate for `/var -> /private/var`, `/tmp -> /private/tmp`, and `/etc -> /private/etc`; all other platforms and mappings remain untrusted.
- Capabilities config confinement, capability-contract extension/state roots, configured OCI executable attestation, and `LocalPluginLoader` now consume the same host-alias rule while final components and user-created parent aliases/junctions remain strict.
- Windows bounded Gate-D suite: 28 pass, 0 fail, 2 Darwin-only skips across config, capability-contract, and plugin-loader tests; CLI trust-boundary subset 3 pass, 0 fail; TypeScript and diff-check clean.
- Independent Gate-D re-review verdict: `READY`, no Critical findings; the earlier loader split was repaired before re-review.
- Real `macos-latest` / Node 24 evidence run `35330634366` on temporary commit `7bae6fde` executed both new Darwin acceptance fixtures without skips: macOS `LocalPluginLoader` host-alias fixture PASS; capability extension/state-root host-alias fixture PASS; exact mapping classifier PASS.
- The same broader three-file Darwin run finished 22 pass / 8 fail. Those eight failures are raw-vs-canonical macOS fixture/expectation portability issues (including `/var` vs `/private/var` keyed paths/assertions) outside the two new alias acceptance fixtures, so Gate D is frozen as implemented/reviewed but not claimed as full Darwin-matrix PASS. User explicitly authorized continuing to Gate E with this follow-up retained for platform acceptance.

Gate E controller evidence (historical; scope honesty strengthened by 2026-09-20 amendment):
- No Gate-E source repair was required after the Gate B/C lifecycle fixes. Audit confirmed `reconcile: exited` is workload quiescence only: execution-host cleanup, internal kernel cleanup, and subprocess completion still require separate output settlement, terminal/empty proof, fresh authority where applicable, and backend/resource release.
- `NativeOwnedProcessBackend` POSIX v2 deliberately permits durable workload retirement to reconcile `exited`, but `release()` independently rejects while the exact terminal supervisor witness is alive, requires settled output, verified **scoped** emptiness, durable stopped proof, stable birth/fence attestation, and a final fenced release re-attestation. Under the amendment, POSIX verified emptiness is process-group emptiness, not all-descendant emptiness.
- Focused lifecycle/recovery suite (`execution-host-streaming-quiesce`, `runner-internal-process-kernel`, `subprocess-runtime`, `runner-resource-cleanup`): 84 pass, 0 fail, 0 skip.
- Explicit Gate-E invariant subset: 7 pass, 0 fail. It covers workload-exit/output-unsettled separation, signal-only exit not replacing reconcile proof, live terminal supervisor blocking release, transient verified-empty retry, output finalized before verified cleanup/release, and fail-closed durable-state/reconcile recovery.
- Real Docker CI-equivalent suite with `RUNNER_V2_REQUIRE_DOCKER=1` across `oci-execution-isolation-provider`, `managed-strict-oci`, and `mcp-tools`: 93 pass, 0 fail, 0 skip. Live-child cleanup, forced cleanup, attach cancellation/disappearance, exact restart recovery, image-mismatch blocking, strict duplex, and public MCP process-tree cleanup all passed.
- Post-run `docker ps -a --filter label=ai-board.runner-v2.owned=true` returned no containers. `npx tsc -p runner-v2/tsconfig.json --noEmit` and `git diff --check` both exited 0.
- OCI's remaining strict symbolic-component walker can still fail closed for macOS `/var/...` caller spellings in working-directory/translated absolute arguments. Controller audit classifies this as the already-recorded Darwin portability follow-up, not a release/lifecycle safety bypass; no trust rule was broadened in Gate E.
- Independent Cursor Agent review at detached HEAD `1c47f285` returned `READY`: no Critical or Important Gate-E findings, all five required lifecycle/recovery cases had implementation proof plus regression coverage, and the reviewer independently reran the explicit invariant subset at 7 pass / 0 fail.
- Post-amendment M3: Job/OCI composition and attach-vs-workload separation revalidated locally; see `evidence/M3.md`. Strong detached-descendant containment remains Job/OCI, not POSIX group.

Gate F causal-classification / GREEN evidence:
- Historical Task-12 benchmark CI failed on Node 22 at `scripts/test-certified-preset-cancellation.mts:89/548`, where the unchanged helper allows 500 zero-delay scheduler turns before reporting `Timed out waiting for certified preset state.` The same failure reproduced in clean `node:22-bookworm` / Node 22.23.2 with the locked `tsx@4.22.5`; Linux/Windows Node 24 did not reproduce it.
- Extended diagnostic instrumentation proved the four preset workers were admitted, but Node 22 never reached the test's stubbed OpenAI stream and failed before provider admission. The persisted fatal reason was normalized to the generic account/configuration-unavailable message, so that text is not treated as a unique fingerprint. The decisive evidence was a minimal module-identity probe: `tsx@4.22.5` on Node 22 loaded separate mutable provider/store singleton instances, so the production provider graph could not see the test-initialized client store. The same probe had one shared provider/store graph on Node 24.
- On that exact Node 22 container, replacing only the test runner with `tsx@4.23.13` made the module-identity probe pass and made the untouched certified-preset test pass with its original 500-turn bound. A second independent store-sensitive benchmark script, `test-benchmark-model-effort-execution.mts`, recovered at the same time. This separates the failure from Runner V2 lifecycle/performance and identifies the benchmark test-runner compatibility bug.
- Accepted implementation candidate changes only the `tsx` devDependency/lock from `4.22.5` to `4.23.13`. No Runner V2 source, certified benchmark logic, model-call timeout, workflow timeout, or benchmark threshold changed.
- Fresh lockfile-controlled Linux Node 22.23.2 validation: `npm run test:certified` exited 0 in ~273 s with `tsx@4.23.13`, including the formerly failing preset cancellation case.
- Fresh lockfile-controlled Linux Node 24 validation on a native container filesystem: `npm run test:certified` exited 0 in ~152 s with `tsx@4.23.13`. An earlier Windows-bind-mounted Node 24 run reached deep into the suite without assertion failures but terminated with host/runtime `ENOMEM`; Docker had ~7.75 GiB available and Windows ~33 GiB free. Re-running from a native Linux copy removed that environment variable and passed end to end without changing any memory or benchmark threshold.

### Scoped-lifecycle local validation (M1–M3; not fresh release CI)

Session-recorded local/targeted evidence on the amendment implementation worktree (documentation pass did not re-execute these commands):

- Lifecycle contract / versioned scope implemented across consumers and durable authority; no PPID/escaped-descendant authority remains.
- Targeted M1/M2 deterministic bundle: 274 tests with five stale fixture failures, then exact 5/5 green fixture-only repair; remaining M1/M2 bundle 75/75 green.
- Workflow/fixture guard set: 18/18 green.
- `subprocess-runtime`: 73/73 plus one existing skip.
- MCP (pre-repair baseline): 46/46 plus two expected local Docker skips.
- Client and observability scripts: PASS (also reconfirmed PASS after repair).
- Direct `tsc`: exit 0. `git diff --check`: exit 0.

#### Repair history (pre-repair independent review — not current status)

Historical independent pre-repair review: `docs/runner-v2/architecture-reassessment-2026-09-19/evidence/implementation-review-before-repair.md` (session `1c259a99-…`) — **`0 BLOCKING / 3 IMPORTANT / NOT READY`**:

1. Observability/client scope projection missing (`lifecycle.scope` / `requiredLifecycleScope`).
2. Lifecycle requirement flags not wired into live families (`requireCompleteCleanup` / `knownUnavoidableDetachment`).
3. Full+contained Job/OCI-preferred honest unconfined fallback composition missing.

#### Repair evidence

- Finding 1–3 repair: scope-honest observability/client projection; trusted lifecycle requirement seams for one-shot/managed/MCP/LSP; full+contained OCI-preferred then full-only honest `unconfined_explicit_full` fallback that leaves contained scope for backend selection. Focused suite **69/69**; observability script PASS; client script PASS; direct tsc/typecheck clean; diff-check clean.
- Controller MCP production propagation gap: hand-crafted launch descriptor worked, but production `McpServerSpec`→attestation→`resolveMcpRuntimeLaunches` did not source lifecycle requirements. Follow-up: trusted `McpServerSpec` plain-data/boolean validation/canonicalization, configuration digest binding, WeakMap/static attestation propagation, runtime launch requirements+digest. Focused MCP suite **60/60**; typecheck clean; diff-check clean.
- Controller independently reran `git diff --check` after repairs: exit 0.
- Historical full `npm run test:runner-v2` was consumed earlier in Task 12 and was **not** rerun in these repairs; do not casually repeat that broad suite unless explicitly authorized.

#### Final independent post-repair review (current)

`evidence/implementation-review-after-repair.txt`: findings **`none`**; verdict **`READY`**. Checklist explicitly confirms all three prior IMPORTANT findings closed, MCP production path closed, legacy v1 fail-closed, OCI workload vs host attach scope, no PPID/ancestry authority, and no product deadline widening.

M1/M2/M3 are recorded as LOCAL_ACCEPTED / READY-for-M4. M4 remains IN_PROGRESS / PENDING_FRESH_REMOTE_EVIDENCE: exact-candidate freeze, commit/push, fresh required CI, Windows/Linux/macOS qualification, configured OCI qualification, Darwin follow-up, package parity/reproducibility, and final release checks. See `evidence/M4.md`. Do **not** claim Gate G PASS.

## Reviewer status

T12-0 baseline evidence has been controller-verified. Gate A received two read-only independent reviews and finished `READY`. Gate B received three read-only independent review passes: the first correctly found parser/blank-evidence/test gaps but withdrew its initial last-tick-descendant premise after verifying the dedicated anchor wrapper; the second found a real lifecycle deadlock and unbounded retry in the first repair; both were fixed. The final Gate B reviewer verdict was `READY`, with no Critical or blocking Important findings, and explicitly re-audited both negative-PGID signal sites and all six prior blockers. Under the 2026-09-20 amendment, that Gate B READY is retained as authenticated process-group ownership evidence, not as acceptance of arbitrary-descendant containment.

Gate C received repeated read-only independent review passes. Earlier `NOT READY` reviews found the post-effect ACK replay bug, over-broad contention classification, missing Windows startup readiness, final-settlement re-attestation poisoning, coordination-path replacement misclassification, and startup busy-read intolerance; each blocker received focused RED/GREEN coverage before repair. The final full Gate C review was `READY` with no Critical findings and confirmed the ownership/control invariants. Its only requested follow-up was diagnostic reason preservation; that change then received a separate narrow post-READY review with verdict `READY` and no blockers.

Gate D received two read-only independent reviews. The first correctly found an end-to-end split where capability capture accepted a Darwin host alias but `LocalPluginLoader` still rejected it. The loader was repaired to consume the same exact host-alias predicate, final-component checks were restored, and the second review returned `READY` with no Critical findings. Full Darwin matrix acceptance remains explicitly deferred because the broader evidence run exposed eight raw-vs-canonical fixture/expectation portability failures even though the new Darwin alias acceptance fixtures themselves passed.

Gate E received a final read-only independent review in Cursor Agent against detached HEAD `1c47f285`. Verdict: `READY`. The reviewer found no Critical or Important findings, independently confirmed all five required Gate-E cases and reran the explicit invariant subset at 7/7. Minor non-blocking suggestions were: add a POSIX retired+supervisor-absent+leftover-output regression; add an OCI `cleaned_pending_ack`+still-listed-container residue regression; retain awareness that the internal kernel may treat `signal(): exited` as workload exit but still requires `verifyEmpty`+`release`; and note that Windows `release()` relies on production callers quiescing first. None was classified as a Gate-E lifecycle blocker. Post-amendment, emptiness claims remain scope-bound.

Gate F received a final read-only independent review in Cursor Agent against working HEAD `bf42482f` plus the three-file Gate-F candidate diff. Verdict: `READY`; no Critical findings. The reviewer independently confirmed the dependency/lockfile change is minimal, the certified-preset 500-turn wait and workflow timeout remain unchanged, the Node 22 RED→module-identity probe→`tsx@4.23.13` GREEN chain is causally sufficient, and the Node 22/24 controlled certified-suite evidence meets Gate F. Its one Important bookkeeping finding was this status file's stale “Gate F still requires causal classification” later-gate bullet; that stale line was removed before acceptance. The reviewer also noted that the generic persisted account/configuration error is normalized and should not be treated as the unique causal fingerprint; the evidence wording above now makes the module-identity probe decisive instead.

Scoped-lifecycle implementation review (2026-09-20): historical pre-repair review `evidence/implementation-review-before-repair.md` ended `NOT READY` with three IMPORTANT findings (repair history only; see M1/M3 evidence). Repairs + MCP production follow-up completed with targeted evidence; final independent read-only review `evidence/implementation-review-after-repair.txt` returns `READY` with findings `none`. M1/M2/M3 LOCAL_ACCEPTED / READY-for-M4. Gate G is not accepted; M4 fresh remote evidence remains open.

## Known later-gate issues

- Gate D/G platform follow-up: the targeted Darwin host-alias acceptance fixtures pass, but the broader three-file macOS run still has eight raw-vs-canonical fixture/expectation portability failures that must be repaired or classified before final matrix acceptance.
- Gate E non-blocking follow-ups: consider adding a POSIX retired+supervisor-absent+leftover-output regression and an OCI `cleaned_pending_ack`+still-listed-container residue regression during final hardening. The strict OCI macOS `/var/...` walker remains part of the Gate D/G Darwin portability follow-up, not a Gate-E lifecycle issue. Gate E evidence did not justify widening Gate B's accepted three-tick POSIX transient-inspection window.
- Gate G / M4: freeze exact candidate, commit/push, run fresh required CI and cross-platform/OCI qualification; resolve Darwin follow-up (still open); package parity/reproducibility and final release checks. Pre-freeze IMPORTANT findings and MCP production gap are closed by post-repair READY review — do not reopen them as current blockers. Keep PR unmerged until Gate G actually passes; leave merge for explicit user approval. Do not casually rerun historical full `npm run test:runner-v2`.
- Gate G final audit: recheck the currently unreachable POSIX branch in `activeOwnedPids` before any future reuse because it still has a legacy permissive parser shape; also retain the documented non-Linux `ps -o lstart=` birth-witness precision limitation in platform evidence.
