# T6a independent review — r5

Reviewer: independent (Opus). Repair cycles 3b and 3c were done by the controller, not by me, and I have no memory of r1–r4 beyond the files. I did not edit any source or test file in the worktree and committed nothing. The only file I wrote in the worktree is this review.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, HEAD `6286a9ee`, T6a uncommitted (26 files).

Scratch folder: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t6a-r5\`
- `notes.md` is the running log.
- `copy\runner-v2\{src,test,skills,bin,tsconfig.json,package.json}` is a byte-identical copy (532 `src` + `test` files compared by sha256 at the start; the 211 `src` files compared again at the end). `copy\node_modules` is a junction to the worktree's `node_modules`.
- `copy\runner-v2\test\probe-r5-factory.test.ts` holds the probes: the controller's `native-delivery-factory.test.ts` unchanged, plus 7 `R5-*` tests appended that use its `runDeliveryFactoryScenario`, with a real `NativeBuildFactory`, a real `ExecutionHost`, real npm and `node --test`, and real SQLite.
- `nodepos\` holds the direct `node --test` and `npm run test -- …` shell probes.
- The raw logs are `run-probe-factory.txt`, `run-probe-mask.txt` and `pr-*.txt`. `prove-red.sh` is the injection script.
- Every child `node --test` in my probes ran with `NODE_TEST_CONTEXT` cleared, either through `unset`/`Remove-Item Env:` or through the fixture's own `delete process.env.NODE_TEST_CONTEXT`.

## Scope

**Read:**
- `T6a-review-r4.md`.
- `evidence/T6a.md`, "Repair cycle 3b" and "Repair cycle 3c".
- `delivery-execution.ts`: the whole of `planTestReport`, `readRunReport`, `runDeliveryCategory`, the depth runner and the boundary driver.
- `delivery-acceptance.ts`: `DeliveryTestReport`, `testsOutcome`, `assertTestsOutcome`, `boundaryNeedsArchitect` and `deliveryBoundaryAction`.
- `scheduler-store.ts`: `deliveryBoundaryStarted`, `deliveryBoundaryChecked`, `deliveryBoundaryFailureResolved`, `parseDeliveryTestReport`, `parseDeliveryDepth` and `finalVerificationEventArtifactHashes`.
- `planning-contracts.ts`: `PHASE_VALIDATION_CHECKS`, `unmappedPhaseValidationIssues` and the `computePlanReadiness` hook.
- `test-report-readers.ts`: `readJUnitReport` and `outcomeFromReportReading`. This file is pre-existing T5 code that T6a now uses as its real-counts source.
- `agent-prompts.ts`: the boundary-check rendering.
- `native-deliverable-review.ts`: the depth invocation.
- The factory test and its fixture.

**Tree integrity:**
- At the start, the sha256 of the 26 files in `git status --short` (excluding `progress.md`) equals, mechanically, the 26 hashes in "SHA-256 of every file in the T6a diff (after 3c)".
- At the end, all 26 are unchanged.
- Against r4's end hashes, these files are byte-identical: `native-build-factory.ts`, `git-run-context.ts`, `sqlite-scheduler-store.ts`, `task-*.ts`, `role-capabilities.ts`, `native-verifier-runtime.ts`, `native-architect-runtime.ts`, `workspace-manager.ts`, `agent-contracts.ts` and `agent-loop.ts`. So r4's factory-wiring and git-scope verdicts carry over unchanged.

## Verification table

| Item | r5 status | Evidence |
|---|---|---|
| **R4-B1** build-script projects | **Fixed** | `runDeliveryCategory` passes the full `build`+`tests` map (`delivery-execution.ts:390-396`). **PR-BUILDMAP** reproduced red: removing the `build` entry pauses the run with `delivery_boundary_unavailable: Final verification build runtime commands conflict with the execution profile.` |
| **R4-B2** unmapped phase words | **Fixed** | `computePlanReadiness` pushes `unmappedPhaseValidationIssues` (`planning-contracts.ts:2385-2388`). This is the shared readiness used by the kernel `plan_ready` path, the runtime pre-check, and the prompts. **PR-PHASE** reproduced red: both R4-B2 tests fail, and the injected sha `4a6708a7…` is identical to the controller's. |
| N-R4-2 boundary dead end | **Fixed** | `boundaryNeedsArchitect` (`delivery-acceptance.ts:532-541`) hands a `repair_planned` boundary back once every repair task is terminal. The kernel requires the matching `resolutionGeneration`. The recheck limit counts `resolutionHistory`, so there is no loop. |
| N-R4-3 interrupted retry | **Fixed** | `delivery.boundary_started` must carry `attempt = starts+1` (`scheduler-store.ts:~6404`). `boundary_checked` must carry the latest started attempt. The FVR `generationId` is `<boundaryId>:<attempt>:<category>`. |
| N-R4-1 executedScope truth | **Fixed** | The kernel requires `executedScope: "full_test_script"` on both the depth record and the boundary record. The selection is stored as informational. |
| `acceptedFailuresUsed` NOTE | **Fixed** | Derived from durable reviews; the kernel refuses a mismatch (controller test, not re-run). |
| Real counts: non-zero exit with a passing report | **Met** | `testsOutcome` returns `failed` for any exit ≠ 0 before it looks at the report. |
| Real counts: zero tests (no files) | **Met** | Controller factory test. **PR-REPORT** reproduced red: with `testsOutcome` returning `"passed"` on exit 0, the zero-test project's boundary passed. |
| Real counts: all skipped / todo | **Met** | Probe **R5-SKIPPED**: counts `{selected 2, passed 0, skipped 2}`, outcome `unknown`, with the named reason. |
| Real counts: **suites without testcases** | **NOT MET** | Probe **R5-SUITEONLY** was accepted. See **R5-B1**. |
| Real counts: report missing | **Met** | `readRunReport` returns `unknown` with `"<runner> wrote no junit report at <path>"`. |
| Stale report (committed, or from an earlier run) | **Met** | The path is `.aiboard-report-<24 hex of sha256(generationId:randomUUID)>.xml`. `existsSync` is refused before the run, and only that path is read. The bytes are stored as an artifact, and the SQLite store verifies the hash. The controller's stale `junit.xml` test covers the committed-file case. A report from an earlier run cannot collide with an unpredictable 96-bit name. |
| Report written by the project to a fixed path | **Met** | Probe **R5-FIXEDPATH**: `unknown` (the runner is unrecognized, and a fixed path is never read). |
| Tests in an un-instrumentable subprocess | **Met** | Probe **R5-SUBPROC** (`npm run test:unit`): `unknown` with the reason `"npm run test:unit" is not a test runner…`. |
| `node --test \|\| true`, `npm test; exit 0` | **Met** | The last segment (`true` / `exit 0`) is unrecognized, so the result is `unknown`. |
| **Composite `A \|\| <node --test>`** | **NOT MET** | Probe **R5-MASK**: a failing first command, and the task and phase were accepted. See **R5-B2**. |
| `node --test` end to end, no positional args | **Met** | Controller factory tests. I did not re-run them. |
| **`node --test <file globs>`** (common shape) | **NOT MET** | Probe **R5-POSITIONAL**: no report is ever written, so the result is permanently `unknown`, with a misleading reason. See **R5-B3**. |
| vitest / pytest / dotnet / mocha flags | **Plausible** | All flags are real: `--reporter=junit --outputFile.junit=`, `--junitxml=`, `--logger "trx;LogFileName=<abs>"`, and `--reporter mocha-junit-reporter --reporter-options mochaFile=`. These CLIs accept options after positionals, so R5-B3 does not apply to them. Only the shapes are unit-tested, as the controller's limit states. |
| jest / go / unknown runner | **Met** | Each returns `unsupported` with a named reason. The boundary `reason` `"Tests exited 0 but did not prove a run: … (runner: …)"` reaches the Architect through `agent-prompts.ts:774`. The routes are the same as for a failed boundary. There is no loop. |
| Kernel order, self-review, dispositions, legacy, keys | **Holds** | The `distinct_model` self-review guard is present (`scheduler-store.ts:6001`). `reduceDeliveryEvent` refuses `planningPolicyVersion !== 1` (`:5794`), including for the new `delivery.boundary_started`. The new key `delivery-boundary-start:<boundaryId>:<attempt>` is deterministic. The random report name appears only in command args, never in an idempotency key. |
| Factory E2E red without wiring | **Holds** | `native-build-factory.ts` is byte-identical to the file on which r4 reproduced PR-FACTORY. |
| Static audits | Not re-run | Owner rule: the controller ran them green on these exact bytes. |

## Prove-red records

Method:
1. Inject into the byte-identical copy with an exact single-occurrence string replace.
2. Run the named test from the copy root with `NODE_TEST_CONTEXT` cleared.
3. Restore by `cp` from the worktree.
4. Check that sha256 before = worktree = after.

| Target | File | sha before = after | sha injected | Result |
|---|---|---|---|---|
| PR-PHASE: unmapped-word blocker removed | `src/planning-contracts.ts` | `f30a534dc53c1ea5e46ab1033953e4c2233690227f848a72ba196bb6d6f611d3` | `4a6708a734217434df8136266b1eaac6a6a9c5cc61920ad5787296044701432d` | **RED**: both `R4-B2` tests fail (2/2). |
| PR-REPORT: report requirement removed (`return report.status;` → `return "passed";`) | `src/delivery-acceptance.ts` | `bf0dd18e75430d490c0470b48ca11b9d01ae7e49fb8f289bde1dddcfd082b549` | `375f01070b95dcc719fcbb78e2aa9cc3ee8c64b389bacbe447128fb0d4c2541b` | **RED**: `real counts: a test command that runs zero tests…`. The boundary recorded `passed:true` for the zero-test project. |
| PR-BUILDMAP: `build` dropped from the runtime command map | `src/delivery-execution.ts` | `7fdcf8fdbe763070286e5cab2b29066d5da212e104a764931f579cc5d02ef4ae` | `2a8d291c3bdfd79cfa5093853e891ff2c5e3526301f271c7c615d4d6756329c1` | **RED**: `R4-B1 … medium tier`. The run paused `delivery_boundary_unavailable`: `Final verification build runtime commands conflict with the execution profile.` |

All three restores printed `RESTORED-MATCH`.

## Findings

### BLOCKING

**R5-B1: A test file with only an empty `describe` (zero tests) is accepted as "≥1 executed, 0 failed".**

Location: `delivery-execution.ts:316-331` (`readRunReport`), which trusts `readJUnitReport` (`test-report-readers.ts:268`) counting `<testcase>` elements.

Scenario:
- `node --test` junit output emits a childless `describe` as a leaf `<testcase name="empty"/>`, while node's own totals in the same file say `<!-- tests 0 --> <!-- suites 1 --> <!-- pass 0 -->`. I verified this by hand on Node 24.18.
- Probe **R5-SUITEONLY** (`test/value.test.mjs` = `describe('empty', () => {})`, real factory): the boundary is `passed:true`, the report is `{status:"passed", counts:{selected:1, passed:1, failed:0}}`, and the task is accepted.
- This is the owner rule broken for "only suites without testcases": a zero-test run passes.

Minimal fix: for the `node --test` runner, take the counts from node's own summary comments in the report (`tests`, `pass`, `fail`, `skipped`, `todo`, `cancelled`), or require them to agree with the element counts. Treat `tests 0` as `unknown`. Add a factory case with an empty `describe`.

**R5-B2: A composite script whose earlier test command fails is accepted when a later `||`-joined (or, on POSIX shells, `;`-joined) `node --test` passes.**

Location: `delivery-execution.ts:233-236`. The script is split on `&&|\|\||;` and only the last segment is judged. That segment gets the reporter, and its exit code is the script's exit code.

Scenario:
- Probe **R5-MASK**: `"test": "node --test failing.mjs || node --test"`, where `failing.mjs` throws. I confirmed by hand that the first command prints `✖ boom … fail 1`.
- Result: exit 0, report `{passed:1, failed:0}`, boundary passed, **task accepted**.
- The controller's limit ("a composite script is judged by its LAST command") presents this as safe. It is safe for `&&` and for `|| true`, but not for `|| <test command>`.
- A worker can write this into `package.json`, and a project can have it legitimately (for example `unit || integration`). Either way, a run with failed tests counts as passed.

Minimal fix: in `planTestReport`, accept a multi-segment script only when every separator is `&&`. For any `||`, `;`, `&` or `|`, return `unsupported`, which makes the result `unknown` with a named reason. Add the R5-MASK case.

**R5-B3: `node --test <files/globs>` never writes the report, so every such project is permanently `unknown`, and the reason given does not say why.**

Location: `delivery-execution.ts:251-258`. The flags go through npm's `--`, which appends them after the script's positional arguments.

Scenario:
- Node treats everything after the first positional as more test patterns, so `--test-reporter*` is ignored. Hand probe with `npm run test -- <flags>`:

  | Script | Exit | Report written |
  |---|---|---|
  | `node --test` | 0 | yes |
  | `node --test test/*.test.js` | 0 | **NO** |
  | `node --test --test-reporter=dot "test/**/*.test.js"` | 0 | **NO** |

