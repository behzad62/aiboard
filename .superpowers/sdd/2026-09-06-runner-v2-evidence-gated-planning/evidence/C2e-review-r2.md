# C2e - independent code review r2 (repair cycle 1)

Reviewer: fresh-context independent reviewer (round 2). I did not write this code and did not do round 1.
Model: Sonnet 5.5 (`claude-sonnet-5-5`). Date: 2026-09-30.
Revision under review: `ca0df135` ("wip(c2e-r1)", parent `5b1d58ae` = C2d accepted). Diff for the repair: `git diff 5b1d58ae ca0df135 -- runner-v2/`.
Inputs: repair brief `c2e-repair1-muse.txt`; `evidence/C2e.md` ("Repair cycle 1"); `C2e-review-r1.md`; round-1 probes (`scratchpad/c2er1/`).
Where I ran things: a detached scratch worktree at `ca0df135` under the system temp directory (files rewritten as LF bytes from the index so every hash equals the blob). The lane A worktree was not touched. My probes are in `scratchpad/c2er2/`. The scratch worktree, its `node_modules` junction (removed with `rmdir` first; `node_modules\eslint` in the lane worktree confirmed present afterwards) and my leftover fixture folders are removed.

## Byte hashes (sha256) at ca0df135 (blob == scratch checkout)

| File | sha256 |
|---|---|
| `runner-v2/src/integration-manager.ts` | `01f8bfab4d2dd13fd3e7dde57e91ccdd8189c85f85279cb59a6b43e0fb30847d` |
| `runner-v2/src/build-runtime.ts` | `782d56118984ed5d7b2f20f8448b8679a123ed1062b35dcf1d7524fd085d39a0` |
| `runner-v2/src/project-docs.ts` | `87d593264c42cca900152195fa15fdc441a83f36fa2f3db5db8b33f984c918d7` |
| `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts` | `f51070b3ebb71710ee703bda6aa05f5489d9ed7a0a046435b6c4c10a81d76a49` |
| `runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts` | `e66649644c27ffaef977607e81789ea8462f2ceef67142300be7fe251e248af3` |
| `runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts` | `be86a6fd9c4b4d308e7d73d762a1b8f6af86df5cd6f7f59bf889ee39f7a9128f` |
| `runner-v2/test/docs-policy-v2-handoff-retry.test.ts` (unchanged) | `b663675ce816316f8107d95ce725745a795c64771ee546c624ebb6ca7a840e17` |
| `runner-v2/test/support/handoff-snapshot-harness.ts` (unchanged) | `1e2eaca0387a21d99d96f4f968ba3c60385fcd6ca0707a66257b1c63c9af7434` |
| `runner-v2/src/scheduler-store.ts` (unchanged) | `abe0dfc967c6ed50d976ec0b6788d683f6feccca60ba5587ffdf60c94155e5ba` |
| `evidence/C2e.md` (blob at ca0df135) | `6b8c912c951f5eddab4a01370e2b5d406e84d58c51f633f9e9e12ea36de9641b` |

The first six hashes equal the ones in `C2e.md` "Changed files". I edited no source or test file under review. I did not commit, stage, stash or push. The lane worktree hash of `integration-manager.ts` is still `01f8bfab...`.

**Verdict: REPAIR - 1 blocking**

The repair closes B-1 as written. A tiny apply on a project with 45,000 ignored files completes, at both sites, and the ignored-path collision refusal is as strong as before. N-1, N-2, N-3 and N-4 are fixed and tested. But the chosen design checks the written paths in chunks of a fixed 200 literal pathspecs, with no bound on the bytes of the command line. On Windows one git call then fails with `CreateProcess (Win32 206)` when 200 changed paths average about 150 characters. A long-path apply that completed before the repair is now refused with "Process launch was not proven." I reproduced it through the real runner and through the manager, and I show the same tree completes with the old listing. The fix is small (chunk by bytes). I list it as B-2. One non-blocking regression from the same repair (N-R2-1) should go in the same cycle.

