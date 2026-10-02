# TX-1 evidence — fast report-matrix tests (test-only)

Owner decision CD-18 option 1 (2026-09-28): the 13 report-matrix tests each ran a whole
fake build (plan, worker, review, integration) only to check how the post-integration
boundary reads a test report. They now drive the boundary check directly.

## What changed (test-only; `runner-v2/src` untouched)

- NEW `runner-v2/test/support/delivery-boundary-harness.ts` — `runDeliveryBoundaryDirect(content,
  scripts, { testFile, extraFiles, pathPrefix })`. It builds the boundary driver with the
  same production construction the factory uses (`createDeliveryBoundaryDriver` from
  `runner-v2/src/delivery-execution.ts` with the real audited execution host from
  `createExecutionHost` + `bindRun`, the real delivery workspace slot from
  `createDeliveryWorkspaceSlot`, the real `FinalVerificationRuntime` and report planning
  inside `runDeliveryCategory`; no fakes on the execution path), against a real temp git
  project (fixture files + `src/value.mjs` committed straight to an integration revision)
  and runs the post-integration boundary for T1. The returned boundary record is assembled
  exactly as the kernel records `delivery.boundary_checked` in `build-runtime.ts`
  (`passed` = every check `passed`, `executedScope` = `full_test_script`). Existing test
  seams only: `runGit` from `support/git-fixture.js` and the `bindRun` capability-contract
  seam from `final-verification-runtime-b1.test.ts`. No production factory seam was needed;
  `runner-v2/src` was not edited (prove-red edit restored byte-exact, see below).
- REWROTE `runner-v2/test/native-delivery-report-counts.test.ts` (5 tests),
  `native-delivery-report-runners.test.ts` (4), `native-delivery-report-paths.test.ts` (4)
  to use the harness. Every assertion keeps its meaning (outcome, counts, selected, runner,
  reason text, report path pattern, `boundary.passed`). Where a test also asserted a kernel
  acceptance fact (`projection.delivery.taskAcceptances.T1 === undefined`), it now asserts
  the equivalent boundary fact (`boundary.passed === false`); accepted tests additionally
  assert `boundary.passed === true`. The pump-level `projection` is gone by design — there
  is no pump anymore.
- NEW `runner-v2/test/native-delivery-report-parity.test.ts` (2 tests: one accepted, one
  not accepted). Each runs the full factory scenario AND the harness and asserts the
  tests-check outcome, counts, runner and reason match.
- `runner-v2/test/native-delivery-factory.test.ts` (4 wiring tests) unchanged by TX-1
  (sha256 `1ed81db8…af636e1cc`; TX-1 wrote nothing to it).

## What each rewritten test now drives (all: harness boundary check for T1, real `node --test` run, real report)

counts (5): zero-test `node --test` run → outcome unknown + "did not prove a run" reason;
stale committed `junit.xml`/`test-results.xml` ignored (fresh `.aiboard-report-<24hex>.xml`
path, selected 0); unrecognized runner `node -e 0` → "not a test runner…" reason naming it;
empty `describe` → counts `{0,0,0,0}` + "suites without tests do not count"; `||`-masked
script → `joins commands with "||"`. All assert `boundary.passed === false`.
runners (4): explicit glob accepted (selected 1); project's own `NODE_OPTIONS` kept and
accepted (passed 1); `--test-name-pattern=nomatch` → selected 0 + "file-level entries…
filters tests by name" + `passed === false`; `--test-name-pattern=value` accepted.
paths (4): `cd test && node --test` accepted via absolute runner-owned report path;
`tsx --test` (repo `.bin` on ambient PATH) accepted; `cd src && … "../test/*.test.mjs"`
+ non-matching pattern → selected 0 + `passed === false`; `../` path to a file with no
`test()` call → selected 0 + `passed === false`.

## Parity result

Both parity tests pass: for the accepted scenario (`node --test`, default fixture) and the
not-accepted scenario (`testFile: null`), the full factory pump and the harness agree on
the tests-check outcome, counts, runner and reason (deep-equal counts, equal rest).

## Timings (`--test-concurrency=4`, `NODE_TEST_CONTEXT` cleared; earlier: serial ~1,600 s, parallel before TX-1 1,005 s)

