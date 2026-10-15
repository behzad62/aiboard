# T6b review r3 (independent reviewer)

Scope: uncommitted T6b on `codex/runner-v2-p6-6`, base `7d21be0b`, after repair cycle 2a (controller: R2-B6, R2-B4) and repair cycle 2b (Muse: R2-B1, R2-B2, R2-B3, R2-B5, lifecycle surface, N-items). I did not write this code and I have no memory of rounds 1-2 beyond `T6b-review-r2.md`. Owner rule applied: the fixers' green suites were not re-run. I re-ran the r2 probes, wrote inverted r3 probes, and reproduced two prove-reds. I edited no source or test file and committed nothing.

Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6b-r3\repo`. It holds a copy of `runner-v2/`, `package.json` and `tsconfig.json`, plus a junction to the worktree `node_modules`. All 36 hashes were verified identical before use.

## Integrity

- **START.** I hashed all 36 files in `git status --short`. All 36 match the "sha256 of all uncommitted files (2a + 2b final state)" list in `evidence/T6b.md` (the only difference is sha256sum's binary-mode `*` marker).
- **END.** I re-hashed all 36 files. `diff start.txt end.txt` shows no differences. The only new file in the worktree is this review.
- **Scratch restore.** Every prove-red mutation was restored byte-exact:
  - `native-build-factory.ts` `22e51d4a…`
  - `repair-approach-contracts.ts` `002e3667…`
  - `scheduler-store.ts` `478f6530…`
  - The scratch hash list equals START after the restore.

## Verification table

| r2 blocker | Verdict | Evidence |
|---|---|---|
| R2-B6 cleanup safety | **FIXED** | See the R2-B6 detail below and PROBE-F3. |
| R2-B4 npm failing ids and flaky rerun | **FIXED** | See the R2-B4 detail below. |
| R2-B1 pause keys | **FIXED** | See the R2-B1 detail below. |
| R2-B2 boundary tool path | **FIXED** | See the R2-B2 detail below. A new identity defect is now reachable: **R3-B1**. |
| R2-B3 empty-evidence relabel | **FIXED** | See the R2-B3 detail below. |
| R2-B5 review charging and FV identity | **FIXED as scoped, with a regression** | See the R2-B5 detail below. Cycle 2b's N-1 change broke the "one decision per dispatch" guarantee: **R3-B2**. Boundary identity is still category-only: **R3-B1**. |

**R2-B6 cleanup safety.**
- **Roots.** `nativeBuildCleanupRoots` (`native-build-factory.ts:3740-3756`) returns only this run's six workspace paths. `tmpdir()`, the state directory and the run root are never roots.
- **PROBE-F3 (production root builder).** These are all retained and survive:
  - a `%TEMP%` user folder
  - `<state>\credentials-dir`
  - a `<state>\builds\run-1` folder
  - a `ws\..\..\credentials-dir` traversal
  - a junction inside the workspace (the target file survives)
  - another run's workspace report

  Only the recorded report inside this run's verification workspace is deleted.
- **Links.** `lstat` is used, and a junction reports `proven/retained`.
- **Recorded non-retained paths.** The only non-retained records production writes are root-level `.aiboard-report-*.xml` files. There is no intermediate path component that a junction could redirect.
- **Search sites.** Searches run after:
  - worker ticks (`build-runtime.ts:1248`)
  - the verifier (`:1688`)
  - review (`:2343`, `:2348`)
  - boundary (`:2461`, `:2485`)
  - FV checks and the flaky rerun (`:3277`, `:3288`, `:3401`)

**R2-B4 npm failing ids and flaky rerun.**
- The FV `run test` command is planned with T6a `planTestReport` (`final-verification-runtime.ts:664-686`). The rerun is narrowed through NODE_OPTIONS `--test-name-pattern`, and the planner marks the run filtered.
- Counts come from T6a `nodeJunitOutcome`: executed = passed + failed. Skipped cases and file-level entries never count.
- The factory test asserts failing id `["t6b red"]`, the flaky/consistent verdicts, a single charge at dispatch for fail-again (`t6b-repair-factory.test.ts:275-283`), and cleanup of both report files.
- **NODE_OPTIONS spoof check.** The skip keys on `command.environment`, which is the runner-built command spec. The derived FV tests command never carries an environment (`final-verification-profile.ts:241-243`), so a project's own NODE_OPTIONS cannot trigger the skip. What happens instead:
  - An ambient NODE_OPTIONS with its own `--test-reporter` makes the planner return `unsupported`, so no report is produced and the rerun is recorded `not_performed`.
  - A `.npmrc` `node-options` setting means no report is produced, so the rerun is recorded `not_performed`.
  - Both are honest and are never counted as flaky.

**R2-B1 pause keys.** The pause key is `…:${used}/${limit}:${lastSequence}` (`build-runtime.ts:3114`). The r2 probes, re-run inverted, now pass:
- **PROBE-G:** after the owner's extension, the next exhaustion pauses again. There are 2 pause events and the end status is `paused`.
- **PROBE-H:** after a generic resume, the run re-pauses durably. `pauseReason` is set and there are 2 pause events.

**R2-B2 boundary tool path.** Issues are opened before the Architect turn (`build-runtime.ts:2415-2426`). PROBE-J2 is the r2 PROBE-J corrected to decide every visible `delivery-boundary:*` issue. With it:
- both decisions are accepted;
- `resolve_delivery_boundary_failure` succeeds;
- `T1-fix` is created;
- both issues are charged once.

The r2 PROBE-J still fails, but only because it decides `issues[0]`, which is now `delivery-boundary:build`. The tool's refusal names the missing `delivery-boundary:tests` issue, so this is a probe artifact, not a defect.

**R2-B3 empty-evidence relabel.** PROBE-I2 uses real store evidence ids (the r2 PROBE-I now stops earlier, at the N-3 unknown-evidence gate).
- All of the following are refused with `invalid_repair_approach_decision`:
  - empty evidence with the same hypothesis;
  - the same evidence with the same hypothesis;
  - empty evidence with a new hypothesis;
  - new evidence with the same hypothesis and the same diagnostic set;
  - a repeat citing the failure's own evidence.
- A plan attempted after those refusals is refused.
- A genuinely new approach with new evidence is accepted and dispatches, taking `used` from 1 to 2.
- The reducer backstop mirrors the tool check (see PR-R3-B3).

**R2-B5 review charging and FV identity.**
- Review fix rounds charge `delivery-review:<task>:<criterion|finding>` (`build-runtime.ts:3210-3259`).
- The FV identity is the category plus the sorted failing ids (`repair-budget-contracts.ts:62-72`).
- The factory fail-again run charges once at dispatch.

Regression checks (read-only; the fixers' suites were not re-run):
- T6a real-counts: the `delivery-execution.ts` diff is additive only (`failingTestIds`).
- Legacy gates: `prepareRepairDispatch`, `chargeReviewFixRound` and `recordCleanupSearch` are all guarded by `planningPolicyVersion === 1`.
- N-4 migration: base `7d21be0b` has no `model_review_outcomes` table, so a base DB gets a fresh create.
- Deterministic keys: pause, cycle and cleanup keys derive from sequence and identity, not the clock.

## Prove-red records (scratch; sha256 before, mutated, restored)

1. **PR-R3-B6: production roots widened back to the old wholesale set.**
   - Mutation: `native-build-factory.ts:3748` `return [` became `return [tmpdir(), stateDirectory, join(stateDirectory, "builds", runId),`.
   - Hashes: `22e51d4a…fd95f5` → `ce0a3226…67efa` → `22e51d4a…fd95f5`.
   - `probe-r3-cleanup.test.ts` (PROBE-F3): tests 1, pass 0, **fail 1**, on the structural assertion "root must not be tmp/state".
   - With `PROBE_SKIP_ROOT_ASSERT=1`: tests 1, pass 0, **fail 1**. `ALIVE` shows the `%TEMP%` user folder, the state credentials folder, the run-root folder and another run's report all **deleted**. Only the junction target survives, because lstat does not follow the junction.
   - After the restore: tests 1, pass 1.
2. **PR-R3-B3: the empty-evidence relabel gate disabled in both layers.**
   - Contract alone: `repair-approach-contracts.ts:92` `if (priors.length > 0)` became `if (priors.length > 0 && false)`.
     - Hashes: `002e3667…` → `b61fda27…`. The mutated hash is identical to the fixer's PR-B3.
     - PROBE-I2 stays green: the reducer backstop refuses with `mechanical_transition_rejected`. Defense in depth is confirmed.
   - Plus the reducer: `scheduler-store.ts` R2-B3 empty-evidence line prefixed `false &&`.
     - Hashes: `478f6530…` → `04af3a94…`.
     - PROBE-I2: tests 1, pass 0, **fail 1**: `C_emptyEvidenceNewHyp must be refused`. The empty-evidence decision is accepted, the plan dispatches, and `used` goes from 1 to 2.
   - Both files were restored to `002e3667…` and `478f6530…`.

## Findings

### BLOCKING

**R3-B1: the delivery-boundary issue identity is the category alone, so unrelated tasks share one 3-cycle budget and the run falsely pauses.**
- **Where.**
  - `build-runtime.ts:2419-2422` and `architect-tools.ts:1353` key the issue as `delivery-boundary:${check.checkId}`, and `checkId` is the category (`delivery-execution.ts:928`: `checkId: category`).
  - `repair-budget-contracts.ts:50` and `:69` pass `delivery-boundary:*` through unchanged.
  - `repairIssueIdentity` hashes only `projectId + rootCause`, so every task in the run maps to the same `delivery-boundary:tests` and `delivery-boundary:build` issues.
- **Scenario (PROBE-J3).** T1, T2, T3 and T4 each fail their boundary once, and each fix passes. The Architect records a distinct decision per task and resolves through the real tools.
  - After T1, T2 and T3 the issues read `delivery-boundary:build used=3` and `delivery-boundary:tests used=3`.
  - T4's **first** boundary failure pauses the run with `repair_issue_paused: Issue delivery-boundary:build used 3/3 repair cycles`.
  - In any plan with more than three tasks, ordinary first-time boundary failures therefore stop the build and require an owner extension.
- **Why it blocks.** This is the same "category alone" identity defect that r2 marked blocking for final verification (R2-B5). The brief requires category + affected obligation/contract + failing check ids. R2-B2 made this path live in cycle 2b. Approach lineage also leaks across tasks: one task's approach is superseded, and so counted failed, by another task's decision.
- **Minimal fix.**
  - Key boundary issues as `delivery-boundary:<taskId>:<checkId>`, plus the sorted failing test ids from the check report when present, through one shared helper used by both `build-runtime.ts` and `architect-tools.ts`.
  - Add PROBE-J3 as a regression test: four tasks each fail once and no pause occurs; one task fails four times and the fourth pauses.

**R3-B2 (regression from cycle 2b N-1): one approach decision now authorizes unlimited dispatches, so a failed approach is repeated without a new decision or new evidence.**
- **Where.**
  - `scheduler-store.ts:3897`: `approach.failed = outcome !== "resolved" && outcome !== "dispatched"`. A dispatched approach stays live.
  - No production site ever records a later `failed` or `resolved` outcome for an approach. The only approach-bound cycle outcome written is `"dispatched"` (`architect-tools.ts:954`).
  - `liveRepairApproach` (`architect-tools.ts:904-908`) accepts any latest non-failed approach.
- **Scenario (PROBE-LIVE).** This is the fixers' own "three real fixes on the same failing test" loop, changed so the Architect records a decision **only in round 1**:

  | Round | Approach state before | Plan result |
  |---|---|---|
  | 2 | `three-round-a1:failed=false`, used 1 | accepted, dispatched, charged |
  | 3 | `three-round-a1:failed=false`, used 2 | accepted, dispatched, charged |

  The test still passes, meaning three dispatches came from one decision. The approach that already failed validation in round 1 is re-dispatched twice with no `record_repair_approach_decision`, no explicit repeat and no new evidence.
- **What this breaks.** The contract guarantees "repeat without new evidence refused" and "a within-budget attempt is not automatically authorized". In r2 this was held, because dispatch marked the approach failed.
- **Minimal fix.** Make a decision authorize exactly one dispatch.
  - Either: mark the approach consumed (`dispatched: true`) on its cycle, and make `liveRepairApproach` return nothing for a consumed approach while context and display still show it as "pending".
  - Or: record the real `failed` outcome, with the new failure evidence, when the next generation of the same issue fails. Record it before the repair turn, so the next dispatch requires a new decision.
  - Add PROBE-LIVE as a regression test: round 2 with no new decision must be refused with `repair_approach_decision_required`, and `used` must stay unchanged.

### NON-BLOCKING

- **N-1.** `chargeReviewFixRound` silently skips the charge when a member has no evidence (`build-runtime.ts:3246` `if (evidenceIds.length === 0) continue;`). Bounded today by the task attempt limit. Fix: charge with the review record id as evidence, or pause.
- **N-2.** The `model_review_outcomes` pre-N4 rebuild (`sqlite-project-memory.ts:190-203`) runs RENAME, CREATE, INSERT and DROP outside a transaction. A crash in the middle loses rows. It only affects pre-N4 T6b development DBs. Fix: wrap it in `BEGIN IMMEDIATE`/`COMMIT`.
- **N-3.** `createSchedulerTempRecorders.recorded` treats a same-path re-record as a no-op without comparing `retained` (`cleanup-ownership.ts`, the "existing" check). A non-retained record would therefore stick even after a later retained record, and a record equal to a root is deletable (`isPathUnderAnyRoot` accepts `rel === ""`). No production site records a workspace root non-retained today. Fix: include `retained` in the comparison and never downgrade retained.
- **N-4.** The runner-global temp sites are **safe but not reported**:
  - the historical git inspection copies, extension staging, the historical SQLite snapshot and the Windows probe roots;
  - each is self-cleaned inside its own operation, has no durable record (production passes no sink; `native-build-factory.ts:3767` and `windows-process-semantic-probes.ts:200` call only the validator), and lies outside the six roots, so the search can never delete it;
  - after a crash, though, such a leftover is neither cleaned nor reported by `cleanup.checked`.

  Documenting this in the evidence is acceptable for T6b. A startup sweep that reports them would close it.
- **N-5.** The evidence text is stale. `T6b.md` 2b says "the factory fail-again half (used 0 pre-dispatch) stays as 2a left it", but the final test asserts `used 1` and one `dispatched` cycle at dispatch (`t6b-repair-factory.test.ts:275-283`). The test is right; the wording should be fixed.
- **N-6.** Workspace creation records are written at search time, not at creation (`native-build-factory.ts:1628-1635`). This is acceptable because they are retained and their own manager removes them. A crash before the first search leaves no owner-visible record.

### NOTE

- The r2 PROBE-F2 still "fails" because it hard-codes the old wholesale roots. It no longer represents production; PROBE-F3 does.
- The r2 PROBE-I now refuses at the N-3 unknown-evidence gate (`d1` is not a store id). PROBE-I2 covers R2-B3 with real ids.
- `Object.hasOwn(command.environment, "NODE_OPTIONS")` is case-sensitive. No runner-built command uses another casing today.

## Commands (exact counts)

All commands ran from the scratch repo root with `NODE_TEST_CONTEXT` unset, using `"C:\Program Files\nodejs\node.exe" ./node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 <file>`.

| File | Result | Notes |
|---|---|---|
| `probe-r2-cleanup.test.ts` | tests 1, pass 0, fail 1 | Hard-coded old roots (see NOTE). |
| `probe-r2-runtime.test.ts` | tests 4, pass 4 | PROBE-G and PROBE-H now pass. PROBE-I is refused via N-3. |
| `probe-r2-boundary.test.ts` | tests 1, pass 0, fail 1 | Probe artifact: it decides only `issues[0]`. |
| `probe-r3-relabel.test.ts` | tests 4, pass 4 | PROBE-I2 alone: 1/1. |
| `probe-r3-cleanup.test.ts` (PROBE-F3) | tests 1, pass 1 | |
| `probe-r3-boundary.test.ts` PROBE-J2 | tests 1, pass 1 | |
| `probe-r3-boundary.test.ts` PROBE-J3 | tests 1, pass 1 | Observational; it logs the false pause quoted in R3-B1. |
| `probe-r3-live-approach.test.ts` `--test-name-pattern="three real fixes"` | tests 1, pass 1 | The pass is the defect: rounds 2 and 3 dispatched with no decision (R3-B2). |

Prove-reds: counts as recorded above (PR-R3-B6: 1 fail twice; PR-R3-B3: 0 fail with the contract mutation alone, 1 fail with both layers mutated).

## Verdict

T6b REVIEW r3 — REPAIR REQUIRED — 2 blocking