## Round-1 findings: status

| r1 | Status | Evidence |
|---|---|---|
| B-1 (whole-tree untracked listing includes IGNORED files, buffered at 4 MiB) | **Closed for the ignored-file count** at both sites. New B-2 (argv length) comes from the chosen design. | A1, A1c, A3, A5, A7, R1-R4, prove-red, below |
| N-1 (wrong skip reason for file / gitlink / directory) | **Closed** | F1, F2, F5, F6, F7, F9a-c, RS; gate 11/11, replay-compat 3/3 |
| N-2 (v1 over-refused unrelated README write) | **Closed for a directory or gitlink at STATE.md.** New gap N-R2-1 for a gitlink above STATE.md. | F10 (worker test green), V1c, V1f, prove-red |
| N-3 (gitlink at STATE.md stalled with EISDIR) | **Closed** | F7 (worker test green), V1c, prove-red |
| N-4 (reuse wording differs for directory / case-variant target) | **Closed** | m-4a, m-4b (worker tests green), M4a, M4b |
| N-5, N-6, N-7, N-8 (minors, not in the repair brief) | Unchanged, still open as minors | see follow-ups |

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| **B-2** (new, introduced by the B-1 design; brief: "bounded for any tree size", no size-dependent refusal) | `assertCheckoutWillNotOverwriteUntracked` (`integration-manager.ts:2213-2223`) and `projectMatchesRevision` (`:1901-1912`): `for (index += 200)` with `...chunk` of `:(literal)<path>` arguments. The chunk is bounded by count (200), not by bytes. A Windows command line is limited to 32,767 characters; each argument costs `path length + 11`. | An apply with 400 changed paths of relative length 153 (and any chunk of 200 paths averaging about 150+ characters) on Windows. Real runner, factory-built port, `applyToProject()` (probe L158 / M158): `THROW Process launch was not proven.` with cause `process_start_failed CreateProcess (Win32 206)`; the project head does not move. Manager-level probe ARGV calls the method on 400 paths: relative length 115 / 135 / 145 OK; 155 and 195 `spawnSync git ENAMETOOLONG`. The same shape with the pre-repair whole-tree listing at the apply site (copy `fb1`): relative length 153 through the real runner completes (`applied=true`, head moves); 155 and 195 pass the manager probe. | The apply completes for any path length, as it did before the repair. | The owner's apply selection is refused for a tree that applied fine before. The error text says nothing about the cause. Fail-closed (no head move, no data loss). Linux and macOS are not affected (argument limits are far higher). | Chunk by a byte budget as well as a count: accumulate pathspecs until the joined text would pass a fixed budget (for example 16 KiB), always send at least one path. Use one helper at both sites. Add a test in the large-tree file: 400 added files with relative paths of about 160 characters (keep the fixture root short so the integration worktree path stays under 260), prove-red with the `for (index += 200)` loop. Note in `C2e.md` that the 200-path chunk was replaced by a byte-bounded chunk. |

How bad: narrow. It needs at least about 130 changed paths in one apply (200 when paths are about 150 characters) and deep relative paths. Deep Java, Android, .NET or generated-docs trees on Windows reach that. The repair theme is "an apply never fails on tree size"; this adds a new size-dependent refusal on the owner's platform, with a cryptic message. That is why I treat it as blocking rather than a follow-up.

## Non-blocking findings

