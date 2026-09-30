# C2e evidence — non-link docs layouts, apply cap and minors (CD-15, CD-17, CD-19)

Base: `88266a9a` (`codex/runner-v2-p6-6`, C2d accepted as wip pending
review; tree holds only the pre-existing `progress.md` and pipeline-doc
working-tree modifications, which predate this session). Lane A
implementation worker. No commits, stages, stashes, pushes, or PRs; all
changes uncommitted.

Scope: packet contract "C2e — Non-link docs layouts, apply cap and
minors". Root causes: (1) the F-matrix non-link blockers (a tracked file
where `docs/` or `docs/project/` is expected, a tracked directory where
`STATE.md` is expected) crashed the stage-time checks and the physical
write (ENOTDIR/EEXIST/EISDIR) on every attempt; (2) `applyToProject`
buffered the whole integration diff into the 4 MiB capped git output, so
a large tree refused the owner's selection; (3) minors m-7, m-11, m-4,
m-8 from the C2c r4/r5 follow-up lists.

## Per-item changes and tests

All run-handoff probes go through `openFactoryPort` (the factory-built
docs port), the production snapshot step, real SQLite and real git. Zero
new full `NativeBuildManager` tests (limit untouched).

| Item | Change | Test |
|---|---|---|
| F-docs-file: tracked file at `docs` hands off | walk + stage + v1 below | project-links "C2e/probe F-docs-file": 1 snapshot, `stateSkippedReason` equals `handoffStateSkipReason("docs")`, commit holds entry files only, user file untouched, status clean, selection completes; v1 refuses naming the file |
| F-project-file: tracked file at `docs/project` hands off | same | project-links "C2e/probe F-project-file": reason `handoffStateSkipReason("docs/project")`, otherwise as above; v1 refuses naming the file |
| F-state-dir: tracked dir at `docs/project/STATE.md` hands off | same | project-links "C2e/probe F-state-dir": reason `handoffStateSkipReason("docs/project/STATE.md")`, otherwise as above; v1 refuses naming the directory |
| G1-select: large-tree apply completes | `applyToProject` diff and name listing go through `git --output` into files, never one capped buffer | large-tree "C2e/probe G1-select": 40,000 files under `docs/generated`, snapshot commits, `apply_to_project` completes, project holds the snapshot and the tree |
| m-7: refused append pauses | current-stop append wrapped in `pauseForHandoffSnapshotFailure` | retry "C2e/m-7 refused append pauses": injected reducer refusal pauses with the reason, resume retries and records |
| m-11: unclean-index wording | empty-commit refusal names the integration index | project-links "C2e/m-11 unclean index reason": staged stranger, refusal matches /integration index is not clean/, HEAD unchanged |
| m-4: reuse wording | reuse/withdrawn commits re-derive entry skips from their own tree in the fresh wording | entry-links "C2e/m-4 reuse wording": reuse records the byte-identical skip reason |
| m-8: withdrawn second stop | regression test only (no product change) | retry "C2e/m-8 W-A4 second stop": stop-1 history plus an empty stop-2 commit (`paths: []`), chain continues, apply completes |

## What changed (file:line)

`runner-v2/src/integration-manager.ts` (only product file with logic;
`project-docs.ts` untouched — outside the writable set):

- `:2485-2534` `commitStateLinkComponents`: a tracked non-link blocker
  counts like a link — a file where `docs/` or `docs/project/` is
  expected, or a directory where `STATE.md` is expected, reports the
  expected component. The shared describer records the same
  tree-derived skip reason for it, which the AR-R05 gate accepts
  exactly as the CD-17 link reason. Missing entries still report
  nothing (J-docs still pauses fail-closed); colliding-link preference
  (m-9) unchanged.
- `:2543-2580` `commitStateNonLinkBlocker`: the HEAD-tree stage-time
  counterpart (links and missing entries are not blockers). Bounded:
  three exact `ls-tree` queries, never a listing, never the worktree.
- `:1090-1120` stage planning: on the kernel path a blocked STATE.md
  is skipped with `handoffStateSkipReason` (the single wording source,
  so fresh, reuse and withdrawn records are identical) before any
  mkdir/write is attempted; on the v1 path the same blocker refuses
  with a clear reason naming the file or directory
  (`... is a regular file, not a directory.` /
  `... is a directory.`), never a raw ENOTDIR/EEXIST/EISDIR crash.
- `:3246` `firstLinkComponent`: ENOTDIR tolerated like ENOENT (a
  component below a tracked file is not a link, and nothing below it
  can be one). This also keeps the spec-copy stageability check from
  throwing on F-matrix layouts.
