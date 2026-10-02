# T6b review r1 (independent reviewer)

Scope: uncommitted T6b on `codex/runner-v2-p6-6`, base `7d21be0b` (30 files: 21 modified, 9 new). Written by MiMo, then Muse. I wrote none of it. Inputs: `t6b-brief.txt`, plan §2, §3, §5.0 (G-5, G-7, G-10), T6, §6 EP24/25/26/31/40/48/49/50/51, owner amendment OA-13..OA-17, `evidence/T6a.md` (limits, real counts 3c), `evidence/T6b.md`, the full diff. I edited no source or test file and committed nothing. Probes and prove-reds ran in a byte-identical scratch copy: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6b\repo` (copy of `runner-v2/` plus a junction to the worktree `node_modules`).

## Integrity

- At START I hashed all 30 files in `git status --short` (progress.md excluded). 29 match `evidence/T6b.md`. The 30th, `repair-approach-contracts.ts`, has a typo in the evidence: it lists `f901109597aaaa4076b4592d110...`, which is 65 hex characters with an extra `2`. The actual hash is `f901109597aaaa4076b459d110ef55e126b4ab6067aa2301cd8962946516a3dc`.
- At END all 30 hashes were identical to START (`diff start-hashes.txt end-hashes.txt`: no differences).
- The evidence restore SHA for prove-red 4 (`0add2866…`) matches no current file. `build-runtime.ts` was edited after that prove-red, so it does not cover the current code.

## Requirement checklist

| Requirement | Result |
|---|---|
| Issue budget: one root-cause issue shared across renames and new symptom text, durable, not resettable | PARTIAL. Identity is `hash(projectId, category set)`, durable in scheduler events. Only failing final-verification checks are ever charged (B5). |
| Three cycles, then a fourth refused | FAIL. The first failure is charged before any fix, so only 2 fixes are dispatched. Refusal crashes the pump, and the owner has no way to extend the issue budget (B3, B5). |
| Diagnostics and reviewer-only passes charge zero | Holds trivially: the one charge site is a failing check. |
| All caps must permit (issue, task attempts, run limit `DEFAULT_REPAIR_PLAN_LIMIT`) | PASS for the final-verification mechanical path (the stricter run cap pauses). The issue cap is vacuous on the review and verifier repair paths (B5). |
| Issue credits never replenish run or task credits | PASS (separate counters). |
| Budget extended only by owner amendment | FAIL. No extension event exists for the issue budget (B3). |
| External blocker consumes nothing; blocker record complete | Record: PASS. Resolution: FAIL. The blocker can never be cleared, and dispatch then throws on every step (B3). |
| RepairApproachDecision at the T6a hook (actor, lineage, prior failure, immutable evidence; repeat refused; relabel/reuse/replay refused; within budget ≠ authorized) | FAIL (B4) |
| OA-14 flaky isolation at the T6a hook, through the audited path, with real counts | FAIL: never runs in production (B2) |
| Defect class on every finding; SQLite store outside the project, across runs, no network | PASS (reviewer tool requires `defectClass`; `project-memory.sqlite` in the state directory). NON-BLOCKING N3, N4. |
| Top five classes in real worker and reviewer briefs, within 300 tokens (EP40) | Wired in code (`native-build-factory.ts:943,1336`), not asserted on actual messages (N4). |
| Per-model outcome for every reviewed accepted task | FAIL: wrong data (B7) |
| OA-17: creation records at every site, both searches after every attempt and verification, ownership-proven cleanup, leftovers reported | FAIL (B1, B6) |
| Legacy runs unchanged | Gated on `planningPolicyVersion === 1`. The worker's legacy test exists; I did not re-run it. |
| Static audits | PASS: 43/43 |
| No `child_process` in new production code | PASS |

## Findings

### BLOCKING

**B1: `execution-host.ts:279` makes every historical Git inspection crash (a regression).**
`persistTempCreation({ …, ownerProjectId: safeSegment(projectRoot) … })`. `safeSegment` (`execution-host.ts:840`) only accepts `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, and it throws "ExecutionHost run/session identity is invalid." for any absolute project path. So `withGitInspection` now always rejects. The failure happens right after `mkdtemp`, before any cleanup is registered, so the temp root also leaks with no record.
- Proof: `git-bootstrap.test.ts` in the worktree gives 6 tests, 5 pass, 1 fail, with that error. In scratch with only the base `execution-host.ts` swapped in: 6/6 pass. The T6b file was restored byte-exact (`bd1a8235…`).
- Minimal fix: use a valid owner id (the run's project id, passed in), write the record without throwing, and write it inside the operation's try/cleanup.

**B2: OA-14 flaky isolation never runs in production. The rerun would also not follow T6a's "real counts" rule.**
- `applyFailingCheckRepairCharge` (`build-runtime.ts:3159`) reads `fact.report?.failingTestIds`. `FinalVerificationRuntime` never sets `report`: T6b only added the type (`final-verification-runtime.ts:204`), and command facts at about lines 640-680 carry no report.
- So `failingTestIds` is always empty in production. `rerunFailingTests` is never called, and a cycle is charged without a rerun and without any "not performed" reason. The factory test confirms this: it asserts `repair.flaky_isolated` count is 0 (`t6b-repair-factory.test.ts:202`). The flaky tests use a driver double that injects a made-up `report: { failingTestIds }` and made-up `rerun-evidence`. The evidence line "production `flakyIsolation` (real filtered rerun)" was never performed.
- If it did run: rerun "green" is `result.check.green` from the same runtime. That value is exit-code-only (`final-verification-runtime.ts:722`, no report reading). A `--test-name-pattern` that matches nothing exits 0. My probe: `node --test "--test-name-pattern=^nonexistent$"` gave exit 0 with 0 real tests run. That run would be recorded as `flaky` with no charge, which breaks the real-counts rule.
- `narrowNodeTestCommand` only accepts a directly invoked `node`. The normal `npm test` profile is always "unsupported".
- Minimal fix: produce `failingTestIds` from a runner-owned report in the final-verification tests run (the T6a `planTestReport`/`readRunReport` path). Judge the rerun by its own report: ≥1 executed, the named ids executed, 0 failed. Otherwise record `not_performed`/`unknown` with the reason. Add a factory test with a really flaky fixture.

**B3: An exhausted issue, a recorded external blocker, or a failed approach leaves the run permanently stuck (realistic deadlock).**
- `prepareRepairDispatch` and the charge path `throw`. The reducer also throws on a fourth charge (`scheduler-store.ts:3828`). `native-build-manager.ts` then pauses with `autonomous_pump_error`, and every resume repeats the same throw.
- No event extends an issue budget: `repair.cycle_limit_extended` only touches `repairCycles`. No event clears a blocker. No blocker record or owner-visible pause states the acceptance condition or the owner action.
- The Architect is never invoked, so it cannot record a new approach.
- PROBE-A: tests issue at 2, one failing check, then 3 steps and `"Issue repair budget is exhausted."` thrown, with 0 Architect calls.
- PROBE-D: after approach a1 failed, the first run of steps and the second run of steps both throw the same error, with 0 Architect calls and status still `running`.
- The worker's own tests show the same thing: they assert `runtime.step()` rejects.
- Minimal fix: turn refusals into a durable pause/blocker with the exact condition, evidence, attempts and owner action. Add an owner-only issue-extension event and a blocker-resolution event. When the latest approach failed, give the Architect a turn to decide instead of throwing before it.

**B4: The RepairApproachDecision is neither usable nor enforced in production.**
- (a) The Architect is never given the issue id. `repairIssues` is not projected into any context, and `record_repair_approach_decision` needs an exact `repair:<24hex>` id; unknown ids return `unknown_repair_issue`. PROBE-B: `issueIdVisibleToArchitect: false`.
- (b) The tool returns lifecycle `architect_action` (`architect-tools.ts:896`), which ends the agent loop (`agent-loop.ts:1021`). The instructed sequence "record the decision, then plan repairs" therefore ends the turn with no repair tasks, and `build-runtime.ts:1420` throws "without a typed action".
- (c) With no recorded decision, the kernel makes one up: `repair:<issue>:initial`, repeat false (`build-runtime.ts:3089-3104`). Every dispatch within budget is then authorized. The plan requires "before every repair dispatch, persist" a decision and says "within budget is not automatically authorized".
- (d) The reducer (`scheduler-store.ts:3786-3811`) and `repair-approach-contracts.ts:32-39` check ids only. They do not check that evidence exists in the evidence store and do not check task lineage. PROBE-C (after a1 failed):
  - accepted: relabel `a1-renamed` with identical hypothesis, diagnostic set and evidence
  - accepted: repeat a1 citing the failed cycle's own evidence
  - accepted: repeat a1 citing a made-up id `not-an-evidence-record`
  - refused: plain resubmit, and repeat with the same `d1`

  After the made-up repeat, dispatch passed the gate and reached the Architect (`architectCalls: 1`).
- Minimal fix:
  - project open issues (id, used/limit, approaches) into the repair turn;
  - make the decision a non-terminal tool, or part of `plan_verification_repairs`/`plan_verifier_repairs`;
  - require a persisted decision bound to this dispatch (issue, task lineage, failure id);
  - validate every evidence id against the evidence store;
  - treat the failed approach's evidence ids and failure evidence as part of its diagnostic set;
  - refuse a new approach id whose evidence set is a subset of a failed approach's set, unless it is marked a repeat with new evidence.

**B5: Cycle accounting does not match the contract, and the issue gate is empty on most repair paths.**
- The only charge site is `build-runtime.ts:3221`, a failing final-verification mechanical check. These repairs pass the dispatch gate against an issue that nothing ever charges:
  - final-verification review repairs (`build-runtime.ts:1325`),
  - verifier repairs (`build-runtime.ts:1628`, issues `verifier:<task>:<criterion>`),
  - T6a delivery fix loops.

  For these repairs the issue-level cap never applies. Once the owner extends the run limit, a fourth or later repair of the same criterion proceeds.
- The dispatch issue is keyed on the joined category set (`build-runtime.ts:3041,3077`), while charges are keyed per category (`:3160`). A multi-category dispatch reads an issue that was never charged.
- Off by one: the first failing check is charged before any fix is dispatched. The sequence is: fail, charge 1, fix 1, fail, charge 2, fix 2, fail, charge 3, refused. That is two fixes, not "three correction-plus-validation cycles" (EP25).
- Minimal fix: charge one cycle per dispatched correction when its validation completes, on every repair path. Use one per-root-cause identity at both dispatch and charge. With several categories, check every member issue.

**B6: OA-17 cleanup is not in the production flow, is incomplete, and its ownership proof can be forged.**
- (a) Production temp search matches nothing. `cleanupAfterAttempt` searches `(spec.runId, spec.projectId)`, but no production site writes that pair: execution-host throws (B1), and the others use `historical-read`, `runner-extension` or `semantic-*` with `runner-state`. Those records are never checked or reported, and the registry grows without bound.
- (b) No creation record exists for the OA-11 disposable copy, the T6a review checkouts and report paths, the verification worktree, or the Architect's disposable copy. EP51 names the OA-11 copy explicitly.
- (c) Searches run only after worker ticks and failing final-verification checks. They do not run after green verification, delivery boundary checks, high-tier review runs, or the independent verifier ("after each verification").
- (d) The ownership proof is a JSON file in the shared `%TEMP%\aiboard-runner-temp-records` (`cleanup-ownership.ts:51`), which any workload the runner executes can write. `cleanupRecordedTempPath` then does `rmSync(recursive)` on whatever path the file names, with no check that the path is outside the project or under a runner-owned root (`cleanup-ownership.ts:171`). PROBE-F: one dropped JSON file made the runner delete a `user-project` directory, reported as `ownership: "proven", action: "cleaned"`. Plan §3 says "No worker-writable duplicate global registry".
- Minimal fix: store creation records in runner state (scheduler events or SQLite in the state directory), keyed to the real run/project. Refuse to clean any path that is not under a runner-created temp root, or that is inside the workspace. Add records at every listed site. Run the search after every verification kind.

**B7: The OA-16 per-model outcome records the wrong fact.**
- `recordReviewOutcome` (`build-runtime.ts:3256-3266`) uses only the accepting review: `defectFound: findings.length > 0` and `authorModelIdentity` of the final revision.
- A task whose first review found a blocking defect and whose fix re-review accepted is recorded as `defectFound: false`. The upsert keeps the latest write, so the earlier defect is erased. When a different model wrote the fix, the original author loses the record.
- T5's `resolveAuthorTier` promotes a model to `frontier` after 5 clean records. Once it is fed this data, scrutiny goes down wrongly.
- Minimal fix: derive `defectFound` from every review in the task's review history (any finding, or any blocking finding, per the owner's definition), per author identity of each reviewed revision.

