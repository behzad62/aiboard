# T5 independent review — round 1

Reviewer: independent reviewer (a different model from the T5 worker, Muse).
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`, branch `codex/runner-v2-p6-6-t5`, base `57e80f45`, T5 not committed.
No source or test file was edited. The only file written in the repo is this review. Scratch probes are in
`C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5\` (`probes.test.mts`, plus `base-sqlite-evidence-store.mts`, a copy of the base-version store from `git show 57e80f45:` with only its imports rewritten).

## Scope reviewed

- New: `validation-policy.ts`, `validation-observation.ts`, `evidence-applicability.ts`, `change-risk.ts`, `affected-tests.ts`, `test-report-readers.ts`, `mutation-probe.ts`, and their 8 test files.
- Modified: `evidence-store.ts`, `sqlite-evidence-store.ts`, `evidence-tools.ts`.
- Scope check: `git status` shows only the files above. No scheduler, planning, build-runtime, factory, runtime, architect, prompt, T1-contract, UI or package file was touched. No new dependency. No existing test file was modified. `createEvidenceTools` is unchanged; the new tools are in a separate `createValidationEvidenceTools`.

## Requirement checklist (must / must-not)

| Req | Must / must-not | Result |
|---|---|---|
| EP15 | Derive intent from behavior with a concise impact reason. Exact failures first. Baseline failures need an explicit disposition and are never an automatic waiver. | Met (`validation-policy.ts`). |
| EP16 | The full suite runs on the final candidate unless a mandate requires it earlier. Conflicts are surfaced. | Met. |
| EP17 | RED→GREEN pairs for the same defect. Fault injection is controlled and restored. Harness failures are excluded. | Met at the record level. |
| EP18 | These cannot satisfy acceptance: zero selected tests, no relevant assertions, an unexplained skip, a stale dirty tree, a substituted artifact, the wrong environment, an unrelated RED, a prose claim. Evidence records the dirty delta and its artifacts. | **Not met:** B4, B5, B9. |
| EP19/20 | Reuse only with a recorded proof. Missing impact info never leads to reuse. Only affected edges are invalidated. | **Not met:** B6. Propagation itself is correct. |
| EP35 | `unverified_claim` is decided mechanically. The residue is labelled as judgement. | Met, with weak spots (N5). |
| EP38 | `change-risk.ts` is pure and deterministic, with the six signals as constants. A lower tier raises risk. Thresholds are measured against the P6.5 commits. | Met (re-derived below). N8 applies. |
| EP45 | The OA-11 ladder. Non-building mutants are discarded. Disposable copy. Caps are recorded. Survivors go to the reviewer and never block. The rung is recorded. | **Not met:** B10. N6 and N7 also apply. |
| EP46 | The OA-12 ladder. Widening goes to at least the module graph. A failed rung steps down. Never an empty selection, never narrower than justified. | **Not met:** B7, B8. |
| EP47 | JUnit and TRX readers. A missing, empty or unreadable report is `unknown`, never `passed`. | **Not met:** B1, B2, B3. N1 also applies. |
| EP48 (obs) | Re-run once, on the same revision and environment, and record one flaky-isolation observation. | Met, with weak spots (N4). |
| Store | Additive tables. Recording is idempotent. Survives restart. A base-version DB still opens. Existing surfaces are unchanged. | Met, except B9 and N9. |

## Findings

### BLOCKING

**B1 — A report where nothing ran reads as `passed`.** `test-report-readers.ts:116-121, 153-156, 172-175`.
- `outcomeFromReportReading` returns `passed` whenever `selected > 0 && failed === 0`, even when `passed === 0`.
- Probes:
  - R1: JUnit `tests="3" skipped="3"` gives `{outcome:"passed", passed:0, skipped:3}`.
  - R2: TRX `total="4" executed="0" passed="0" notExecuted="4"` gives `passed`.
  - R4: gtest with all tests disabled (`tests="2" disabled="2"`, testcases `status="notrun"`) gives `passed` with `passed:2`, because `disabled` is ignored.
- End to end (probe A3): the same all-skipped counts with `skipRationale:"skip"` satisfy `assessObservationForAcceptance`. That is a false green on an OA-13 path.
- Fix:
  - Report `unknown` when `passed === 0`, or when executed is 0 (TRX `executed`).
  - Count JUnit `disabled`, and `status="notrun"` testcases, as not executed.

**B2 — TRX `timeout` and `aborted` count as skipped, so the run reads as `passed`.** `test-report-readers.ts:148-156`.
- `skipped = total - passed - (failed + error)`.
- Probe R3: `total="3" passed="1" failed="0" timeout="1" aborted="1"` (ResultSummary `outcome="Failed"`) gives `{outcome:"passed", skipped:2}`.
- Fix:
  - Add `timeout` and `aborted` to failed.
  - Treat `inconclusive`, `passedButRunAborted`, `notRunnable`, `disconnected` and `inProgress` as `unknown` (or failed), never as skipped.
  - Treat a `ResultSummary outcome` that disagrees with the counters as `unknown`.

**B3 — Malformed or self-contradicting JUnit is read as `passed`.** `test-report-readers.ts:75-111`.
- The reader trusts the first `<testsuites>` aggregate and never cross-checks the document. Probes:
  - R5: aggregate `failures="0"` while a `<testcase>` contains `<failure>` gives `passed`.
  - R6: a report truncated mid-write (`...<testc`) gives `passed` 5/5.
  - R7: totals inside an XML comment are preferred over the real `<testsuite tests="2" failures="1">`. The result is `passed` 9/9 against a real failure.
  - R8c: an XXE DOCTYPE document still reads `ok` (no expansion happens, which is fine). It shows that DOCTYPE and entity documents are not rejected.
- OA-13 says unreadable means `unknown`.
- Fix:
  - Strip comments and CDATA before scanning.
  - Require a balanced root close (`</testsuites>` or `</testsuite>`).
  - When `<testcase>` elements exist, require the aggregates to equal the element counts (`<failure>`, `<error>`, `<skipped>`). Any disagreement is `unknown`.
  - Reject `<!DOCTYPE`/`<!ENTITY` as `unknown`.

**B4 — A stale dirty-tree observation satisfies acceptance against a clean current tree.** `validation-observation.ts:199-209`.
- When `expectedUncommittedContentDigest` is undefined (the caller's current tree is clean), an observation with `dirty:true` and any digest passes. The comparison only runs when an expected digest is supplied.
- Probe A1: dirty observation `uncommittedContentDigest:"dirtyX"` against a clean expected tree gives `{satisfies:true}`.
- The evidence therefore describes content that no longer exists. The worker's test and prove-red #4 only cover the case where both sides are dirty.
- Fix:
  - Make the expected clean or dirty state explicit (for example `expectedDirty: boolean`, required).
  - Reject when `obs.dirty !== expectedDirty` or when the digests differ.

**B5 — Required assertions that were skipped, or never exercised, still satisfy acceptance.** `validation-observation.ts:187-195`.
- Relevance is `some(required ∈ selected)`. Skipped IDs are never subtracted, and any non-empty `skipRationale` counts as an explanation. Probes:
  - A2: required `a1` is in both `selectedAssertionIds` and `skippedAssertionIds`, with rationale `"n/a"`. Result: `satisfies:true`.
  - A3: every selected test is skipped, `passed:0`. Result: `satisfies:true`.
  - A7: only 1 of 3 required assertions was selected. Result: `satisfies:true`. This is the OA-2 "criterion never exercised" shape, the P6.5 defect this phase exists to catch.
  - A6: `requiredAssertionIds: []` skips the relevance check entirely.
- Fix:
  - Require every required assertion to be selected and not skipped (and passing, where per-assertion results exist).
  - Fail closed when the required list is empty.
  - Never let a skip rationale cover a required assertion.

**B6 — Evidence is reused when behavior impact was never inspected.** `evidence-applicability.ts:95, 121-125`.
- `behaviorChanged = (input.changedCheckIds ?? []).includes(checkId)`. An omitted `changedCheckIds` (behavior/code impact not inspected) cannot be told apart from "inspected, nothing changed".
- Probe E1: four matching fingerprints across `r1..r2`, `changedCheckIds` omitted, gives `reusable`.
- There is also no source-content or uncommitted-digest dimension, so a code change between snapshots is invisible unless the caller volunteers it. EP19 and the T5 checkbox say missing impact info leads to a bounded investigation, never unconditional reuse. T1's own note I8 makes the same point about a bare "not provided".
- Fix:
  - Require an explicit behavior-impact observation (inspected plus old/new identity of the check's input closure, or an explicit list that has been marked inspected).
  - Return `unknown` when it is absent.

**B7 — The affected-tests ladder returns an empty selection on widening triggers and on common layouts.** `affected-tests.ts:364, 387-393, 410-416`.
- The module-graph rung returns `[]` with status `ok` whenever no changed file sits inside a module directory, or no file matches the `isTestFile` heuristic. Probes:
  - T1: changing `package-lock.json` in an npm workspace (a widening trigger) gives `{rung:"module_graph", tests:[], widened:true}`.
  - T4b: changing `Directory.Build.props` in .NET gives `tests:[]`, widened.
  - T2: a root-level shared source file outside the workspaces gives `[]`.
  - T4: a realistic xUnit layout (`tests/App.Tests/CalcTests.cs`, with a ProjectReference to the app) gives `[]`. `isTestFile` does not recognise `*Tests.cs`, and the worker's .NET and CMake fixtures use `.test.ts` files.
  - T7: a Cargo crate with inline `#[cfg(test)]` tests gives `[]`.
  - T3: an impact tool with `configured:true` but no `run` gives rung `impact_tool` with `[]`.
  - T8: LSP `ok` with zero references gives rung `lsp_references` with `[]`.