- `:1363-1388` `applyToProject`: the integration diff goes through
  `git diff --binary --full-index --output=<patchPath>` (allowed by the
  Runner Git policy; verified byte-identical semantics in a scratch
  repo) instead of one capped stdout buffer; emptiness is a patch-file
  stat, and the already-applied early return removes its patch file as
  before. Conflict refusal (`apply --check`), the audit patch file,
  the journal and the recovery path are untouched.
- `:2035-2065` `assertCheckoutWillNotOverwriteUntracked`: the
  changed-name listing goes through `diff --name-only -z --output` to
  a scratch sibling of the transition index (removed in a finally),
  then the identical set-intersection refusal. The untracked listing
  stays buffered (the project is proven clean just before, so it is a
  few bytes).
- `:677-687, :3145-3152` reuse/withdrawn lookup: `documentCommitResult`
  gains the fresh-worded entry skips re-derived from its own commit
  (m-4) via `:2589-2633` `commitEntrySkipReasonsFromTree` plus the
  bounded commit-tree helpers `:2636` `commitTreeAncestorLink` and
  `:2664` `commitTreePathMode`. Unresolvable/outside/kernel-owned
  targets and missing/non-regular targets keep the exact stage-time
  detail through the shared `entryLinkSkipDetail`; an ancestor link in
  the commit tree names the junction; a redirect the tree proves is
  left to the describer (wording already matches); a regular blob
  without the section keeps the generic wording so tampering layouts
  (D1-reuse) still complete instead of pausing.
- `:714-720` (m-11): the unclean-index empty-commit refusal reads
  `Project document commit refused: the integration index is not clean
  (staged changes remain while every write was skipped: ...)`.
  Fail-closed and HEAD-unchanged as before.

`runner-v2/src/build-runtime.ts`:

- `:2546-2578` (m-7): the current-stop `appendHandoffSnapshotCommitted`
  is routed through `pauseForHandoffSnapshotFailure`, so a refused
  append pauses with the reducer's reason and a resume retries (the
  landed commit is reused by key). The withdrawn-stop append already
  threw into the reconcile wrapper, which pauses the same way.
- `:2734-2741` (m-4): the withdrawn-stop describer call passes the
  port's re-derived skips as `stageSkipped`, so history records match
  fresh records (W-B1 class).

`scheduler-store.ts`: unchanged (the gate already accepts any
non-empty `stateSkippedReason`; the runtime proves it from the commit
tree). `native-build-factory.ts`: unchanged (the apply call lives in
the integration manager). No events added, removed, or reworded;
replay-compatibility is covered by the untouched-file suites below.

`runner-v2/test/support/handoff-snapshot-harness.ts`: one additive
helper, `:888` `failNextSnapshotAppendOnce` (m-7 fault injection on
the harness store instance).

## Changed files (sha256, final bytes)

- `04c1ea896228dcfeca7b0c38eb16f79290fb6ee762d2edc9ec5010439bec0ecc` runner-v2/src/integration-manager.ts
- `e1dce26ec605707a33ebe4da4259905ff8bc0788e5c576777ed16b1548ae818e` runner-v2/src/build-runtime.ts
- `1e2eaca0387a21d99d96f4f968ba3c60385fcd6ca0707a66257b1c63c9af7434` runner-v2/test/support/handoff-snapshot-harness.ts
- `b2a97fc0007acb472b58eba66cb32abe80c478d3334089649f71b5b30785e188` runner-v2/test/docs-policy-v2-handoff-project-links.test.ts
- `189920ab506da0fb8c00f658b89b62e1c1d5e991edca659ec0120a93a244b01d` runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts
- `b663675ce816316f8107d95ce725745a795c64771ee546c624ebb6ca7a840e17` runner-v2/test/docs-policy-v2-handoff-retry.test.ts
- `a7544ea59ffcf4cebeca078f52f4fb851d5beafa295df131cf717921ff1fcb45` runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts

Encoding: LF, no BOM. `git diff --check` on this packet's files is
clean (the only `git diff --check` hits in the worktree are
pre-existing trailing-whitespace lines in another packet's
`muse-pipeline-2026-09-29.md`, untouched here).

## Suites (worker-run, NODE_TEST_CONTEXT cleared)

New tests, each `--test-concurrency=1`:

- C2e/probe F-docs-file: pass 1/1 (73.2 s).
- C2e/probe F-project-file + F-state-dir: pass 2/2 (150.3 s).
- C2e/m-4 reuse wording: pass 1/1 (95.2 s; one assertion fixed
  mid-session — rev-list counts the link-setup commit too, test only).
