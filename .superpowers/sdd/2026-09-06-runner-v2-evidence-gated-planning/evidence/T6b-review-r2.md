# T6b review r2 (independent reviewer)

Scope: uncommitted T6b on `codex/runner-v2-p6-6`, base `7d21be0b`, after repair cycle 1 by Muse (30 files: 20 modified, 10 new). I did not write this code and I have no memory of round 1. Inputs:
- `t6b-brief.txt` and `t6b-repair1.txt`
- `evidence/T6b-review-r1.md`
- `evidence/T6b.md`, section "Repair cycle 1", including its stated gap: no full three-round worker loop in the harness
- the full diff

I edited no source or test file and committed nothing. All probes and prove-reds ran in a byte-identical scratch copy: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6b-r2\repo`. It contains a copy of `runner-v2/`, `package.json` and `tsconfig.json`, plus a junction to the worktree `node_modules`. All 30 hashes were verified identical before use.

## Integrity

- **START.** I hashed all 30 files in `git status --short`. All 30 match the "Repair cycle 1" table in `evidence/T6b.md`, including the corrected `repair-approach-contracts.ts` `a62d904b…`.
- **END.** I re-hashed all 30 files. `diff start-hashes.txt end-hashes.txt` shows no differences. The only new file in the worktree is this review.
- **Scratch.** Each file mutated for a prove-red was restored byte-exact:
  - `cleanup-ownership.ts` `d4ad5027…`
  - `build-runtime.ts` `b8cce8ca…`
  - `flaky-rerun.ts` `19c70ba3…`
- **Hygiene.**
  - No `child_process`/spawn/execFile in the new modules.
  - No new `process.env` reads.
  - No BOM and no mixed line endings in the 30 changed files.

## Verification per round-1 finding

| r1 | Verdict | What I checked |
|---|---|---|
| B1 execution-host regression | **FIXED** | `safeSegment` is no longer applied to the project path. Recording is best-effort inside the operation. The failure path now removes the root. The `git-bootstrap` pin exists and the worker ran it at 6/6. Production passes no record sink here (see B6), which is acceptable for a self-cleaning root. |
| B2 OA-14 flaky isolation in production | **PARTIAL, still BLOCKING (R2-B4)** | Fixed: the verdict now follows real counts (`judgeFlakyRerun`); NODE_TEST_CONTEXT is stripped from final-verification children; `not_performed` is recorded honestly. Not fixed: the only tests command production ever builds cannot be narrowed, so the rerun never runs. The required factory flaky and fail-again tests do not exist. |
| B3 deadlock | **PARTIAL, still BLOCKING (R2-B1)** | The first exhaustion now pauses durably, and owner-only extend and clear events exist. But the next pause after an owner extension crashes `step()`, and a generic owner resume leaves a phantom "running" run (PROBE-G, PROBE-H). |
| B4 approach decision | **PARTIAL, still BLOCKING (R2-B3)** | Fixed: issues and approaches appear in the Architect context; the decision tool is non-terminal; dispatch requires a live decision; evidence ids are checked against the store; relabel with identical evidence and repeats citing failure evidence are refused. Not fixed: a relabelled failed approach with **no** evidence dispatches and charges (PROBE-I). |
| B5 cycle counting | **PARTIAL, still BLOCKING (R2-B2, R2-B5)** | Fixed: charging happens at dispatch; one key serves charge and dispatch; three dispatches pass and a fourth pauses (my PR-C). Not fixed: T6a review-finding fix rounds are never charged; the final-verification root cause is still the category alone; the new boundary gate makes a boundary repair impossible (PROBE-J). |
| B6 OA-17 | **PARTIAL, still BLOCKING (R2-B6)** | Fixed: records now live in Runner-private SQLite; lstat means symlinks and junctions are not followed; the worker's probe F is green. Not fixed: the production root set includes all of `%TEMP%` and the whole state directory (PROBE-F2); required creation records are missing; searches do not run after boundary, review or verifier verifications. |
| B7 per-model outcome | **FIXED** | `reviewOutcomeByAuthor` spans every review round. The store ORs `defect_found` (sticky), and the outcome is recorded before `task.acceptance_recorded`. See N-4 for the key scope. |
| N1 NODE_TEST_CONTEXT | FIXED in production (`junitEnvironment` strips it). The fixture still uses the absolute `node` binary that the repair brief asked to drop (N-7). |
| N2 classes after kernel accept | FIXED (`native-deliverable-review.ts` records only when `!accepted.isError`). |
| N3 brief injection on real messages | NOT DONE (N-5). |
| N4 EP50 track record into the author tier | FIXED. The snapshot is taken at request time, carried in the risk input, and replayed by the reducer (`readTrackRecordSnapshot`). |
| N5 attempt-scoped process search | NOT DONE (N-6). |
| N6 clock idempotency keys | FIXED (`cleanup:${trigger}:${lastSequence}`; temp keys come from the record identity). |
| N7 evidence ids | Mostly fixed (the decision's `evidenceIds`, repair task evidence and blocker evidence are checked against the store). `diagnosticSet` ids are not checked (N-3). |
| Evidence hash typo | FIXED. |

## Prove-red records (scratch, sha256 before, mutated and after; the byte-exact restore was verified)

1. **PR-A, B6 root gate: a forged record outside the runner roots gets deleted.**
   - Mutation: `cleanup-ownership.ts:120` `if (!isPathUnderAnyRoot(...))` became `if (false && ...)`.
   - Hashes: before `d4ad5027…`, mutated `ac1b1bb8…`, restored `d4ad5027…`.
   - `t6b-defect-cleanup.test.ts`: tests 9, pass 7, **fail 2**:
     - "ownership decision keeps candidates inside runner roots…"
     - "probe F: a forged record outside runner roots never deletes a user folder" (`actual: 'proven'`)
2. **PR-B, B3: a throw instead of a pause.**
   - Mutation: `build-runtime.ts:3072` makes `pauseOnRepairIssue` throw first.
   - Hashes: before `b8cce8ca…`, mutated `ecb53e9a…`, restored `b8cce8ca…`.
   - `t6b-repair-runtime.test.ts`: tests 12, pass 10, **fail 2**:
     - "an exhausted issue pauses repair dispatch through the real pump"
     - "seeded cycles survive the check and the fourth correction pauses…" (`Error: PROVE-RED budget_exhausted: … used 3/3`)
3. **PR-C, B5: a fourth fix is allowed.**
   - Mutation: `build-runtime.ts:3139` issue exhaustion gate became `if (false && issue.used >= issue.limit)`.
   - Hashes: mutated `c2875f27…`, restored `b8cce8ca…`.
   - `t6b-repair-runtime.test.ts`: tests 12, pass 10, **fail 2**. The same two tests fail: the fourth dispatch is no longer paused and goes on to an Architect repair turn.
   - The tool check (`architect-tools.ts:731`) and the reducer guard remain as a second and third layer.
4. **PR-D, B2: a rerun with zero executed tests is recorded as flaky.**
   - Mutation: `flaky-rerun.ts:94` `rerunExecuted >= Math.max(1, …)` became `rerunExecuted >= 0`.
   - Hashes: before `19c70ba3…`, mutated `e514d2cf…`, restored `19c70ba3…`.
   - `t6b-flaky-rerun.test.ts`: tests 5, pass 4, **fail 1**: "a green rerun that executed nothing is not flaky" (`actual: true, expected: false`).
   - The end-to-end empty-pattern case stays green under this mutation. There the missing report (`readJUnitTestReport` returns `undefined`) is the guard, not the verdict line.

## Findings

### BLOCKING

**R2-B1 (B3 residual): after an owner extension, the next exhaustion crashes `step()`. A generic resume leaves a phantom running run.**
- **Cause.** `build-runtime.ts:3079` keys the pause as `repair-issue-paused:${issueId}:${cause}`. The key has no generation, no used/limit and no resume epoch. `SqliteSchedulerStore.append` returns the existing event on a duplicate key when the payload is identical, and throws on a payload conflict.
- **PROBE-G** (real SQLite, advancing clock, real pump):
  1. Issue at 3/3: step returns `repair_issue_paused`.
  2. The owner appends `repair.issue_budget_extended +1`: status `running`.
  3. The fourth, owner-authorized correction is charged: 4/4.
  4. The next dispatch-ready step **throws** `Scheduler idempotency conflict for repair-issue-paused:repair:001c5dff…:budget_exhausted.`, because the detail changed from "used 3/3" to "used 4/4". The run is left `running` and every later step throws the same way.
  - The same collision happens whenever a task-attempt pause follows an issue-budget pause, because both use cause `budget_exhausted`.
- **PROBE-H.** At 3/3 the run pauses. The owner uses the ordinary `run.resumed`. Three further steps each return `{status:"paused", action:"repair_issue_paused"}`, but the projection stays `running` with no `pauseReason`, and only one pause event exists. The run then reports "running" to the owner and never progresses.
- **Minimal fix.**
  - Make the pause key unique per occurrence, for example `…:${cause}:${issue.used}/${issue.limit}:${lastSequence}`, or only skip the append when the projection is already paused for this issue.
  - Always return the durable projection status.
  - Add PROBE-G and PROBE-H as regression tests.

**R2-B2 (B5/B4 regression): a new-policy boundary repair is impossible, and the run then throws on every step.**
- **Cause.**
  - `resolve_delivery_boundary_failure` now requires a live decision for issue `delivery-boundary:<checkId>` (`architect-tools.ts:1346-1357`).
  - No production code ever opens a `delivery-boundary:*` issue. `ensureRepairIssue` is called only from `prepareRepairDispatch`, and only for final-verification and verifier dispatches (`build-runtime.ts:3123,3196`).
  - `requireLiveRepairDecision(undefined)` returns `unknown_repair_issue` (`architect-tools.ts:915`).
  - `record_repair_approach_decision` also refuses the unknown issue, and the issue is never shown in the Architect context.
- **PROBE-J.** The T6a delivery harness (policy 1) was changed only so that the Architect answers the `delivery_boundary_failed` turn through the **real tools**. Result:
  - `visibleIssues: []`
  - `resolveIsError: true`, message `"Repair dispatch requires the current durable issue repair:f17469d4…"`
  - the step then throws `Architect returned from delivery_boundary_failed without a typed action.`
  - no `T1-fix` task, status `running`
- **Why tests did not catch it.** T6a's green boundary tests append `delivery.boundary_failure_resolved` directly and bypass the tool, so they cannot see this.
- **Minimal fix.**
  - On a failed boundary, open the member issues before the Architect turn, via `prepareRepairDispatch` or `ensureRepairIssue` on the `delivery_boundary_failed` path, including the pause-on-exhaustion.
  - Project those issues into the turn.
  - Add a tool-driven boundary repair test.

**R2-B3 (B4 residual): a failed approach relabelled with no evidence dispatches and charges.**
- **Cause.**
  - `repair-approach-contracts.ts:77` refuses a renamed approach only when `evidenceIds.length > 0 && every id is excluded`.
  - The reducer (`scheduler-store.ts`, `repair.approach_decided`) has the same condition.
  - Hypothesis and diagnostic-set equality are never compared.
- **PROBE-I.** After a1 ("first remedy", `[d1]`) failed, the Architect called `record_repair_approach_decision` with `a1-renamed`, the same hypothesis, `diagnosticSet ["d1"]` and `evidenceIds []`. Result: `decisionIsError: false`; `plan_verification_repairs` gives `planIsError: false`; `used 2`; repair task `relabel-repair` is dispatched.
- **Why this fails the contract.** It is exactly the "relabelled approach … refused" negative proof, and "a within-budget attempt is not automatically authorized".
- **Minimal fix.** When prior approaches exist, require at least one cited evidence id that is outside every prior approach's excluded set. Also refuse a new id whose hypothesis and diagnostic set equal a failed approach's.

**R2-B4 (B2 residual): OA-14 never runs in production.**
- **Why.**
  - The only tests command the runner ever derives is `process.execPath <npm-cli.js> run test` (`final-verification-profile.ts:243`). The profile is runner-derived and validated, so no other shape reaches the pump.
  - `isDirectNodeTestCommand` needs `--test` in the args (`flaky-rerun.ts:23-26`). So:
    - `junitDestination` is never set (`final-verification-runtime.ts:640`),
    - no final-verification fact ever carries `failingTestIds`,
    - every failing tests check records `not_performed: … npm-managed command or missing report`.
  - The factory test asserts exactly this path (`t6b-repair-factory.test.ts`).
- **"Impossible" does not hold.**
  - T6a already captures a junit report for `npm run test` through NODE_OPTIONS reporter flags (`planTestReport`; my shape run planned `node --test t.test.mjs` as a node junit report).
  - Narrowing works the same way: `NODE_OPTIONS='--test-name-pattern=^alpha$' node npm-cli.js run test` executed 1 test with 1 pass on node v24.18.0.
- **Required tests missing.** The repair brief asked for "a factory test with a real failing then passing test must record `flaky` and no charge; one that fails again must charge once". That test does not exist. The t6b-flaky-rerun integration test re-implements the driver's steps (narrow, new runtime, judge) inside the test, so the factory `flakyIsolation` driver and the pump-to-driver path are exercised by no test.
- **Minimal fix.**
  - Reuse T6a's `planTestReport` NODE_OPTIONS reporter for the final-verification tests command.
  - Narrow the rerun with NODE_OPTIONS `--test-name-pattern`.
  - Add factory tests for a real flaky fixture (records flaky, no charge) and a fail-again fixture (consistent failure, charged once at dispatch).

**R2-B5 (B5 residual): not every repair source is charged, and the final-verification issue identity is the category alone.**
- **Review fix rounds.** T6a deliverable-review fix rounds (reject, then worker fix, then re-review) never open or charge an issue. No path calls `ensureRepairIssue` or `chargeRepairDispatch` for them. The repair brief listed "T6a review findings and boundary failures, verifier repairs, fix-delta loops" explicitly. Boundary charging exists in the tool but is unreachable (R2-B2).
- **Identity.** The final-verification root cause is `final-verification:<category>` (`repair-budget-contracts.ts:46-53`; `build-runtime.ts:3193`). The brief required "category + affected obligation/contract + failing check ids (not category alone)". Every unrelated tests failure in a run therefore shares one 3-cycle issue.
- **Minimal fix.**
  - Open and charge a `delivery-review:<task>:<criterion or finding class>` issue when a blocking review dispatches a fix round.
  - Build the final-verification root cause from category plus failing check or test ids (sorted) plus affected obligation.

**R2-B6 (B6 residual): OA-17 root containment is vacuous in production, creation records are missing at the required sites, and searches are missing after most verification kinds.**
- **(a) Roots.** The production root set is `[tmpdir(), this.options.stateDirectory, runRoot]` (`native-build-factory.ts:1608`). The OS temp directory and the whole state directory are not runner-owned roots. PROBE-F2 calls the production `searchRunnerOwnedTempLeftovers` with exactly those roots:
  - a record for `%TEMP%\someone-elses-folder-…\user-data` returns `proven/cleaned`, and the folder is **deleted**;
  - a record for `<state>\credentials-dir` also returns `proven/cleaned`, and it is **deleted**.
  - The worker's "probe F" passes only because it uses a narrow test root (`runnerRoots: [runnerRoot]`), while its victim also lives under `tmpdir()`. The test therefore does not represent production, and the evidence line "a forged record outside runner roots never deletes a user folder" overstates what production does.
  - Records are Runner-private SQLite rows, so exploiting this needs a forged or wrong row. But the second conjunct the brief demands ("AND still under a runner-owned root") provides no protection for anything in `%TEMP%` or the state directory.
  - Fix: pass per-site roots, for example `tmpdir()/aiboard-git-inspection-*` prefixes checked by basename, `<runRoot>` subtrees and the verification workspace roots, never `tmpdir()` or `stateDirectory` wholesale.
- **(b) Records.** The only durable creation records production writes are task workspaces, and those are marked `retained`, so the temp search in practice can only report retained workspaces. Missing:
  - the verification worktree, the delivery-review and delivery-boundary checkouts (these are the OA-11 disposable copy that EP51 names), the Architect command copy, the verifier and baseline workspaces, and the final-verification junit report files: none are recorded;
  - `execution-host.ts` and `runner-capability-contract.ts` accept a sink, but production never passes one (`native-build-factory.ts:2051-2054`, `plugin-loader.ts:135`, `runner-capability-contract.ts:178`);
  - `native-build-factory.ts:3708` and `windows-process-semantic-probes.ts:200` call only the side-effect-free validator `recordTempCreation`.
- **(c) Searches.** `recordCleanupSearch` runs only after worker ticks and final-verification checks (`build-runtime.ts:1243,3189,3200,3313`). It does not run after delivery boundary checks, high-tier review runs, the independent verifier, or the flaky rerun.

### NON-BLOCKING

- **N-1.** An approach is marked `failed` at dispatch time.
  - Cause: `chargeRepairDispatch` records `outcome: "dispatched"`, and the reducer sets `approach.failed = outcome !== "resolved"` (`scheduler-store.ts:3877`).
  - Effect: every dispatched approach is durably `failed=true` before its validation runs, and the Architect context shows it that way. The real outcome of a correction plus its validation is never recorded, and the plan asks for the outcome to be recorded.
  - Fix: record `pending` at dispatch and the real result when the validation completes.
- **N-2.** `renderRepairIssues` (`agent-prompts.ts:640`) omits `failureEvidenceIds`, the ids a repeat must not cite. It also renders every issue unbounded as a `required` section.
- **N-3.** Evidence-store validation covers the decision's `evidenceIds` but not its `diagnosticSet`.
- **N-4.** `model_review_outcomes` is keyed `(project, model, task)` (`sqlite-project-memory.ts:87`). Plan task ids such as `T1` recur across runs, so runs merge and the sticky OR carries a defect into later runs. This errs toward a worse record. Fix: add the run id to the key.
- **N-5.** Defect-class injection is still not asserted on real worker and reviewer `AgentModelRequest` messages. The classes are captured once per runtime construction (`native-build-factory.ts:948,1341`).
- **N-6.** The process search still calls `stopRun(runId)`, which covers the whole run rather than the attempt (`cleanup-ownership.ts:242`).
- **N-7.** The factory fixture still uses the absolute `process.execPath` in the npm script (`t6b-repair-factory.test.ts:127`). The repair brief asked for normal `node` resolution.
- **N-8.** The final-verification junit parser (`final-verification-runtime.ts:1617`) counts skipped cases and suite-level testcases as executed. On real node 24 output an empty `describe` is emitted as a non-file-level testcase. Harmless today because the path is unreachable (R2-B4). Mirror T6a's synthetic and skip handling when it is wired. The report file is also never removed and never recorded (OA-17).
- **N-9.** `beforeRepairDecisionDispatch` (`delivery-acceptance.ts`) is no longer called anywhere in production. The gate now lives in the tools and `prepareRepairDispatch`. Either delete it or call it.

### NOTE

- T6a's real-counts rules are unchanged. The three JUnit fixes are all in the new final-verification parser; `delivery-execution.ts` only gains `failingTestIds`. Real node v24.18.0 output through T6a `nodeJunitOutcome` and `planTestReport`:

  | Shape | Result |
  |---|---|
  | empty `describe` | `unknown` (selected 0) |
  | name-pattern with no match | `unknown` |
  | nested failing test | `failed`, id `inner` |
  | `node --test \|\| true` | no report plan (refused) |
  | `tsx --test` | planned as a node junit report, as accepted in T6a |

  The stale-report protection sits in T6a's `readRunReport`, which is unchanged.
- The state-directory trust model is the same as the existing managed-process records. A workload that can write the runner SQLite could forge any event, so the root check is defense in depth. That is why R2-B6(a) is about the stated contract and the unrepresentative test, not a live exploit.
- Legacy runs: every new gate checks `planningPolicyVersion === 1`. The worker's legacy test is green in the evidence. EP50 replay handles an absent `trackRecord`. I did not re-run replay suites (owner rule).

## Commands (exact counts)

All commands ran from the scratch repo root with `NODE_TEST_CONTEXT` unset, using `node ./node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 <file>`.

- `runner-v2/test/probe-r2-runtime.test.ts` (copy of the worker's runtime harness plus 3 reviewer probes; the one copied worker test passes): tests 4, pass 1, **fail 3**. PROBE-G, PROBE-H and PROBE-I each fail as quoted above.
- `runner-v2/test/probe-r2-boundary.test.ts` (T6a delivery harness helpers plus PROBE-J): tests 1, pass 0, **fail 1**, as quoted.
- `runner-v2/test/probe-r2-cleanup.test.ts` (PROBE-F2): tests 1, pass 0, **fail 1**. Both victims were deleted.
- `runner-v2/test/probe-r2-shapes.mts` (plain `tsx`, real node 24 junit files from `nodeprobe/`): output as quoted in NOTE.
- Shell: `NODE_OPTIONS='--test-name-pattern=^alpha$' node npm-cli.js run test` gives tests 1, pass 1, fail 0.
- Prove-reds PR-A through PR-D: counts as recorded above.
- I did not re-run the worker's green suites (owner rule). Round-1 probes A–D and F were re-run in inverted form: G and H cover the A/D deadlock family, I and J cover the C/D approach family, F2 covers F.

## Verdict

T6b REVIEW r2 — REPAIR REQUIRED — 6 blocking
