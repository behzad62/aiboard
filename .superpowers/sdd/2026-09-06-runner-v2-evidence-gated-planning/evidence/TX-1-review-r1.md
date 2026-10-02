# TX-1 independent review r1

**Verdict: REPAIR — 1 blocking**

Reviewer: fresh-context independent reviewer (did not write TX-1). Review only: no edits to the
repo; probes ran from scratch copies in the session scratchpad (`scratchpad/tx1r1/`). The worktree
state after the review matches its state before it.

Scope reviewed: `runner-v2/test/support/delivery-boundary-harness.ts` (new),
`runner-v2/test/native-delivery-report-{counts,runners,paths}.test.ts` (rewritten),
`runner-v2/test/native-delivery-report-parity.test.ts` (new). Compared against
`git show HEAD:runner-v2/test/native-delivery-factory.test.ts` (original 13 matrix tests and the
`runDeliveryFactoryScenario` helper), `runner-v2/src/native-build-factory.ts` (driver construction),
`runner-v2/src/delivery-execution.ts`, `runner-v2/src/build-runtime.ts` (kernel recording) and
`runner-v2/src/scheduler-store.ts` (reducer checks). Contract: `tx1-brief-muse.txt`, plan §TX-1 and
CD-18.

## Findings

| Id | Class | Finding | Fix |
|---|---|---|---|
| B1 | **BLOCKING** (lost assertion; divergence from production recording) | The 5 accepted matrix tests (explicit glob, NODE_OPTIONS, name-pattern=value, `cd test`, `tsx --test`) lost the accepted-path checks that HEAD ran on every accepted call through `runDeliveryFactoryScenario` (HEAD `native-delivery-factory.test.ts:517-530`): `report.status === "passed"`, `counts.passed >= 1`, **`assert.match(report.artifactHash, /^[a-f0-9]{64}$/)`**, passed tests check with evidence, and kernel task and phase acceptance. The rewrite replaces "task accepted" with `boundary.passed === true`, which the harness computes itself from the driver's outcomes (harness :201). That is not equivalent in the accepted direction: production records the boundary through the kernel reducer (`scheduler-store.ts` `deliveryBoundaryChecked` :6927-7022 plus `validateSchedulerEvidenceEvent` :2401), which rejects a passed tests check unless `assertTestsOutcome` holds (`delivery-acceptance.ts:106-124`: counts.passed ≥ 1, failed 0, selected ≥ 1, report path, 64-hex artifactHash), the check has exit 0 and evidence, the evidence ids exist as command evidence and their exit code matches, and the report artifact exists. The harness applies none of these checks. Probe A: for all 5 accepted variants probed, 3 record mutants (artifactHash dropped, evidenceIds emptied, counts.failed = 1) **still satisfy every rewritten accepted-test assertion** while the kernel rejects each of them. So a harness test can pass where production fails (the reducer throws on `store.append`). No current bug: every probed real harness record passes the kernel checks. The harness docstring and the evidence say the record is assembled "exactly as the kernel records `delivery.boundary_checked`". That holds for the payload shape only, not for recording (validation). The not-accepted direction is equivalent: task acceptance requires the latest boundary `passed` (`scheduler-store.ts:7176-7182`), so `taskAcceptances.T1 === undefined` ⇔ `boundary.passed === false` holds for those 8 tests. | Preferred, test-only with no src change: before cleanup, have `runDeliveryBoundaryDirect` run the kernel's own record checks through exported functions and throw if the kernel would reject the record. The checks are `assertTestsOutcome` on the tests check, the "passed ⇒ exit 0 and evidence" rule, `validateSchedulerEvidenceEvent` with the harness evidence store (it returns early on an `undefined` projection, so pass a non-undefined one), and `artifacts.get(report.artifactHash)`. Every harness test then carries the acceptance gate the pump used to give it. A working reference is `kernelValidate` in `scratchpad/tx1r1/probe-harness.mts` (about 25 lines). Minimum alternative: restore the helper's explicit assertions (`report.status`, `counts.passed >= 1`, artifactHash regex, `evidenceIds.length > 0`) in the 5 accepted tests. Update the harness docstring and the TX-1 evidence mapping either way. |
| M1 | MINOR | The parity test compares only the tests check's outcome, counts, runner and reason, as the brief specifies. It does not compare `boundary.passed`, the check-id list (`build`/`tests`), `exitCode`, `report.status`/`path`, or `changedFiles`/`selection`. Probe B, variant V2 (`changedFilesFor → []`): parity **passes** although changedFiles differ. That field is harmless for the matrix tests, but it is a blind spot. Both parity scenarios are default `node --test`, so construction details that matter only for matrix variants (PATH prefix, `cd`, tsx) are not parity-guarded. | Also compare `passed`, the check ids and outcomes, `exitCode` and `report.status` (costs nothing). Optionally compare the whole normalized record: the probe shows it is already equal field-for-field (see Probe B). |
| M2 | MINOR | Timing target (about 5 min) not met; the evidence states this honestly. The controller's run log (`ndf-grp-after-c2c-r2.txt`, concurrency 6) shows the **parity file is now the group's critical path**: its two tests run serially, 338.8 s + 292.2 s = 631 s, which matches the 632 s wall. The wiring files take 541 s and 545 s. | Run the pump and the harness concurrently inside each parity test (`Promise.all`), or split the two parity tests into two files: the group wall drops to about 545 s (the wiring files). Getting below that needs fewer wiring pumps, which is outside TX-1. |
| M3 | MINOR (informational) | The harness checkout differs from the factory's: one commit instead of baseline + integration commit, and no runner `.gitignore` (the production `captureGitBaseline` adds `DEFAULT_IGNORE_BLOCK` on a fresh repo). The boundary worktree is added from the project root rather than `integrationManager.path` (factory :689-701). The difference is immaterial: `driver.check` always pins `targetRevision`, the object DB is shared, and Probe B's normalized full-record diff (factory pump vs harness) is **equal on every field** in both scenarios. | None required; optionally mention in the evidence. |
| M4 | MINOR (informational) | Other construction differences, none affecting the tests check. The harness skips `binding.recover()` / `assertIsolationRecoveryClear` (factory :448-453; no-op on fresh state). It uses a stub capability contract, the existing seam `final-verification-runtime-b1.test.ts:353-356`; `bindRun` reads only its digest (`execution-host.ts:247,859-865`), and the capabilities config is empty in both. `changedFilesFor` is a constant. There is no `signal`. Driver option-by-option (factory :1303-1311, :1379-1391): `runId`, `git` = `requireGitRunner(binding.git).lifecycle("verification").run`, `artifacts` = the host's store, `evidenceStore`, `execution` = `binding.commandExecution`, `boundaryWorkspace` = `createDeliveryWorkspaceSlot` over `VerificationWorkspaceManager{kind:"independent-verifier", workspaceSuffix:"delivery-boundary", targetRevision}`, and `ambientNodeOptions` = the host's `filteredEnvironmentSource()` with a case-insensitive `NODE_OPTIONS` lookup. All of these are faithful. C2c's uncommitted factory diff (+4 lines, `canStageSpecPath`) does not touch this path. | None. |
| M5 | MINOR | Cleanup on failure paths: the root is created at harness :70 but the `try` starts only at :175. A failure in the npm lock (:114), git (:116-121), `bindRun` (:135) or `SqliteEvidenceStore` (:151) leaks the temp root and leaves the execution host unclosed, which can keep handles open. In `finally`, a throwing `binding.close()` skips `executionHost.close()` and `rmSync`. The success path is clean: no `aiboard delivery boundary *` directory remains in `%TEMP%` after the controller's run or after this review's probes. | Open the `try` right after `mkdtempSync` (host and binding optional in `finally`) and make each `finally` step independent. |
| M6 | MINOR | The evidence is stale after the controller's split. TX-1.md describes a 5-file, 19-test group with `native-delivery-factory.test.ts` sha `1ed81db8…`; the group is now 6 files (that file is `bc842e8b…`, plus `-tiers`). The "every assertion keeps its meaning" mapping does not mention the dropped helper assertions (see B1). | Refresh with the repair. |
| M7 | MINOR | The harness duplicates the fixture writer and `withPathPrefix` from `delivery-factory-scenario.ts` instead of sharing them, so the two fixtures can drift. Today they differ only in the package name (harmless). | Optionally export a shared `writeDeliveryFixture` from the scenario module. |