- OA-12 says a widening trigger reaches at least the module graph, never narrower than justified, and never an empty selection.
- The worker's tests "widening triggers step down…" and "unsupported_language is a failed rung…" assert only the rung, and both actually produce `tests: []` (`affected-tests.test.ts:44-58, 102-121`).
- Fix:
  - A lockfile or root build-config change affects every module.
  - A changed file outside every module, or an empty rung result, steps down (to the full suite when nothing is selected).
  - An impact tool with no `run` counts as not configured.
  - Assert the actual selection in the tests.

**B8 — The module graph drops dependents for Go and Gradle, so it selects fewer tests than justified.** `affected-tests.ts:251-265, 279-285`.
- The Go parser emits packages with `dependsOn: []`, despite its doc comment ("dependents via import comments").
- The Gradle parser reads only `settings.gradle` includes, with no `project(':x')` edges.
- Probe T5: `api` imports the changed `util`; only `util/u_test.go` is selected.
- Probe T6: `app` depends on `core`; only `CTest.java` is selected.
- At high tier this command is the OA-4 affected-test run. A broken dependent is never run, which is a false-green route.
- Fix:
  - Parse Go `import "<module>/<pkg>"` lines and Gradle `project(':x')` dependencies.
  - Where edges cannot be parsed, treat every module as a dependent (the safe direction).