| # | Where | Probe | Observation | Suggested fix |
|---|---|---|---|---|
| **N-R2-1** (v1 regression created by N-2 + N-3 together) | `integration-manager.ts:1159`: `blocker !== null && (blocker.kind === "file-not-dir" \|\| write.path === "docs/project/STATE.md")`. The N-3 work added a mid-level kind `"submodule"` (gitlink at `docs` or `docs/project`). It is not `file-not-dir`, so a README write under it is no longer refused. | **V1a**: gitlink at `docs`, v1 write `docs/project/README.md`: `THROW git add -- docs/project/README.md failed with exit code 128: fatal: Pathspec 'docs/project/README.md' is in submodule 'docs'`, and the file was already written under the placeholder folder (`docs/project/README.md` stays on disk). **V1b**: gitlink at `docs/project`, same result. By reading, on the r1 bytes the same write was refused up front (a mid-level gitlink counted as "file-not-dir": "... is a regular file, not a directory", mislabeled but before any write); I did not probe the r1 bytes. STATE.md writes are still refused correctly (F1, F6, V1 STATE rows). No head move. | Fails closed, but with a raw git error and a stray file, and the brief asked for "v1 refuses clearly". | Refuse any write whose blocker sits above STATE.md: `blocker.component !== "docs/project/STATE.md" \|\| write.path === "docs/project/STATE.md"`. Add V1a as a test (prove-red with the current condition). |
| N-R2-2 | `projectMatchesRevision` first listing (`ls-files --others --exclude-standard -z`) | By reading | Bounded for ignored files, but a project with more than about 4 MiB of non-ignored untracked paths makes the recovery throw `output_limit` instead of returning false. Fails closed, and the old code had the same exposure (worse). | Follow-up; page it or read it through `--output`-style scratch if it ever matters. |
| N-R2-3 | `applyChangedPathSet` (`:1920-1944`) | By reading | The `git diff --name-only --output=...` call sits before the `try`, so a partial scratch file can remain after a failed or crashed call. Same profile as r1 N-6. In the rollback branch at `:1675` a throw from this helper would replace the original error. | Move the diff call inside the `try`; add `.names` files to `cleanupOwnedProjectApply`. |
| N-R2-4 (wording, for T7a) | `stateBlockerReasonKind` / `commitStateBlockers` | C-1 test asserts it | A case collision (two spellings of `docs` or `docs/project`) still records "is a symbolic link or junction". The worker disclosed it and kept it because C2d test C-1 asserts it. It is durable once T7a stamps. | Before T7a: add a collision reason kind; old logs are unaffected. |

## Answers to the judge items