- C2e/m-11 unclean index reason: pass 1/1 (47.6 s).
- C2e/m-7 refused append pauses: pass 1/1 (95.9 s).
- C2e/m-8 W-A4 second stop: pass 1/1 (163.4 s; setup needed the
  W-CI `integration.revision_advanced` shape so the document chain
  continues — the early seed-time attempt invalidated FV, test only).
- C2e/probe G1-select: pass 1/1 (319.1 s).

Validation (five files, `--test-concurrency=4`, NODE_TEST_CONTEXT
cleared): exit 0 — retry (21 tests), project-links (20),
entry-links (21), integration-manager.test.ts (35),
project-doc-commit.test.ts (20): 117 tests, 117 pass, 0 fail. Every
line streamed green, no ✖; the verdict rests on the zero exit plus the
absence of any failure in the streamed output (the runner's summary
block was truncated in delivery, so no `duration_ms` is quoted here;
wall time was on the order of C2d's 39 min for the same files).

Large-tree file ALONE (`--test-concurrency=1`, NODE_TEST_CONTEXT
cleared): 4 tests, 4 pass, 0 fail (`duration_ms 1078789`, ~18 min) —
G1 (281.3 s), G1-control (241.7 s), C2e G1-select (286.9 s), G1-flat
(268.1 s). The pre-existing G1 tests needed no change (none asserted
the old refusal).

Static (final bytes): tsc (`tsc -p runner-v2/tsconfig.json --noEmit`)
clean, exit 0; eslint on all seven changed files clean, exit 0;
`git diff --check` on this packet's files clean (the only worktree
hits are pre-existing trailing-whitespace lines in another packet's
`muse-pipeline-2026-09-29.md`, untouched here).

Suites not run: native-delivery files (the pipeline runs them);
whole-repo suite (out of scope).

## Prove-red records (sha256 before/after, byte-exact restore)

Backups under `/tmp` (`c2e-backup-integration-manager.ts`,
`c2e-backup-build-runtime.ts`); every restore verified by hash.

1. Item 1 (F-matrix): with the kernel STATE.md skip disabled
   (`integration-manager.ts` `7663609e80892e99041300c1b772007ec06c1f74a19805582b0e3f2228a95dd7`),
   "C2e/probe F-docs-file" goes red: 0 snapshots
   (`0 !== 1`, "the run hands off instead of stalling on ENOTDIR").
   Restored to `04c1ea89...` (hash match).
2. Item 2 (apply cap): with the buffered whole-tree diff put back
   (`integration-manager.ts` `58f464d78314cb041fe6286a6f0b30de41d30a5edcba74542070871c3d3b4206`),
   "C2e/probe G1-select" goes red with the exact old failure:
   `GitCommandError: Git output exceeded 4194304 bytes ...`
   (`output_limit`, from `applyToProject`). Restored to `04c1ea89...`
   (hash match).
3. Item 3 (m-7): with the append guard removed
   (`build-runtime.ts` `383d6d296cc99e719ca520628cb3db2f0356ea05de0e29d7557c47b17256e8bc`),
   "C2e/m-7 refused append pauses" goes red: the injected refusal
   propagates as a pump error out of `runUntilBlocked`
   (`Error: Handoff snapshots must include docs/project/STATE.md.`
   at `appendHandoffSnapshotCommitted`) instead of pausing. Restored
   to `e1dce26e...` (hash match).

## Not done / limits

- The shared `handoffStateSkipReason` wording (frozen:
  `project-docs.ts` is outside the writable set) names "a symbolic
  link or junction" even for F-matrix file/directory blockers. The
  recorded reason always names the right component
  (`docs`/`docs/project`/`docs/project/STATE.md`) and the outcome, and
  fresh/reuse/withdrawn records are identical; the v1 refusal is fully
  truthful. A wording split needs a `project-docs.ts` change in a
  later packet.
- Untracked F-matrix blockers (a file at `docs` never committed) are
  out of scope: the skip reason must come from the commit tree
  (m-3/J-docs), and an untracked blocker has no commit-tree fact, so
  those layouts still fail closed instead of handing off. The brief
  names tracked layouts only.
- `findTrackedFileWithDigest` still lists the whole tree
  (`ls-tree -r`) into the capped buffer; it is only reached when a
  manifest with valid artifact bytes is due (none of the large-tree
  probes hit it), so the G1 selection completes. Bounding it belongs
  to the same follow-up as the escalation it came from.
- `git diff --output` relies on the Runner Git policy allowing the
  flag (it does: only `--config-env`-class, submodule, signing and
  editor args are forbidden) and on git writing the file with the same
  bytes as stdout (verified byte-semantics in a scratch repo; the
  G1-select and m-8 applies prove it end to end).

