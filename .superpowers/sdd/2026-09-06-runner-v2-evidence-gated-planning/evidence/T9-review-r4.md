# T9 independent review — round 4 (narrow)

Reviewer: independent reviewer (not the T9 author). I did not edit any source or test file. This review is the only file I wrote in the repo. Nothing was committed, staged or stashed.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, base `57e80f45`. T9 and repair cycles 1–3 are uncommitted (15 modified files, 2 untracked). This review did not change them: `git status --short` is identical before and after, apart from this file.

## Scope

- **Round-3 findings to verify:**
  - **B4-r3** (blocking): guidance acknowledged as `folded_into_planning` could be swallowed before plan readiness.
  - **N-C**: on an answered run, guidance acknowledged after the answer was never reflected in it.
  - **NOTE-1**: the prompt sentence was unconditional.
  - **N-D** is recorded as "not done" and belongs to T7.
- **What I read:**
  - `T9-review-r3.md`
  - the brief `t9-repair3.txt`
  - evidence `T9.md` "## Repair cycle 3", including the worker's stated limit that a checkpoint alone cannot unbind a stale review
- **Cycle-3 delta:** I diffed the round-3 byte-identical copy (`review-scratch-t9-r3\copy`) against the tree.
  - 6 source files changed: `scheduler-store.ts`, `planning-projection.ts`, `build-runtime.ts`, `planning-review.ts`, `agent-prompts.ts`, `native-architect-runtime.ts`.
  - `request-triage.ts` changed.
  - 2 tests changed: `request-triage.test.ts`, `planning-review.test.ts`.
  - No other file changed.
- **Probes** (outside the repo):
  - `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t9-r4\probe-r4.test.mts` runs the real `SqliteSchedulerStore`, `SqliteEvidenceStore`, `BuildRuntime` pump and Architect tool registry (`record_planning_checkpoint`, `request_coverage_review`, `revise_planning_plan`, `acknowledge_user_guidance`), with no seeded evidence.
  - I also re-ran the round-3 `probe-r3.test.mts`.

## Verification

| Item | Verified? | Basis |
|---|---|---|
| **B4-r3 kernel** | **Yes** | See the three bullets below the table. |
| **B4-r3 pump mirror** | **Yes** | `build-runtime.ts:2291-2295`: a bound review requested at or before the fold returns `undefined` (the Architect gets `plan_required`) and never reaches `appendPlanReady`. Without the mirror, the kernel still refuses. See prove-red 2: the gate records the kernel text, so the check is defense in depth. |
| **R1 inverted** | **Yes** | See the R1 row under "Commands and exact counts" (round-3 probe re-run). |
| **R1b control** | **Yes** | The round-3 probe R1b still passes: after readiness, `folded_into_planning` is refused with "requires no ready plan". |
| **Re-planning window** | **Yes** | Probe D3 runs ready → new verdict (not ready) → fold → the stale review is not re-used → post-fold revision → new review with the guidance → ready. The worker test is at `request-triage.test.ts:4112`. |
| **Reviewer context, T3b blindness** | **Yes** | Only the two `buildCoverageVerdictContext` calls changed (`planning-review.ts:1992,2194`), and both render guidance after `recorded-obligations` (`agent-prompts.ts:457-465`). The derive pass (`buildCoverageDeriveContext`, `:1792`) is unchanged. Blindness concerns the plan, not user guidance. |
| **Architect planning status** | **Yes** | `renderPlanningStatus` lists acknowledged guidance with its text and resolution, plus the two flags (`agent-prompts.ts:734-786`). Probe statuses show `folded_into_planning:<text>` with `afterFold:false`, and `turnAfter` flips false→true after the checkpoint. |
| **N-C** | **Yes** | See the N-C bullets below the table. |
| **NOTE-1** | **Yes** | `native-architect-runtime.ts:224-226` uses the `folded_into_planning` sentence only when `planningPolicyVersion === 1`. The legacy text is identical to the pre-T9 wording. |

**B4-r3 kernel details:**
- `latestFoldedIntoPlanningAck` is stamped only in the folded-ack branch, at `scheduler-store.ts:3614-3623`.
- `foldedGuidancePlanReadyBlocked` (`:1005-1026`) is enforced before the event on `planning.plan_ready` (`:2461-2468`). It refuses in two cases:
  - the bound review's `requestedSequence` is at or before the fold;
  - no draft, revision or checkpoint postdates the fold.
- The sequence is threaded into the planning reducer (`:2476`), and the projection stamps are at `planning-projection.ts:1498,1534,1568`.
- It is a no-op when no fold exists or on legacy runs, so pre-T9 logs replay untouched.

