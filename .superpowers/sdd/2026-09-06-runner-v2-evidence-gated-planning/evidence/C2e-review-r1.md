# C2e - independent code review r1

Reviewer: fresh-context independent reviewer (round 1). I did not write this code.
Model: Sonnet 5.5 (`claude-sonnet-5-5`), extra-high effort. Date: 2026-09-30.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `0ec56592` ("wip(c2e)", parent `88266a9a` = C2d).
Inputs: brief `c2e-brief-muse.txt`; plan CD-15, CD-17, CD-19 and packet "C2e"; `evidence/C2e.md`; `C2c-review-r3.md` (F-matrix, 4 MiB cap, G1 / G1-control); `C2c-review-r4.md` (m-7, m-8); `C2c-review-r5.md` (m-11, m-4); `muse-pipeline-2026-09-29.md` (controller runs on the C2e bytes: handoff 7 files 96/96, large-tree 4/4, native-delivery 20/20; I did not repeat them).

## Byte hashes (sha256), the same at the start and at the end of the review

| File | sha256 |
|---|---|
| `runner-v2/src/integration-manager.ts` | `04c1ea896228dcfeca7b0c38eb16f79290fb6ee762d2edc9ec5010439bec0ecc` |
| `runner-v2/src/build-runtime.ts` | `e1dce26ec605707a33ebe4da4259905ff8bc0788e5c576777ed16b1548ae818e` |
| `runner-v2/test/support/handoff-snapshot-harness.ts` | `1e2eaca0387a21d99d96f4f968ba3c60385fcd6ca0707a66257b1c63c9af7434` |
| `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts` | `b2a97fc0007acb472b58eba66cb32abe80c478d3334089649f71b5b30785e188` |
| `runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts` | `189920ab506da0fb8c00f658b89b62e1c1d5e991edca659ec0120a93a244b01d` |
| `runner-v2/test/docs-policy-v2-handoff-retry.test.ts` | `b663675ce816316f8107d95ce725745a795c64771ee546c624ebb6ca7a840e17` |
| `runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts` | `a7544ea59ffcf4cebeca078f52f4fb851d5beafa295df131cf717921ff1fcb45` |
| `runner-v2/src/scheduler-store.ts` (unchanged by C2e) | `abe0dfc967c6ed50d976ec0b6788d683f6feccca60ba5587ffdf60c94155e5ba` |
| `runner-v2/src/project-docs.ts` (unchanged by C2e) | `205421e1759b67a66fae0322dfd4f988a3be8504abcfec3f560d15040eca93a2` |
| `evidence/C2e.md` (hashed at the end only; I did not edit it) | `71895a71a8baa4a6cb869cde680e14a9bcfaff6249fcb3499ff843a1922fb34d` |

The first seven hashes equal the ones in `C2e.md`. I edited no source or test file. I did not commit, stage, stash or push. Every probe is a test file in my scratch folder that imports the worktree modules by absolute file URL. Fixtures live under the system temp directory and were removed by `fixture.close()`. The shared `node_modules` was restored by the controller mid-review; I saw no missing-module error and no "Process launch was not proven" transient.

**Verdict: REPAIR - 1 blocking**

C2e does what the brief asks for the F-matrix, for m-7, m-11 and m-8. The commit-tree walk backs every skip, and the run hands off in all the named layouts and in most variants. The new `--output` diff is byte-exact and keeps the conflict refusal. One thing is not closed: the apply is still not bounded for any tree size. Its untracked-file check lists the whole project, including ignored files, into the 4 MiB buffer. A tiny apply on a project with a big ignored folder is refused with the same `Git output exceeded 4194304 bytes` error. The evidence says the project is "proven clean, so it is a few bytes". That is false for ignored files, because `git status --porcelain` never lists them. I have a failing probe and a two-line fix. The rest are non-blocking, but I recommend folding the cheap ones into the same repair (N-2, N-3, N-4).

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| B-1 (brief item 2: "never read a whole-tree listing ... into one capped buffer"; bounded for any tree size) | `integration-manager.ts:2052` in `assertCheckoutWillNotOverwriteUntracked` (called at `:1459` and `:1552`): `this.git(this.repositoryRoot, ["ls-files", "--others", "-z"])`. The same listing sits at `:1780` (`projectMatchesRevision`, recovery only). `git ls-files --others` without `--exclude-standard` lists every untracked AND ignored file. The C2e comment ("the project is proven clean just before the apply, so the untracked listing stays a few bytes") is wrong: the clean check is `git status --porcelain` (`:1329-1331`), which does not list ignored files. | Probe **A1**: the project ignores a `ignored_deps/` folder (via `.git/info/exclude`) holding 45,000 files (a typical `node_modules`-sized tree). The integration branch holds only the handoff snapshot. The owner selects `apply_to_project`. `git status --porcelain -z --untracked-files=all` prints 0 bytes; `git ls-files --others -z` prints 4,455,000 bytes. | The apply completes, as it does for the 40,000-file tree in G1-select and in probes L1 / L2. | The selection is refused: `Git output exceeded 4194304 bytes or its exact bounded artifact is unavailable.` The project head does not move. **A1c** (same layout, 100 ignored files) completes. | Read the untracked listing through a higher explicit bound, the way `change-set.ts:120` does (64 MiB): `this.execute({ cwd: this.repositoryRoot, args: ["ls-files", "--others", "-z"], maxOutputBytes: 256 * 1024 * 1024 })` at `:2052` and at `:1780`. A stricter alternative: read the changed-name file (already on disk) and ask `ls-files --others -z -- <chunk>` for chunks of a few hundred literal pathspecs. Add a regression test (A1 shape, 45,000 ignored files, a tiny apply completes) and a prove-red (put the old listing back, the test goes red). Correct the C2e.md sentence. |

