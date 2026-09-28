# C2c - independent code re-review r4

Reviewer: fresh-context independent re-reviewer (round 4). I did not write this code and did not do rounds 1 to 3. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `7eb31177`; C2c uncommitted.
Inputs: `C2c-review-r3.md` (NB-4, NB-5, NB-6, m-4 partial, follow-ups), `C2c.md` "Repair cycle 3 (controller)", plan CD-4, CD-15 and CD-17, and the controller's repair script and prove-red script.

The reviewed bytes match the cycle-3 evidence: scheduler-store `abe0dfc9`, integration-manager `e0c8fb79` (sha256 prefixes). build-runtime `a85a24c5`, project-docs `205421e1` and project-doc-commit test `ed3f622c` are unchanged since round 3. The docs-policy-v2-handoff test is `5a5e0b65`. All of these were the same at the end of the review. I edited no source or test file. Every probe ran from test files in my scratchpad that import the worktree modules by absolute URL. Every fixture lives under the system temp directory, and each "outside" directory is inside that fixture root. No leftover fixtures remain. As instructed, I did not run the docs-policy-v2-handoff suite.

**Verdict: REPAIR — 3 blocking**

Cycle 3 fixes the three round-3 failures exactly as specified. DUP-A4, DUP-A4-retry, W-A4, W-S1, W-CI, G1-flat and CI-lm all now complete (or commit) through the production manager and the factory-built port. The relaxed reducer accepts no false record (J-docs-dup fails closed), and v1 behaves as at HEAD apart from the declared refusals. However, the two new mechanisms each open a stuck run of their own, and one C2c-reachable layout was never probed:
- **NB-7 (fix delta of NB-5)**: `caseFoldedWorktreeNames` gets the committed spelling from the *current worktree*. When the worktree no longer holds that spelling, the walk misses a committed `Docs` link. The withdrawn-stop reconciliation then fails on every attempt.
- **NB-8 (fix delta of NB-6)**: `:(icase)` in `indexEntryModes` also feeds `isEntryLinkRedirectTarget`. A link whose target differs in case from the tracked file (`AGENTS.md -> notes.md`, tracked `NOTES.md`) is now redirected, and `git commit -- notes.md` then fails on every attempt. At round-3 bytes the same layout was skipped with a reason and completed.
- **NB-9 (already-reviewed code, reachable only through C2c's CD-17 skip)**: when every handoff write is skipped (a docs link together with both entry files linked elsewhere), `commitHandoffSnapshot` throws `Project document commit wrote nothing` on every attempt. CD-15 and CD-17 say each of those skips is accepted and the handoff proceeds.

Each is a stuck run backed by a failing probe (the CD-4 late-finding rule). NB-7 and NB-8 each have a passing control at round-3 bytes.

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| NB-7 (stuck run; new in cycle 3) | `integration-manager.ts:2349-2356` (`commitStateLinkComponents`) and `2392-2399` (`caseFoldedWorktreeNames`). When the exact name is not in the commit tree, the other spellings come from `readdir` of the **live worktree**, not from the commit. The withdrawn-stop path (`build-runtime.ts:2726-2737`) describes an **older** commit. If the worktree changed since then, the committed `Docs` link is invisible: `dirLinks` is empty, then `holds no verifiable STATE.md`, then a throw, then a pause before the current stop commits. Resume re-walks the same way. | **W-CI-rm**: a finish run whose checkout has a committed `Docs` real link to an outside directory. Stop 1's commit lands (tree: `120000 Docs`, no STATE.md), then the read fails. Guidance withdraws the handoff. A later integration commit removes `Docs` (`git rm`). FV re-runs, and the Architect re-requests. **W-CI-mv**: the same, but `Docs` is replaced by a real `docs/` directory. | The withdrawn stop-1 record carries the tree-derived `docs` reason (as W-CI and W-A4 do), stop 2 commits, and the run hands off. | W-CI-rm and W-CI-mv: stop 2 and both resumes pause with `withdrawn-stop reconciliation failed for stop 15: commit … holds no verifiable STATE.md.`. There are 0 snapshots, the owner is refused, and outside holds only `own.txt`. **Controls:** W-A4-rm (exact `docs` link, removed the same way) reconciles, and stop 2 commits STATE.md (2 snapshots). W-CI-rm with the round-3 whole-listing walk monkeypatched in also reconciles (2 snapshots). The final selection in both controls is refused only because the probe moved HEAD without recording an integration revision (a harness artifact that is the same in both). | Query the commit tree, never the worktree, for the other spellings, and keep it bounded. `git ls-tree` rejects `:(icase)` (`pathspec magic not supported`), but it accepts many names in one call. One `ls-tree <treeRef> -- <every case permutation of the name>` per level (16 for `docs`, 128 for `project`, 128 for `STATE.md`) returns at most that many lines. Add W-CI-rm as a regression test. |
| NB-8 (stuck run; new in cycle 3) | `integration-manager.ts:2651-2669`: under `:(icase)` a case-variant entry is keyed by the **requested** spelling. `isEntryLinkRedirectTarget` (`2601-2603`) therefore accepts target `notes.md` when the index holds `NOTES.md`. `lstat("notes.md")` succeeds on the case-insensitive checkout. The splice then writes into `NOTES.md`. `git add -- notes.md` exits 0 but stages nothing, and `git commit … -- … notes.md` fails with `pathspec 'notes.md' did not match any file(s) known to git` (confirmed in a scratch repository). The catch runs `reset --hard`, and the next attempt repeats. | **RD-case**: tracked `NOTES.md`, and `AGENTS.md` is a link-mode entry (core.symlinks=false) whose target text is `notes.md`. **RD-case-real**: the same with a real link. Such a link works for the user on Windows or macOS, so nothing prompts them to fix it. | The run hands off (at round-3 bytes the redirect was refused and AGENTS.md skipped with a reason, which CD-15 accepts). | 0 snapshots, 3 of 3 attempts pause with `git commit --allow-empty … -- docs/project/STATE.md …`, and the owner is refused. No data loss: status is clean, and HEAD `NOTES.md` is untouched. **Controls:** RD-control (target spelled `NOTES.md`) redirects and completes. **RD-case with the round-3 `indexEntryModes` monkeypatched in** completes, with `AGENTS.md … skipped (target notes.md is not a regular tracked file)`. | Fold case only for link detection (`firstLinkComponent`, `entryLinkRawTarget`, `indexClaudeLinksAgents`). For a redirect target, require the index entry's own spelling to equal the target (return the real `entryPath` from `indexEntryModes`), or redirect to the index spelling and commit that path. Add RD-case as a regression test. |
| NB-9 (stuck run; already-reviewed code, allowed: critical and backed by a failing probe) | `integration-manager.ts:695-697`: `if (paths.length === 0) throw "Project document commit wrote nothing"`. This throw predates C2c. Before C2c, a docs link refused the whole commit anyway, so the throw was unreachable for these layouts. CD-17's STATE.md skip makes "every write skipped" reachable. | **ALL-SKIP**: `docs` is a real link to outside, `AGENTS.md` a link-mode entry to `MISSING.md`, and `CLAUDE.md` a link-mode entry to `AGENTS.md`. **ALL-SKIP-out**: `docs` a link-mode entry to outside, and both entry files link-mode entries to outside files. | Every skip carries a commit-tree-corroborated reason (CD-15 for each entry file, CD-17 for STATE.md), and the handoff proceeds, as in DUP-A4. | 0 snapshots, 3 of 3 attempts pause with `Project document commit wrote nothing: docs/project/STATE.md is not written: docs is a symbolic link…`, and the owner is refused. No commit is made. Outside is unchanged. | On the kernel path, when every write is skipped with a recorded reason, make the empty snapshot commit (the `paths: []` shape the NB-4 reducer now accepts). Make sure nothing else is staged: commit only when the index is clean, or build the commit from `HEAD^{tree}`. The describer and the gate then judge from the tree. Keep the throw for v1. Add ALL-SKIP as a regression test. |

## Resolution of round-3 items

Every row is proven through the factory-built docs port, the production `NativeBuildManager`, and real SQLite and git.

| Item | Status | Proof |
|---|---|---|
| NB-4 (empty snapshot commit refused) | **RESOLVED** | DUP-A4: 1 snapshot, `paths: []`, a tree-derived `docs` reason, `bodyDigest ""`, completed, outside `own.txt` only. DUP-A4-retry: the first activation records the snapshot; re-activations are idle with 0 pump errors; resume is correctly refused ("awaiting … handoff selection"); selection completes. W-A4, W-CI and W-S1: stop 2's empty commit (`paths: []`) is recorded, chained to stop 1's history record, and the run completes (`apply_to_project`, physical 1). CI-lm-dup and S1-dup (new: empty commit with a `Docs` link-mode entry, and with a STATE.md link): completed with the correct reason. |
| NB-4 relaxation, false-acceptance check | **HOLDS** | J-docs-dup (new: an out-of-band junction the tree never held, entry files already current, so the commit is empty): 0 snapshots and a fail-closed pause `commit … holds no docs/project/STATE.md` on 3 of 3 attempts. The owner is refused. The reducer is runner-only (`actor.role === "runner"`), and the runtime derives `stateSkippedReason` only from the commit tree (`dirLinks`). |
| NB-5 (whole-parent `ls-tree`) | **RESOLVED** for its input; **the fix introduces NB-7** | G1-flat: the snapshot commits (paths `AGENTS.md`, `CLAUDE.md`, `STATE.md`), v1 commits `de3cc233`, and the same-request retry returns `de3cc233`. G1-flat-control commits. The selection refusal in G1-flat is the pre-existing 4 MiB cap in `applyToProject` (as in round 3's G1 and G1-control). |
| NB-6 (exact-case stage-time index) | **RESOLVED** for its input; **the fix introduces NB-8** | CI-lm: 1 snapshot, the `docs` reason, completed, outside `own.txt`. v1 gives the declared refusal `… refused because docs is a symbolic link or junction.`, with outside unchanged. |
| m-4 residual (wording) | **OPEN** (deferred by the controller; unchanged code) | Not re-verified. The outcome is correct. |
| Round-3 follow-up: route a refused append through `pauseForHandoffSnapshotFailure` | **NOT DONE** (optional) | See minor m-7. |
| Round-3 follow-up: a second-stop regression test | **NOT DONE** | Only DUP-A4 was added. W-A4, W-CI and W-S1 now pass as probes only. See m-8. |
| Controller tests and prove-red | **CONFIRMED** | "C2c round 3/probe DUP-A4", "G1-flat" and "CI-lm" assert the right facts (paths `[]` and the reason; 1 snapshot plus a returned v1 commit; the reason plus the declared v1 refusal). The prove-red restore hashes (`abe0dfc9`, `e0c8fb79`) equal the current bytes. |

## Fix-delta answers (brief item 2)

- **Can the relaxed reducer accept a record it should not?** No false acceptance was observed. The reducer cannot see the tree, so it relies on the runner-only actor and on the runtime's describer, which sets `stateSkippedReason` only from `dirLinks` (the commit tree). An empty commit whose STATE.md skip the tree does not back pauses fail-closed (J-docs-dup). An empty commit "when STATE.md should have been written" can arise only from a stage-time skip without tree backing, which is the same fail-closed pause. The reducer does still accept `paths` holding STATE.md together with a skip reason. The runtime never emits that (the reason is set only when `!stateChanged`), and this is unchanged since round 2.
- **Is `caseFoldedWorktreeNames` safe when the worktree and the commit disagree?** No. A spelling present only in the commit is missed (NB-7). A spelling present only in the worktree is harmless: each candidate is queried exactly against the commit tree, so a link is reported only when the commit holds it. There is no false positive. It is bounded in git output (one exact query per candidate, and a case-insensitive directory holds at most one variant). It reads a directory listing through an out-of-band junction (names only, never written), which becomes moot with the NB-7 fix.
- **Does `:(icase)` change v1 or exact-case repositories?** On a case-sensitive checkout the code is byte-equivalent to round 3: the same pathspec, and the same keying because `entryPath === path`. That checkout could not be exercised here (every checkout on this machine is case-insensitive). On a case-insensitive checkout with exact-case entries the result is identical, since only case-variant entries change the map. v1: the V1 matrix is unchanged (4 refusals, plain commits `[AGENTS.md, docs/project/STATE.md]`), CI-lm v1 gives the declared CD-17 refusal instead of `ENOTDIR`, and G1-flat v1 commits. v1 refuses every entry link, so NB-8 is v2-only. On the kernel path, `:(icase)` changes redirect decisions for case-variant targets (NB-8).

## Safety invariants (brief item 3)

- **Nothing is written outside the repository**: holds in every probe. Outside holds only `own.txt` (plus `a.md` and `c.md`, which the ALL-SKIP-out probe itself placed there). `shared.txt` has the same hash in every plan-only probe, including S1-dup.
- **No layout leaves a run unable to hand off**: violated by NB-7, NB-8 and NB-9. The F-matrix and DOCS-dir (below) are pre-existing.
- **The gate accepts a skip only with commit-tree backing**: yes (J-docs-dup). No false acceptance was observed.
- **v1 unchanged except the declared refusals**: yes (see above).
- `git diff --check` is clean. Encoding: no BOM; project-docs.ts is CRLF only; the other changed files are LF only. The runner tsc and eslint runs are the controller's and were not repeated (the no-duplicate rule).

## Probes

Scratch files in `…\scratchpad\r4c2c\`: `r3-a` to `r3-e` (the round-3 probes, re-run unchanged), `r4-new`, `r4-b` (a corrected withdrawn-change harness, plus round-3-bytes emulation by prototype monkeypatch in the probe process only), `r4-c`, and `r2/re-r2-p2a` and `r2/re-r2-p2b2`, with their logs. No "Process launch was not proven" transient appeared this round.

| Probe | Result |
|---|---|
| DUP-A4 / DUP-A4-retry | completed; `paths: []`, reason from the tree; no pump error (NB-4 resolved) |
| W-A4 / W-S1 / W-CI | history record correct; stop 2's empty commit recorded; completed |
| G1-flat / G1-flat-control | snapshot commits; v1 commits and its retry returns the same commit (NB-5 resolved) |
| CI-lm | completed; v1 gives the declared refusal (NB-6 resolved) |
| J-docs-dup (new) | fail-closed pause, owner refused, 0 snapshots: **no false acceptance** |
| CI-lm-dup / S1-dup (new) | empty commit, reason recorded, completed |
| **ALL-SKIP / ALL-SKIP-out (new)** | **stuck on 3 of 3 attempts: `Project document commit wrote nothing` (NB-9)** |
| **RD-case / RD-case-real (new)** | **stuck on 3 of 3 attempts: `git commit … -- notes.md` pathspec error (NB-8)** |
| RD-control / RD-case@round3-indexEntryModes | completed (redirect / skip with a reason) |
| **W-CI-rm / W-CI-mv (new)** | **stuck: `withdrawn-stop reconciliation failed … holds no verifiable STATE.md` on stop 2 and 2 resumes (NB-7)** |
| W-A4-rm (control) / W-CI-rm@round3-walk | reconciled, 2 snapshots (selection refused only by the probe's unrecorded HEAD move) |
| V1 matrix; C3, L2-real, C12, C-regress (C1, C2, C4, C5, C8) | unchanged from round 3; all completed |
| DOCS-dir (new, pre-existing) | stuck on 3 of 3 attempts: `git commit … -- docs/project/STATE.md` pathspec error (see Escalate) |

## Follow-up list

Blocking (this repair):
1. NB-7: find the other spellings in the commit tree (bounded multi-name `ls-tree`), never from the worktree. Regression test: W-CI-rm.
2. NB-8: fold case for link detection only, and require the index's own spelling for a redirect target (or redirect to that spelling). Regression test: RD-case.
3. NB-9: when every kernel write is skipped with a recorded reason, make an empty snapshot commit (clean index). v1 keeps the throw. Regression test: ALL-SKIP.

Minor (non-blocking):
1. m-7: a snapshot append the reducer refuses is still a pump error (`build-runtime.ts:2546` sits outside the failure-pause wrapper), so any future runtime/reducer disagreement wedges silently. Route it through `pauseForHandoffSnapshotFailure`.
2. m-8: add one second-stop (withdrawn) regression test for the empty commit (W-A4 or W-CI). Today these pass only as probes.
3. m-4 residual wording (B3 reuse, W-B1): still open.
4. J-docs permanence: unchanged. J-docs-dup shows that the empty-commit variant is equally permanent (the landed commit is reused by key).
5. `indexEntryModes`: when two index entries fold to the same name (a colliding repository on a case-insensitive checkout), the last one wins. Link-target pathspecs still interpret glob characters (round-3 minor 4, use `:(literal)`, combinable with `icase`).
6. The D1 asymmetry and spec facts outside the describer (round-3 minors 3 and 5); M-7 `git add -f` for the evidence files.

Escalate (pre-existing, not C2c; must close before T7a stamps docs v2):
1. **Case-variant real paths on a case-insensitive checkout** make the kernel and v1 commit's exact pathspec match nothing. The layouts are a regular capital `Docs/` directory (DOCS-dir probe: stuck on 3 of 3 attempts; git stores `Docs/project/STATE.md` and the commit's `-- docs/project/STATE.md` fails) and a lowercase `agents.md` or `claude.md`. A capital `Docs/` folder is common on Windows and macOS. The fix is the same shape as NB-8: commit the index's own spelling.
2. The F-matrix non-link layouts; the 4 MiB cap in `applyToProject` for large trees (G1-flat selection).
