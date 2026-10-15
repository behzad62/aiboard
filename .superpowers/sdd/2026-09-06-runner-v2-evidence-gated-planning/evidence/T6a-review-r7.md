# T6a independent review — r7

Reviewer: independent (Opus). I did not do Repair cycle 3e; the controller did. I have no memory of r1–r6 beyond their files. I edited no source or test file in the worktree and committed nothing. This review is the only file I wrote in the worktree.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted (28 files).

Scratch folder: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r7\`
- `notes.md` is the running log.
- `copy\` and `copy2\` are byte-identical copies of `runner-v2\{src,test,skills,bin,tsconfig.json,package.json}`, verified by sha256 over 532 `src` + `test` files. Each copy's `node_modules` is a junction to the worktree's.
  - `copy\` runs the probes.
  - `copy2\` is used for prove-reds, so an injection cannot touch a running probe.
- `copy\runner-v2\test\probe-r7-factory.test.ts` is the controller's current `native-delivery-factory.test.ts` with 17 probes appended:
  - 5 r6 probes, re-run inverted (`INV-R6-*`);
  - 12 new r7 probes (`R7-*`).

  The probes use the real `NativeBuildFactory`, a real `ExecutionHost`, real npm and `node --test`, and real SQLite. The only harness change is that `extraFiles` creates parent directories.
- `plan-matrix.mts` / `plan-matrix.txt` drive the real `planTestReport` on 46 script shapes (win32 and POSIX) and the real `nodeJunitTestCases` on two junit files that Node 24 wrote by hand.
- `hand\` holds direct `node --test` and `tsx --test` runs.
- The raw probe log is `run-probe-r7.txt`; the prove-red logs are `pr-PR-R7-*.txt`.
- Every child `node --test` ran with `NODE_TEST_CONTEXT` unset.

## Scope

**Read:**
- `T6a-review-r6.md`.
- `evidence/T6a.md` "Repair cycle 3e", plus the 3c section for the owner decision.
- `delivery-execution.ts`: `planTestReport`, `splitAndChain`, `nodeJunitSummary`, `nodeJunitTestCases`, `npmrcSetsNodeOptions`, `readRunReport`, `runDeliveryCategory`, and the probe `explicitEnvironment`.
- `final-verification-runtime.ts`: `sameEnvironment` and `sameCommands`.
- `final-verification-profile.ts`: `validCommand`, `validCommandEnvironment` and `cloneCommand`.
- `native-build-factory.ts:1285-1290`: the ambient `NODE_OPTIONS` lookup.
- The 3e unit and factory tests.

**3d → 3e delta:**
- I diffed the r6 scratch copy (the reviewed 3d bytes) against the worktree.
- Changed source:
  - `delivery-execution.ts`: only `planTestReport`, the new `nodeJunitTestCases` and `npmrcSetsNodeOptions`, `readRunReport`, the imports, and the probe `explicitEnvironment` line.
  - `final-verification-runtime.ts`: `sameEnvironment`.
  - `final-verification-profile.ts`: this file is new in the diff. Its changes are `validCommandEnvironment` and `cloneCommand`, 12 lines added and 2 removed against HEAD.
  - `native-build-factory.ts`: the case-insensitive `NODE_OPTIONS` lookup.
- Every other file in the diff has the same hash as in the 3d/addendum list.

**Tree integrity:**
- Start: the sha256 of all 28 files in `git status --short` (excluding `progress.md`) matched the 28 hashes in "Repair cycle 3e". I checked this mechanically (`ALL28MATCH`).
- End: all 28 files are unchanged (`END-MATCH-28`). `copy2\runner-v2\src` is identical to the worktree `src` (`COPY2-SRC-IDENTICAL`).

## Verification table

| Item | r7 status | Evidence |
|---|---|---|
| **R6-B1** name/skip/only filter that selects no test | **Fixed** | Probes: **INV-R6-NAMEPATTERN** → `unknown`, counts `{0,0,0,0}`, the reason names the file-level entries and the filter, not accepted. **R7-SKIPALL** (`--test-skip-pattern=value`) → `unknown`. **R7-ONLY** (`--test-only`, no `.only`) → `unknown`. **R7-ISONONE** (`--test-isolation=none --test-name-pattern=nomatch`) → `unknown` (0 file-level entries, 0 tests). The controller's positive case (a pattern that selects a real test is accepted) is in its suite. The **PR-R7-B1F** prove-red is red (see below). **Gap:** `..`-relative names, see **N-R7-1**. |
| N-R5-1: a file with no `test()` call | **Fixed** | **R7-NOTEST** → `unknown` ("1 file-level entries … do not count"), not accepted. **R7-EMPTYPLUSREAL** (a no-test file next to a real test) → `passed`, counts `{1,1,0,0}`. The synthetic entry is not counted, and the real test still passes. |
| **N-R6-1** unmodelled shell syntax | **Fixed** | Plan matrix: all the reviewer's crafted shapes → `UNSUPPORTED` with the character named: win32 `'…\|\|…'`, POSIX `\" \|\| … # \"`, `$( )`, backticks, `! cmd &&`, win32 `^\|\|`, `%X%`. The literal `\|\|`, `;`, newline and CRLF → "joins commands with". POSIX `'&&'` stays one segment, and in a real shell it is a literal argument, so that is correct. Factory probe **INV-R6-CMDQUOTE** → `unknown`, not accepted (in r6 it was accepted). The **PR-R7-SHELL** prove-red is red. |
| **N-R6-2** relative report path | **Fixed** | `NODE_OPTIONS` carries `--test-reporter-destination="<abs, forward-slash>/.aiboard-report-<hex>.xml"`. The fixture path contains spaces. **INV-R6-CD** (`cd test && node --test`) → `passed` `{1,1,0,0}`. **INV-R6-NPMRC** → `unknown`, and the reason now names `.npmrc node-options`. |
| Notes 1–5 (r6) | **Fixed** | 1: `sameEnvironment` is key-sorted, and a removal (`undefined`) differs from an absent name. 2: `validCommandEnvironment` checks names against `^[A-Za-z_][A-Za-z0-9_]*$` and values as string or undefined; `cloneCommand` deep-copies the environment. 3: probe commands pass `explicitEnvironment: { NODE_TEST_CONTEXT: undefined }` (`delivery-execution.ts:775-776`). 5: the `NODE_OPTIONS` lookup is case-insensitive. 4 was informational. |
| **Over-correction: ordinary `node --test` shapes** | **Hold** | Factory probes, each with `passed` and counts `{1,1,0,0}`: **R7-QUOTEDGLOB** (`node --test "test/**/*.test.mjs"`), **R7-CONC** (`--test-concurrency=1`), **R7-BUILDCHAIN** (`npm run build && node --test`), **R7-IMPORT** (`node --import ./setup.mjs --test`, the `--import tsx` shape), and **INV-R6-CD**. The plan matrix also plans these: `node --import tsx --test ["glob"]`, `tsc -p . && node --test dist/test/`, `--experimental-test-coverage`, `--env-file`, `--experimental-strip-types`, `--test-timeout --test-force-exit`, `npx node --test`, `node.exe --test`, and POSIX `'glob'`. **R7-DIR** (`node --test test/`) failed, but Node 24 itself fails that script: a hand run with no runner environment reports the directory as one failing "test" (`test failed`). So this is node behaviour, and `failed` is the true outcome. |
| **Over-correction: `tsx --test`** | **NOT MET** | `tsx --test` and `tsx --test test/*.test.ts` → `UNSUPPORTED`: "not a test runner the runner can make write a machine-readable report". That reason is false. See **R7-B1**. |
| Refusals of `\`, `^`, `$` and `'` on win32 | Acceptable | The win32 `'glob'` refusal is correct, because cmd.exe hands node the literal quotes. Other refused shapes: `test\\unit` paths and `--test-name-pattern="^value$"`. These are uncommon, safe (`unknown`, with a named reason) and have forward-slash or unanchored alternatives. **NOTE-1**. |
| `NODE_TEST_CONTEXT` in OA-11 probe children | **Holds** | **INV-R6-HIGHPROBE**: the probe ran (`builtin_mutator`, 150 generated, 6 executed, 0 caught, all 6 survivors on filler lines that the value test does not exercise, as in r6). The code sets the removal. Survivors on untested filler are the expected result, not skipped files. |
| `NODE_OPTIONS` preserved / ambient reporter | **Holds** | The code appends to the ambient value, and the lookup is case-insensitive. The controller's factory test covers this; I did not re-run it. |
| `environment` field safety | **Holds** | Unchanged from r6. It is now also type-checked at profile validation. `sameEnvironment` treats `{}` and absent as equal, and both have the same effect on the child. |
| r4–r6 carry-overs | **Hold** | These files and regions are byte-identical to 3d/addendum, and the 3e hunks do not touch them: the build-script map, unmapped phase words, the boundary dead end, the interrupted retry (attempt-scoped `generationId`), `executedScope` truth (probes show `executedScope:"full_test_script"`), stale reports ignored (the pre-existing-path refusal is unchanged; the name is still `sha256(generationId:randomUUID)`), kernel order, the `distinct_model` self-review (every probe asserts `independence: "distinct_model"`), dispositions, factory E2E red without wiring (wiring unchanged apart from the lookup), legacy runs unchanged, and deterministic keys (the random name is not in any key). |
| Static audits / controller suites | Not re-run | Owner rule. |