## Non-blocking findings

| # | Where | Probe | Observation | Suggested fix |
|---|---|---|---|---|
| N-1 (wording; the plan says "a precise reason the owner can act on") | `project-docs.ts:407` `handoffStateSkipReason` (outside the C2e writable set; the worker disclosed it) | F2, F1, F3, F4, F5, F6: every non-link blocker records `docs/project/STATE.md is not written: <component> is a symbolic link or junction; ...`. That is false for a file, an empty file, a gitlink or a directory. The v1 refusal says "a regular file, not a directory" even for a gitlink (F1, F6). | The record is durable in the event log (T7a stamps real runs), so a false sentence is stored for good once T7a ships. The outcome is correct. | Before T7a: put `project-docs.ts` in the repair's writable set. Carry a kind with the component (`dirLinks` entries or a parallel `dirBlockers`) and word it: "is a regular file", "is a submodule entry", "is a directory". Keep the link wording for real links so stored logs replay unchanged. |
| N-2 (v1 regression) | `integration-manager.ts:1105-1116` | **F10**: STATE.md is a tracked directory; v1 `commitProjectDocuments` writes only `docs/project/README.md`. Before C2e it wrote fine. Now: `Project document path docs/project/README.md is refused because docs/project/STATE.md is a directory.` | The v1 refusal keys on the STATE.md chain, not on the write's own path. Only the layout of a directory at STATE.md is affected, and it fails closed. | Refuse only when the blocker can affect the write: `blocker.kind === "file-not-dir" \|\| write.path === "docs/project/STATE.md"`. |
| N-3 (same class as F-state-dir) | `integration-manager.ts:2526` and `:2563` (only mode `040000` counts at the STATE.md level) | **F7**: a gitlink (mode 160000, an empty directory on disk) at `docs/project/STATE.md`. 0 snapshots; every attempt pauses with `EISDIR ... open '...docs\project\STATE.md'`; v1 also throws `EISDIR`. | Not one of the three named layouts, but the same failure signature, and CD-15 says no layout may strand a run. | Treat any mode other than 100644/100755/120000 at the STATE.md level as `dir-not-file` in both walks. |
| N-4 (m-4 not fully closed) | `commitEntrySkipReasonsFromTree` (`:2589-2633`), branch at `:2621` | **M4a** (link to a tracked directory `somedir`) and **M4b** (link `notes.md`, index holds `NOTES.md`): fresh records `(target ... is not a regular tracked file)`; the reused commit records `(the target holds no marked section)`. M4c (outside), M4d (kernel-owned STATE.md) match, and the worker's own M4e layout (missing target) matches. | The outcome is the same and both are accepted. The C2e claim "the reuse records exactly what a fresh commit of the same layout records" is overstated: only missing, link, outside and kernel-owned targets match. | In the tree helper, word "not a regular tracked file" for mode 040000 / 160000 and for a target found only by case folding (compare the requested spelling with the tree's). Keep the generic wording for a regular blob with the exact spelling. Add M4a / M4b as tests. |
| N-5 (disclosed) | `findTrackedFileWithDigest` (`:979`) still lists `ls-tree -r -l` into the capped buffer | Not probed (the harness has no artifact store). By reading: on a tree above about 4 MiB of listing the throw is caught by the runtime and recorded as `specCopySkipped: tracked_search_failed`. | The run still hands off; only the spec copy is lost. | Same follow-up as B-1's higher bound, or page the listing. |
| N-6 | `:1366-1386`, `:2030-2075` | By reading: `<index>.names` (the changed-name scratch) is removed in a `finally`, but a hard crash leaves it, and `cleanupOwnedProjectApply` does not remove it. A crash between `git diff --output` and the `try` also leaves a partial patch. | Leaks bytes in the runner state directory; no correctness effect. | Add `${indexPath}.names` to `cleanupOwnedProjectApply`; move the `--output` diff and the `stat` inside the `try`. |
| N-7 (style) | `build-runtime.ts:2551-2575` | By reading: the m-7 `try` block re-indents only the first eight fields of the `appendHandoffSnapshotCommitted({...})` literal; the rest and the closing `});` keep the old indent. | Cosmetic. | Re-indent. |
| N-8 (test coverage) | `docs-policy-v2-handoff-large-tree.test.ts`; retry / project-links files | The existing G1, G1-control and G1-flat tests select `keep_integration_branch`, so they never exercised the apply; only G1-select does. My probes L1 (flat) and L2 (control) pass. There is no test for a large ignored tree (B-1), for a v1 write unrelated to STATE.md (N-2), or for a W-S1 second stop. The item-1 prove-red disables only the stage-time skip; the tests would also go red without the walk change or the v1 refusal (they assert the snapshot count, the tree-derived reason and the v1 message), so it is acceptable. | | Add the B-1 test; optionally turn G1-flat / G1-control to `apply_to_project` (about 5 minutes each). |