---

# Repair cycle 1 (review r1: REPAIR — B-1 blocking; N-1..N-4 recommended)

## Repair scope (review r1: 1 blocking + 4 recommended)

| Item | Change |
|---|---|
| B-1 (blocking) | `assertCheckoutWillNotOverwriteUntracked` no longer buffers the whole-tree `ls-files --others -z` listing (it includes IGNORED files, which `git status --porcelain` never shows). Only the paths the apply will write are checked, in bounded chunks of 200 `:(literal)` pathspecs per `ls-files --others -z` call; each call's output holds only collisions. `--others` without `--exclude-standard` still reports ignored files at those paths, so the ignored-path collision refusal is byte-identical. `projectMatchesRevision` (recovery only) no longer buffers the whole-tree listing either: it checks the index/worktree against the revision as before, then a `--exclude-standard` untracked listing (a user file anywhere outside the apply still blocks recovery, same exposure as the apply's own `status --porcelain` clean check) plus the chunked written-paths check above, so an ignored file at a target path still refuses instead of being overwritten. `git ls-files` has no `--output` flag (verified), so the listing cannot go through a file. No cap was raised. Follow-up found in validation: the first attempt (`--exclude-standard` alone) regressed `integration-manager.test.ts` "crash recovery never overwrites an ignored untracked target path" and "journal recovery blocks mismatches ..." — fixed by the two-part check; both green again (see suites). |
| N-2 | v1 `commitProjectDocuments` refuses only the write the blocker can affect: `blocker.kind === "file-not-dir" \|\| write.path === "docs/project/STATE.md"`. A directory/submodule/collision at STATE.md no longer blocks an unrelated `docs/project/README.md` write. |
| N-3 | Both commit-tree walks count any non-regular, non-link mode at the STATE.md level as a blocker (mode 160000 gitlink, 040000 directory, anything else): `commitStateBlockers` and `commitStateNonLinkBlocker`. Kernel skips STATE.md with the tree-derived reason; v1 refuses clearly (`is a submodule entry.`). |
| N-4 | `commitTreePathMode` now reports `{ mode, exact }` (`exact` = the tree holds the target under the requested spelling at every level). The reuse/withdrawn re-description words mode 040000 / 160000 and folded-only matches as "not a regular tracked file", exactly as the stager does; only a regular blob at the exact spelling keeps the generic wording (tampering layouts still complete). |
| N-1 | `project-docs.ts` gains `HandoffStateBlockerKind` ("file" \| "submodule" \| "directory") and `handoffStateBlockerSkipReason` (new sentences; `handoffStateSkipReason` frozen byte-identical). The kind travels `commitStateBlockers` → `documentCommitResult.stateBlockerKind` → `describeSnapshotCommitFacts.commitStateBlockerKind` (both runtime call sites) → recorded `stateSkippedReason`. Links and case collisions carry no kind and keep the legacy wording, so stored logs replay unchanged. Scope note: the case-collision record keeps the legacy sentence (C2d test C-1 asserts it); only file/gitlink/directory records changed, per the brief. |

## Changed files (sha256, final bytes)

- `01f8bfab4d2dd13fd3e7dde57e91ccdd8189c85f85279cb59a6b43e0fb30847d` runner-v2/src/integration-manager.ts (prove-reds ran against `d4eaf504...`; the recovery follow-up above moved it to the final hash — the reverted/re-restored regions are textually identical in both)
- `782d56118984ed5d7b2f20f8448b8679a123ed1062b35dcf1d7524fd085d39a0` runner-v2/src/build-runtime.ts
- `87d593264c42cca900152195fa15fdc441a83f36fa2f3db5db8b33f984c918d7` runner-v2/src/project-docs.ts
- `f51070b3ebb71710ee703bda6aa05f5489d9ed7a0a046435b6c4c10a81d76a49` runner-v2/test/docs-policy-v2-handoff-project-links.test.ts
- `e66649644c27ffaef977607e81789ea8462f2ceef67142300be7fe251e248af3` runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts
- `be86a6fd9c4b4d308e7d73d762a1b8f6af86df5cd6f7f59bf889ee39f7a9128f` runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts
- harness unchanged (`1e2eaca0387a21d99d96f4f968ba3c60385fcd6ca0707a66257b1c63c9af7434`); retry file unchanged (`b663675ce816316f8107d95ce725745a795c64771ee546c624ebb6ca7a840e17`).

## New/updated tests

