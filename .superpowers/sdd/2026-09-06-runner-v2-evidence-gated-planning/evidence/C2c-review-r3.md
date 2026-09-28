# C2c - independent code re-review r3

Reviewer: fresh-context independent re-reviewer (round 3). I did not write this code and did not do rounds 1 or 2. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `62362265`; C2c uncommitted.
Inputs: `C2c-review-r2.md` (and `C2c-review-r1.md` for context); the cycle-2 brief `c2c-repair2-muse.txt`; `evidence/C2c.md` "Repair cycle 2"; plan CD-4, CD-15 and CD-17.

The files under review match the cycle-2 evidence hashes exactly: build-runtime `a85a24c5`, integration-manager `23d392d9`, project-docs `205421e1`, docs-policy-v2-handoff test `f63caa16`. scheduler-store (`d248e1dc`) and project-doc-commit test (`ed3f622c`) are unchanged since round 2. During the review the controller committed TX-1 (HEAD is now `7eb31177`, test-only); the C2c bytes above were unchanged at the end. I edited no source or test file. Every probe ran from test files in my scratchpad that import the worktree modules by absolute URL, so nothing was written into the repository. Every fixture lives under the system temp directory, and every "outside" directory is inside that fixture root. I did not run the native-delivery files.

**Verdict: REPAIR — 3 blocking**