### NON-BLOCKING

- **N1: Worker finding 1 ("bare `node --test` exit 0 under the managed host").**
  - Reproduced: scratch copies of the factory test with bare `node` failed (1 test, 0 pass: the tests check went green, `actual 0, expected 1` cycles). The absolute binary passes (1/1). Bare `node` plus `delete process.env.NODE_TEST_CONTEXT` passes (1/1).
  - Shell probe: with `NODE_TEST_CONTEXT` set (`child`, `child-v8` or empty), `node --test failing.test.mjs` exits 0 for both bare and absolute binaries. Without it, exit 1.
  - Classification: a test-harness artifact. `NODE_TEST_CONTEXT` leaks from `tsx --test` through `snapshotNativeBuildAmbientEnvironment()` into the final-verification child. `FinalVerificationRuntime` does not clear it; `delivery-execution.ts:315,802` does.
  - It is not a PATH or shim resolution issue. Why the quoted absolute path escapes it under the managed host is still unexplained.
  - It does not defeat T6a real counts for boundary or high-tier checks: those read this run's report and clear the variable.
  - It does expose that final-verification `tests` green is exit-code-only (pre-existing, T8 / owner scope). That matters for B2.
  - The T6b fixture hides the leak and its comment gives the wrong cause. Fix: clear `NODE_TEST_CONTEXT` in the fixture, as T6a's does, and in final-verification child environments.