**N-C details:**
- `answeredRunReadiness` (`scheduler-store.ts:961-975`) requires an answer whose sequence is greater than the fold.
- The answer-review input always carries acknowledged guidance (`build-runtime.ts:2510-2513`, `:2699-2714`).
- Both reviewer passes render it (`request-triage.ts:1120-1124`, `:1278-1282`), and malformed entries fail closed (`:1544-1552`).
- There is no loop without bound: each fold needs exactly one newer answer.

### Deadlock hunt: guidance that needs no plan change, arriving between a passing review and `plan_ready`

The worker's stated limit is correct: a checkpoint cannot unbind a stale bound review. `request_coverage_review` refuses with `coverage_review_current` while the current review matches the revision, digest and manifest (`planning-review.ts:1294-1306`).

That limit does **not** produce a deadlock. A revision with identical content is accepted:
- `revise_planning_plan` only requires a *new* `revisionId` (`planning-tools.ts:660-665`), and the reducer refuses nothing else for identical content (`planning-projection.ts:1503-1537`).
- The digest covers the whole revision, including `revisionId` (`planning-contracts.ts:962-970`). The no-op revision therefore gets a new digest, the old review is unbound, and a new request is allowed.

I drove it through the real pump with a sensible scripted Architect:
- **Planning turn 0:** it records a checkpoint "reviewed against guidance" and then tries `request_coverage_review`.
- **Planning turn 1:** it revises with identical content (new id only) and then requests review.
- **Turn 2:** a third planning turn would throw ("would loop").

| Variant | Pump steps to ready | Architect turns | Coverage reviewer calls | Result |
|---|---|---|---|---|
| D1: guidance after passing verdict (R1 timing) | 5 (`user_guidance_required`, `plan_required`, `plan_required`, `coverage_review_recorded`, `plan_ready`) | 3 (ack, checkpoint + request refused `coverage_review_current`, no-op revise + request ok) | 1 (`coverage_revision_noop`, prior `coverage_1`, guidance text present) | ready on `revision_noop` |
| D2: guidance while the pre-fold review is in flight | 6 (adds the in-flight `coverage_review_recorded`) | 3 | 2 (`coverage_1`, which saw the guidance, then `coverage_revision_noop`) | ready on `revision_noop` |
| D3: re-planning window (ready → new verdict → fold) | 5 | 3 | 1 (prior `coverage_2`) | ready on `revision_noop` |

Code reading of the other path to a post-fold review with no revision (a source amendment after the fold, then a request): the kernel refuses on the "no planning turn" arm. The pump records a non-terminal `plan_ready_blocked` gate, which falls through on the next step (`build-runtime.ts:2279-2281`). A checkpoint then satisfies the rule on the still-bound post-fold review. This path does not deadlock either.

The N-C analogue does not deadlock. `record_answer`'s idempotency key is `request-answered:${lastSequence}` (`request-triage.ts:269`), so an identical re-answer after the fold is accepted. The probe confirms it clears the fold issue, and a fold before the answer imposes nothing.

## Findings

### BLOCKING

None.

### NON-BLOCKING

- **N-E: the refusal text points at a remedy that the tool refuses.**
  - The kernel's (b) text (`scheduler-store.ts:1021-1025`) says "revise the plan or record a checkpoint reviewed against the guidance, then request a new coverage review". The (a) text (`:1014-1017`) says "request a new coverage review after the acknowledgement".
  - When the stale review is still bound, the request tool refuses `coverage_review_current` until the Architect revises. In practice this costs one wasted Architect turn: D1, D2 and D3 each took checkpoint → refusal → revision. The tool's own error ("revise the plan to request a scoped re-review") steers the Architect correctly.
  - Minimal fix: the (a) text should say "revise the plan (a new revision id suffices), then request a new coverage review". Optionally, `renderPlanningStatus` could add a one-line hint when `boundReviewRequestedAfterFold === false`.
- **N-F: conservative extra review (D2).**
  - A review requested before the fold but executed after it did see the guidance: the pump snapshots guidance at review time (`build-runtime.ts:2399-2402`). It is still treated as stale because the gate keys on the request sequence.
  - The cost is one extra Architect revision and one extra review. This is fail-safe and matches the brief's rule ("requested AFTER"), so it is not a defect.
  - Possible refinement: key on the obligations or verdict sequence instead.

### NOTES

- **NOTE-A (N-D, recorded as not done):** the client type `lib/client/runner-v2.ts` still lacks `folded_into_planning`. It belongs to T7.
- **NOTE-B (replay):**
  - The plan_ready gate runs in the reducer on replay. That is deterministic, because it depends only on prior events.
  - Pre-T9 logs have no fold. Logs with no fold are unaffected by the gate.
  - The only logs that could newly fail replay are uncommitted dev logs written by T9 cycles 1–2 in which a fold preceded a `plan_ready` on a stale review. That is exactly the B4-r3 defect state and has no production footprint.