Cycle 2 fixes what round 2 asked for. NB-1, NB-2, NB-3, m-1, m-2 and m-3 hold under every probe, and one describer now serves the fresh, reuse and withdrawn-stop paths (the withdrawn M-6 corner, W-B2, completes). Nothing reached an outside directory in any probe. Three stuck runs remain, and each is backed by a failing probe:
- **NB-4 (critical, already-reviewed code)**: in any CD-17 layout (a linked `docs`, `docs/project` or STATE.md), if AGENTS.md and CLAUDE.md already hold the exact v2 sections, the snapshot commit is empty. The reducer refuses `paths: []`, and the run is stuck for good. This hits every second stop of a run (the withdrawn-stop probes) and every later AIBoard run on a project whose docs folder is a link.
- **NB-5 (new in cycle 2)**: the new commit-tree walk runs `git ls-tree <commit>:docs`, which lists every direct child of `docs/`. With 40,000 files directly under `docs/`, every snapshot fails on the 4 MiB cap. The v1 document commit also lands and then throws, again on retry. This is the NB-3 class brought back by the NB-2 fix.
- **NB-6 (critical, already-reviewed code)**: a committed `Docs` link checked out with `core.symlinks=false`, the Git for Windows default, fails on every attempt with `ENOTDIR ... mkdir docs`. The stager's index check is exact-case, while the new commit-tree side is case-folded.

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| NB-4 (stuck run; CD-17; allowed as new: critical and backed by a failing probe) | `scheduler-store.ts:9294`: `paths.length === 0 \|\| ...` throws `Handoff snapshots must include docs/project/STATE.md.` even when `stateSkippedReason` is present. The kernel commits with `--allow-empty` (`integration-manager.ts:724`), and `readHandoffSnapshotFile` lists no names for an empty commit, so the runtime records `paths: []`. The current-stop append (`build-runtime.ts:2546`) is outside the failure-pause wrapper, so the refusal is a pump error and not a retryable pause. Every re-activation reuses the empty commit by key and throws again. | **DUP-A4**: `docs` is a real link to an outside directory; AGENTS.md and CLAUDE.md are committed holding exactly the v2 section and line (what an earlier AIBoard run's handoff leaves in the project). **W-A4 / W-S1 / W-CI**: a finish run in the A4, S1 and CI layouts; stop 1's commit lands, then the read fails; guidance withdraws; FV re-runs; the Architect re-requests. Stop 2 is empty because stop 1 already committed the sections. | The snapshot records the STATE.md skip and the handoff completes, as the single-stop A4, S1 and CI layouts do. | DUP-A4: 0 snapshots, pump error `Handoff snapshots must include docs/project/STATE.md.`, the empty commit in the log (`headChangedPaths: []`), and the owner refused (`The kernel handoff snapshot is required ...`). **DUP-A4-retry**: 2 re-activations and 1 accepted resume. Each attempt throws the same error (the last ends in `autonomous_pump_error`), there are still 0 snapshots and only one snapshot commit, and the owner is refused. W-A4, W-S1 and W-CI: the withdrawn stop-1 history record is correct (the reason is tree-derived, and case-folded for `Docs`), but stop 2 fails with the same pump error and the owner is refused. **DUP-control** (the same entry files, no link): completes, with paths `[docs/project/STATE.md]`. | In the reducer, accept `paths: []` when `stateSkippedReason` is a string (the runtime already proves the entry facts from the tree). Optionally, route a refused append through `pauseForHandoffSnapshotFailure`, so a refusal is never a silent pump error. Add DUP-A4 and one second-stop case (W-A4 or W-CI) as factory-port regression tests. |
| NB-5 (stuck run plus an undeclared v1 regression; new in cycle 2) | `commitStateLinkComponents` (`integration-manager.ts:2337-2343`) lists each parent tree whole with `git ls-tree <commit>[:<dir>]` so that it can match names case-folded. `ls-tree <commit>:docs` prints every direct child of `docs/`. Output over the 4 MiB cap throws `output_limit`, even with `allowFailure`. `documentCommitResult` calls this walk on every snapshot, every reuse and every v1 `commitProjectDocuments` (the walk runs after the v1 commit). | **G1-flat**: 40,000 tracked files directly under `docs/` (the worker's G1 file names; about 108 bytes per `ls-tree` line, about 4.3 MB). | The snapshot commits, and v1 behaves as at HEAD (the brief: "never list a whole directory"). | 3/3 attempts pause with `Git output exceeded 4194304 bytes ...`, with 0 snapshots and the owner refused. The v1 commit lands (revision count 2 to 3) but throws, and a retry with the same request id throws again (reuse also runs `documentCommitResult`). **G1-flat-control** (30,000 flat files, under the cap): the snapshot commits. G1 (nested `docs/generated/`) and G1-control now commit, so NB-3 itself is fixed. | Query each level for the single entry, never the whole listing. For example, run `git ls-tree <commit> -- <exact path>` for the expected spelling. For a case-insensitive checkout, take the on-disk spelling from a bounded source (the worktree `readdir` of that one parent, or the index entry found with `:(icase)`) and then query that exact entry. Add G1-flat (or a small-cap variant) with a v1 assertion. |
| NB-6 (stuck run; CD-17 case-insensitive link; allowed as new: critical and backed by a failing probe) | Stage time: `firstLinkComponent` (`integration-manager.ts:2732-2752`) checks index modes with an exact-case pathspec (`ls-files -- docs` does not match a `Docs` entry; I confirmed this in a scratch repository with `core.ignorecase=true`, and `:(icase)docs` does match). The worktree `lstat("docs")` then reports a plain file, so no link is found. The STATE.md write then runs `mkdir docs/project` (`integration-manager.ts:1081`) and throws. The new case-folded commit-tree walk is never reached. | **CI-lm**: a committed `Docs` link (mode 120000) to an outside directory, checked out with `core.symlinks=false` as a plain file. This is how a repository with a `Docs` symlink lands on a default Git for Windows clone. `core.ignorecase=true`. | STATE.md is skipped with the CD-17 reason (`docs is a symbolic link or junction`), and the run completes, as CI (a real link) and A4-lm (link-mode, exact case) do. | 3/3 attempts pause with `ENOTDIR: not a directory, mkdir '...\docs'`. 0 snapshots, and the owner is refused. Nothing is written outside (`own.txt` only). v1 throws the same `ENOTDIR` instead of the declared CD-17 refusal. | Compare index modes case-folded when the checkout is case-insensitive: `:(icase)<component>` with the same exclude, or case-fold the returned names. The stager and the describer then see the same link. A non-directory where a directory is expected could also be treated as a recorded skip, which would also close the pre-existing F-matrix. Add CI-lm as a regression test (v2 completes; v1 gives the CD-17 refusal). |

## Resolution of round-2 items

Every row is proven through the factory-built docs port, the production `NativeBuildManager`, and real SQLite and git.

| Item | Status | Proof |
|---|---|---|
| NB-1 (M-6 on reuse) | **RESOLVED** | B2 (link-mode) and B2-real (real link): after 1 resume, 1 snapshot, the redirect plus the M-6 omission re-described from the tree, and completed. B2 hit one extra load transient (`Process launch was not proven.`), and the next resume recovered. B2-control completes. The withdrawn corner W-B2: the stop-1 history record carries the tree-derived redirect and omission; stop 2 commits, continues the chain and completes. |
| NB-2 (STATE.md skip on reuse) | **RESOLVED** | S1-reuse: after 1 resume, completed with `docs/project/STATE.md is not written: docs/project/STATE.md is a symbolic link ...`. CI-reuse: after 1 resume, completed with the case-folded `docs` reason and nothing outside. A4-reuse: the same. The fresh paths S1, S1-out, CI, A3, A3n, A4 and A4-lm complete, with nothing outside. (The next stop after such a commit hits NB-4.) |
| NB-3 (whole-subtree index listing) | **RESOLVED** for the index query; **reintroduced** through `ls-tree` (NB-5) | G1 (40,000 files under `docs/generated/`, `ls-files` output 4,720,000 bytes): the snapshot commits, and v1 commits. G1-control: the snapshot commits, and v1 commits. The refused harness selection in both is the pre-existing 4 MiB cap in `applyToProject`, the same as in round 2. |
| m-1 (false `stateSkippedReason`) | **RESOLVED** | A1, A2, A5 and J-specs: STATE.md committed, `stateSkippedReason` absent, outside empty, `spec: not recorded`. |
| m-2 (fail-open on a check error) | **RESOLVED** | E3-throw: `specCopySkipped: write_failed`, `spec: not recorded`, no spec file in the commit, completed. |
| m-3 (uncorroborated STATE.md skip) | **RESOLVED as specified** | J-docs: 0 snapshots, a fail-closed pause (`commit ... holds no docs/project/STATE.md`), the owner refused, the outside directory holds only `own.txt`. See follow-up 2: the pause outlives the tampering. |
| m-4 (reason wording) | **PARTIAL** | E3 records `path_occupied`. D1 and D1-link record `target sub/notes.md is not reachable: sub is a symbolic link or junction`. But **B3 on reuse** still records the generic `CLAUDE.md is a symbolic link to NOTES.md; the entry is skipped (the target holds no marked line).`, while fresh C3 records the M-6 omission (the describer derives the omission only for a link to `CLAUDE.md`). The evidence claim "the B3/M-6 reuse re-description is the recorded omission" is inaccurate. **W-B1**: the withdrawn history record says `(the target holds no marked section)`, while the fresh stop-2 record for the same layout says `(target MISSING.md is not a regular tracked file)`. The outcomes are correct; only the wording differs. |
| m-5 | information (unchanged) | C9-bs and C9-bs-escape as in round 2. |
| m-6 (CD-17 wording) | **RESOLVED** (controller) | The plan's CD-17 now names "the handoff file itself, for example `docs/project/STATE.md`". |
| M-7 | **OPEN** (controller) | `git add -f` for the evidence files at commit time. |

## Structural claim (brief item 2)

- **One describer**: confirmed. `describeSnapshotCommitFacts` (`project-docs.ts`) is called on the current stop, fresh or reused (`build-runtime.ts` about line 2449), and on the withdrawn stop (about line 2726). Both feed the same `handoffEntryFileStatus`. A STATE.md skip comes only from the commit tree (`dirLinks`), so a stage-time STATE.md reason is never passed in (m-3). The probes agree: B2 fresh and reused, W-B2 history, and W-A4, W-S1 and W-CI history records all carry the tree-derived facts.
- **Remaining places where stage-time or worktree facts decide on their own**:
  1. Stage-time link detection (`firstLinkComponent`: exact-case index plus worktree `lstat`) alone decides whether STATE.md is written, and it disagrees with the case-folded commit tree. That is **NB-6**.
  2. The entry skip text: the stage-time reason is kept whenever the tree holds the link, so the same layout gets two wordings (fresh versus reuse or withdrawn; m-4 residual). This does not change the outcome.
  3. An entry skip under out-of-band tampering (D1: a junction above the target, while the tree holds a regular `sub`) is accepted on the tree fact "AGENTS.md is a link". The STATE.md analogue (J-docs) pauses. This is minor and in the same class as earlier rounds.
  4. The spec-copy facts are not part of the describer: `specCopyClaimFromCommit` reads the commit tree, and `stagedSpecSkipped` and a re-computed `specCopySkipped` serve as fallbacks. This does not change the outcome; the gate ignores spec facts.
- **Withdrawn-stop corners** (no dedicated worker test): the M-6 corner (W-B2) passes end to end. The dir-link corners (W-A4, W-S1, W-CI) and W-B1 reconcile the withdrawn commit correctly. The dir-link runs are then stuck at stop 2 by NB-4, which is not a withdrawn-path defect.

## Safety invariants (brief item 3)

- **Nothing is written outside the repository**: holds in every probe. That covers A1, A2, A3, A3n, A4, A4-lm, A4-reuse, A5, CI, CI-reuse, CI-lm (v2 and v1), J-docs, J-docs-recover, J-specs, S1 (`shared.txt` unchanged), S1-out (outside file unchanged), D1 and D1-link, W-A4, W-S1 and W-CI (outside holds only `own.txt`), DUP-A4, DUP-A4-retry, the v1 matrix and C9-bs-escape.
- **No layout leaves a run unable to hand off**: violated by NB-4, NB-5 and NB-6. The pre-existing F-matrix is unchanged: a tracked file at `docs` fails with `ENOTDIR`, a file at `docs/project` with `EEXIST`, and a directory at STATE.md with `EISDIR`, each on 3/3 attempts.
- **The gate accepts a skip only with a commit-tree-backed reason**: STATE.md, yes (J-docs pauses, and every recorded STATE.md reason names a tree link). Entry files, yes, by the tree link (item 3 above is the tampering-only asymmetry). No false acceptance was observed.
- **v1 unchanged except the declared refusals**: the v1 matrix is unchanged (`docs` refused as a real link, link-mode, junction and `Docs` link; plain commits `[AGENTS.md, docs/project/STATE.md]`). G1 v1 commits again. **But NB-5 adds a new v1 failure** (G1-flat: the commit lands, then the call throws on every try). CI-lm v1 throws `ENOTDIR`, as at HEAD, instead of the declared refusal.
- **Replay-compatibility and static audits**: the worker ran replay-compatibility and the git, lsp and mcp caller audits green on these exact bytes (233/233 aggregate), so I did not re-run them (no-duplicate rule). I ran the two it did not run, one-shot-command-routing-static and static-adapter-policy: **8/8 pass**. `git diff --check` is clean. Encoding: no BOM; project-docs.ts is CRLF only; the other changed files are LF only (matches the evidence).

## Environment note

"Process launch was not proven." (`subprocess-runtime.ts`, unchanged code) appeared under load: 8 of my probe processes plus the controller's suites. It added one failure pause that the next resume cleared (B2, A3n, B3). It also refused one harness apply (A2). A2 re-run alone completes. No finding depends on these transients: NB-4 to NB-6 fail identically on every attempt, with their exact error named.

## Probes

Scratch files `re-r2-p1`, `re-r2-p2a`, `re-r2-p2b1`, `re-r2-p2b2`, `re-r2-p3` and `re-r2-p3c` (the round-2 probes, unchanged, re-run against these bytes), plus `r3-a` to `r3-e` (new), with their logs, are in `...\scratchpad\r3c2c\`. The harness is the round-2 one (`openFactoryPort`, `harness`, `planOnlyThroughFactoryPort`, `failNextSnapshotReadOnce`); `runW` adds the finish-run withdrawn-stop flow. All 11 files exit 0: they report outcomes and fail only on harness errors.

| Probe | Result |
|---|---|
| B2 / B2-real / B2-control | completed, 1 snapshot, M-6 omission tree-derived (NB-1 resolved) |
| S1 / S1-out / S1-reuse | completed, STATE.md skip naming the file itself, `bodyDigest ""`, nothing outside (NB-2 resolved) |
| CI / CI-reuse / A4 / A4-lm / A4-reuse / A3 / A3n | completed, reason names the linked component, outside empty |
| G1 / G1-control | snapshot and v1 commit (NB-3 resolved; the harness apply cap is pre-existing) |
| A1 / A2 / A5 / J-specs | completed, no `stateSkippedReason`, `write_failed`, `spec: not recorded` (m-1) |
| E3 / E3-throw | `path_occupied` / `write_failed`, `spec: not recorded`, completed (m-4 / m-2) |
| J-docs | fail-closed pause, owner refused, outside only `own.txt` (m-3) |
| D1 / D1-link | the junction or link named, outside unchanged, completed (m-4) |
| B1 / B1c / B4 | after 1 resume, completed |
| B3 (reuse) | completed; **generic wording, not the M-6 omission** (m-4 residual) |
| C3 / C9 / C9-bs / C9-bs-escape / C11 / C7 / L2-real / C12 / C-regress (C1, C2, C4, C5, C8) | completed, as in round 2 |
| E1 / E2 | no index or status change / clean status after a failure |
| V1 matrix | 4 refusals, no commit, nothing outside; plain commits |
| F-matrix | pre-existing: stuck on 3/3 attempts (`ENOTDIR` / `EEXIST` / `EISDIR`) |
| **W-B2** (new: withdrawn stop, M-6) | 2 snapshots chained, history record tree-derived, completed |
| **W-B1** (new: withdrawn stop, missing target) | 2 snapshots chained, completed; wording differs between history and fresh records |
| **W-A4 / W-S1 / W-CI** (new: withdrawn stop, dir or file link) | history record correct; **stop 2 stuck (NB-4)**, owner refused |
| **DUP-A4 / DUP-A4-retry** (new) | **stuck for good (NB-4)**: pump error on every activation and after resume, 0 snapshots |
| DUP-control (new) | completed |
| **G1-flat** (new) | **stuck on 3/3 attempts, and v1 throws after committing and again on retry (NB-5)** |
| G1-flat-control (new, 30,000 flat files) | snapshot commits |
| **CI-lm** (new) | **stuck on 3/3 attempts with `ENOTDIR mkdir docs` (NB-6)**; v1 `ENOTDIR` |
| J-docs-recover (new) | still stuck after the junction is removed and `docs` restored (follow-up 2) |
| one-shot-command-routing-static, static-adapter-policy | 8/8 |

## Follow-up list

Blocking (this repair):
1. NB-4: accept an empty `paths` when `stateSkippedReason` is present. Consider pausing, instead of throwing, when a snapshot append is refused. Regression tests: DUP-A4 and a second-stop layout (W-A4 or W-CI).
2. NB-5: bounded per-entry commit-tree queries (no whole-directory `ls-tree`). Regression test G1-flat (or a small-cap variant) with a v1 assertion.
3. NB-6: case-folded index link detection at stage time (`:(icase)`), consistent with the describer. Regression test CI-lm (v2 completes; v1 refused per CD-17).

Minor (non-blocking):
1. m-4 residual: one wording source for entry skips. B3/C3 on reuse should record the M-6 omission (the describer derives it only for a `CLAUDE.md` target); fresh and history records should use the same text (W-B1).
2. J-docs permanence: the fail-closed pause outlives the tampering, because the landed STATE-less commit is reused by key (J-docs-recover). Fail closed before committing, when a stage-time STATE.md skip has no index or tree backing, so that a resume after repair commits fresh.
3. The D1 asymmetry: an entry skip under an out-of-band junction is accepted, while STATE.md pauses (tampering-only).
4. `indexEntryModes([target])` passes a user-controlled link target as a pathspec, so glob characters are live. A committed link to, for example, `docs/generated/*` would list that whole directory (the NB-5 class, contrived). Use `:(literal)`.
5. The spec-copy facts sit outside the describer (outcome-neutral).
6. M-7: `git add -f` for the evidence files.

Escalate (pre-existing, not C2c): the F-matrix non-link layouts (a shared fix with NB-6 is possible); the 4 MiB cap in the project handoff apply for large trees (G1, G1-control, G1-flat-control); the process-launch and PowerShell-probe transients under load.