**B9 — The durable observation loses the identity fields the acceptance gates need.** `evidence-store.ts` (`StoredValidationObservation.observation: ValidationObservation`) and `sqlite-evidence-store.ts` `recordObservation`.
- Only the frozen T1 shape is persisted. Probe S1 lists the stored keys: there is no `capabilityFingerprint`, `uncommittedContentDigest`, `artifactHashes` or `skipRationale`.
- After a restart, T6 cannot re-run the stale-dirty-tree, substituted-artifact, capability or skip checks from durable state. EP18 requires the stored evidence to identify the dirty delta and its artifacts.
- Fix: persist the `MeaningfulObservation` envelope additively, for example an extra JSON column or wrapper object. No T1 change is needed.

**B10 — Rung 1 of the mutation probe discards the tool's survivors and reports a failed tool as a successful rung.** `mutation-probe.ts:471-497`.
- `survivors: []` is hard-coded. `parseSurvivors` output appears only as a note count. A non-zero or 127 exit is not treated as a failed rung.
- Probe P1: the tool exits 127 ("not found") and `parseSurvivors` returns 2. The result is `{rung:"project_tool", survivors:0, partial:false}`.
- The reviewer is told "no survivors", which is the opposite of the evidence. OA-11 says to output survivors as reviewer evidence and to record the rung that was actually used.
- Fix:
  - Carry the tool's survivors into `survivors`, typed as tool IDs.
  - Treat a tool that failed or could not be launched as a failed rung, then step down to the built-in mutator and record it.