## Review questions

1. **Faithfulness.** The driver construction matches `NativeBuildFactory` option by option (M4). It uses the real `createExecutionHost` + `bindRun`, the real `createDeliveryWorkspaceSlot`/`VerificationWorkspaceManager`, and the real `FinalVerificationRuntime` and `planTestReport` inside `runDeliveryCategory`; there are no fakes on the execution path. The workspace-root and checkout differences (M3) are immaterial, as the probe shows. **The divergence is after the driver:** the kernel's record validation is not applied (B1).
2. **Coverage.** See the table below. All 8 not-accepted tests keep every assertion, and `passed === false` is equivalent to the kernel fact. All 5 accepted tests keep their body assertions but lose the helper's accepted-path assertions (B1).
3. **Parity.** It really runs the full factory pump (`runDeliveryFactoryScenario`) and the harness on the same inputs and compares outcome, counts (deep-equal), runner and reason. It **can fail**: Probe B variant V1 (the harness sources `NODE_OPTIONS` differently) makes both parity tests fail. Variant V2 (changedFiles) is not detected (M1).
4. **Prove-red restore.** `git diff HEAD -- runner-v2/src/delivery-execution.ts` is empty. The working bytes have sha256 `6b859f1e…4cec8`, equal to the before/after value in the evidence. It also equals the HEAD blob converted to CRLF (`git show HEAD:… | sed 's/$/\r/' | sha256sum` gives `6b859f1e…`); the file has 947 lines and 947 CRs, so line endings are uniform. `git hash-object` equals `HEAD:` (`757693ae`). **Confirmed byte-identical.**
5. **Hygiene.** All 5 files are LF-only with no BOM, a trailing newline and no trailing whitespace; they are UTF-8 (one em dash in a harness comment). The 5 sha256 values match the evidence. `tsc -p runner-v2/tsconfig.json --noEmit` is clean (the include list covers `test/**`). `eslint` on the 5 files is clean. `git diff --check` is clean. Temp directories are cleaned on the success path (M5 covers the failure paths). Nothing is written outside `tmpdir()` except npm's own cache and logs, the same as the pre-existing scenario.