- large-tree "C2e repair cycle 1/probe A1": 45,000 ignored files + tiny apply → completes, project holds the applied snapshot (prove-red below).
- large-tree "C2e repair cycle 1/probe A3": ignored file at an added path → refused with the exact old collision message, head/status/file unchanged (keeps the refusal exactly as strong under the new mechanism).
- project-links "C2e repair cycle 1/probe F10" (reviewer F10): STATE.md directory + v1 README-only write → commits; STATE.md write still refused.
- project-links "C2e repair cycle 1/probe F7" (reviewer F7): gitlink at STATE.md → 1 snapshot with the submodule wording, selection completes, v1 refuses `is a submodule entry.`
- entry-links "C2e repair cycle 1/m-4a" (directory target) and "m-4b" (case-variant target): fresh and reuse record the byte-identical "not a regular tracked file" reason.
- Updated to the N-1 wording: F-docs-file and F-project-file (`handoffStateBlockerSkipReason(..., "file")`), F-state-dir (`"directory"`). Link/collision assertions (F-collide, C-1) untouched and still legacy-worded.

## Suites (worker-run, NODE_TEST_CONTEXT cleared)

New tests, each `--test-concurrency=1`:

- C2e repair cycle 1/probe A1: pass 1/1 (179.8 s; 201.2 s in the large-tree-alone run).
- C2e repair cycle 1/probe A3: pass 1/1 (177.6 s; 141.2 s in the large-tree-alone run).
- C2e repair cycle 1/probe F10 + F7: pass 2/2 (208.4 s + 136.7 s).
- C2e repair cycle 1/m-4a + m-4b: pass 2/2 (344.6 s + 316.9 s).
- Recovery re-run after the follow-up fix (`--test-name-pattern="ignored|mismatch|ref moved|retiring|concurrent managers"`, integration-manager.test.ts): pass 7/7 (~40 s).

Validation (six files, `--test-concurrency=4`, NODE_TEST_CONTEXT cleared): exit 0 —
entry-links, project-links, retry, integration-manager.test.ts, project-doc-commit.test.ts,
replay-compatibility.test.ts: 132 tests, 132 pass, 0 fail (`duration_ms 4471710`, ~75 min
wall under load). An earlier run on the pre-follow-up bytes failed exactly the two
recovery tests named above and nothing else; the follow-up fixed them (re-run green) and
the final full run is clean.

Large-tree file ALONE (`--test-concurrency=1`, NODE_TEST_CONTEXT cleared): 6 tests, 6 pass,
0 fail (`duration_ms 2893861`, ~48 min wall under load) — G1 (510.9 s), G1-control
(443.6 s), G1-select (1076.8 s), A1 (201.2 s), A3 (141.2 s), G1-flat (519.3 s). The
pre-existing G1 tests needed no change (none asserted the old refusal).

Static (final bytes): tsc (`tsc -p runner-v2/tsconfig.json --noEmit`) clean, exit 0;
eslint on all six changed files clean, exit 0; `git diff --check -- runner-v2/` clean
(the only worktree hits are pre-existing trailing-whitespace lines in another packet's
`muse-pipeline-2026-09-29.md`, untouched here).

Suites not run: native-delivery files (the pipeline runs them); whole-repo suite (out of scope).

## Prove-red records (sha256 before/after, byte-exact restore)

Backups under `C:\Users\b_a_s\AppData\Local\Temp\c2e-r1-pr\` (`integration-manager.fixed.ts`
refreshed to the final `01f8bfab...` bytes); every restore below was verified by hash at the
time (`d4eaf504...`), and each reverted/re-restored region is textually identical in the
final bytes, so the reds prove the final code too.

1. B-1: with the whole-tree `ls-files --others -z` listing put back, "C2e repair cycle 1/probe A1" goes red with the exact old failure: `GitCommandError: Git output exceeded 4194304 bytes or its exact bounded artifact is unavailable.` (`output_limit`, from `assertCheckoutWillNotOverwriteUntracked`). Restored to `d4eaf504...` (hash match).
2. N-2: with the old `if (blocker !== null)` v1 condition put back, "C2e repair cycle 1/probe F10" goes red: `Project document path docs/project/README.md is refused because docs/project/STATE.md is a directory.` Restored (hash match).
3. N-3: with the directory-only STATE.md-level checks put back in both walks, "C2e repair cycle 1/probe F7" goes red: 0 snapshots (`0 !== 1`, the EISDIR stall). Restored to `d4eaf504...` (hash match).

## Correction to the C2e record

The C2e.md sentence "The untracked listing stays buffered (the project is proven clean just before, so it is a few bytes)" was wrong: the clean check is `git status --porcelain`, which never lists ignored files, while `ls-files --others` without `--exclude-standard` lists them all. This repair removes the whole-tree untracked listing instead of buffering it.