### NON-BLOCKING

- **N1 — The report scanners hang on quadratic input.** `test-report-readers.ts:75, 87, 137`.
  - `/<testsuite\b[^>]*>/g` backtracks to the end of the input for every opening tag that has no `>`.
  - Probe R9 (JUnit): 22 KB takes 24 ms, 88 KB takes 346 ms, 352 KB takes 5.5 s.
  - Probe R9trx (TRX): 320 KB takes 4.9 s.
  - At the 10 MB bound this extrapolates to more than an hour. A worker controls the report file, so this is a hang on untrusted input.
  - Fix: use a linear scan (`indexOf` for `<` and `>`) or bound it with `[^>]{0,8192}`.
- **N2 — Acceptance never compares config or dependency fingerprints** (probe A4 passes with `OLDcfg`/`OLDdep`). `validation-observation.ts:216-221`.
- **N3 — Prose detection is the literal `method === "prose"` only** (probe A5: `method:"manual-claim"` passes). `validation-observation.ts:184`. Use an allow-list of supported machine-readable methods instead.
- **N4 — `recordFlakyIsolation` checks only the count of re-run tests.** It does not check which tests were re-run (they could be different tests), and it ignores capability, config and dependency fingerprints (probe A10 records `flaky`). `validation-observation.ts:383-414`.
- **N5 — `decideUnverifiedClaim` verifies a claim with an empty revision and no artifacts** (probe E2). `evidence-applicability.ts:231-237`.
  - The command check compares `[command, ...args].join(" ")`, so `npm`+`["test"]` and `"npm test"`+`[]` are indistinguishable.
  - Fix: require a non-empty revision and at least one cited artifact; compare argv structurally.
- **N6 — The lexer is not string-aware for several C-family constructs.** Mutants are generated inside:
  - Java text blocks and Kotlin, Swift or C# `"""` strings (M1, M2).
  - C# verbatim strings, including multi-line ones (M3).
  - Rust `r#"…"#` and C++ `R"(…)"` raw strings (M4raw, M5raw).
  - Rust, Kotlin or Swift nested block comments (M4nested).
  - JS regex literals (M5regex).
  - Generic brackets `List<String>` are also mutated (M7), which produces mutants that cannot build.

  Survivors never block, so the harm is reviewer noise and wasted mutant budget. It is still short of OA-11's string-aware lexer.
- **N7 — Mutants that do not build count as caught by default.** With no `buildCommand` and no `isBuildFailure`, a compile error counts as caught (probe P2: 2 caught, 0 discarded). This is contrary to OA-11's "discarded, not counted as caught". For compiled families, require one of the two, or report caught as unverified. `mutation-probe.ts:436, 541-550`.
- **N8 — The shared-kernel set is hard-coded to Runner V2 basenames** (`change-risk.ts:77-106`). For any target project the kernel signal is always 0 (probe C1: `src/core/scheduler.py` is not kernel). Accept a caller-supplied named set, and keep this set as the P6.5 measurement fixture.
- **N9 — `recordObservation` accepts an `evidenceId` that does not exist in `evidence_records`** (probe S1: `"does_not_exist"` is stored). Check existence in the same run.
- **N10 — An LSP result with `truncated: true` is treated as a complete selection** (probe T8b). Step down instead.
- **N11 — The worker's ladder and fixture tests do not assert selections** (see B7). The .NET and CMake fixtures use TypeScript test filenames, so the parsers are untested on realistic layouts.