## Prove-red records

Method:
1. Inject into `copy2` with an exact single-occurrence replace.
2. Run the named controller test from the copy root with `NODE_TEST_CONTEXT` unset.
3. Restore by `cp` from the worktree.
4. Check that sha256 before = worktree = after.

All runs printed `RESTORED-MATCH`. Before = after = `be3deb924dd061cd00fb98960cd0a9d44719e59577b83c99487b7f63e1a2c634`.

| Target | Injected sha256 | Test | Result |
|---|---|---|---|
| PR-R7-SHELL: `unmodeled = null` | `90e5d2249b624b152f78afc5199e6e10e62eeda4640a56c956da2b7c3eb8838b` (**identical** to the controller's PR-R6-SHELL) | `delivery-acceptance.test.ts` "real counts: the report plan enables…" | **RED** (1/1 fail): "cmd.exe does not treat ' as a quote" |
| PR-R7-B1F: no file-level subtraction (`const synthetic: typeof cases = []`) | `a14275cdf0fa4159a19517b85ce9e01f1ab2ef70ea44113df7c476f646d0adf7` | `native-delivery-factory.test.ts` "R6-B1: a name pattern that selects no test…" | **RED** (1/1 fail): `counts.selected` `1 !== 0` at `:367` |
| (side check) the same injection against the unit test `R6-B1: node's file-level entries…` | `a14275cd…` | `delivery-acceptance.test.ts` | green. The unit test covers only `nodeJunitTestCases`, not the subtraction. The factory test is the one that catches it. |

**About the controller's PR-R6B1 record.** I recomputed the controller's injected sha `07646bcf…`: it is `const synthetic = cases.filter(() => false);`, which is semantically identical to my injection. With it, the `filtered` guard (`:513`, which requires ≥1 real case) still keeps the outcome `unknown`. The test goes red on the counts assertion, and the task is **not** accepted. The evidence line "failed (was accepted)" therefore overstates the red. The red itself is real and reproduced. See **NOTE-2**.

## Findings

### BLOCKING

**R7-B1: `tsx --test` is refused as "not a test runner", so every project whose test script is `tsx --test` can never reach task acceptance, although the runner's own mechanism works for it.**

Location: `delivery-execution.ts:285`. Only a head token matching `^node(\.exe)?$` gets the `NODE_OPTIONS` junit plan. `tsx` falls through to `:355-357`.

Evidence:
- Plan matrix: `tsx --test` and `tsx --test test/*.test.ts` → `UNSUPPORTED`.
- Hand run in `hand\p2`: `tsx --test "test/*.test.ts"` with exactly the runner's `NODE_OPTIONS` (`--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="<abs>"`) exits 0 and writes a junit report with node's summary (`tests 1 / pass 1 / fail 0`) and a real `<testcase name="ts real" … file="…a.test.ts">`.
- `tsx` forwards `NODE_OPTIONS` to the node process it starts, and node's own `--test` runner produces the report. So the same reader, the file-level subtraction and the filter handling apply unchanged.

Scenario:
- A TypeScript project with `"test": "tsx --test …"`. This is the most common TS form of `node --test`, and it is this repository's own `runner-v2/package.json` script (`tsx --test test/*.test.ts`).
- Every boundary `tests` check is `unknown` with a reason that is factually wrong, so the Architect gets a false instruction.
- The task never reaches acceptance unless the project's test script is rewritten.

Why this is blocking:
- The brief lists `tsx --test` among the shapes that must still pass.
- The refusal is not needed for the owner rule, because the report comes from node's own runner.
- This is **not** a 3e regression. It has been refused since 3c, and r6 recorded it only as "safe (never passed)". If the owner considers tsx out of scope, this can be downgraded.

Minimal fix:
- In `planTestReport`, treat `tsx` like `node` when the head tokens include `--test`. The change is `/^(node(\.exe)?|tsx)$/`, with the same `--test-reporter` refusal, filter detection and `NODE_OPTIONS` plan.
- Add a factory case with a real `tsx --test` on a committed `.ts` test, or at least a unit plan case, plus a hand-verified report.

### NON-BLOCKING

**N-R7-1: file-level entries whose name starts with `..` are not recognised, so R6-B1 and N-R5-1 reopen for a `cd <dir> && node --test "../…"` script.**

Location: `nodeJunitTestCases`, `delivery-execution.ts:435-442`.

Node names the synthetic entry relative to its own cwd. After `cd src`, the entry is `..\test\value.test.mjs`. None of the four rules match:
1. `resolve(checkout, "..\test\…")` points outside the checkout.
2. `relative(checkout, file)` is `test/…`, not `../test/…`.
3. The name is not the absolute file path.
4. `file.endsWith("/../test/…")` is false.

The entry is therefore counted as an executed real test and as a real case for the filter guard. Hand junit `hand\p1\r3.xml` gives `fileLevel:false` for both entries.

Factory probes, real flow:
- **R7-DOTDOT-FILTER**: `cd src && node --test --test-name-pattern=nomatch "../test/*.test.mjs"` → boundary `passed: true`, tests `passed`, counts `{selected:1, passed:1}`, and the task was accepted. Zero test functions ran.
- **R7-DOTDOT-NOTEST**: `cd src && node --test "../test/*.test.mjs"` with a test file that has no `test()` call → the same result, accepted.

This is non-blocking because it needs `cd` into a sibling directory plus a parent-relative test path, together with either a filter that matches nothing or a test file with no tests. That combination is uncommon, and the plain `cd test && node --test` case is correct.

Minimal fix: in rule 4, strip leading `../` segments from the normalized name before `endsWith`. For example, `const tail = normalize(name).replace(/^(\.\.\/)+/, "")` and then `normalize(file).endsWith("/" + tail)`. This only ever undercounts. Add a unit case with a `..\test\x.test.mjs` name.

### NOTE

1. `\` (for example `node --test test\\unit\\*.test.js`), `^`/`$` (anchored `--test-name-pattern`), `(`/`)` and `%` are refused for every runner, not only `node --test`. The result is safe (`unknown` with the character named) and rarely hit; a forward-slash path or an unanchored pattern works around it. If this proves noisy, allow these characters inside double quotes on POSIX only.
2. Evidence wording for PR-R6B1: the injection it records (`cases.filter(() => false)`) turns the factory test red on `counts.selected`, not by acceptance, because the `filtered` guard still returns `unknown`. The prove-red itself is real, and I reproduced it with an equivalent injection. The wording should say "red on counts (selected 1 ≠ 0); the filter guard kept it unknown".
3. The unit test `R6-B1: node's file-level entries…` covers only classification. It stays green when the subtraction in `readRunReport` is removed, so only the ~90 s factory test guards the subtraction. A unit case over `readRunReport`, or an exported pure counting helper, would be cheaper.
4. `node --test test/` (a bare directory) fails under Node 24 itself, because the directory is run as a file. The runner reports `failed` correctly. This is recorded here only so the result is not read as an over-correction.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of the 28 changed files: start vs the 3e list vs end | — | 28/28 identical | — |
| Scratch copies identical (532 `src` + `test` each; `copy2` `src` identical at the end) | — | identical | — |
| `plan-matrix.mts` (real `planTestReport` × 46 shapes, real `nodeJunitTestCases` × 2 Node-written junit files) | — | see table and findings | — |
| `probe-r7-factory.test.ts --test-name-pattern="^(INV\|R7)-"` (17 probes) | 17 | 14 | 3 |
| PR-R7-SHELL (`delivery-acceptance.test.ts`, "real counts: the report plan…") | 1 | 0 | 1 |
| PR-R7-B1F (`native-delivery-factory.test.ts`, "R6-B1: a name pattern that selects no test") | 1 | 0 | 1 |
| PR-R7-B1 side check (`delivery-acceptance.test.ts`, "R6-B1: node's file-level entries") | 1 | 1 | 0 |
| Hand runs (Node v24.18.0, win32): `node --test --test-name-pattern=nomatch` junit; `cd sub && node --test … "../test/*.test.mjs"` junit; `node --test test/` with no runner env; `tsx --test` and `node --import tsx/loader --test` with the runner's `NODE_OPTIONS` | — | see findings | — |

How to read the probe counts:
- **R7-DIR** fails because Node itself fails on a directory argument (NOTE-4).
- **R7-DOTDOT-FILTER** and **R7-DOTDOT-NOTEST** fail because they show the defect in N-R7-1.
- The other 14, including all five inverted r6 probes, behave as the owner rule requires.

I did not re-run any suite the controller reported green (owner rule).

`T6a REVIEW r7 — REPAIR REQUIRED — 1 blocking`