| scope | wall |
|---|---|
| 13 matrix tests as a group (counts+runners+paths) | ~375 s (13 pass) |
| counts alone | ~392 s (5 pass) |
| runners alone | ~315 s (4 pass) |
| paths alone | ~332 s (4 pass) |
| parity alone (2 full pumps + 2 harness runs) | ~553 s (2 pass) |
| wiring alone (unchanged, 4 full pumps) | ~870 s (4 pass) |
| whole group (5 files, 19 tests) | ~932 s (19 pass, 0 fail) |

Per-test runs stay ~75–85 s (real `npm install --package-lock-only`, git, host bind, real
test run); inside one file they execute serially, across files in parallel processes.

## Prove-red (matrix rule: zero-test report is not accepted)

- `runner-v2/src/delivery-execution.ts` sha256 before: `6b859f1ebe493b4da9c9952052b6edddfeda8d544ad32826a45871764744cec8`.
- Temporary edit (line 475, `nodeJunitOutcome`): `executed >= 1 && passed >= 1` →
  `executed >= 0 && passed >= 0` (boundary treats a zero-test report as passed).
- Full counts file went red (exit 1; the two zero-test tests failed). Single-test capture:
  `native-delivery-report-counts.test.ts:11:10` — `assert.equal(tests.outcome, "unknown")`
  failed with actual `'passed'`, expected `'unknown'`.
- Restored byte-exact; sha256 after: `6b859f1ebe493b4da9c9952052b6edddfeda8d544ad32826a45871764744cec8` (equal).
  `git status runner-v2/src` shows no TX-1 change.

## Validation

- 5 files green solo and as a group (19 pass, 0 fail, exit 0).
- `tsc -p runner-v2/tsconfig.json --noEmit`: clean (one parity typing error found and fixed).
- `eslint` on the 5 changed/new test files: clean.
- `git diff --check`: clean. Untracked-file check: new files are exactly the harness +
  the parity test; the rewritten matrix files keep their worktree (uncommitted) paths; no
  other test file touched; `runner-v2/src` untouched.

## sha256 of changed files

- `runner-v2/test/support/delivery-boundary-harness.ts`: `34c99cb2b9eed8256baef9aed458069a68f5f2aa86fc141787c047c6dc7bc626`
- `runner-v2/test/native-delivery-report-counts.test.ts`: `bdf78843d81c49eb5f967408a91ebd2c5ccd0fecf9f99dfa74868807452408da`
- `runner-v2/test/native-delivery-report-runners.test.ts`: `18978daae7c5239d215e9adffc031504404aac1a3893dbed5d6d2beffede31ce`
- `runner-v2/test/native-delivery-report-paths.test.ts`: `a16ba92fedba9539f3c4156c207217bcf81664f8036d0fe168676cf67432eb3d`
- `runner-v2/test/native-delivery-report-parity.test.ts`: `514e24e788d361b5e3989727473559b1f93c834387dfd8798396c66bc7579fff`

## Not done / limits

- The ~5-minute goal for the whole group is NOT met: 932 s (~15.5 min). The 13 matrix
  tests alone are ~375 s (down from 1,005 s parallel / ~1,600 s serial); the remainder is
  the 4 unchanged wiring tests (~870 s, kept whole-pump by decision) plus the new parity
  test (~553 s, two full pumps). Removing the parity pumps or shrinking the wiring set
  would be needed to reach ~5 min — both outside this packet's brief.
- Harness `changedFilesFor` returns `["src/value.mjs"]` (what the factory's durable
  submission yields for these fixtures) rather than a real change set; selection-dependent
  assertions are unaffected (matrix asserts only the tests check + `passed`).
- Harness run/evidence/task ids are fixed (`run-delivery-boundary`, `boundary:T1:1`);
  safe because each call owns an isolated temp root, host binding and stores.
- All changes left uncommitted, per the brief. C2c's uncommitted work in the worktree
  (including `runner-v2/src/*` and `native-delivery-factory.test.ts`) was not touched.

## Repair cycle 1 (B1: accepted-path kernel gate; test-only)

Independent review r1 (`TX-1-review-r1.md`) returned REPAIR — 1 blocking (B1):
the 5 accepted matrix tests checked only `boundary.passed === true`, which the
harness computes itself, and never ran the kernel's record checks
(`assertTestsOutcome`, the passed-check rules, `validateSchedulerEvidenceEvent`,
artifact existence). Fix, test-only, in the shared harness path:

