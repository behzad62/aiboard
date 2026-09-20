# M4 qualification refactor execution record

Status: IN_PROGRESS. Gate G is not PASS. PR #95 must remain unmerged.

## Authority and starting evidence

The user's 2026-09-20 Gate G handoff authorizes this bounded qualification refactor, targeted validation, independent Cursor review, commit/push, and fresh hosted acceptance. Source: `C:/Users/b_a_s/.codex/attachments/d4621510-eee3-4787-998e-d76e846c475a/Pasted text.txt`. It explicitly prohibits the global Runner V2 suite and retains Node 24 only. This is execution of that supplied scope, not a reopening of the accepted lifecycle architecture.

Starting revision: `2ffb805436dd768a1986246275f4c84a89d74f18`. Local runtime: Node `24.18.0`, Windows. Required PR runs `35492673910` (benchmark) and `35492673923` (portable/package matrix) succeeded. Qualification run `35492714608` failed; Linux native and OCI succeeded, while other jobs mixed stale fixtures, CLI failures, and real-host contention. Those results do not qualify the next candidate.

## Existing uncommitted hunk disposition, before restructuring

| File / hunk | Disposition | Evidence and boundary |
| --- | --- | --- |
| `runner-v2/src/git-bootstrap.ts`: retry exact binding close once | KEEP | User-supplied deterministic RED and two local regression greens explain a transient cleanup error masking success or the typed primary error. Consumer retry only; persistent failure still throws, and `ExecutionHost.close()` is unchanged. |
| `runner-v2/test/git-bootstrap.test.ts`: success and primary-error retry tests | KEEP | Direct regression coverage for the consumer repair. Recheck this focused file; do not recreate the already-observed RED by resetting legitimate work. |
| `runner-v2/test/cli-capabilities-config.test.ts`: Windows outer readiness guard | KEEP | Test-process guard only (90 seconds Windows / 30 seconds elsewhere); no product deadline changes. |
| Same file: active Build baseline and unsupported-version fixtures | KEEP | Satisfy the baseline prerequisite and reject version 3 because version 2 is current. These repair obsolete expectations. |
| `runner-v2/test/posix-process-backend.test.ts`: bounded running convergence | REWORK | Keep bounded convergence and supervisor evidence; additionally fail immediately on definitive invalid states rather than waiting through them. Persistent unknown remains failure. |

No inherited hunk is removed or deferred. Product fence, lifecycle, ownership, and containment changes are out of scope unless new deterministic evidence proves a separate defect.

## Acceptance and execution boundaries

- Replace mixed qualification entrypoints with small real-host acceptance files. Keep the broad original files available for deterministic and focused regression use.
- Preserve the hosted qualification routes that existed before this refactor: Windows Job and portable lifecycle, POSIX/macOS identity, actual recovery/restart, CLI/config trust, managed/MCP execution, OCI containment, and terminal/output evidence. LSP was not a prior hosted-qualification entrypoint and remains covered by the existing deterministic/required checks rather than a new hosted scenario. Record the old-to-new coverage mapping.
- Run entrypoints in fresh Node processes, serially where they share a host. Use unique fixture roots, exact owned cleanup, bounded convergence, and unchanged product deadlines.
- Retain useful failure artifacts before cleanup: fixture state, SQLite sidecars, supervisor records, output, safe process snapshots, timing, and durable recovery evidence where applicable. Artifact collection cannot turn failed cleanup into success.
- Verify locally with focused workflow contract tests, bootstrap regressions, supported qualification files, TypeScript, and diff hygiene. Unsupported local host gates require hosted evidence.
- Obtain one fresh read-only independent Cursor review; repair only concrete Blocker/Important findings. Then commit/push, obtain required PR CI and Windows/Linux/macOS/OCI qualification on the final SHA, reconcile M4/Gate G, and leave a clean tree for user review. No merge.

## Results

Implementation and local targeted validation are complete. The complete independent read-only Cursor review found no Blockers and one Important issue (the harness timeout regression's 500 ms outer budget), plus two minors. All three findings were repaired and freshly revalidated; details are recorded in `qualification-review-after-repair.md`. Later final-review attempts were limited by Cursor's account model quota and no verdict is invented from them.

The candidate is ready to freeze and push for final-SHA hosted acceptance. **Gate G remains open**: required PR CI and fresh isolated Windows/Linux/macOS/OCI qualification on the pushed SHA are still mandatory, and PR #95 remains unmerged.

### Prior failed run: bounded classification

The controller inspected the failed-job log for `35492714608`, rather than treating its overall red status as a new architecture defect:

| Observation | Classification / next evidence |
| --- | --- |
| Recovery on all three hosts returned HTTP 500; Windows/macOS expected typed 412, Linux expected 201 | Matches the user-diagnosed bootstrap close-error masking defect. Keep the exact consumer retry and exercise real recovery in isolation. |
| Unsupported persisted execution-safety fixture failed across all hosts | Obsolete version-2 expectation; use version 3 and satisfy the baseline prerequisite. |
| Windows active legacy Build fixture waited without its required baseline | Stale fixture; keep the baseline repair. |
| macOS process-group test observed unknown instead of running after a fixed delay | Test observation timing; bounded convergence with exact state evidence, never a product fail-open. |
| Windows Job fixture startup, late birth, portable channel and writer-fence acquisition failed with contention / `database is locked` | Coupled host qualification is the working hypothesis, supported by user-recorded local exact-command passes. Isolate first; no fence or deadline repair inferred. |
| macOS extension-static-validation CLI test exited with `git_missing` | Unclassified host-sensitive preflight observation; isolated real CLI qualification must retain this acceptance route and diagnose any recurrence. |
| Linux native and OCI jobs passed | Historical supporting evidence only; fresh final-SHA qualification remains required. |

Local Docker engine was unavailable at handoff verification (`docker info` could not connect to the Linux engine pipe). OCI and POSIX/macOS acceptance therefore remain hosted gates unless local capability changes; no skipped local case is counted as a pass.
