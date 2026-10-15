# FX-1 - independent code review r1

Reviewer: fresh-context independent reviewer. I did not write this code. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `6e8c7ef4`; FX-1 changes uncommitted.
Inputs: brief `fx1-brief-muse.txt`, plan FX-1 section (CD-16), `C2b-review-r3.md` (NF-6, probe RA), `evidence/FX-1.md`.
The sha256 of all three changed files matches `evidence/FX-1.md`, both before and after my probes (`build-runtime.ts 81ae3dc1…c744a`, `build-risk-reassessment.test.ts 4cf15b68…a30f`, `docs-policy-v2-handoff.test.ts d8b29fbe…5e7c`).
My probes ran from a temporary test file that I have since deleted. A copy is in my scratchpad as `zz-fx1-review-probe.test.ts`. `git status` is back to the worker's set.

**Verdict: ACCEPT**

The fix is correct and general. The key `build-risk:${targetRevision}:${finalVerification.generationId}` is unique for each final-verification (FV) generation, comes from durable state, and is stable on replay. The livelock is gone for v1 and docs-v2, whether the guidance withdraws a handoff or arrives before any handoff. A run already livelocked under the old key recovers after the upgrade. No finding blocks FX-1.

Separately, the worker's `complete_run` finding is **CONFIRMED: HIGH, pre-existing, not caused by FX-1** (section CR-1). FX-1 now exposes it. Before FX-1 the run spun on assessRisk and never reached the Architect. Now it reaches the Architect and gets stuck in a loop of pauses.

## 1. Is the livelock gone, and is the key sound?

- **Where the key comes from.** `projection.finalVerification.current` is checked non-null (`build-runtime.ts:1697`). `generationId` is a required non-empty string (`parseFinalVerificationGeneration`, `scheduler-store.ts:7575`). The reducer refuses a second generation while one is current, and refuses to bring back any id already in the history ("cannot be reactivated", `scheduler-store.ts:5628-5639`). FV history is append-only (it is only ever built at :5381, :5666 and :9816). Production ids come from the log (`final-verification-generation-<hash><-n>`, where n is the history length, `architect-tools.ts:1852-1864`) and are stored in the event payload. So the id is never undefined, never reused within a run, and the same on replay and restart.
- **No duplicate or stale assessment.** Build risk is invalidated only by a revision advance (:5392) or by guidance (:9828). Both also remove the current FV generation, so any new generation starts with no current risk, and each generation gets at most one assessment. The check after `assessRisk` (`:1711-1718`) drops an assessment whose generation went stale. Probe E: guidance-2 landed during the assessment, so nothing was appended (`build_risk_assessment_invalidated`). Re-appending the same event returns the same eventId. The same key with a different payload throws `Scheduler idempotency conflict`.
- **Old logs.** `recordBuildRiskAssessment` (`:5458-5530`) reads only the payload, never the key. No code reads the `build-risk:` prefix (grep of src and test). `pre-capability-run.fixture.json:741` keeps the old shape in the replay fixture. Probe H: a log livelocked under the old key, reopened with FX-1 code, records `build-risk:<R>:gen-h-rerun` next to the old `build-risk:<R>` and completes.
- **Behavior change.** At the same revision, a re-assessment whose input changed used to throw an idempotency conflict. It is now recorded. The rule that a high assessment cannot be lowered for the same revision (`:5503-5508`) is unchanged.

## 2. Other revision-scoped keys (brief item 3)

I spot-checked the keys the worker lists:
- `verifier:*:<reviewId>`: the review id hashes the FV generation (`native-verifier-runtime.ts:1170-1185`). Safe.
- `final-verification-plan:<rev><suffix>`: safe.
- `${generationId}:*`: safe.

Plan-critique, repair-cycle, planning, question and acknowledgement keys are versioned or are not state that guidance invalidates. One listed rationale is wrong (N1).

## Findings (FX-1)