## Coverage map (HEAD → TX-1)

| Test | HEAD body assertions | TX-1 | Kept? |
|---|---|---|---|
| real counts: zero tests | exit 0, unknown, runner, counts.passed 0, reason regex, acceptance undefined | same + `passed === false` | yes |
| real counts: stale junit.xml | unknown, fresh path regex, selected 0, acceptance undefined | same + `passed === false` | yes |
| real counts: unrecognized runner | exit 0, unknown, 2 reason regexes, acceptance undefined | same + `passed === false` | yes |
| R5-B1 empty describe | exit 0, unknown, counts {0,0,0,0}, reason, acceptance undefined | same + `passed === false` | yes |
| R5-B2 `\|\|` masked | unknown, reason, acceptance undefined | same + `passed === false` | yes |
| R6-B1 nomatch | exit 0, unknown, selected 0, reason, acceptance undefined | same + `passed === false` | yes |
| N-R7-1 `../` + nomatch | unknown, selected 0, acceptance undefined | same + `passed === false` | yes |
| N-R7-1 `../` no test() | unknown, selected 0, acceptance undefined | same + `passed === false` | yes |
| R5-B3 explicit glob | passed, selected 1 + helper accepted-path (HEAD :518-530) | passed, selected 1, `passed === true` | **helper lost (B1)** |
| NODE_OPTIONS kept | passed, counts.passed 1 + helper | same + `passed === true` | **helper lost (B1)** |
| R6-B1 pattern=value | passed, selected 1 + helper | same + `passed === true` | **helper lost (B1)** |
| N-R6-2 `cd test` | passed, selected 1 + helper | same + `passed === true` | **helper lost (B1)** |
| R7-B1 tsx --test | passed, selected 1 + helper | same + `passed === true` | **helper lost (B1)** |