### NOTES

- Idempotent replay compares `JSON.stringify`, so the same observation with its keys in a different order raises "idempotency conflict" (probe S1). This is harmless but brittle.
- Base-version DB migration works. A DB created by the base-version `SqliteEvidenceStore` opens read-only (`listObservations` returns `[]` because `hasTable` guards it), then read-write. The legacy evidence row is preserved, and an observation survives close and reopen (probe S1).
- `maxMs` is checked only between mutants, so one command can overrun it by up to `perCommandTimeoutMs`.
- In `resolveInheritedBaselineFailures`, when a check has duplicate dispositions the last one silently wins.

## Change-risk measurement (EP38) — re-derived

- I re-derived all 14 commits (`git log --no-merges f3bccc8a^1..f3bccc8a^2`, excluding docs-open `a4e62e1d`) with `git show --numstat`, excluding `progress.md`.
- File counts match 14/14. Line counts match 11 of the 12 text commits. The exception is `9c437b47`: 462 by my count against 450 in the table. Its size points stay at 2 either way, so the tier is unchanged.
- The defect labels agree with the P6.5 ledger (`progress.md` lines 129–136):
  - P6.5.2 (`919ea31a`): 3 defects.
  - P6.5.3 (`d42bd321`): 2 coverage gaps.
  - P6.5.4 (`1aab6713`): coverage gaps.
  - P6.5.5b (`fb1cfe67`): dead code.
  - P6.5.6 (`58f71603`): pass 1 was not blind, which only execution could show.
  - P6.5.5a, 5c and 5d had "no findings".
- All three conditions hold:
  - None of the five defect commits is `low`.
  - Four trivially safe commits are `low`.
  - `58f71603` is `high`.
- On overfitting: `CHANGE_RISK_SIZE_LINES_LOW_MAX = 120` sits just above `86c523ec` (117 lines). The criteria do not depend on it, because `cb84807f` and both bundle commits are `low` regardless. I see no obvious per-commit tuning.
- Caveat: the kernel and size signals do nearly all the separating. P6.5 cannot exercise the no-test and waiver signals, as the worker says.

## Commands and counts

- sha256 of all 18 files listed in `evidence/T5.md`: **18/18 match** the working tree (`sha256sum`).
- Reviewer probes: `node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5\probes.test.mts` gave 41 observational probe tests, all executed. The `PROBE …` outputs cited above come from this run. The two asserting probes (C1 determinism, S1 migration and restart) passed.
- Worker suites were not re-run, per the owner rule.
- **Prove-red reproduced: an unknown report treated as passed** (`test-report-readers.ts`, CRLF).
  - BEFORE: `6c9869ce7df0ff4e4044338f8962b882ad97762453b09f6595f0ff7534cea11a`, 7248 bytes.
  - Injection at line 169: `outcome: "unknown"` becomes `outcome: "passed"`, a unique match.
  - INJECTED: `37df75a43bcd305179044d7e4dd2ecd08c571f617b8f01dcbdfd0e078d8e60c0`, 7247 bytes. This equals the worker's recorded injected hash, and `git diff --no-index` shows 1 line changed.
  - `runner-v2/test/test-report-readers.test.ts` went RED at `:43`: `actual: 'passed', expected: 'unknown'`.
  - Restored from a byte copy. AFTER: `6c9869ce…ea11a`, 7248 bytes. `cmp` reports the file byte-identical.
- Scope: `git status --short` shows only the 3 modified and 15 new T5 files. `git diff --name-only` shows no test or forbidden file.

## Verdict

The zero-selection, RG-2 and harness-RED guards hold. So do the policy, baseline, propagation and change-risk pieces, and the base-DB migration. The acceptance, reader, reuse and affected-test gates each still let a false `passed`, `reusable` or empty or under-selected result through on realistic inputs (B1–B8). The durable record also drops the identities those gates need (B9), and rung-1 mutation survivors are lost (B10).

T5 REVIEW r1 — REPAIR REQUIRED — 10 blocking