- NEW exported `assertKernelRecordsBoundary(boundary, { evidenceStore,
  artifacts })` in `runner-v2/test/support/delivery-boundary-harness.ts`. It
  builds the `delivery.boundary_checked` event exactly as `build-runtime.ts`
  appends it, mirrors the `deliveryBoundaryChecked` reducer per-check rules,
  and gates through the REAL exported kernel functions (not copies):
  `assertTestsOutcome` (`delivery-acceptance.ts`),
  `validateSchedulerEvidenceEvent` (`scheduler-store.ts`, against the live
  harness evidence store with a non-undefined projection so the
  command-evidence path runs), and `finalVerificationEventArtifactHashes` +
  `ArtifactStore.verifySync` (the append-time artifact gate). Throws exactly
  when the kernel would reject the record.
- `runDeliveryBoundaryDirect` calls it before cleanup for EVERY record
  (accepted or not), and accepted records additionally re-check HEAD's
  accepted-path assertions in the shared path (`assertAcceptedBoundaryShape`:
  report status passed, counts.passed >= 1, 64-hex artifactHash, passed tests
  check carrying evidence) — so all 5 accepted matrix tests check them again.
  Harness docstring updated (record is validated, not just shape-assembled).
- NEW negative test in `native-delivery-report-counts.test.ts` ("B1: the
  kernel record validation rejects a boundary whose tests report counts were
  edited"): via a test-only `mutateBoundaryForTest` harness hook, the tests
  report counts get `failed = 1` with outcome still passed (the reviewer's
  probe shape); the run rejects with
  "at least one executed and zero failed tests".
- No other test file touched; `runner-v2/src` untouched.

Prove-red (drop the kernel validation call from the harness → negative test
goes red; byte-exact restore):

- Harness sha256 before: `245145cf6443e6640b6e9528788e35c4c59f31b5cd801fc2ab95315b8695a557`.
- With the `assertKernelRecordsBoundary` call dropped, the B1 test alone went
  red: fail 1, `AssertionError [ERR_ASSERTION]: Missing expected rejection`
  (`native-delivery-report-counts.test.ts:63`).
- Restored byte-exact; harness sha256 after:
  `245145cf6443e6640b6e9528788e35c4c59f31b5cd801fc2ab95315b8695a557` (equal).

Validation (`--test-concurrency=6`, `NODE_TEST_CONTEXT` cleared):

- 6-file group (4 report files + `native-delivery-factory.test.ts` +
  `native-delivery-factory-tiers.test.ts`): 20 pass, 0 fail; wall 812.8 s
  (~13.5 min). B1 negative test alone: ~118.6 s pass; red run ~106.7 s.
- `tsc -p runner-v2/tsconfig.json --noEmit`: clean. `eslint` on the 5 TX-1
  test files: clean. `git diff --check`: clean. Untracked-file check: no new
  files from this cycle (only the TX-1 harness + 4 report files, already
  untracked); `%TEMP%` has no leftover `aiboard delivery boundary *` dirs.
- Nothing committed, staged, stashed or pushed. Other uncommitted work in the
  worktree (C2c `runner-v2/src/*`, `native-delivery-factory.test.ts`, etc.)
  not touched.

sha256 of changed files (this cycle):

- `runner-v2/test/support/delivery-boundary-harness.ts`: `245145cf6443e6640b6e9528788e35c4c59f31b5cd801fc2ab95315b8695a557`
- `runner-v2/test/native-delivery-report-counts.test.ts`: `47cc6003f2830082d5d6da21d54d72281b9ba6bca3b8f00ab05492156106eacf`
- runners/paths/parity: unchanged this cycle (shas as above).

## Acceptance (controller)

Review r2 (`TX-1-review-r2.md`): **ACCEPT, 0 blocking.** The harness runs the kernel's real checks; all three round-1 mutants are rejected; the real reducer records all 13 matrix records; no assertion removed or weakened. Minor follow-ups: N1 (the docstring's "exactly" is too strong: some kernel shape checks, for example a missing runner, are not repeated; the driver cannot produce those records) and N2 (the negative test covers one of three checks).
Controller changes in the same commit: the original `native-delivery-factory.test.ts` was split mechanically into the shared scenario `test/support/delivery-factory-scenario.ts`, two wiring files (`native-delivery-factory.test.ts`, `native-delivery-factory-tiers.test.ts`) and the report files TX-1 then rewrote (CD-18). Group timing: 19/19 in 632 s at concurrency 6 before this repair, 20/20 in 812.8 s after it (both measured next to a running review); about 1,600 s serial before CD-18.
