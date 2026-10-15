# C2c - independent code re-review r5

Reviewer: fresh-context independent re-reviewer (round 5). I did not write this code and did not do rounds 1 to 4. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `7eb31177`; C2c uncommitted.
Inputs: `C2c-review-r4.md` (NB-7, NB-8, NB-9, minors, escalations), `C2c.md` "Repair cycle 3 (controller)" and "Repair cycle 4 (Muse, lane A)", plan CD-4, CD-15, CD-17 and the C2c contract, and the r4 scratch probes (`…\scratchpad\r4c2c\`).

Byte hashes (sha256), the same at the start and at the end of the review:

| File | sha256 |
|---|---|
| `runner-v2/src/integration-manager.ts` | `717dcce99510a530c31a0aa426389d8a7f63dc20a6cb586b0f6a5af8c1ff8b32` |
| `runner-v2/test/docs-policy-v2-handoff.test.ts` | `2e92648354ba0f4524eef5c6a6e77665e0f332675ba367c234489d7fd0d0b34e` |
| `runner-v2/src/scheduler-store.ts` | `abe0dfc967c6ed50d976ec0b6788d683f6feccca60ba5587ffdf60c94155e5ba` |
| `runner-v2/src/build-runtime.ts` | `a85a24c540e2b0b12519812014afc444d46a8a6d716d411dd1af554aec1061b2` |
| `runner-v2/src/project-docs.ts` | `205421e1759b67a66fae0322dfd4f988a3be8504abcfec3f560d15040eca93a2` |
| `runner-v2/src/native-build-factory.ts` | `1980602e6e15608c820e50febd0f03498897ec5b09bc453f28ab55348df78daa` |

I edited no source or test file. I did not commit, stage, stash or push. Every probe is a test file in my scratch folder (`…\scratchpad\r5c2c\`) that imports the worktree modules by absolute file URL. Round-3 behavior was emulated only by a prototype patch inside the probe process. Every fixture was under the system temp directory, each "outside" directory was inside its fixture root, and none of my fixtures remain. As instructed, I did not run the whole docs-policy-v2-handoff file or any native-delivery file. No "Process launch was not proven" transient appeared.

**Verdict: ACCEPT**

The three r4 blocking findings are fixed for the general case, not only for the named probes. Each is proven through the production `NativeBuildManager`, the factory-built docs port (the real execution-host git path), real SQLite and real git:
- **NB-7**: the case-folded walk now reads only the commit. A withdrawn stop whose commit holds a case-variant link at any level (`Docs`, `docs/Project`, `docs/project/state.md`) is reconciled after the worktree drops that spelling, and the run completes. The 16-variant and the 128-variant `ls-tree` both work through the real git path.
- **NB-8**: a redirect target resolves only by the index's own spelling. The case-variant link is skipped with a reason and the run completes. The exact-spelling control still redirects. The CD-17 check still catches a committed `Docs` link.
- **NB-9**: when every write is skipped, the kernel makes an empty commit with every runner trailer. Nothing else can enter it. The gate accepts it, a crash between commit and event is recovered by key, and v1 keeps its refusal.

There is no false acceptance, nothing is written outside the repository, and v1 is unchanged. The new findings below are all non-blocking. The most important is T-1: the two NB-7 regression tests do not use the factory-built port, and the evidence says they do. My factory-port versions of the same flow pass, so the fix is proven; the test shape and the evidence sentence still need correcting.

## Findings (all non-blocking)

| # | Location | Probe | Expected | Actual / controls | Fix suggestion |
|---|---|---|---|---|---|
| T-1 (test shape; evidence accuracy) | `docs-policy-v2-handoff.test.ts:5502-5649` (`driveWithdrawnDocsLinkScenario`) | Read of the helper; timing (7 s against 350 s); F-W-CI-rm and F-W-CI-mv | The C2c contract and the file's own rule (`:690-698`): regression tests go through the production manager **and the factory-built port**. `C2c.md` cycle 4 says "All production flow through NativeBuildManager with the docs port NativeBuildFactory builds". | W-CI-rm and W-CI-mv use `openGitRepo` and the hand-built `gitDocsPort` around the fixture `IntegrationManager`. Git runs through `spawnSync`, not the execution host and the Runner Git policy, and `relateRevision` is stubbed. That is why they take 7 s. They do drive the production `NativeBuildManager`, and they do exercise the withdrawn-stop reconciliation of a commit whose `Docs` spelling is gone (prove-red below). **Control:** the same flow through `openFactoryPort` (F-W-CI-rm, F-W-CI-mv) completes with the same facts. | Correct the evidence sentence. Then either move W-CI-rm onto `openFactoryPort` (the F-W-CI-rm shape in my scratch file) or record the exception in the evidence. TX-2's handoff harness with the factory-built port is the natural home. |
| m-9 (fix-delta regression; colliding repositories only) | `integration-manager.ts:2439-2456` (`commitTreeEntryFolded` returns the first matching line) | **F-collide**: the commit tree holds both a `Docs` link and a `DOCS/project/keep.md` tree | Consistent with the stage-time check, which sees the `Docs` link and skips STATE.md | The walk takes `DOCS` (it sorts first) and finds no link. `dirLinks` is empty, and the run pauses fail-closed on 3 of 3 attempts (`commit … holds no docs/project/STATE.md`). The owner is refused, and nothing is written outside. **Control:** the same layout with the cycle-3 worktree walk completes (1 snapshot, the `docs` reason). The round-2 whole-listing walk also took the first match. | Non-blocking: git itself cannot check out such a tree on a case-insensitive filesystem (it reports a path collision), r4 filed colliding repositories as minor, and the outcome is fail-closed. If the owner reads CD-15 as covering these repositories, the fix is two lines: among the matched lines, prefer a `120000` entry. |
| m-10 (escalation class; reachable in a new way) | `integration-manager.ts:2617-2630` (`entryLinkRawTarget` folds case and now reads the blob by the index's spelling) | **F-LC-agents**: a lowercase `agents.md` link-mode entry to a tracked `NOTES.md` | The r4 escalation: lowercase entry files are pre-existing and open | The run is stuck: 3 of 3 attempts pause with `lacks the v2 AGENTS.md section or the CLAUDE.md line`, and the owner is refused. The commit now also holds the AIBoard section written into `NOTES.md`. At cycle 3 the blob read missed, so the entry was skipped without a write, and the run was stuck in the same way (the commit tree has no `AGENTS.md`). The write stays on the integration branch, and no project is mutated. | Fold this into the escalation fix (commit the index's own spelling, or treat a case-variant entry file as absent). |
| m-11 (wording) | `integration-manager.ts:705-708` | **D-allskip-dirtyindex**: an unrelated file staged in the integration index | Fail closed, commit nothing | It fails closed correctly: HEAD is unchanged, and the staged file is neither committed nor unstaged. But the message is `Project document commit wrote nothing: …`, which hides the real cause. | Say that the integration index is not clean. |

## Resolution of round-4 items

| Item | Status | Proof |
|---|---|---|
| NB-7 (other spellings came from the live worktree) | **RESOLVED** | Direct lookup of the old commit after the worktree lost the spelling gives the right `dirLinks` for `Docs` removed, `Docs` replaced by a real `docs/`, `docs/Project` (level 2), `docs/project/state.md` (level 3) and `DOCS/PROJECT/State.Md` (all three levels). The cycle-3 walk returns `[]` for each (control). Through the factory port and the production manager, F-W-CI-rm, F-W-CI-mv, F-W-Proj-rm and F-W-state-rm all complete. In each, the stop-1 history record carries the tree-derived reason, stop 2 commits STATE.md on the recorded revision, the choice is `apply_to_project` with one physical apply, and outside holds only `own.txt`. The r4 originals (raw HEAD move) now reconcile too (2 snapshots, like the W-A4-rm control). All three refuse the final selection for the same harness reason as in r4. |
| NB-8 (`:(icase)` fed the redirect decision) | **RESOLVED** | R4 RD-case and RD-case-real complete with `AGENTS.md … skipped (target notes.md is not a regular tracked file)`. `NOTES.md` is never written. D-rd-dircase (`Docs/notes.md` against a tracked `docs/notes.md`) is skipped the same way. The R4 RD-control and D-rd-control exact spelling still redirect into `NOTES.md` and complete. D-cilm and R4 CI-lm-dup show the CD-17 check still catches a committed `Docs` link-mode entry. |
| NB-9 (every write skipped threw) | **RESOLVED** | R4 ALL-SKIP and ALL-SKIP-out complete with 1 snapshot, `paths: []` and every reason. Directly, D-allskip and D-allskip-spec (a spec copy also skipped) show that the commit's tree equals its parent's and that the commit carries every runner trailer. A second call reuses the commit with no new commit, and the lookup finds it. F-ALL-SKIP-reuse (the read-back fails once after the empty commit, then a resume) makes exactly one kernel commit, reuses it by key, records 1 snapshot and completes. D-allskip-unstaged: an unstaged edit and an untracked file stay out of the commit and remain in the worktree. D-allskip-dirtyindex fails closed (m-11). v1: D-v1-allskip and the V1 matrix give the declared refusals. A plain v1 commit is unchanged. `commitProjectDocuments` is byte-identical to HEAD. |
| m-7, m-8, m-4 residual, J-docs permanence, the F-matrix, the 4 MiB cap, DOCS-dir case-variant real paths | **OPEN** (known; not made worse except as in m-10) | F-ALL-SKIP-reuse shows the m-4 reuse wording again (`the target holds no marked section` against the fresh `not a regular tracked file`). F-J-ALL-SKIP: an out-of-band junction with both entry files linked elsewhere now lands an empty commit and then pauses fail-closed on every attempt. That is the same J-docs permanence as J-docs-dup, which also still fails closed. D-walk-projdir: a real `docs/Project/` directory fails on the `git commit … -- docs/project/STATE.md` pathspec. That is the DOCS-dir escalation one level down, unchanged by cycle 4. The stop-1 pump error `The kernel handoff snapshot is required for the handed-off revision.` appears in every withdrawn probe and control, as in r4. |

## Brief questions

- **Bounded, commit-only walk (NB-7).** There is one `ls-tree <treeRef> -- <variants>` call per level: 16 variants for `docs`, 128 for `project` and 128 for `STATE.md`. The output holds only the matching entries, and nothing reads the worktree. `ls-tree` pathspecs are literal, so the fixed names cannot glob. The walk runs only on a case-insensitive checkout and only after the exact query misses. The 128-variant call passes the Runner Git policy and the execution host (F-W-Proj-rm, F-W-state-rm). A name with no letters cannot occur, because the three parts are constants. By inspection, `caseVariants` would return the name alone, which is one harmless repeat of the exact query. The reuse path in `commitHandoffSnapshot` and the withdrawn-stop lookup both use the same `documentCommitResult`.
- **Case folding only for link detection (NB-8).** `indexEntryModes` keys entries by the index's spelling. `findIndexEntry` folds only when asked, and `isEntryLinkRedirectTarget` asks for the exact spelling. Colliding entries: D-rd-collide (tracked `NOTES.md` and `notes.md`) redirects into the exact `notes.md`. On disk there is one file, holding `NOTES.md`'s bytes, so the commit replaces `notes.md`'s bytes with `NOTES.md`'s bytes plus the section, and the worktree is left with ` M NOTES.md`. This is the same at round-2 and round-3 bytes (pre-existing, colliding repositories only; see follow-up 4). For colliding trees in the walk, see m-9.
- **Empty kernel commit (NB-9).** It is made only when nothing is staged, which means every write was skipped with a recorded reason (a redirect always stages its target). It also requires `git diff --cached --quiet` to report a clean index. It commits the index as-is, so its tree equals HEAD's. Hooks are off (`core.hooksPath=` in the Runner Git policy). The reducer accepts `paths: []` only with a tree-derived `stateSkippedReason`. When there is no tree link, the gate pauses fail-closed (F-J-ALL-SKIP, J-docs-dup). `applyToProject` carries a diff, so an empty commit adds nothing there.
- **Test shape (brief item 3).** See T-1 for the port. Recording the later `Docs` change as `integration.revision_advanced` with FV re-run on it is the faithful shape: in production the integration branch moves only through a recorded integration, and a raw HEAD move is not a production state. Two small inaccuracies remain. First, a raw move does not "dangle the document chain": r4's raw-move probes and mine record both snapshots, and the refusal comes at the final selection (FV is on the pre-move revision). Second, the worker's helper seeds the baseline as the integration revision while the `Docs` link commit sits unrecorded on top. That is the same kind of unrecorded move at setup, though it does not affect what the test asserts.
- **Prove-reds (brief item 4).** I repeated the NB-7 one without touching any file. A copy of the handoff test file in my scratch folder, run with the verbatim cycle-3 worktree walk patched in, gives red on both W-CI-rm and W-CI-mv (`actual: 0, expected: 2` snapshots). Unpatched, both are green (7.2 s and 7.0 s). The NB-8 and NB-9 prove-reds are meaningful by construction. RD-case and ALL-SKIP assert 1 snapshot, and r4's probes of the old code recorded 0 snapshots on those exact layouts.
- **Minors and escalations (brief item 5).** Cycle 4 does not make m-7, m-8, the F-matrix or the 4 MiB cap reachable in a new way. The lowercase entry-file escalation is reachable in a new way (m-10). DOCS-dir case-variant real paths are unchanged (D-walk-projdir).

## Safety invariants

- **Nothing is written outside the repository.** This holds in every probe: outside holds only `own.txt`, plus the `a.md` and `c.md` that ALL-SKIP-out itself placed there. `shared.txt` has the same hash in every plan-only probe.
- **No layout leaves a run unable to hand off.** This holds for every r4 layout and every new case-variant layout. The exceptions are m-9 (colliding trees, new against cycle 3), m-10 (the lowercase entry file, pre-existing) and the known escalations. All of them fail closed.
- **The gate accepts a skip only with commit-tree backing.** Yes: F-J-ALL-SKIP, J-docs-dup and F-collide all pause fail-closed.
- **v1 is unchanged except for the declared refusals.** Yes: the V1 matrix, D-v1-allskip, and the byte-identical `commitProjectDocuments`.
- `git diff --check` is clean. Both cycle-4 files are LF only with no BOM. tsc, eslint and the suites are the worker's and the controller's runs, and I did not repeat them (the no-duplicate rule).

## Probes

Files in `…\scratchpad\r5c2c\`: `r5.test.ts` (the r4 helpers plus `r5part.ts`), `r4rerun.test.ts` (r4's probe file, unchanged), `worker-copy.test.ts` (the handoff test file with absolute imports, plus an opt-in cycle-3 walk patch), and `v1matrix.test.ts`. Logs: `d.log`, `p1.log` to `p7.log`, `pr-wci-*.log` and `v1.log`.

| Probe | Result |
|---|---|
| worker W-CI-rm / W-CI-mv (copy), unpatched / cycle-3 walk | green (7 s) / **red** `actual: 0, expected: 2`: the prove-red is meaningful |
| D-walk-Docs-rm, -Docs-mv, -Project-rm, -state-rm, -ALLCAPS-rm | the old commit keeps its link fact after the spelling is gone; the cycle-3 walk gives `[]` (control) |
| D-walk-control | no link: STATE.md committed, no `dirLinks` |
| F-W-CI-rm, F-W-CI-mv, F-W-Proj-rm, F-W-state-rm (factory port) | completed: 2 snapshots, reason from the tree, stop 2 on the recorded revision, 1 physical apply |
| R4 W-CI-rm, W-CI-mv, W-A4-rm (r4 originals) | stop 2 reconciles (2 snapshots) in all three; the same harness refusal at selection in all three |
| R4 RD-case, RD-case-real; D-rd-case, D-rd-dircase | skipped with a reason; target never written; completed |
| R4 RD-control; D-rd-control | redirect into `NOTES.md`; completed |
| D-cilm; R4 CI-lm-dup, S1-dup | CD-17 link caught; completed with the reason |
| R4 ALL-SKIP, ALL-SKIP-out; D-allskip, D-allskip-spec | empty commit, tree equals parent, runner trailers, reused on retry; completed |
| F-ALL-SKIP-reuse | one kernel commit, reused after the read failure, 1 snapshot, completed |
| D-allskip-unstaged / D-allskip-dirtyindex | nothing unrelated committed / fail-closed throw (m-11) |
| D-v1-allskip; V1 matrix | declared refusals; plain v1 commit unchanged |
| R4 J-docs-dup; F-J-ALL-SKIP | fail-closed on 3 of 3 attempts, owner refused: **no false acceptance** |
| **F-collide / F-collide@cycle3-walk** | **stuck on 3 of 3 attempts / completed (m-9)** |
| F-LC-agents; D-rd-lcagents | stuck, section written into `NOTES.md` on the integration branch (m-10, escalation) |
| D-rd-collide; D-walk-projdir | pre-existing colliding-notes substitution; pre-existing DOCS-dir pathspec failure |

## Follow-up list

Blocking: none.

Minor (non-blocking):
1. T-1: correct the `C2c.md` cycle-4 sentence claiming the factory port for all tests. Move W-CI-rm onto `openFactoryPort`, or record the exception. Optionally align the helper's seed with the `Docs` link commit.
2. m-9: in `commitTreeEntryFolded`, prefer a `120000` line among the folded matches, so a colliding tree agrees with the stage-time check.
3. m-11: name the unclean index in the empty-commit refusal.
4. Colliding `NOTES.md`/`notes.md` redirect (pre-existing): the commit replaces `notes.md`'s bytes with the on-disk file's bytes. Refuse a redirect whose target collides case-insensitively with another index entry.
5. Still open from r4: m-7 (a refused append is a pump error), m-8 (a second-stop test is now partly covered by W-CI; there is none for W-A4 or W-S1), m-4 reuse wording, J-docs permanence (now also through an empty commit), the D1 asymmetry, and M-7 `git add -f`.

Escalate (pre-existing, not C2c; must close before T7a stamps docs v2):
1. Case-variant real paths on a case-insensitive checkout: a capital `Docs/` directory, `docs/Project/` (D-walk-projdir), and lowercase `agents.md` or `claude.md`. The lowercase entry file now fails after writing the section into its link target (m-10). The fix has the same shape for all: commit the index's own spelling.
2. The F-matrix non-link layouts; the 4 MiB cap in `applyToProject`.