Totals: 5 accepted and 8 not accepted. By file: counts has 5 not accepted; runners has 3 accepted and 1 not accepted; paths has 2 accepted and 2 not accepted.

## Probes (scratch: `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\tx1r1\`)

`probe-harness.mts` is a scratch copy of the TX-1 harness, importing the worktree's `src` by absolute URL. It adds construction variants and `kernelValidate`: the reducer's per-check rules, `assertTestsOutcome`, `validateSchedulerEvidenceEvent` against the live evidence store, and artifact existence, all run before cleanup. All six processes ran in parallel (about 9.5 min wall, under contention from a concurrent reviewer).

**Probe A — kernel acceptance vs rewritten assertions** (`probe-a.mts 1|2` → `probe-a-{1,2}.json`):

| Variant | passed | outcome | counts | real record: kernel errors | mutants (drop artifactHash / empty evidence / failed = 1): rewritten assertions still pass? | kernel |
|---|---|---|---|---|---|---|
| explicit-glob | true | passed | 1/1/0/0 | none | yes / yes / yes | rejects all 3 |
| name-pattern-value | true | passed | 1/1/0/0 | none | yes / yes / yes | rejects all 3 |
| cd-test | true | passed | 1/1/0/0 | none | yes / yes / yes | rejects all 3 |
| tsx | true | passed | 1/1/0/0 | none | yes / yes / yes | rejects all 3 |
| node-options | true | passed | 1/1/0/0 | none | yes / yes / yes | rejects all 3 |
| zero-tests | false | unknown | 0/0/0/0 | none | — | — |
| or-masked | false | unknown | — | none | — | — |
| cd-src-nomatch | false | unknown | 0/0/0/0 | none | — | — |

Kernel messages seen: "Boundary tests passes only with a recorded report of at least one executed and zero failed tests." and "passed requires exit 0 and evidence". Conclusion: the harness has no present defect, but the rewritten accepted assertions do not encode the kernel acceptance gate (B1).

**Probe B — parity sensitivity** (`probe-b.mts factory-acc|factory-not|harness-acc|harness-not`, `compare.mts`). The factory pumps took about 334 s each; each harness run took about 115-145 s under contention.

| Scenario | V0 real harness | V1 `ambientNodeOptions → "--test-reporter=tap"` | V2 `changedFilesFor → []` |
|---|---|---|---|
| accepted (`node --test`) | parity PASS | parity **FAIL** (outcome unknown ≠ passed; counts; reason) | parity PASS (changedFiles differ, undetected) |
| not accepted (`testFile: null`) | parity PASS | parity **FAIL** (counts; reason) | parity PASS (undetected) |

Normalized full-record diff of the factory pump against the V0 harness: `passed`, `executedScope`, `changedFiles`, `selection`, and `checks` (ids, command, args, exitCode, outcome, reason, evidence count, report with ids and hashes masked) are **equal** in both scenarios.

**Other checks:** the controller log (19/19 ✔; per-test durations as quoted in M2); `%TEMP%` scan after all runs (no leftover harness or probe directories); `git status` unchanged by this review.