**1. B-1.**
- Apply site. **A1** (45,000 ignored files in `ignored_deps/`, ignored through `.git/info/exclude`; tiny apply through the owner selection): `OK status=completed choice=apply_to_project`, the project head moves, project tree equals integration tree, the 45,000 ignored files are still there, the `handoff` folder is empty. **A1c** (100 ignored files) completes. Independent prove-red: copy `fb1` with the whole-tree `ls-files --others -z` put back in `assertCheckoutWillNotOverwriteUntracked`, the worker's own test "probe A1" goes red with `GitCommandError: Git output exceeded 4194304 bytes or its exact bounded artifact is unavailable.` from `assertCheckoutWillNotOverwriteUntracked` (`:2214` in the copy). The restored code is the tested code.
- Collision strength. **A3** (ignored file at an added path): refused with `Automatic project handoff would overwrite the untracked or ignored path ...`, head unchanged, user file intact, handoff folder empty. **A5** (450 added files under an ignored folder; an ignored user file placed at position 0, 199, 200, 399, 400 and 449 one after the other): each refused with the exact message, head unchanged; after the files are removed the same apply completes. So the chunk boundaries do not hide a collision. **A7** (13 colliding names: `g[1]x.txt`, `g{2}.txt`, `sp ace.txt`, `café.txt`, `-dash.txt`, `a'b.txt`, `100%.txt`, `x@{1}.txt`, `$dollar.txt`, `^caret.txt`, `!bang.txt`, `~tilde.txt`, a Japanese name): every one refused with its own path; the final apply completes. `:(literal)` keeps glob and magic characters exact. The refusal is exactly as strong as the old listing for files at written paths. (Like the old listing it does not compare an ignored directory against an added file of the same name; unchanged.)
- Recovery site (`projectMatchesRevision`). **R1** (crash after the ref advanced, 45,000 ignored files, then a fresh manager's `applyToProject()`): `OK applied=true`, trees equal. **R3** (crash after the journal was written, same tree): completes, trees equal. Prove-red for this site alone (copy `fr1`: only the `--exclude-standard` argument removed): R1 throws `Fixture output exceeded the caller bound`. **R2 / R4** (crash, then an ignored user file appears at a written path in the second chunk of 250 paths): recovery refuses (`cannot be recovered safely ... unrelated changes`) and the user file is intact. The existing `integration-manager.test.ts` file passes 37/37 (including the seven recovery tests the worker had to fix).
- No raised cap: the diff shows no change to `maxOutputBytes`; the listing for written paths is chunked, and the recovery listing uses `--exclude-standard`. The design choice is sound; the chunk bound is the gap (B-2).

**2. N-1.** Recorded `stateSkippedReason` per kind (factory-built port, fresh commit): file at `docs` or empty file: `docs/project/STATE.md is not written: docs is a regular file, not a directory; ...`. Gitlink at `docs`, at `docs/project`, at STATE.md: `... <component> is a submodule entry; ...`. Directory at STATE.md (also the `state.md/` case-variant): `... docs/project/STATE.md is a directory; ...`. Real links keep `... is a symbolic link or junction ...` (unchanged wording). The v1 refusal names the same kinds. Reuse equals fresh: **RS** file at `docs` and directory at STATE.md record byte-identical reasons on the fresh commit and on the reused commit after an injected read failure. **F9a-c** (second stop after a file at `docs`, a directory at STATE.md, a gitlink at `docs`): the empty second commit, the reuse and the withdrawn-stop lookup all carry the kind. The remaining RS layouts (gitlink cases) I stopped before they finished; F9c covers their manager result and the runtime code path is shared. Replay compatibility: `handoffStateSkipReason` is byte-identical (the diff only adds a comment above it); new wording is a new function (`handoffStateBlockerSkipReason`) and two new optional fields, so nothing old is re-read differently; the store validates only that `stateSkippedReason` is a non-empty string (`scheduler-store.ts:9276-9279`); `docs-policy-v2-handoff-gate.test.ts` (it seeds the legacy sentence) 11/11 and `replay-compatibility.test.ts` 3/3. AR-R05: the runtime still takes the STATE.md skip only from the commit-tree walk (`commitStateBlockers` through `describeSnapshotCommitFacts`); stage-time STATE.md reasons are still ignored; the kind is read from the same walk. Scope: `project-docs.ts` changes are the N-1 type, the new function, one optional field and the describer branch only.

**3. N-2, N-3, N-4.** Worker tests run by me on the clean bytes: F10 pass, F7 pass, m-4a pass, m-4b pass. Extra probes: **V1c** (gitlink at STATE.md, v1 README write) and **V1f** (directory at STATE.md, same): both commit; **F1, F2, F5, F6, F7** v1 STATE.md writes refuse with the kind wording; **M4a / M4b**: `same: true` (both say `target ... is not a regular tracked file`). Gap: N-R2-1 above.

**4. Prove-reds.** Independent, each in a separate copy of the tree, each restored by deletion of the copy. B-1: red with the exact old error (above). N-2: old condition `if (blocker !== null)` put back, F10 red: `Project document path docs/project/README.md is refused because docs/project/STATE.md is a directory.` N-3: directory-only checks put back in both walks, F7 red: `the run hands off instead of stalling on EISDIR ... 0 !== 1`. All three are meaningful: they fail on the stated symptom and pass on the repair. The records in `C2e.md` are consistent with what I saw. No test covers B-2, N-R2-1 or the second site (R1) inside the repo; I used scratch probes for them.

**5. No regression / scope.** C2d and C2c layouts: F5 (case-variant directory), M4a/M4b (case-variant target), the reuse tests, `integration-manager.test.ts` 37/37, `project-doc-commit.test.ts` 21/21, gate 11/11, replay-compat 3/3 all pass on the scratch bytes. I did not repeat the worker's six-file 132-test run or the large-tree file alone (48 min) and I did not re-run G1-select. Scope: changed files are `integration-manager.ts`, `build-runtime.ts` (two three-line pass-throughs), `project-docs.ts` (N-1 only), and three handoff test files plus evidence. `scheduler-store.ts`, `native-build-factory.ts`, the harness and the retry file are unchanged. All blobs are LF, no BOM (CR count 0). `git diff --check` clean. `tsc -p runner-v2/tsconfig.json --noEmit` exit 0, eslint on the six changed files exit 0. No `child_process`, `spawn` or `exec` in the new product code. No event type or reducer branch was added, removed or reworded.

## Probes (scratch, `scratchpad/c2er2/`)

| Probe | Result |
|---|---|
| A1 45,000 ignored files, tiny apply | completes; trees equal; ignored files intact; `handoff` empty |
| A1c 100 ignored files | completes |
| A3 ignored file at an added path | refused with the exact message; head, status, file unchanged |
| A5 collision at chunk positions 0/199/200/399/400/449 (450 files) | each refused; final apply completes |
| A7 13 special file names | each refused; final apply completes |
| **L / M158 400 files, relative length 153, real runner** | **`Process launch was not proven` (cause `CreateProcess (Win32 206)`); head unchanged** |
| L140, L150 (relative length 135, 145) | complete |
| Lfault158 (same shape, old apply-site listing) | completes |
| **ARGV direct method call, 400 paths** | **115 / 135 / 145 OK; 155 and 195 `spawnSync ENAMETOOLONG`; old listing OK at 155 and 195** |
| R1, R3 recovery with 45,000 ignored files | complete; trees equal |
| R1 with the recovery listing reverted (`fr1`) | red |
| R2, R4 recovery with an ignored file at a written path (second chunk) | refused; user file intact |
| F1 / F2 / F5 / F6 / F7 recorded reasons + v1 refusals | kind wording; selection completes |
| F9a / F9b / F9c second stops | kind carried on second commit, reuse and lookup |
| RS file at `docs`, directory at STATE.md: fresh vs reuse | identical reasons |
| M4a / M4b fresh vs reuse | identical |
| **V1a / V1b gitlink above STATE.md, v1 README write** | **raw `git add` failure + stray file (N-R2-1)** |
| V1c / V1f gitlink or directory at STATE.md, v1 README write | commit |
| Worker tests F10, F7, m-4a, m-4b (clean bytes) | pass |
| gate 11/11, replay-compat 3/3, integration-manager 37/37, project-doc-commit 21/21 | pass |
| tsc, eslint, `git diff --check` | clean |

Notes on my own probe runs: two "Process launch was not proven ... read ECONNRESET" transients appeared in fixture cleanup under heavy machine load (V1b close). They are not the B-2 failure: the B-2 cause is `CreateProcess (Win32 206)` and it reproduces without load in the manager-level probe. A6 and the REL=168 run failed in fixture cleanup ("Filename too long" on `git worktree remove`) because the harness root plus a 165-character path passes 260; they are not findings.

## Follow-up list

Blocking (this repair):
1. B-2: chunk the written-path checks by a command-line byte budget (and keep a count cap) at both sites; add a long-path test with a prove-red.

Recommended in the same repair:
2. N-R2-1: refuse v1 writes whose blocker is above STATE.md (one condition); add V1a as a test.

Before T7a stamps docs v2:
3. N-R2-4: a collision-specific reason wording (old logs keep reading as they are).

Minor, carried over or new:
4. N-R2-2 (recovery listing of non-ignored untracked paths), N-R2-3 (scratch file outside `try`; rollback branch masking).
5. r1 N-5 (`findTrackedFileWithDigest` listing), N-6 (`.names` in `cleanupOwnedProjectApply`), N-7 (indent), N-8 (W-S1 second-stop test; G1-flat and G1-control still select `keep_integration_branch`).