- **N2:** `record_deliverable_findings` writes defect classes before the kernel accepts the append (`native-deliverable-review.ts:911`). Refused or foreign calls are still counted.
- **N3:** Defect-class injection into real worker and reviewer messages is not asserted on actual `AgentModelRequest` messages, which the brief requires. The class list is captured once per runtime construction.
- **N4:** `ModelTrackRecordSnapshot` is never passed to `assessChangeRisk`, and `modelRiskSnapshot` is unused. EP50 consumption, where "a worse record raises the tier", is not wired. Scope is T5/T6; the controller should assign it.
- **N5:** `searchOwnedProcesses` calls `stopRun(runId)`, which stops every run-owned process, not only the finished attempt's. `listRun(runId)` can never return a foreign owner, so the "unproven process" branch is dead code.
- **N6:** The `cleanup.checked` idempotency key comes from the clock (`build-runtime.ts:3246`), and findings are not projected anywhere visible.
- **N7:** `rerunEvidenceIds`, charged-cycle `evidenceIds` and blocker `evidence` are not checked against the evidence store.
- **N8:** Root-cause identity is only the category, so unrelated test failures merge into one issue. This errs on the strict side.

### NOTE

- `worker-lifecycle-tools.ts` and `worker-runtime.ts` are byte-changed but not content-changed. They now have mixed line endings (478/482 and 552/558 CRLF; the checkout is CRLF with `core.autocrlf=true`). With CRs stripped they equal HEAD (`0572eb38…` both for `worker-runtime.ts`). `git hash-object` equals the index blob, so no behavior changes and a commit would not change them.
- The evidence calls this "stat-only", which is inaccurate: the bytes changed. Recommend `git checkout --` both files before commit.
- All 18 modified sources are mixed-EOL, with new lines in LF. Autocrlf normalizes this. There is no BOM.
- Static audits are clean.

