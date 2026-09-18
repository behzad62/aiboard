# Runner V2 Task 12 — Durable Gate Status

> **Authoritative continuation state.** Update this file whenever a gate changes status. Do not infer completion from chat summaries.

Plan: `docs/runner-v2/task-12-bounded-gates.md`

- Gate 0 baseline: PASS
- Gate A fencing: PASS
- Gate B POSIX: PASS
- Gate C Windows: PASS
- Gate D macOS/config: IMPLEMENTED / DARWIN_MATRIX_FOLLOWUP
- Gate E lifecycle/Docker: IN_PROGRESS
- Gate F benchmark: NOT_STARTED
- Gate G final acceptance: NOT_STARTED

## Current gate

T12-E — lifecycle settlement and real Docker/OCI is in progress. Gate D implementation is frozen and independently reviewed; broader Darwin matrix cleanup remains recorded for final platform acceptance.

## Clean repair workspace

- Worktree: `D:\repos\ai-discussion-board\.worktrees\runner-v2-task12-bounded`
- Branch: `codex/runner-v2-task12-bounded`
- Canonical Task-12 PR head used as repair base: `cb5320b60ffa6130950db49c59263b4b4501977b`
- Plan/docs replay commit: `3bcb40b0`
- Extracted POSIX safety commit: `7317fa49`
- Extracted capabilities-config confinement commit: `99b4cfb2`

## Baseline provenance

The previous local branch remains available for forensic reference, but its checkpoint history is deliberately excluded from this repair branch:

- `9878a12b9ed1cffe317145a9fa9d465370a03df1` — 1,716 files / ~12.6M inserted lines; contaminated checkpoint.
- `bf57a2de71fe5eea8b88fe53764900264c764603` — mixed 10-file Runner runtime checkpoint layered on `9878a12b`.

Neither checkpoint is in `codex/runner-v2-task12-bounded` ancestry.

Legitimate reviewed fixes extracted from `9878a12b`:
- POSIX membership parser fails closed for PID 0 / invalid non-positive rows except positive PID + PGID 0 kernel-thread rows.
- POSIX post-anchor force control re-attests recorded descendant birth witnesses before group signaling.
- Capabilities config canonical confinement rejects parent-alias escape into the project while preserving host-native aliases.

## Quarantined local-only patches

Do not copy these into the repair branch without the owning gate's review:
- `9878a12b` managed-stop/session-runtime attempt remains quarantined; Gate A was reimplemented and reviewed independently on the bounded repair branch instead of copying that checkpoint.
- `bf57a2de` Windows/portable/MCP coordination patch was independently reviewed during Gate C and deliberately not copied wholesale; Gate C reimplemented only the bounded Windows/portable coordination behavior justified by fresh RED/GREEN evidence.
- Benchmark/calibration/generated artifacts contained in `9878a12b`: excluded from Task-12 repair history.

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

Gate B RED/GREEN evidence:
- The extracted `7317fa49` stale-PGID repair was independently re-audited rather than accepted from checkpoint history.
- The shared POSIX membership parser now fails closed for malformed/nonpositive rows and for a blank successful `ps` snapshot; the native backend reuses that parser so junk evidence cannot become false emptiness/release proof.
- Every negative-PGID signal in `runner-v2/src` is centralized in `signalOwnedPosixGroup`; its two supervisor call sites perform a fresh exact inner-fence re-attestation immediately before signaling.
- Before anchor exit, the exact anchor PID/group/birth witness is re-attested. After anchor exit, force control requires at least one exact recorded live descendant birth witness and refuses recycled, mismatched, empty, or unprovable groups without blind signaling.
- Exact descendant witnesses are learned only while the authenticated anchor remains live; witness discovery stops after real anchor exit so a recycled PGID cannot manufacture new ownership evidence.
- Transient control inspection preserves the exact request and is bounded to three attempts for one owner/fence/sequence/action. During the retry window status remains non-terminal; at exhaustion the tick publishes `outcome_unknown` and stops launching further control inspections for that exact request.
- Workload retirement/output settlement runs before polling new control once retirement is durable. Graceful requests after real anchor exit are stale no-ops; only force may address birth-attested surviving descendants.
- Final Windows focused POSIX suite: 56 pass, 0 fail, 1 POSIX-host skip.
- Final Linux Node 24 suite: 57 pass, 0 fail, 0 skip, including the real immediate-launcher-exit/surviving-descendant fixture.
- Shared portable protocol/contract validation: 33 pass, 0 fail. Targeted Windows destructive-control compatibility: 2 pass, 0 fail. `npx tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- `ps -e -o pid=,pgid=` was verified to emit the expected numeric format in both `node:24-bookworm` and `node:24-alpine` target-style containers.

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

## Reviewer status

T12-0 baseline evidence has been controller-verified. Gate A received two read-only independent reviews and finished `READY`. Gate B received three read-only independent review passes: the first correctly found parser/blank-evidence/test gaps but withdrew its initial last-tick-descendant premise after verifying the dedicated anchor wrapper; the second found a real lifecycle deadlock and unbounded retry in the first repair; both were fixed. The final Gate B reviewer verdict was `READY`, with no Critical or blocking Important findings, and explicitly re-audited both negative-PGID signal sites and all six prior blockers.

Gate C received repeated read-only independent review passes. Earlier `NOT READY` reviews found the post-effect ACK replay bug, over-broad contention classification, missing Windows startup readiness, final-settlement re-attestation poisoning, coordination-path replacement misclassification, and startup busy-read intolerance; each blocker received focused RED/GREEN coverage before repair. The final full Gate C review was `READY` with no Critical findings and confirmed the ownership/control invariants. Its only requested follow-up was diagnostic reason preservation; that change then received a separate narrow post-READY review with verdict `READY` and no blockers.

Gate D received two read-only independent reviews. The first correctly found an end-to-end split where capability capture accepted a Darwin host alias but `LocalPluginLoader` still rejected it. The loader was repaired to consume the same exact host-alias predicate, final-component checks were restored, and the second review returned `READY` with no Critical findings. Full Darwin matrix acceptance remains explicitly deferred because the broader evidence run exposed eight raw-vs-canonical fixture/expectation portability failures even though the new Darwin alias acceptance fixtures themselves passed. Gates E-G still require their documented independent review before acceptance.

## Known later-gate issues

- Gate D/G platform follow-up: the targeted Darwin host-alias acceptance fixtures pass, but the broader three-file macOS run still has eight raw-vs-canonical fixture/expectation portability failures that must be repaired or classified before final matrix acceptance.
- Gate E: supervisor/output/release settlement and real Docker lifecycle remain open. `oci-execution-isolation-provider.ts` still has its own strict symbolic-component walker for caller working-directory/translated absolute paths; audit it here because `/var/...` caller spellings may currently fail closed on macOS. Revisit Gate B's accepted-but-short three-tick (~75 ms default) POSIX transient-inspection window if lifecycle evidence shows real host hiccups need a wider time floor; do not replace it with unbounded retry.
- Gate F: certified preset timeout still requires causal classification, not timeout inflation.
- Gate G final audit: recheck the currently unreachable POSIX branch in `activeOwnedPids` before any future reuse because it still has a legacy permissive parser shape; also retain the documented non-Linux `ps -o lstart=` birth-witness precision limitation in platform evidence.
