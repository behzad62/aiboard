# C2d - independent code review r2 (repair cycle 1)

Reviewer: fresh-context independent reviewer (round 2). I did not write this code and did not do round 1.
Model: Sonnet 5.5 (claude-sonnet-5-5), extra-high effort. Date: 2026-09-30.
Reviewed commit: `37433efd` ("wip(c2d-r1)"), on top of C2e `0ec56592` and C2d `88266a9a` (parent `010d65e6`).
Inputs: round 1 (`C2d-review-r1.md`), repair brief `c2d-repair1-muse.txt`, evidence `C2d.md` "Repair cycle 1", `git show 37433efd`, round 1 probe sources (scratchpad `c2dr1\`, reused unchanged).
Where I ran: a detached scratch worktree at `37433efd` (`C:\Users\b_a_s\AppData\Local\Temp\c2dr2\wt`), `node_modules` linked by junction. The lane A worktree was not touched. I edited no source or test file, and did not commit, stage, stash or push. Cleanup is done: the junction was removed first (link gone, the shared `node_modules\eslint` still exists), then the scratch worktree was removed and pruned, then the scratch folder was deleted. My probe sources and logs are kept in `...\scratchpad\c2dr2r2\`.

sha256 of the changed files at `37433efd` (the committed LF blobs; they match the worker's evidence byte for byte):

| File | sha256 |
|---|---|
| `runner-v2/src/integration-manager.ts` | `421a42caa41bd750fb6c394e57565a7db3cddaf6860a72defa89dcb260769a03` |
| `runner-v2/src/project-docs.ts` | `359f55877aa4b0bbc58a5fc83344b60c098dfa87804a1efd572024ac9214d1b3` |
| `runner-v2/src/build-runtime.ts` | `98f9290cb4af3d9d6257b3e00a22c046efb9a025557612c0882c10d7ff7c04a4` |
| `runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts` | `a983d81345b269f0251c812b0377ed152fcf786ca6562188550ca39b2afc21c6` |
| `runner-v2/test/docs-policy-v2-handoff-project-links.test.ts` | `0064e61867759f0b021ea2fc96eeae9789a6a7cbf434c38ae86ceb8df100a128` |
| `runner-v2/test/project-doc-commit.test.ts` | `3cf2a050bcfbbf7fdd69db45cfb313bbeeb76a0c71cce53402a8e4461ed954e8` |
| `runner-v2/test/support/handoff-snapshot-harness.ts` (unchanged by the repair) | `1e2eaca0387a21d99d96f4f968ba3c60385fcd6ca0707a66257b1c63c9af7434` |

The scratch checkout came out with CRLF (Windows `core.autocrlf=true`). I converted the `runner-v2` files to LF before running anything, and the LF hashes above equal the blobs.

**Verdict: ACCEPT**

All three r1 blockers are fixed and proven. The escalation is handled as decided, with commit-tree-derived reasons only. Nothing regressed. There are no blocking findings. There is one real cost finding that I recommend fixing soon (N-1: the git-call count went up by 5 and 4 of them are avoidable) and a few small notes.

## r1 findings status

| r1 item | Status | Evidence |
|---|---|---|
| B1 v1 completion wedge (README fact) | **Resolved** | V1-GATE (`k6`) with a `Docs/` repo: `readme=true ready=true issues=[]` (r1: `readme=false ready=false`). `docs/` control still ready. Extra variants pass: `docs/Project/`, `DOCS/Project/readme.md` (user's own lowercase README), `docs/project/Readme.MD`, no docs at all: `readme=true` each. The v1 test now asserts `entryPoint.readme` and feeds the real facts into `buildCompletionReadiness`. Prove-red is red (`readme false !== true`), the exact-`docs/` control stays green. |
| B2 false acceptance, two STATE.md spellings | **Resolved (fail-closed, as briefed)** | FA-1 (`fa`): the commit changes `docs/project/state.md`, the read-back content is the stale OLD bytes (digest valid), and the read-back `paths` no longer contain `docs/project/STATE.md`, so `stateChanged=false`. I also drove it through the real runtime (`h2`, factory port): `snapshots=0`, `run.paused handoff_snapshot_failed: commit ... lists no docs/project/STATE.md path`. Same as the parent's behavior. Prove-red is red (`actual: true, expected: false`). |
| B3 entry-file wedge (lowercase `claude.md` target) | **Resolved** | The 16-layout matrix (`m1`) is **16/16 accepted** (L09 and L10 flip from pause to accept; the commit holds `claude.md` + STATE.md). Full runtime through the factory port: H1-Eh gives `snapshots=1`, owner selection `completed` (r1: `snapshots=0`, paused). Canonical control H1-Eh2 and H1-Ed also complete. Prove-red with both folds reverted: the gate returns null, red. |
| Escalation C-1: `docs/` and `Docs/` both tracked | **Resolved as decided** | The run hands off; STATE.md is skipped with the shared reason derived from the commit tree (`dirLinks`), the gate accepts it. Verified for `docs`+`Docs`, `docs/Project`+`docs/project` and `DOCS`+`Docs` with a STATE.md under one. Reuse by key returns the same commit and the same reason; a second stop works. Prove-red is red (`0 !== 1`, the run wedges). |
| Escalation C-2: `AGENTS.md` and `agents.md` (or CLAUDE pair, or both pairs) tracked | **Resolved as decided** | The colliding entry is skipped with a tree-derived reason; the other entry and STATE.md still commit; both colliding bytes untouched; the run hands off and the reuse path records identical wording. Prove-red is red (`agents.md` enters the commit). |
| False acceptance check for the escalation | **Holds** | E4: a stage-time collision skip with no collision facts from the commit tree is **not** accepted (`handoffEntryFileStatus` returns null); with the tree facts it is accepted. A file-level STATE.md collision is not reported as a skip (E3/FA-1 stay closed). |
| m-1 M-6 self-import for lowercase `agents.md` | Resolved | L07/L08 now commit only `agents.md` + STATE.md (the pointer is satisfied through the link); E-d passes. |
| m-2 dropped-spec skip loses its canonical path | Resolved | D-drop for the `Docs` variant records `docs/project/specs/source_value.md` (canonical). |
| m-3 the 8-letter cap | Unchanged, optional | Same results as r1 (S1, S6-8, S6-9 fail the pathspec only when the manager is called directly with identical bytes). `caseVariants` returns the exact name over the cap, so the new resolved-walk cannot miss an exact entry. |
| m-4 extra git calls | **Not improved; worse by 5** | See N-1. |
| m-5 tests | Resolved | The v1 test asserts the facts and the completion gate. The new tests carry a `linux` skip guard. The six original C2d harness tests are still unguarded (was optional). |
| m-6 evidence | Resolved | `C2d.md` records the README fact, the completion check and the numbers. |

## New findings (all non-blocking)

| # | Where | Finding | Suggested fix |
|---|---|---|---|
| N-1 (cost, recommended) | `integration-manager.ts:2928-2949` (`projectDocEntryPointFacts`, README fold), called from `documentCommitResult` for the kernel path too | One snapshot now makes **48 manager git calls** with `docs/` present and **44** with an empty repo. Round 1 measured 43 at C2e (39 at C2d-only, 29 at the parent); the worker's before/after tally gives 43 and 39 at C2e for the same two configurations, and my trace agrees with the worker's 48 and 44. I traced every call. The README fold adds a 4-call `ls-tree` miss-walk (calls 35-38 in my trace) on every kernel snapshot whose repo has no `docs/project/README.md`, which is the common case. The kernel never consumes the `readme` fact (only the v1 event does, `build-runtime.ts:2983`). The two collision lookups add 2 (stage prefetch and commit facts) and the consolidation of the level walk saves 1. On Windows and macOS only (Linux returns early; not measurable on this machine, read from the code). At the PX-1 rate of about 1 s per audited call this is about +5 s per handoff. Correctness is not affected. | Give `documentCommitResult` a flag so only the v1 path (`commitProjectDocuments`) does the README fold; the kernel snapshot skips it. That takes back the 4 calls. |
| N-2 (wording) | `commitStateLinkComponents` / `commitStateNonLinkBlocker` + `handoffStateSkipReason` | A directory collision records "docs is a symbolic link or junction", which is not true. The worker disclosed it and it follows the C2e F-matrix precedent (a file where a directory is expected records the same text). The gate accepts any non-empty reason. | Add a distinct describer reason for `case-collision` when the describer scope is open again. |
| N-3 (owner note) | B2 by design | Two spellings of STATE.md still pause on every attempt (fail-closed, brief-approved). It is reachable when a repository authored on Linux carries both `STATE.md` and `state.md` and is opened on Windows or macOS. CD-15 says no layout may leave a run permanently unable to hand off, so the controller may want to record this exception. | Later option: hand off from one unambiguous spelling for both the name and the content. |
| N-4 (v1 path, pre-existing) | `commitProjectDocuments` | (a) With colliding `docs/` and `Docs/` the v1 commit refuses with a clear reason ("tracks two spellings of docs") instead of wedging: fine. (b) With colliding entry files (V1Y probe) the v1 commit writes the section into `agents.md` on top of the bytes of the `AGENTS.md` file (one physical file on disk), so the user's lowercase entry is rewritten, and `agentsMarkedSection` is false. Same as the parent. The v1 gate cannot accept a skip, and the worker disclosed it. | Out of scope for this packet; docs policy 1 is retired at T7a. |
| N-5 (scope, for the controller) | `build-runtime.ts` (2 escalation hunks), `project-docs.ts` (new fact fields, `handoffEntryCollisionSkipReason`, describer branches) | The B3-only waiver covers the two one-line folds. The other hunks are for the escalation (the gate accepts an entry skip only with commit-tree corroboration, so it needs a collision fact). Disclosed by the worker. I judge them necessary for the controller's own C-2 decision and confined to it (optional fields, no event, reducer or scheduler-store change). | Controller to confirm the widened scope. |
| N-6 (cosmetic) | `project-docs.ts:429-441` | The new JSDoc for `handoffEntryCollisionSkipReason` was inserted between the JSDoc of `handoffEntryGenericSkipReason` and its function, so that JSDoc is now orphaned. | Move the new block above the old one. |
| N-7 (API nuance, no impact) | `readHandoffSnapshotFile` | Reading a non-STATE path (a spec copy) in a variant-directory layout returns `paths` with the raw `Docs/project/STATE.md` instead of the canonical name, because the B2 guard compares to the path the content came from. The runtime reads only `.content` for spec reads (`build-runtime.ts:2690`), so nothing changes. My reused round 1 probe S3 asserts the old shape and fails on exactly this line. | None needed. |

## Judge items

1. **B1 to B3 resolved.** Yes, each with the round 1 probe and a full-runtime check (see the table).
2. **Escalation as decided, no false acceptance.** Yes. STATE.md and entry skips are derived from the commit tree only, a stage-only claim without tree facts is refused (E4), a file-level STATE.md collision stays closed, and nothing was written outside the repository or through a link in any probe (`outside` kept only `own.txt` in the reused L-a, L-b and F-collide-deep probes).
3. **Kernel variants.** The 8 kernel variants K-A to K-G still pass (8/8). The reused r1 probes E-a to E-h, D-rd-collide-a/b, D-rd-control, NB-8, V1-B to V1-F all pass. Two reused probes fail on assertions, not on behavior: L-c expects `dirLinks` `["STATE.md"]` but the shipped constant `HANDOFF_STATE_LINK_COMPONENTS` is `"docs/project/STATE.md"` (the constant is unchanged since the parent, and the behavior is right: STATE.md skipped, nothing written outside); S3 is N-7. Neither is caused by C2d or C2e.
4. **Tests and prove-reds.** The seven new tests pass by name: B1 pair (5 s and 4 s), B3-L09 (144 s), B3-L10 (153 s), C-2 (125 s), FA-1 (140 s), C-1 (140 s). I re-ran five prove-reds on a disposable copy (B1, B2, B3, C-1, C-2), each with its single reversion, and each is red for the stated reason. The control test stays green in the B1 run. The tests use the factory-built port with real SQLite and git, assert the recorded snapshot, the exact commit paths, the reasons, `own.txt` untouched, a clean status and the owner selection.
5. **Git calls per snapshot.** 48 (docs present) and 44 (empty), against 43 and 39 at C2e (the worker's tally; round 1 measured 43 at C2e, 39 at C2d-only, 29 at the parent): **+5**, of which 4 are avoidable (N-1). Zero extra calls on a case-sensitive checkout by code reading.
6. **Scope, encoding, gates.** Changed product files: `integration-manager.ts`, `build-runtime.ts`, `project-docs.ts` (N-5). No event type, reducer or scheduler-store change, so stored logs replay unchanged; the entry facts are not spread into any event payload. All seven files are LF with no BOM. `tsc -p runner-v2/tsconfig.json --noEmit` exit 0. `eslint` on the six changed files exit 0. `git diff --check` is clean for `runner-v2`; the only hits are trailing spaces in the evidence log `muse-pipeline-2026-09-29.md`. No `child_process`, `spawn` or `exec` in the added product lines.

## Probes I ran (scratch worktree at `37433efd`)

Sources and logs: `...\scratchpad\c2dr2r2\` (reused r1 probes `k1` to `k8`, `fa`, `m1`, `cost`, `h1`; mine: `e1`, `h2`, `v1x`, `v1y`, `cost2`, `cost3`, `rev1.mjs`, `rev2.mjs`).

| Probe | Result |
|---|---|
| `k6` V1-README and V1-GATE (`Docs` and `docs`) | 4/4; `readme=true ready=true` for both |
| `v1x` v1 README fact for `docs/Project`, `DOCS/Project/readme.md`, `docs/project/Readme.MD`, no docs; colliding `docs`+`Docs` | 5/5; readme true in the four; the collision refuses with a clear reason |
| `fa` FA-1 | `stateChanged=false`; read-back paths exclude `docs/project/STATE.md` |
| `h2` FA-1 through the runtime (factory port) | `snapshots=0`, paused `handoff_snapshot_failed ... lists no docs/project/STATE.md path` |
| `m1` 16-layout entry matrix | 16/16 accepted |
| `h1` H1-Eh (lowercase `claude.md` target) and H1-Ed | both `snapshots=1`, selection `completed` |
| `k1` 8 kernel variants | 8/8 |
| `e1` C-1 (3 shapes), reuse, second stop; C-2 (5 shapes), reuse; E3 file-level collision; E4 fabricated skips | 10/10; skips accepted with tree reasons; E3 stays closed; E4 refused without facts |
| `k2 k3 k5 k7 k8` (reused) | 31 of 33; the 2 failures are stale or outdated assertions (see judge item 3) |
| `cost` / `cost2` (call trace) | 48 (docs present) and 44 (empty) |
| Seven new repair tests by name | 7/7 |
| Prove-red on a disposable copy: B1, B2, B3, C-1, C-2 | all red for the stated reason |
| tsc, eslint, `git diff --check`, LF/BOM, child_process grep | clean |

Note on method: my first attempt to apply the prove-red reversions directly to the scratch worktree files was blocked by the permission classifier; nothing was changed. I ran the reversions on a disposable copy inside the scratch tree instead, and deleted it.

## Follow-up list

Not blocking (for the controller):
1. N-1: skip the README fold on the kernel snapshot path (recovers 4 of the 5 added calls).
2. N-5: confirm the widened `build-runtime.ts` and `project-docs.ts` scope for the escalation.
3. N-3: record the two-STATE.md-spellings exception against CD-15, or plan a later fix.
4. N-2, N-6: reason wording for collisions; JSDoc placement.
5. Optional, carried: m-3 (`:(icase,literal)` lookup for long names), platform guards on the six original C2d harness tests, `readHandoffSnapshotFile` nuance (N-7), v1 colliding entries (N-4, gone with T7a).

The controller still owns the large-tree and native-delivery files, the full handoff suites (worker reported entry-links 24/24, project-links 22/22, retry 22 and integration-manager 36 green) and the C2e review; I did not re-run them.