## Prove-red records (scratch copy, byte-exact restore)

1. **Worker PR1** (fourth cycle refused), `scheduler-store.ts:3828` guard replaced with a comment.
   - Before: `6fb478d7…6f85e4a`, mutated: `262bb0fa…43f7`.
   - `t6b-repair-budget` + `t6b-repair-runtime`: 19 tests, 18 pass, **1 fail**: "the third cycle is counted and the fourth is refused through the real pump", `AssertionError: Missing expected rejection.`
   - Restored `6fb478d7eaab52b0e694dd2d4acecfcca40542fa5040dbe41bafcf3a16f85e4a`.
2. **Worker PR5** (ownership proof), `cleanup-ownership.ts:101` owner check replaced with a comment.
   - Before: `df9301d4…273298d`, mutated: `a821672d…612a`.
   - `t6b-defect-cleanup`: 7 tests, 6 pass, **1 fail**: "cleanup search checks owned records…", `3 !== 2`.
   - Restored `df9301d4dab9fa8e384c92966de79369b9089bb501be66f1354d1c4ea273298d`.
3. **Reviewer (B1)**: swapped in the base `execution-host.ts`. `git-bootstrap` went from 6 tests / 5 pass / 1 fail to 6/6 pass. T6b file restored (`bd1a8235…c6cc945`).

## Commands (exact counts)

All from the repo root (or the scratch root), with `NODE_TEST_CONTEXT` cleared, using `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.

- Worktree `runner-v2/test/git-bootstrap.test.ts`: tests 6, pass 5, fail 1.
- Worktree static audits (`git-caller-audit`, `lsp-caller-audit`, `mcp-caller-audit`, `managed-backend-boundary`, `one-shot-command-routing-static`, `static-adapter-policy`): tests 43, pass 43, fail 0.
- Scratch `git-bootstrap` with base `execution-host.ts`: tests 6, pass 6.
- Scratch factory variants:
  - `probe-a-abs`: 1 test, pass.
  - `probe-b-bare`: 1 test, fail (0 cycles).
  - `probe-c-bare-clear`: 1 test, pass.
- Scratch `probe-runtime.test.ts` (PROBE-A..D, observational, real SQLite scheduler/evidence stores, advancing clock, real pump): tests 4, pass 4. Outputs are quoted in B3, B4, B5.
- Scratch `probe-forged-record.test.ts` (PROBE-F): tests 1, pass 1 (the victim directory was deleted).
- Shell probes (`node --test` with and without `NODE_TEST_CONTEXT`; name-pattern that matches nothing): exit codes as quoted in N1 and B2.
- I did not re-run the worker's green suites (owner rule). The importer matrix is the controller's.

## Verdict

T6b REVIEW r1 — REPAIR REQUIRED — 7 blocking
