# TX-1 independent re-review r2 (CD-4, targeted)

**Verdict: ACCEPT**

Reviewer: a fresh-context independent reviewer. I did not write TX-1 and did not do round 1. This was a review only. The one repo write is this report. Probes ran from the session scratchpad (`scratchpad/tx1r2/`) and import the worktree modules unmodified. `git status` is the same before and after the review. The TX-1 sha256 values are unchanged: harness `245145cf…a557`, counts `47cc6003…eacf`. The code reviewed is `runner-v2/test/support/delivery-boundary-harness.ts` and `runner-v2/test/native-delivery-report-{counts,runners,paths,parity}.test.ts`. I compared it with `src/build-runtime.ts` (boundary append, about lines 3405-3437, and acceptance append, about 3342-3354), `src/scheduler-store.ts` (`deliveryBoundaryChecked`, `deliveryTaskAccepted`, `validateSchedulerEvidenceEvent` → `validateDeliveryCommandEvidence`, `finalVerificationEventArtifactHashes`, `parseDeliveryTestReport`), `src/sqlite-scheduler-store.ts` (append-time gates, about lines 300-315), and `src/delivery-acceptance.ts` (`assertTestsOutcome`, `deliveryBoundaryAction`, `evaluatePhaseAcceptance`). All reads are of the current working tree.

## Resolution table

| Round-1 id | Status | Basis |
|---|---|---|
| **B1** (accepted tests lost the kernel acceptance checks) | **RESOLVED** | See Q1. The harness now runs the kernel's substantive record gates through the real exported functions. It also restores HEAD's accepted-path assertions on every accepted call. All three round-1 probe mutants are now rejected, both on a synthetic record and through the real driver path (probes P1 and P2). The real kernel reducer records all 13 real matrix records (P2). |
| M1 (parity compares a subset of fields) | open, minor | The parity file is unchanged (sha `514e24e7…` equals round 1). The brief did not ask for this. The parity harness side now also passes through `assertKernelRecordsBoundary`. |
| M2 (timing) | open, minor | The evidence reports the group wall as 812.8 s. The brief did not ask for this. |
| M3, M4 (informational) | n/a | The construction code is unchanged. |
| M5 (cleanup on failure paths) | open, minor | The `try` still starts after setup (harness :286). The brief did not ask for this. |
| M6 (stale evidence) | partly addressed | The "Repair cycle 1" section describes the 6-file, 20-test group. The earlier "What changed" text still says 5 files and 19 tests, which is acceptable because it is historical. |
| M7 (fixture duplication) | open, minor | Unchanged. |

## Q1: Does the harness run the validation the kernel runs, through the real functions?

**Kernel path for `delivery.boundary_checked`:** `build-runtime.ts` appends the event. `SqliteSchedulerStore.append` then runs `validateSchedulerEvidenceEvent`, followed by `finalVerificationEventArtifactHashes` and `verifySync`, followed by the reducer (`deliveryBoundaryChecked`). Acceptance (`deliveryTaskAccepted`) depends on the boundary only through the latest boundary's `passed`, its `boundaryId` and the integration revision. Phase acceptance (`evaluatePhaseAcceptance`) depends on it only through a passed boundary that has a passed check with the required id. The scenario phase requires `["tests"]`.

**What `assertKernelRecordsBoundary` runs:**
- **Event.** It builds the same event payload that `build-runtime.ts` appends: the same fields, `checks` copied the same way, and `passed` equal to every check passing.
- **`validateSchedulerEvidenceEvent`.** It calls the real function with a non-undefined `{}` projection. For this event type the projection is only tested for truthiness, and `validateDeliveryCommandEvidence(event, store)` then runs against the live harness evidence store.
- **Artifact gate.** It calls the real `finalVerificationEventArtifactHashes` plus `ArtifactStore.verifySync` on the store the driver wrote to. This is the same gate as `sqlite-scheduler-store.ts` :310-314.
- **`assertTestsOutcome`.** It calls the real function on the tests check.
- **Mirrored reducer rules.** The rest of the reducer's per-check rules are hand-mirrored: `executedScope`, non-empty checks, passed ⇒ exit 0 and evidence, failed ⇒ evidence or reason, and `passed` equal to every check passing. The reducer itself is not exported, so it cannot be called directly.
- **Accepted-path assertions.** For every accepted record, `assertAcceptedBoundaryShape` restores HEAD's assertions: report status `passed`, `counts.passed >= 1`, a 64-hex `artifactHash`, `passed === true`, and a passed tests check that carries evidence. Together with `boundary.passed`, that is exactly the boundary-dependent input to task and phase acceptance.
- **Pump-state checks.** The reducer checks that the task is integrated and unaccepted, that the revision is current, that the attempt was durably started, and the generation and boundary id. The harness does not run these. That is correct: they depend on the pump's projection, not on the driver's output.

**Probe P1: differential, synthetic record, no test runs** (`part1.mts`, output in `part1.json`). The oracle is the real append path: `validateSchedulerEvidenceEvent` + `verifySync` + the **real** `reduceSchedulerEvent` over a minimal synthetic projection (`oracle.mts`: T1 `integrated` at the revision, `boundary:T1:1` started at attempt 1). The oracle records the unmutated record (M0).