## Answers to the judge items

1. **F-matrix.** The gate accepts a STATE.md skip only when the commit tree backs it. The runtime takes `stateSkippedReason` only from the commit-tree walk (`dirLinks`, through `describeSnapshotCommitFacts`); stage-time STATE.md reasons are ignored. Probes: **F8** (an untracked file at `docs`, tree clean) and **F12** (tree holds a directory, worktree holds a file) give 0 snapshots and a fail-closed pause with the raw `ENOTDIR`. **F11** (tree holds a file at `docs`, worktree holds a directory) is accepted, and rightly so: the commit tree holds the blocker. Variants that hand off with a tree-derived reason and a completed selection: gitlink at `docs` (F1), empty file at `docs` (F2), file `Docs` (F3), file `docs/Project` (F4), directory `docs/project/state.md` (F5), gitlink at `docs/project` (F6). Second stops **F9a / F9b / F9c** (file at `docs`, directory at STATE.md, gitlink at `docs`): the second commit is empty and chains to the first, the reuse and the withdrawn-stop lookup both return `dirLinks`. v1 refuses all six with a clear reason and no commit (wording issue N-1; over-refusal N-2). Exception: N-3.
2. **Bounded apply.** The diff and the changed-name list now go through `git --output`, so neither passes a capped buffer. The earlier guarantees hold. Exactly what is applied: **A4** (binary with NULs, Latin-1 bytes, CRLF, exec bit, rename, delete) ends with the project tree hash equal to the integration tree hash; the old string path decoded the diff as UTF-8, so this is also strictly better. Conflict refusal: **A2** (`patch does not apply`) and **L3** (40,000 files plus one conflicting path: `already exists in index`); in both the project head, status and files are unchanged. Untracked/ignored collision: **A3** is refused as before. The audit record: a second `applyToProject()` after **A4** returns "applied" with no new project commit (the trailers are found). Nothing outside the project: the patch and scratch live in the runner state directory, and the `handoff` folder is empty after every probe. Large trees: **L1** (40,000 flat files under `docs`) and **L2** (40,000 under `site/generated`) complete with equal trees. **But B-1**: not bounded for a project with a large ignored folder.
3. **m-7.** **M7a**, with a real reducer refusal (the probe empties `paths` on the first snapshot append): the run pauses with `handoff_snapshot_failed` and detail `Handoff snapshots must include docs/project/STATE.md.`, no pump error, 1 kernel commit; a resume reuses the landed commit by key and records exactly 1 snapshot; the Architect is called once. **M7b** (the refusal persists for three cycles): one pause per cycle with unique keys (`handoff-snapshot-failed:22:22`, `:22:24`, `:22:26`), 0 snapshots, still 1 commit, each cycle returns in bounded time. No loop and no duplicated event. Resume needs the owner, so nothing spins.
4. **m-11 / m-4 / m-8.** m-11: the refusal now reads `Project document commit refused: the integration index is not clean (staged changes remain while every write was skipped: ...)`; HEAD is unchanged and the staged stranger is kept; the v1 message is unchanged. m-4: partial, see N-4. m-8: present in the retry file; it needs the empty second commit (without the NB-9 branch stop 2 would pause), so it is meaningful. It asserts two chained snapshots, `paths: []`, the docs-link reason on both, the outside folder untouched, and the apply completes.
5. **Tests.** All eight named tests exist and start from `openFactoryPort`; zero new full `NativeBuildManager` tests; real SQLite and real git. The m-7 test uses a stub throw on the harness store; my M7a shows the same result with a real reducer refusal. The prove-red records in `C2e.md` are consistent with the code (the restore hashes equal the current bytes). The large-tree file was updated honestly: no old test asserted the refusal, and the new G1-select test checks the digest of the applied STATE.md and a generated file. Coverage gaps are in N-8.
6. **Scope and encodings.** Changed files are inside the writable set (`integration-manager.ts`, `build-runtime.ts`, the four handoff test files, one additive harness helper, the evidence). `scheduler-store.ts`, `project-docs.ts` and `native-build-factory.ts` are untouched. All changed files are LF with no BOM (blobs and working tree). `git diff --check` is clean. No `child_process` or `spawn` in the new product code (git goes through `this.execute`). No event type or reducer branch was added, removed or reworded, so stored logs replay unchanged. `git diff --output` is allowed by the Runner Git policy (`git-execution-policy.ts` lists only config, exec-path, submodule, signing and editor arguments).

