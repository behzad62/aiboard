# T6a independent review — round 8 (narrow)

Reviewer: independent Claude session (no shared memory with the controller; no source or test edits; no commits).
Date: 2026-09-25. Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6` (T6a uncommitted, 28 changed files).
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r8\`.

## Scope

Only the "Repair cycle 3f" changes:
- `runner-v2/src/delivery-execution.ts` `planTestReport` head-token regex (R7-B1), `nodeJunitTestCases` `tail()` `./`/`../` stripping (N-R7-1), and the new pure `nodeJunitOutcome` (NOTE-3).
- New tests: `test/delivery-acceptance.test.ts` (N-R7-1 unit, R6-B1 fast guard, tsx plan cases) and `test/native-delivery-factory.test.ts` (R7-B1 factory, two N-R7-1 factory tests, and the `extraFiles` mkdir/0755 harness change).

## Integrity

- START: sha256 of all 28 files in `git status --short` equals the "Repair cycle 3f" list (mechanical `diff`: MATCH28). `delivery-execution.ts` = `e168d709…f2da92`.
- END: same 28 hashes, unchanged (END-UNCHANGED 28). `git status --short` still shows 28 entries.
- Mutations were done only in byte-identical scratch copies (`copy/`, `copy2/`: 532 src+test files identical to the worktree, verified by sha256 lists), each restored byte-exactly (restored sha = worktree sha, recorded per run).

## Verification

### 1. Plan matrix (unit, `planTestReport`, win32 and linux; `probe-r8-plan.test.ts`, 1/1 pass; `plan-matrix.txt`)

Accepted as the node runner (runner `node --test`, NODE_OPTIONS reporter set) on both platforms:
`tsx --test`, `tsx --test test/*.test.ts`, `npx tsx --test`, `tsx.cmd --test`, `tsx.exe --test`, `TSX --test`, `tsx --tsconfig tsconfig.test.json --test`, `tsx --import ./setup.mjs --test`, `tsc && tsx --test`, `node --test`, `node --test test/`, `cd src && node --test "../test/*.test.mjs"`.
Filtered = true: `tsx --test --test-name-pattern=nomatch`, `--test-skip-pattern=x`, `--test-only`.
Refused (unsupported): `tsx`, `tsx watch`, `tsx scripts/run-tests.ts`, `tsx --test --test-reporter=dot` (own reporter), `tsxx --test`, `tsx-node --test`, `ts-node --test`, `npx --yes tsx --test`, `node_modules/.bin/tsx --test`.
Planned but not a test runner: `tsx scripts/run-tests.ts --test`, `tsx watch --test` (see NOTE-1/NOTE-2; both proven harmless below).

### 2. Real reports from real tsx/node (hand runs, `hand/`, fed to the real `nodeJunitOutcome`; `outcome.txt`)

| Shape (cwd) | Report | Outcome |
|---|---|---|
| `tsx --test test/value.test.ts` | yes | passed, selected 1 |
| `tsx --test --test-name-pattern=nomatch` | yes (1 file-level entry) | unknown, selected 0 |
| `tsx --test test/empty.test.ts` (no test()) | yes | unknown, selected 0 |
| `tsx --test value + empty` | yes | passed, selected 1 (file-level subtracted) |
| `tsx --test failing.test.ts` | yes, rc 1 | failed |
| `tsx scripts/run-tests.ts --test` | **no report** | (unknown in the runner) |
| `cd src && tsx --test --test-name-pattern=nomatch ../test/value.test.ts` | name `..\test\value.test.ts` → fileLevel true | unknown, selected 0 |
| `cd src && tsx --test ../test/empty.test.ts` | fileLevel true | unknown |
| `cd src && node/tsx --test --test-name-pattern=nomatch ../test/../test/value.test.ts` | node normalises the name to `..\test\value.test.ts` → fileLevel true | unknown |
| `--test-skip-pattern=value` (skips all) | 1 file-level entry, pass 1 | unknown |
| `tsx watch --test` (killed after 25 s, rc 124) | yes, report says passed | report passed, but the exit code is non-zero/null so `testsOutcome` is failed/unknown |

No leftover watch processes after the hand runs (checked with `Get-CimInstance`).

### 3. Factory probes (end-to-end runtime, `probe-r8-factory.test.ts` = byte copy of the factory file + appended probes; `run-probe-r8b.txt`): 11 tests, 11 pass, 0 fail

Run with the worktree's `node_modules/.bin` on PATH (see R8-B1 for why this is needed):

| Probe | tests outcome | accepted |
|---|---|---|
| PR8-TSX-GLOB `tsx --test test/*.test.mjs` | passed, selected 1 | yes |
| PR8-TSX-NOMATCH `tsx --test --test-name-pattern=nomatch` | unknown | no |
| PR8-TSX-FAIL `tsx --test` + failing test | failed (exit 1, report failed) | no |
| PR8-TSX-NOTEST no-test file | unknown, 0 real | no |
| PR8-TSX-SCRIPTARG `tsx scripts/run.mjs --test` | unknown, "wrote no junit report" | no |
| PR8-TSX-SCRIPT `tsx scripts/run.mjs` | unknown, "not a test runner" | no |
| PR8-TSX-DOTDOT-NOMATCH `cd src && tsx --test --test-name-pattern=nomatch "../test/*.test.mjs"` | unknown | no |
| PR8-INV-R7-DOTDOT-FILTER (r7 probe, inverted) `cd src && node --test --test-name-pattern=nomatch "../test/*.test.mjs"` | unknown | no |
| PR8-INV-R7-DOTDOT-NOTEST (r7 probe, inverted) `cd src && node --test "../test/*.test.mjs"` + no-test file | unknown | no |
| PR8-DOTDOT-REAL `cd src && node --test "../test/*.test.mjs"` real test | passed, selected 1 | yes |
| PR8-NPX-TSX `npx tsx --test` | passed, selected 1 | yes |

Both r7 findings are fixed in production: R7-B1 (`tsx --test` shapes are accepted with real counts) and N-R7-1 (`../` names recognised; the two r7 probes that were accepted with 0 real tests are now `unknown` / not accepted). The owner's real-counts rule holds for every tsx shape probed: zero real tests, a failing run and a script that is not node's runner are never counted as passed; each report is this run's own runner-owned path.

### 4. Earlier-round behaviour still holds

Plan matrix: `&&`-only chains, shell-character refusal, own `--test-reporter` refusal, NODE_OPTIONS kept/appended, `NODE_TEST_CONTEXT` cleared, filter detection — unchanged (the controller's unit asserts plus my matrix). `readRunReport` still delegates node reports to the same counting (now `nodeJunitOutcome`); failing/zero-test/filtered cases give the same statuses as r7 (factory probes above). `testsOutcome` (delivery-acceptance.ts:96) still fails any non-zero exit. No regression found in production code.

### 5. Shim leakage

`grep` of `runner-v2/src` for `node_modules`/`.bin`/`tsx.cmd`: only the head-token regex at delivery-execution.ts:287. The shims exist only in the test fixture (`extraFiles`). No production leak. (But the shims also do not do what the evidence says — R8-B1.)

## Prove-red records (copy2, byte-exact restore each time)

`before = after = worktree = e168d7095b585837edf478ea510ce9a0da1180868123e9562595263be5f2da92` for every row (RESTORED-MATCH).

| Id | Injection in `delivery-execution.ts` | Injected sha256 | Test run | Result |
|---|---|---|---|---|
| FAST-EXEC | `executed = Math.max(0, summary.tests)` (no subtraction) | `6840402d…d9fd01fc` | unit `R6-B1 (fast guard)` | RED 1/1 fail |
| FAST-PASS | `passed = Math.max(0, summary.pass)` | `e62e577b…e6cec7f4` | unit `R6-B1 (fast guard)` | RED 1/1 fail |
| N1-DOTDOT | `tail` strips only `./` (`/^(\.\/)+/`) | `abef0096…fe8c17ed8` | unit `N-R7-1` | RED 1/1 fail |
| B1-REGEX | head regex back to `/^node(\.exe)?$/i` | `ab1aff26…295c96ad53` | unit `real counts: the report plan…` | RED 1/1 fail |
| B1-NOTEST-GUARD | drop `&& head.includes("--test")` | `3ede548c…99084724` | unit `real counts: the report plan…` | RED 1/1 fail (`tsx src/cli.ts` no longer refused) |
| FAST-FILTERGUARD | `(!filtered \|\| realCases.length >= 1)` → `true` | `e5932e33…378ab0204e` | unit fast guard; then all of delivery-acceptance.test.ts | GREEN 1/1 and 28/28 — see NOTE-3 |

The fast guard really guards the R6-B1 subtraction (both the `executed` and `passed` subtractions go red in milliseconds).

## Findings

### BLOCKING

**R8-B1 — the R7-B1 factory test does not test what it claims and is red in a clean environment.**
File: `runner-v2/test/native-delivery-factory.test.ts:387-399` (evidence T6a.md:584, "reached through committed `node_modules/.bin/tsx(.cmd)` shims in the fixture project").
Scenario: the fixture project's `.gitignore` (the runner's safety defaults) contains `node_modules/` (`git check-ignore -v node_modules/.bin/tsx.cmd` → `.gitignore:9:node_modules/`), so the shims are never committed and never reach the integration checkout where `npm run test` runs (the checkout holds only `.gitignore`, `package-lock.json`, `package.json`, `src`, `test`). The command resolves `tsx` from the ambient PATH instead. The test therefore passes only when the test process's PATH already has a `tsx` (for example when it is started from an npm script, which puts the repository's `node_modules/.bin` on PATH).
Reproduced in the WORKTREE with the prescribed command from the repo root (`node .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 --test-name-pattern="^R7-B1" runner-v2\test\native-delivery-factory.test.ts`, `NODE_TEST_CONTEXT` cleared): **1 test, 0 pass, 1 fail** — `exitCode 1, outcome failed`, stored stderr `'tsx' is not recognized as an internal or external command`. The same command with `<worktree>\node_modules\.bin` prepended to PATH: **1/1 pass**. So `native-delivery-factory.test.ts` (claimed 17/17 in 3f) is 16/17 under a clean PATH — a red suite in the gate matrix / CI, and the recorded mechanism is false. (The production fix itself is correct; the controller's PR-R7-B1 red was genuine because the plan refusal happens before any command runs.)
Minimal fix: make the fixture's `tsx` reachable independent of the caller's PATH — e.g. in the test, pass the execution host an ambient environment whose PATH is prefixed with the repository's `node_modules/.bin` (or a scratch directory holding the shims), or put the shims in a committed, non-ignored directory and prepend it to PATH for the run; drop the ignored `node_modules/.bin` extraFiles. Then correct the 3f evidence wording and re-run the factory file under the plain `node …cli.mjs --test` command without `node_modules/.bin` on PATH.

### NON-BLOCKING

None.

### NOTE

- **NOTE-1** `delivery-execution.ts:287` — `head.includes("--test")` accepts `--test` anywhere, so `tsx scripts/run-tests.ts --test` (and pre-existing `node script.mjs --test`) get the node plan although `--test` is the script's argument. Harmless: the outcome comes only from this run's own report; with no report it is `unknown` (PR8-TSX-SCRIPTARG), and a script that really runs `node:test` produces real counts. Optional: require `--test` before the first non-flag token.
- **NOTE-2** `tsx watch --test` (and pre-existing `node --test --watch`) is planned; it never exits, so the command times out and `testsOutcome` gives failed/unknown even though a passing report exists. No acceptance; only a wasted timeout. Optional: refuse `watch`/`--watch` with a clear reason.
- **NOTE-3** `delivery-execution.ts:473` — the R6-B1 `filtered` guard (`!filtered || realCases.length >= 1`) is unguarded by any unit test (FAST-FILTERGUARD: fast guard 1/1 green, whole delivery-acceptance file 28/28 green). It is defence in depth behind the subtraction (every real no-match report I produced has executed = 0 already), so it is not blocking; a one-line fast-guard case whose summary over-reports (e.g. `tests 2 / pass 2` with one file-level entry and no real case, `filtered=true`) would pin it.
- **NOTE-4** Safe refusals of uncommon shapes: `npx --yes tsx --test`, `node_modules/.bin/tsx --test`. Refusal is `unknown`, never a false pass.
- **NOTE-5** The `../` suffix rule can only mark more entries file-level (undercount), never fewer; node normalises `../test/../test/x` names before reporting, so the contrived un-normalised form does not occur in practice.

## Commands and exact counts

| Command (repo root or scratch copy; `NODE_TEST_CONTEXT` cleared) | Tests | Pass | Fail |
|---|---|---|---|
| copy: `probe-r8-plan.test.ts` (plan matrix, 52 shape×platform lines) | 1 | 1 | 0 |
| copy: `probe-r8-outcome.test.ts` (real hand reports → `nodeJunitOutcome`) | 1 | 1 | 0 |
| copy: `probe-r8-factory.test.ts --test-name-pattern=^PR8-`, clean PATH (first attempt) | 2 run | 0 | 2 (stopped; `'tsx' is not recognized`) → led to R8-B1 |
| copy: `^(R7-B1\|PR8-TSX-NOMATCH)`, clean PATH, fixtures kept | 2 | 0 | 2 |
| **worktree**: `native-delivery-factory.test.ts --test-name-pattern=^R7-B1`, clean PATH | 1 | 0 | 1 |
| **worktree**: same, `node_modules/.bin` on PATH | 1 | 1 | 0 |
| copy: `probe-r8-factory.test.ts --test-name-pattern=^PR8-`, `node_modules/.bin` on PATH | 11 | 11 | 0 |
| copy2 prove-red FAST-EXEC / FAST-PASS / N1-DOTDOT / B1-REGEX / B1-NOTEST-GUARD | 1 each | 0 | 1 each (RED) |
| copy2 prove-red FAST-FILTERGUARD (fast guard / whole unit file) | 1 / 28 | 1 / 28 | 0 / 0 |

Suites the controller ran green were not re-run in full (owner rule); only the single R7-B1 test was run in the worktree to confirm R8-B1.

T6a REVIEW r8 — REPAIR REQUIRED — 1 blocking