| Mutant | Harness `assertKernelRecordsBoundary` | Real kernel |
|---|---|---|
| M1 (r1) drop tests `artifactHash` | rejects ("…at least one executed and zero failed tests.") | rejects (same message) |
| M2 (r1) empty tests `evidenceIds` | rejects ("A passed boundary check requires exit code 0 and its evidence.") | rejects (same) |
| M3 (r1) `counts.failed = 1`, outcome passed | rejects (assertTestsOutcome) | rejects (same) |
| evidence cites a missing id / exit-code mismatch / tests exit 1 but passed / `passed` true with a failed check / string exit code | rejects | rejects |
| well-formed but unstored `artifactHash` | rejects ("Artifact … was not found.") | rejects (same) |
| report `runner` deleted or `""`; duplicate check id; `checkId ""`; `counts.selected = 1.5`; `selection.rung ""`; non-tests check outcome `"bogus"` | **accepts** | rejects (N1) |

**Probe P2: the real driver path, unmodified worktree harness** (`part2.mts`, five processes, 348 s wall). I ran the real `runDeliveryBoundaryDirect` on all 13 matrix inputs, then passed each returned real record to the real reducer oracle:
- **5 accepted records** (explicit glob, NODE_OPTIONS, name-pattern=value, `cd test`, tsx): the harness resolves with `passed: true` and outcome `passed`. Counts are 1/1/0/0 and the runner is `node --test`. **The real reducer records each one.**
- **8 not-accepted records:** the harness resolves with `passed: false` and outcome `unknown`. **The real reducer records each one.**
- **Round-1 mutants through the real path, via the hook, on a real accepted run:**
  - Drop `artifactHash`: rejected (AssertionError from the restored 64-hex match).
  - Empty evidence: rejected (AssertionError from the restored evidence assertion).
  - `counts.failed = 1`: rejected by the real `assertTestsOutcome`.
- **Residual demo:** deleting the report `runner` is accepted by the harness and rejected by the real reducer ("Missing runner.").

**Conclusion.** B1 is resolved. Every rule that decides whether the kernel records a *passed* boundary and accepts the task and phase now runs through the real functions or the restored assertions. The round-1 probe records are now rejected. Every real matrix record is accepted by the real reducer. The mirror is not *literally* exact (N1). The gap covers only structural parsing that the typed driver cannot reach: the runner is always a constant or template non-empty string (`delivery-execution.ts` :240-358), check ids are fixed, and the outcome is a typed union.

## Q2: The `mutateBoundaryForTest` hook

- **Test-only.** It is declared only in `test/support/delivery-boundary-harness.ts` and used only by the B1 negative test (`native-delivery-report-counts.test.ts:65`). No `src` file references it.
- **Cannot affect other tests.** It is a per-call option: it is optional-chained, holds no module state, and each call has its own temp root, host, binding and stores. It runs only when a test passes it.
- **Does not hide failures today.** It runs *before* both validations, so a mutation is still subject to the kernel gates. The only current use sits inside `assert.rejects` with a regex that matches only the `assertTestsOutcome` message. A driver failure or a missing report (TypeError in the hook) would not match that regex, so the test would fail. Using `failed = 1` is a sound choice: it bypasses the restored shape assertions, so it isolates the kernel path, and the prove-red result confirms this.
- **Theoretical risk.** A future test could use the hook to forge a consistent accepted record, for example by rewriting the outcome, status and counts over a real stored report and real evidence. That would be visible in the test body, and the name says ForTest. It is not a finding.

## Q3: Fix delta

I reverse-applied the worker's recorded edits (the `edit_file` outputs in `tx1-repair1.jsonl`) to the current files. The harness came out at sha256 `34c99cb2…c626` and counts at `bdf78843…08da`, **exactly the round-1 shas in TX-1.md**. The delta is therefore exactly:
- the harness: imports, docstring, `assertKernelRecordsBoundary`, `assertAcceptedBoundaryShape`, the hook option, and the mutate-then-validate lines;
- one appended test in counts.

No assertion was removed or weakened. The runners, paths and parity files are byte-unchanged. The prove-red temporary edit was reverted (the edit log shows it was removed and restored, and the final sha equals the evidence). Hygiene: both changed files are LF-only, with no BOM, no trailing whitespace and a trailing newline. No `aiboard delivery boundary *` directories are left in `%TEMP%` after the probes. I did not rerun the 6-file group: the worker ran it 20/20 on these exact bytes, and P2 covers the same 13 inputs plus the hook.

## Findings (none blocking)

| Id | Class | Finding | Suggested fix |
|---|---|---|---|
| N1 | MINOR | The per-check mirror is not the kernel reducer. The docstring and evidence say it "Throws exactly when the kernel would reject the record". P1 shows 7 structural mutants that the harness accepts and the reducer rejects: report `runner` missing or empty, duplicate or empty `checkId`, non-integer counts, empty `rung`, and an invalid non-tests outcome (`parseDeliveryTestReport` / `requiredString` / `stringArray` / the enum check). None is reachable from the typed driver, and P2 shows the real reducer records all 13 real records, so no current test can pass where production fails. | Run the real reducer inside `assertKernelRecordsBoundary`: `reduceSchedulerEvent` over a minimal synthetic projection (`scratchpad/tx1r2/oracle.mts`, about 25 lines; it records M0 and rejects every mutant above). That removes the mirror entirely. Otherwise, soften "exactly" to "the substantive record gates" and list the omitted structural parsing. |
| N2 | MINOR | The negative test covers only the `assertTestsOutcome` arm. If only the `validateSchedulerEvidenceEvent` line or only the `verifySync` loop were deleted, no test would go red: all real records pass them, and the negative test fails earlier. | Add a millisecond-fast direct unit test of the exported `assertKernelRecordsBoundary` on a synthetic record with real stores, with one mutant per gate (missing evidence id, unstored artifact hash, failed count, passed without evidence). `part1.mts` is a working template, and it needs no driver run. |

## Probe files

`C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\tx1r2\`: `oracle.mts`, `part1.mts` with `part1.json`, and `part2.mts` with `part2-p{1..5}.json` and `log-p{1..5}.txt`.