| # | Severity | Where | Finding | Suggested action |
|---|---|---|---|---|
| N1 | MINOR (pre-existing, not guidance-specific; route to controller) | `build-runtime.ts:1862` `verifier-selection:${targetRevision}:${reason}`; the evidence's "SAFE" line | The evidence says a same-key re-append "returns the existing user-selection pause". That is wrong once the owner has already made a selection. **Probe F**: a high-risk run gets `selection_required`, the owner selects, and the verifier is unavailable again with the same reason. The append then dedupes and nothing is recorded. `step()` returns `paused/verifier_selection_required` while the projection stays `running` with selection `selected`. There is still 1 `selection_required` event, and verify is called on every step. Under the manager, the pump stops on "paused", and the run sits in `running` with no prompt. Guidance on an unchanged revision reaches this path again (it re-runs verify at the same revision), but a selection alone can reach it too. | Correct the evidence line. Open a follow-up to key the selection by occurrence (for example the selection-history count or `lastSequence`). |
| N2 | MINOR (validation gap, closed here) | `evidence/FX-1.md` Suites | The brief asks for the importer suites of every changed file. Several importers of `build-runtime.ts` on the verifier/risk/guidance path were not listed. I ran them: native-verifier-factory, plan-critique-runtime, repair-cycles, change-risk, planning-tools, user-steering-runtime and final-verification-completion gave **100 pass, 0 fail**. The other importers never construct an independent verifier (grep for `independentVerifier` and `verifier-run-fixture`), so the changed line cannot run there. | Note it in the evidence. |
| N3 | MINOR (test strength) | `build-risk-reassessment.test.ts` v1, docs-v2 and restart tests; G2-prod and G3 | "Completes" is reached through a seeded `project.handoff_requested` (`handoff-2`), which production cannot produce (see CR-1). This is disclosed under "Not done". No test shows a production-real completion after a re-assessment. My **probe D** does (v1 and v2 complete through a real first `complete_run`). | Optional: add probe D, guidance before any handoff, as a regression test. |
| N4 | NIT | evidence | The `verifier-selection` line number is `build-runtime.ts:1862` in the final bytes, not :1853 (it moved when the comment block was added). | Fix the reference. |

**Tests fail for the right reason.** I simulated the old key without editing source: a store subclass rewrites the `build.risk_assessed` key to `build-risk:<rev>` (probe G). In the worker's RA scenario and in the case without a handoff, `stepUntilReassessed` (10 steps) makes 10 `assessRisk` calls and leaves 1 risk event, so the worker's behavioral assertion `risks.length === 2` fails. Then `runUntilBlocked(20)` returns `step_allowance_yielded`. The worker's recorded prove-red failed first on the key-shape assertion. The behavioral assertions after it also catch the livelock.

**C2b tests.** G2-prod and G3 keep every C2b assertion: withdrawn-stop history, chain parent, transient pause, retry on resume, project order, one Architect call. Only the `risk:rerun-low` seed is replaced, by the real re-assessment plus a key assertion, and the stop-1 seed is unchanged. The harness runtime now has the verifier. Stop 1 is unaffected because the seeded risk is current, so `assessRisk` is not called. The two tests still prove what they proved, and they now also guard FX-1.

**Encoding.** All three files: no BOM, LF only (0 CRLF, 0 lone CR), no trailing whitespace, ending in LF. `build-runtime.ts` has 69 non-ASCII bytes, the same as HEAD. The other two files have 0 non-ASCII bytes (HEAD also 0 for the handoff test). `git diff --check -- runner-v2` is clean.

## CR-1 - `complete_run` fixed idempotency key (separate; not counted against FX-1)

| Field | Value |
|---|---|
| Verdict | **CONFIRMED** |
| Severity | **HIGH**: a permanent stuck-run class. Each resume costs one Architect model turn. |
| Where | `architect-tools.ts:2399` uses `idempotencyKey: "project-handoff-requested"` (from `f9acace3`, 2026-07-12). Guidance withdraws a requested handoff at `scheduler-store.ts:4515-4530` (from `826bcdcc`, 2026-08-27). Every `project.handoff_requested` is written through this key (grep of src). |
| FX-1 touched it? | No. FX-1 does not change `architect-tools.ts`. |
| Mechanism | The reducer accepts a second request after a withdrawal (`:5058`). The store dedupes before the reducer runs. With the same summary and actor, the old stop-1 event is returned with `isError:false` and no new event. With a different summary (or a different Architect runtime id after a failover), the result is `mechanical_transition_rejected: Scheduler idempotency conflict for project-handoff-requested`. Either way `projectHandoff` stays empty, and the runtime throws `Architect returned from completion_decision_required without a typed action.` (`build-runtime.ts:1406-1410`). |
| Scope | Any run whose requested handoff is withdrawn by guidance, with or without a plan change, because the key ignores the revision. My probes cover finish runs, v1 and docs-v2. plan_only runs use the same tool, so they are affected by inspection. There, the handoff sits "requested" waiting for the owner, which is exactly when an owner is likely to give guidance. |
| Exit? | None in product. Resume pauses again, the owner's selection is refused ("Final project handoff is not awaiting user selection."), and there is no cancel. In docs-v2, the stop-1 kernel snapshot commit stays in the integration branch and is never reconciled, because stop 2 never happens. |
| Suggested fix | Key the request by stop occurrence. Keep the old key for the first request so replay is unchanged, and use `project-handoff-requested:<projectHandoffHistory.length>` (or the guidance version) after a withdrawal. Then make the tests use it in place of the `handoff-2` seeds. This needs a controller packet, because `architect-tools.ts` is outside FX-1's writable set. |