## Probes

Files are in `C:\Users\b_a_s\AppData\Local\Temp\claude\D--repos-ai-discussion-board\c3a6c726-b6f1-47ec-bea6-214ebdabe566\scratchpad\c2er1\` (`base.mts`, `f1.test.mts`, `f9.test.mts`, `m7.test.mts`, `m4.test.mts`, `apply.test.mts`, `large.test.mts`, logs `fb*.log`). Each harness test took 100-300 s under load; the 40,000-file ones took about 15 minutes with three running at once. They report outcomes and fail only on harness errors.

| Probe | Result |
|---|---|
| F1 gitlink at `docs` | 1 snapshot, tree-derived reason, `paths` AGENTS/CLAUDE, selection completes; v1 refuses |
| F2 empty file at `docs` | same |
| F3 file `Docs` (case variant) | same |
| F4 file `docs/Project` | same, component `docs/project` |
| F5 directory `docs/project/state.md` | same, component `docs/project/STATE.md` |
| F6 gitlink at `docs/project` | same |
| **F7 gitlink at `docs/project/STATE.md`** | **0 snapshots, every attempt `EISDIR`; v1 `EISDIR` (N-3)** |
| F8 untracked file at `docs` | 0 snapshots, fail-closed pause `ENOTDIR` (no false acceptance) |
| F11 tree file at `docs`, worktree directory | accepted with the tree reason (the tree backs it) |
| F12 tree directory at `docs`, worktree file | 0 snapshots, fail-closed pause `ENOTDIR` |
| **F10 STATE.md directory, v1 write of `docs/project/README.md`** | **refused (N-2)** |
| F9a / F9b / F9c second stop (file, STATE.md directory, gitlink) | empty commit chained to the first; reuse and lookup carry `dirLinks` |
| M7a real reducer refusal, then resume | pause with the reason; 1 commit; resume records 1 snapshot; select completes |
| M7b refusal persists 3 cycles | 1 pause per cycle, unique keys, 1 commit, no loop |
| M4a directory target / M4b case-variant target | **reuse wording differs from fresh (N-4)** |
| M4c outside target / M4d kernel-owned target | same wording |
| A2 conflict | refused (`patch does not apply`), head and status unchanged, `handoff` empty |
| A3 ignored file at an added path | refused (`would overwrite the untracked or ignored path`), head unchanged |
| A4 mixed content; second `applyToProject()` | trees equal; second call "applied", no new commit; `handoff` empty |
| **A1 45,000 ignored files, tiny apply** | **refused: `Git output exceeded 4194304 bytes` (B-1); status 0 bytes, `ls-files --others` 4,455,000 bytes** |
| A1c 100 ignored files | completes |
| L1 40,000 flat files under `docs`, select | completes, trees equal |
| L2 40,000 files under `site/generated`, select | completes, trees equal |
| L3 40,000 files plus a conflicting path in the project | refused (`already exists in index`), head, status and file unchanged |

## Follow-up list

Blocking (this repair):
1. B-1: bound the untracked/ignored listing in `assertCheckoutWillNotOverwriteUntracked` (`:2052`) and `projectMatchesRevision` (`:1780`). Add the A1-shaped regression test with a prove-red. Correct the C2e.md sentence.

Recommended in the same repair (cheap, each has a failing probe):
2. N-2: limit the v1 refusal to writes the blocker can affect.
3. N-3: count any non-regular, non-link mode at the STATE.md level as a blocker in both walks.
4. N-4: word directory, gitlink and case-only-target skips as "not a regular tracked file" on the reuse and withdrawn paths; add M4a / M4b tests.

Before T7a stamps docs v2:
5. N-1: accurate reason wording for file, gitlink and directory blockers (needs `project-docs.ts` in the writable set; keep the link wording so stored logs replay unchanged).

Minor:
6. N-5 (`findTrackedFileWithDigest` listing), N-6 (`.names` cleanup, patch inside the `try`), N-7 (indent), N-8 (turn G1-flat / G1-control to apply selections; add a W-S1 second-stop test; add a v1 unrelated-write test).