- **NOTE-C (idempotency):** `sameCoverageReviewRequest` (`planning-projection.ts:986-996`) compares all six payload fields of `CoverageReviewRequestRecord` and excludes only the new stamp. An identical re-append keeps its first sequence, and the tool key `planning-coverage-request:${reviewId}` is unchanged.
- **NOTE-D (diff hygiene):**
  - `git ls-files --eol` shows `i/lf w/crlf` with `core.autocrlf=true`.
  - Every changed or untracked file is uniformly CRLF: 0 LF-only lines across all 17 files.
  - `git diff` contains 0 added or removed lines carrying a stray `\r`. `--numstat` shows only content hunks (no full-file churn).
  - The cycle-3 delta against the round-3 copy touches only the intended hunks: fold stamp, gate, sequence threading, request/turn stamps, pump mirror, verdict-context guidance, answer-review guidance, and the prompt sentence.
- **NOTE-E (regressions checked, code reading plus probes):**
  - T3 admission and coverage logic are unchanged apart from the added gate and stamps.
  - Legacy runs: the gate and N-C both require a fold, and folds require policy 1.
  - Answered-run zero-mutation: no mutating path was added.
  - Triage-first: unchanged, and `request_coverage_review` still requires `build`.
  - Idempotency keys are deterministic, as above.

## Claims check

- **sha256 of all 17 files in "Repair cycle 3 → Changed files" match the tree: 17/17** (`sha256sum -c`, 0 mismatches).
- **Worker suites were not re-run** (owner rule): 21 files, 433/433.
- **Prove-red, reproduced in a byte-identical scratch copy.**
  - The copy is `review-scratch-t9-r4\copy`. 517 tracked and untracked `runner-v2` files were hash-compared with `cmp`: 0 diffs. `node_modules` is a junction.
  - Injections used a byte-preserving Node replace with exactly one match. Each `diff` showed exactly 1 line changed.

  | # | Guard | Injection | sha256 BEFORE / DURING / AFTER | Result (`request-triage.test.ts`) |
  |---|---|---|---|---|
  | 1 | Kernel `plan_ready` fold gate | `scheduler-store.ts:2467` `if (foldedBlocker)` → `if (false && foldedBlocker)` | `bce9ed4c…` / `1e56623b…` (**same as the worker's DURING**) / `bce9ed4c…` | 35 tests, 33 pass, 2 fail: the B4-r3 main test (`:3851`, `Missing expected exception` at `:4024`, the stale `plan_ready` wrongly succeeds) and the re-planning-window test (`:4112`) |
  | 2 | Pump mirror (extra, not in the worker's evidence) | `build-runtime.ts:2294` `false &&` | `3ee9e84c…` / `39809721…` / `3ee9e84c…` | 35 tests, 34 pass, 1 fail: `:4112` "readiness was not attempted". The pump now attempts readiness, and the kernel still refuses with "coverage review coverage_2 was requested before user guidance g2 …" |
  | 3 | N-C answered readiness | `scheduler-store.ts:965` fold read forced to `undefined` | `bce9ed4c…` / `7b5da52d…` / `bce9ed4c…` | 35 tests, 34 pass, 1 fail: the N-C test, with issues `["docs/project/STATE.md has not been committed."]` (the re-answer demand is gone, matching the worker's evidence) |

  - After each injection I restored the file from the saved original and confirmed with `cmp` that it is byte-identical to the worktree.
- **The worktree was never modified.** The 17 hashes were re-checked after all runs: 0 mismatches.

## Commands and exact counts

- `sha256sum -c` over the 17 evidence hashes: 17 OK, 0 mismatches.
- `probe-r4.test.mts`: 4 tests, 4 pass, 0 fail. These are D1, D2, D3 and N-C (identical re-answer clears the fold issue; a fold before the answer leaves no issue).
- `probe-r3.test.mts` re-run: 5 tests, 4 pass, 1 fail.
  - R1 fails with "architect not expected: plan_required". This is the **intended inversion**: step 2 is now a planning turn, not `plan_ready`.
  - R1b, R2, R3 and R4 pass.
- Prove-red in the scratch copy: 3 injections × `request-triage.test.ts` (35 tests) gave 33/2, 34/1 and 34/1, each failing exactly the targeted tests.
- No full suite was run, and no suite from the worker's list was re-run.

## Verdict

T9 REVIEW r4 — ACCEPT