## Probes (real SQLite, real git, advancing clock, production-shaped verifier with the real `deriveNativeVerifierRiskInput`, production `NativeBuildManager` unless the probe says "runtime direct")

| Probe | Setup | Result |
|---|---|---|
| RA-v1 (runtime direct, as in C2b r3) | v1 finish run to the handoff, then guidance `no_plan_change`, then a green FV re-run on the same revision, then `runUntilBlocked(20)` | Stop 1: `paused`, `requested`, risk low, key `build-risk:<R>:gen-ra-v1`. After guidance: **1 assessRisk call**, keys `…:gen-ra-v1` and `…:gen-ra-v1-rerun`, risk current, history `[invalidated]`. **No livelock.** The Architect is re-invoked and `complete_run` gives `isError:false, newRequest:false`, then the runtime throws `Architect returned from completion_decision_required without a typed action.` (CR-1). |
| RA-v2 (runtime direct) | same, with a docs-v2 seed | Stop 1: 1 snapshot, key `…:gen-ra-v2`. After guidance: 1 assessRisk call, key `…:gen-ra-v2-rerun`. Then the same CR-1 throw. |
| RA-v1-diff | the second `complete_run` uses a different summary | The tool returns `Scheduler idempotency conflict for project-handoff-requested.`, then the same runtime throw. |
| C-v1 (manager) | withdrawn handoff, then `activate`/`awaitIdle`, then 3 resume cycles, then owner selection | cycle 0 and cycles 1-3 all end `paused/autonomous_pump_error` with no handoff. Architect calls go 2→3→4→5 (one model turn per cycle). The risk keys stay at 2. Owner selection is refused: "not awaiting user selection". |
| C-v2 (manager, factory-built port) | stop-1 snapshot read fails, then guidance, FV re-run, and 2 resume cycles | Stop 1 is `handoff_snapshot_failed`. Every cycle ends `autonomous_pump_error` with 0 snapshots recorded, and Architect calls go 2→3→4. Owner selection is refused. (44.5 s) |
| D-v1 and D-v2 (manager) | guidance after the risk is assessed but before any handoff, then an FV re-run, then a real first `complete_run` | Both **`completed`/`apply_to_project`**. Keys: G1 and G2. 1 assessRisk call after guidance. 1 Architect call with `newRequest:true`. No pump errors. v2 has 1 snapshot. |
| E (manager) | stale generation, then a crash before the append, then a restart, then replay | Stale step: `build_risk_assessment_invalidated`, no append. Crash inside `assessRisk`: no key recorded. After `recover`: exactly one `…:gen-e-g3`, then `completed`. Replay of the same event gives the same eventId and no new row. Same key with a different payload throws a conflict. |
| F (runtime direct) | high risk, verifier unavailable, owner selects, verifier unavailable again | See N1: 3 steps each return `paused/verifier_selection_required`, status `running`, selection `selected`, 1 selection event, verify calls 2→3→4. |
| G (old key simulated) | old-key store in the RA shape, and in the no-handoff shape | Both: after 10 steps, 1 risk event and 10 assessRisk calls; `runUntilBlocked(20)` gives `step_allowance_yielded`, `riskCurrent:null`, and 30 calls in total. |
| H (in-flight upgrade) | livelocked under the old key, then reopened with FX-1 code | Before: `step_allowance_yielded`, key `build-risk:<R>`. After: `completed`, keys `build-risk:<R>` and `build-risk:<R>:gen-h-rerun`, 1 Architect call. |

## Suites (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- Run by me, not run by the worker: native-verifier-factory, plan-critique-runtime, repair-cycles, change-risk, user-steering-runtime, final-verification-completion and planning-tools: **100 pass, 0 fail** (22 s).
- Not re-run, because the worker ran them green on byte-identical files (hashes verified): build-risk-reassessment (4), docs-policy-v2-handoff (44), build-runtime (28), scheduler-store with verifier-contracts (72), native-build-manager (58), replay-compatibility with the audits (42), native-delivery-factory (17), runner `tsc`, and eslint. My probes raised no concern in their scope.
- Not run by anyone: the other importers of `build-runtime.ts` (project-docs, request-triage, t6b-repair-*, final-verification-review/repair/orchestration/execution/integrity, control-server, and others). None of them constructs an independent verifier, so the changed line cannot run there.