- Probe **R5-POSITIONAL** (real factory, `"test": "node --test test/*.test.mjs"`, one passing test): outcome `unknown`, reason `node --test wrote no junit report at .aiboard-report-….xml`.
- Explicit globs are the usual `node --test` form, and `node --test` is the one runner the evidence claims is enabled end to end. No task in such a project can ever be accepted, and final-ready is unreachable.
- The Architect's only routes are a recheck (same result) or a repair, and the reason gives it no clue that the script shape is the cause.
- This is the owner requirement "runner enables report output for common runners" not performed for the common shape of the claimed runner. It has the same practical effect as R4-B1.

Minimal fix (either option):
- (a) Pass the reporter flags through `NODE_OPTIONS`. I verified that `NODE_OPTIONS="--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=<path>" node --test "test/*.test.js"` writes the report on Node 24.18.
- (b) Run the last segment directly with the flags inserted immediately after `--test`. I also verified this form.
- If neither is possible, detect positional or own-reporter arguments and return `unsupported` with a reason that names the cause.

Also add the R5-POSITIONAL case.

### NON-BLOCKING

- **N-R5-1:** A `node --test` test file that contains no `test()` call is reported by node itself as one passing file-level test (`<!-- tests 1 --> <!-- pass 1 -->`), so it counts as "≥1 executed". This is node's own semantics, and even the fix for R5-B1 would not catch it. Owner awareness only.
- **N-R5-2:** On a Node version without the `junit` reporter, the appended flag makes `node --test` exit non-zero. The result is then `failed` with an exit-code reason instead of `unknown` with "reporter unsupported". That is safe, but the diagnosis is misleading.

