# T6a independent review — r6

Reviewer: independent (Opus). Repair cycle 3d and its addendum were done by the controller, not by me, and I have no memory of r1–r5 beyond the files. I did not edit any source or test file in the worktree and committed nothing. The only file I wrote in the worktree is this review.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted (27 files).

Scratch folder: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r6\`
- `notes.md` is the running log.
- `copy\runner-v2\{src,test,skills,bin,tsconfig.json,package.json}` is a byte-identical copy. At the start I compared 532 `src` + `test` files by sha256; at the end I compared the 211 `src` files again. `copy\node_modules` is a junction to the worktree's `node_modules`.
- `copy\runner-v2\test\probe-r6-factory.test.ts` is the controller's `native-delivery-factory.test.ts` with 15 probes appended:
  - the r5 probes, re-run inverted (`INV-*`);
  - new r6 shapes (`R6-*`).
  The probes use the real `NativeBuildFactory`, a real `ExecutionHost`, real npm and `node --test`, and real SQLite. The only harness change is that `extraFiles` creates parent directories.
- `hand\` holds the direct shell probes (`cmd.exe` through npm, `sh -c`, and direct `node --test`).
- Raw logs: `run-probe-r6.txt`, `pr-PR-*.txt`. `prove-red.sh` is the injection script.
- Every child `node --test` in my probes ran with `NODE_TEST_CONTEXT` unset.

## Scope

**Read:**
- `T6a-review-r5.md`.
- `evidence/T6a.md`: "Repair cycle 3d" and its addendum.
- `delivery-execution.ts`:
  - `planTestReport`, `splitAndChain`, `nodeJunitSummary`, `reporterUnsupportedIn`, `readRunReport` and `runDeliveryCategory`;
  - the depth runner, `runDeliveryProbe` and the boundary driver.
- `delivery-acceptance.ts`: `testsOutcome` and `assertTestsOutcome`.
- `final-verification-runtime.ts`: the `environment` field, `sameCommands` and `executeCommand`.
- `final-verification-profile.ts`: `validCommand`, `cloneCommand`, and where profiles come from.
- `architect-tools.ts:1428-1440`: the profile authority is runner-owned.
- `child-environment.ts`: the explicit-override policy.
- `one-shot-command-executor.ts:185-235`: both permission-profile paths.
- `native-build-factory.ts`: the ambient `NODE_OPTIONS` wiring.
- The factory test and its fixture.

**Tree integrity:**
- At the start, the sha256 of the 27 files in `git status --short` (excluding `progress.md`) matched the 27 hashes in "SHA-256 of every file in the T6a diff (after the addendum)". I checked this mechanically (`START-MATCH-27`).
- At the end, all 27 are unchanged (`END-MATCH-27`).
- The scratch copy's 211 `src` files are identical to the worktree at the end.

## Verification table

| Item | r6 status | Evidence |
|---|---|---|
| **R5-B1** empty `describe` | **Fixed** | `readRunReport` takes the `node --test` counts from node's own summary (`delivery-execution.ts:426-443`). Probe **INV-R5-SUITEONLY**: `unknown`, counts `{0,0,0,0}`, reason "suites without tests do not count", not accepted. **PR-R5B1** reproduced red (below). |
| **R5-B2** `\|\|` / `;` / `\|` / `&` masking | **Fixed for the literal separators** | `splitAndChain` (`:336-367`). Probe **INV-R5-MASK**: `unknown` with the reason `joins commands with "\|\|"`, not accepted. **R6-MIDFAIL** (`node --test failing.mjs && node --test`): `failed`. **R6-ECHOLAST** (`node --test && echo done`): `unknown`. **PR-R5B2** reproduced red. Shell-quoting evasions remain (see **N-R6-1**). |
| **R5-B3** file globs | **Fixed** | The flags go through `NODE_OPTIONS` (`:265-291`). Probe **INV-R5-POSITIONAL** (`node --test test/*.test.mjs`): `passed`, counts `{1,1,0,0}`, fresh `.aiboard-report-<24hex>.xml`. **PR-R5B3** (remove `NODE_OPTIONS`) reproduced red: the boundary failed and the task was not accepted. |
| `NODE_TEST_CONTEXT` removed from child runs | **Holds for the tests category** | `environment.NODE_TEST_CONTEXT: undefined` (`:287`). The fixture workaround is gone, and the factory tests still count real tests. It is **not** applied to the OA-11 probe commands (see **NOTE-3**). |
| Old Node / reporter rejected → `unknown` | **Holds by code** | `reporterUnsupportedIn` covers Node's pre-junit error (`Cannot find package 'junit'`). `testsOutcome` returns `unknown` only when that flag is set; otherwise a non-zero exit is `failed`. Never `passed`. I have no old Node to run it on, so this is code reading only. |
| Project's own `NODE_OPTIONS` preserved | **Holds** | The reporter flags are appended to the ambient `NODE_OPTIONS`. An ambient `--test-reporter` gives `unknown`. The controller's factory test covers this; I did not re-run it. |
| `.npmrc` `node-options`, `cd x && node --test`, inline `NODE_OPTIONS=`, `cross-env`, `tsx --test`, a script's own `--test-reporter` | **Safe (never passed)** | **R6-NPMRC**: npm replaces `NODE_OPTIONS`, so no report is written and the result is `unknown`. **R6-CD**: the relative destination lands under `test/`, so the result is `unknown`. The other shapes have an unrecognized head token, or the script's own reporter is detected, so they are `unknown`. The reasons are imprecise (**N-R6-2**). |
| `--experimental-test-coverage` | **Met** | **R6-COVERAGE**: `passed`, counts `{1,1,0,0}`. |
| **`--test-name-pattern` that matches no test** | **NOT MET** | **R6-NAMEPATTERN**: accepted, and zero test functions ran. See **R6-B1**. |
| Nested `node --test` inside a test | **Safe** | **R6-NESTED**: `failed`. A hand run without the runner's environment fails the same way (node's own `NODE_TEST_CONTEXT` inheritance), so this is not caused by the runner. |
| Fake report through the project's `--require` hooks | **Not a live risk** | The ambient `NODE_OPTIONS` comes from the host (`filteredEnvironmentSource()`), not from the project. Also, `testsOutcome` gates on the exit code before it reads the report, and node exits non-zero on any failure, so a forged report can only add a "≥1 test" claim. The path is `sha256(generationId:randomUUID)`, so it is unpredictable, and it is refused if it already exists (`:515-517`). Project code can read the path from `process.env.NODE_OPTIONS`, but that buys nothing beyond writing a trivial test. |
| **`environment` field: security** | **No new exposure** | Every `FinalVerificationCommand` comes from the runner's `inspectFinalVerificationExecutionProfile`. The Architect's plan chooses categories, not commands. The field is set only by `planTestReport`. `child-environment.ts:112-119` still rejects sensitive and `RUNNER_*`/`AIBOARD_RUNNER_*` names. Both the full and the non-full executor paths apply the same factory. The audit records names only, so no values are stored. The field does not widen the audited host (same executable, arguments, cwd and grants). |
| **`environment` absent → final verification unchanged** | **Holds** | `sameCommands` compares `JSON.stringify(env ?? null)`, which gives `null === null`. `executeCommand` spreads `explicitEnvironment` only when the field is present (`final-verification-runtime.ts:1403,1532`). |
| r4/r5 carry-overs | **Hold** | The files are byte-identical to the 3c/3d evidence except `delivery-execution.ts`, `native-build-factory.ts` (the ambient getter only) and the two tests. The following are untouched by 3d: the build-script map (`:523-529`), unmapped phase words, the boundary dead end, the interrupted retry (attempt-scoped `generationId`, `:798`), `executedScope` truth, stale reports ignored, kernel order, the `distinct_model` self-review, the dispositions and the deterministic keys. The random report name appears only in `NODE_OPTIONS` and arguments, never in an idempotency key. The **INV-R5-FIXEDPATH** and **INV-R5-SUBPROC** probes are still `unknown`. |
| Factory E2E red without wiring | **Holds** | The delivery wiring in `native-build-factory.ts` is unchanged apart from the added `ambientNodeOptions` getter. **PR-R5B3** shows that the factory E2E goes red when the report plumbing is removed. |
| Static audits / controller suites | Not re-run | Owner rule. |

## Prove-red records

Method:
1. Inject into the byte-identical copy with an exact single-occurrence replace.
2. Run the named controller test from the copy root with `NODE_TEST_CONTEXT` unset.
3. Restore by `cp` from the worktree.
4. Check that sha256 before = worktree = after.

All three printed `RESTORED-MATCH`.

| Target | File | sha before = after | sha injected | Result |
|---|---|---|---|---|
| PR-R5B1: the node-summary branch disabled (the `<testcase>` count is used instead) | `src/delivery-execution.ts` | `edf106f23787a820873c6ce221aa282316a1da4855b9e2b86af3c00b39e3a924` | `e1642550cc1c664870b285bccde1f4425216ccbde9b45d352e2921758a1e59a1` | **RED**: `R5-B1: an empty describe…`. The boundary recorded `passed: true` (1/1 fail). |
| PR-R5B2: `\|\|` treated as a chain separator | `src/delivery-execution.ts` | same | `3b83e07c7c6bf7b3475e174bc89cbe8cfb90e4515094e72ff7d81be1b7c5ac7b` | **RED**: `R5-B2: a script that masks…`. The boundary recorded `passed: true` (1/1 fail). |
| PR-R5B3: `NODE_OPTIONS` line removed from the plan | `src/delivery-execution.ts` | same | `8c37fcaeac0f2416843dfbef2a06d33b391b348a03b6cbd20b91016eb271b8f4` | **RED**: `R5-B3: node --test with an explicit glob…`. `delivery_boundary_failed`, not accepted (1/1 fail). |

## Findings

### BLOCKING

**R6-B1: `node --test` with a name or skip filter that selects no test is accepted as "≥1 executed, 0 failed", although no test function ran.**

Location: `delivery-execution.ts:426-443`. It trusts node's summary `tests`/`pass`. It does not recognize node's synthetic file-level entry.

Scenario:
- When a test file reports no subtests, node reports the FILE itself as one passing test.
- Hand run on Node 24.18: `node --test --test-name-pattern=nomatch test/ok.test.mjs` gives exit 0, and the junit report contains a single `<testcase name="test\ok.test.mjs" … file="…\test\ok.test.mjs"/>` with `<!-- tests 1 --> <!-- pass 1 -->`. The real test `it's ok` never ran.
- Probe **R6-NAMEPATTERN** (real factory, `"test": "node --test --test-name-pattern=nomatch"`): the boundary is `passed: true`, the tests check is `passed`, and the task was accepted. The fixture's `not_accepted` assertion failed with `true !== false`.

Why this is blocking:
- A name filter (`--test-name-pattern`, `--test-skip-pattern`, or `--test-only` without `.only` tests) is an ordinary script shape.
- A filter that stops matching after a rename, or that a worker writes, silently turns "zero tests executed" into acceptance.
- That breaks the owner rule directly.

N-R5-1 (a file with no `test()` call) is the same mechanism. r5 recorded it for owner awareness only. The filter shape makes the mechanism reachable from the test script itself, not only from a degenerate test file.

Minimal fix:
- For `node --test`, do not count node's synthetic file entries. These are `<testcase>` elements whose `name` equals the path of their own `file` attribute relative to the checkout (or whose name is a path to a discovered test file). Subtract them from `tests` and `pass`. If nothing remains, the result is `unknown` with a named reason. This closes N-R5-1 too.
- Alternatively, as a smaller fallback, return `unsupported` when the script or ambient `NODE_OPTIONS` contains `--test-name-pattern`, `--test-skip-pattern` or `--test-only`. That alone leaves N-R5-1 open.
- Add a factory case: `node --test --test-name-pattern=nomatch` must not be accepted.

### NON-BLOCKING

**N-R6-1: The quote-aware `&&` splitter does not model the real shell, so deliberately crafted scripts can still mask a failing test run.**

Location: `splitAndChain`, `delivery-execution.ts:336-367`.

It treats `'…'` and `"…"` as quotes and nothing else. I proved these shapes end to end:
- **Windows `cmd.exe`** (npm's default script shell here) does not treat `'` as a quote. Probe **R6-CMDQUOTE**, real factory: `"test": "node --test failing.mjs '|| node --test test/value.test.mjs '"`.
  - The failing test ran and failed.
  - `||` then ran the passing command; node ignores the stray `'` pattern.
  - Result: exit 0, report `{1,1,0,0}`, **task accepted**. The same result by hand through npm.
- **POSIX `sh`**, hand runs:
  - `node --test failing.mjs \" || node --test ok.mjs # \"` (a backslash-escaped quote, then a comment);
  - `node --test $(node --test failing.mjs >/dev/null) ok.mjs` (command substitution; backticks work the same way).
  Both give exit 0 and a report with pass 1, fail 0. `splitAndChain` returns one segment for all of them. `! cmd && node --test` is the same class, by code reading.

These are adversarial constructions, not shapes anyone writes by accident. The literal `||`/`;`/`|`/`&` shapes, which do occur naturally, are now refused. A reviewer would also see such a `package.json` diff. That is why I list this as non-blocking.

Minimal fix: refuse (return `unsupported`) any test script that contains shell metacharacters the splitter does not model:
- `$`, a backtick, `\`, `#`, `!`, `(`, `)`, `<`, `>`, `^` or `%`;
- on win32, any `'`.

This is a whitelist of plain words, `&&`, and double-quoted arguments.

**N-R6-2: The destination is relative, so `cd <dir> && node --test` is permanently `unknown`, and the reason misdiagnoses it.**

Location: `delivery-execution.ts:278`.

Probe **R6-CD**: the report is written under `test/`. The reason says "must run node --test directly (not through another tool that drops NODE_OPTIONS)", which is wrong for this shape. **R6-NPMRC** (an `.npmrc` with `node-options=`) gets the same misleading reason.

This is safe, because it is never `passed`. But it is a monorepo-style shape with no route to acceptance.

Minimal fix: pass an absolute, double-quoted destination in `NODE_OPTIONS` (node accepts `"…"` there), or name `cd` and npm's `node-options` in the reason.

### NOTE

1. **`sameCommands` compares the environment with `JSON.stringify`** (`final-verification-runtime.ts:1403`). It drops `undefined` values (a removal compares equal to "no entry") and depends on key order. Today both sides come from the same object, so this is harmless. A key-sorted comparison that keeps `undefined` would be exact.
2. **`validCommand` does not type-check the new `environment` field** (`final-verification-profile.ts:543-549`), and `cloneCommand` copies it through. Every profile is runner-built today. A malformed value would still be refused later by `assertEnvironmentEntry`.
3. **The OA-11 probe commands get no `explicitEnvironment`** (`delivery-execution.ts:686-700`), so `NODE_TEST_CONTEXT` is not removed there. The 3d text says "every `node --test` child run". In production the runner is not under `node --test`, so the ambient environment has no `NODE_TEST_CONTEXT`. Under the test harness, the probe children could skip their files. **R6-HIGHPROBE** was inconclusive: 6/6 survivors, all on filler lines the value test does not exercise.
4. `reporterUnsupportedIn` matches any stderr text. A project test that prints "Unknown test reporter" makes an exit-0 run `unknown`. That is safe.
5. The ambient lookup is `.NODE_OPTIONS`, which is case-sensitive on a plain snapshot object. A Windows variable spelled `Node_Options` would be replaced, not kept. This is an edge case.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of the 27 changed files: start vs the addendum list vs end | — | 27/27 identical | — |
| Scratch copy identity (532 src+test at the start; 211 src at the end) | — | identical | — |
| `probe-r6-factory.test.ts --test-name-pattern="^(INV-\|R6-)"` (15 probes) | 15 | 14 | 1 |
| PR-R5B1 (`native-delivery-factory.test.ts`, `R5-B1: an empty describe`) | 1 | 0 | 1 |
| PR-R5B2 (`R5-B2: a script that masks`) | 1 | 0 | 1 |
| PR-R5B3 (`R5-B3: node --test with an explicit glob`) | 1 | 0 | 1 |
| Hand probes (Node v24.18.0, win32): cmd.exe `'\|\|` mask through npm; sh `\"…#` and `$( )` masks; stray `'` pattern; `--test-name-pattern=nomatch` junit; nested `node --test` with and without the runner's `NODE_OPTIONS`; `splitAndChain` verdicts for 6 shapes | — | see findings | — |

How to read the probe counts:
- The failing probe is R6-NAMEPATTERN. That failure is the defect (R6-B1).
- R6-CMDQUOTE "passes" because the fixture's default path asserts acceptance. That is the N-R6-1 demonstration.
- All other INV and R6 probes behave as the owner rule requires. Their outcomes are quoted above.
- The prove-reds are red as intended.

I did not re-run any suite the controller reported green (owner rule).

`T6a REVIEW r6 — REPAIR REQUIRED — 1 blocking`