### NOTE

- The kernel checks `report.path` only for presence, not against `^\.aiboard-report-[a-f0-9]{24}\.(xml|trx)$`. It verifies that the artifact exists, but not that it is fresh for this boundary. The runner is the only writer, so this is not model-exploitable.
- The kernel does not require that a boundary `checks` array contains a `tests` check. The driver always emits one.
- Harness observation, not a product defect: my first R5-MASK/R5-ORTRUE variants put a failing file under `test/`. The fixture's fake worker runs `node --test` as its evidence, so that evidence failed, and the fixture's fake Architect then reused a call id (`protocol_error:duplicate_call_id`). R5-MASK was re-run with the failing file outside the default discovery patterns. The `|| true` shape is covered by code reading and the controller's unit test.

## Commands and counts

| Command | Tests | Pass | Fail |
|---|---|---|---|
| sha256 of the 26 changed files: start vs the 3c evidence list vs end | — | 26/26 identical | — |
| Scratch copy identity (532 src+test at the start; 211 src at the end) | — | identical | — |
| `probe-r5-factory.test.ts --test-name-pattern=R5-` (POSITIONAL, MASK v1, ORTRUE, SKIPPED, SUITEONLY, FIXEDPATH, SUBPROC) | 7 | 4 | 3 |
| `probe-r5-factory.test.ts --test-name-pattern=R5-MASK` (fixed fixture) | 1 | 1 | 0 |
| PR-PHASE (`delivery-acceptance.test.ts`, `R4-B2`) | 2 | 0 | 2 |
| PR-REPORT (`native-delivery-factory.test.ts`, `runs zero tests`) | 1 | 0 | 1 |
| PR-BUILDMAP (`native-delivery-factory.test.ts`, `R4-B1 … medium`) | 1 | 0 | 1 |
| Hand probes: `node --test` / `npm run test -- <flags>` shapes, `NODE_OPTIONS`, empty describe, empty file, `\|\|` masking (Node v24.18.0) | — | see findings | — |

How to read the probe counts:
- In the 7-test run, R5-POSITIONAL, SKIPPED, FIXEDPATH and SUBPROC pass as observers, and their logged outcomes are quoted above.
- R5-SUITEONLY "fails" because the fixture's `not_accepted` assertion found `boundary.passed:true`. That is the defect (R5-B1).
- MASK v1 and ORTRUE failed on the harness call-id artifact described in the NOTE.
- The fixed R5-MASK "passes" because the fixture's default path asserts acceptance. That is the defect (R5-B2).
- The prove-reds are red as intended.

I did not re-run any suite the controller reported green (owner rule).

`T6a REVIEW r5 — REPAIR REQUIRED — 3 blocking`
