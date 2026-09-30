# C2d evidence — case-variant docs spellings (CD-15, CD-19)

Base: `da771649` (`codex/runner-v2-p6-6`, TX-2 accepted; tree clean except
the pre-existing `progress.md` and plan-doc working-tree modifications,
which predate this session). Lane A implementation worker. No commits,
stages, stashes, pushes, or PRs; all changes uncommitted.

Scope: packet contract "C2d — Case-variant docs spellings" (plan CD-15,
CD-17, CD-19). One root cause for all items: on a case-insensitive
checkout (`core.ignorecase=true`), git stores the spelling the repository
has (for example `Docs/project/STATE.md`, `docs/Project/`, `agents.md`),
but the writes and the commit pathspecs used the canonical spelling
(`docs/project/STATE.md`, `AGENTS.md`). The commit then failed with a
pathspec error on every attempt, or a write landed in a file the commit
did not record.

## Root-cause fix

`runner-v2/src/integration-manager.ts` (only product file changed;
`project-docs.ts` needed no change — see "Why no gate/describer change"
below):

- `resolveIndexSpelling` / `resolveSpellingInTree` (`:2581-2623`): the
  index's own spelling of a canonical write path. Each existing path
  component resolves through the HEAD commit tree (exact `ls-tree` per
  level, plus one folded multi-name `ls-tree` per missed level — the
  NB-7 bounded pattern); components that do not exist yet keep the
  canonical spelling. Identity on a case-sensitive checkout. The live
  worktree is never consulted (NB-7). Used for every physical write and
  staged path in `stageProjectDocWrites` (`:1043-1058`, `:1075-1077`)
  and `stageHandoffSpecCopies` (`:829-835`), on the kernel path and the
  v1 Architect path alike. Recorded skip/redirect reasons keep the
  canonical entry path; redirect targets are never resolved (NB-8
  exact-spelling rule kept).
- `readHandoffSnapshotFile` (`:891-921`): the blob is read through the
  commit's own spelling when the canonical one matches nothing, and the
  commit's real spellings are reported under the canonical handoff
  spellings (`canonicalHandoffSpelling`, `:3156-3177`) on a
  case-insensitive checkout only. Same retry in `readIntegrationTipFile`
  (`:941-952`), so hand-edit detection still sees variant-dir snapshots.
- `projectDocEntryPointFacts` via `readBlobFolded` (`:2543-2578`):
  entry facts fold case, so a section committed as `agents.md` /
  `claude.md` still satisfies the gate.
- `commitEntryLinkTarget` via `commitEntryLinkBlob` (`:2683-2710`):
  the link fact folds to the entry's own spelling (F-LC-agents).
- `commitTreeEntryFolded` (`:2490-2506`): among folded matches, prefer
  the link entry (mode 120000), so the walk agrees with the stage-time
  check (F-collide).
- `caseVariants` (`:3200-3224`): bound the fold to names with at most 8
  case-distinct letters (256 variants max; the fixed handoff names need
  at most 128). A longer dynamic name (a spec-copy filename such as
  `source_value-<hex>.md`) would otherwise produce millions of
  pathspecs and break the `ls-tree` call — found by validation
  (A1/A2 below); longer names return the exact spelling alone.
- `isEntryLinkRedirectTarget` (`:2795-2802`): refuse a redirect whose
  target collides case-insensitively with another index entry
  (D-rd-collide); the entry is skipped with a reason instead of
  substituting one entry's bytes for the other's.
- `agentsRedirectTargets` (`:1114-1121`): a physical path that only
  differs in case from the entry file is the entry's own file, not a
  redirect — otherwise the M-6 omission would drop the CLAUDE.md pointer
  for a lowercase-`claude.md` layout.
- `isHandoffSpecCopyPath` (`:3148-3152`): folds case, so a spec copy
  staged through the index spelling still classifies as a spec copy.

Why no gate/describer change: `scheduler-store.ts` (`handoffSnapshotAtCurrentStop`)
and `build-runtime.ts` (`handoffEntryFileStatus`,
`describeSnapshotCommitFacts` in `project-docs.ts`) are outside the
writable set. All case handling hides inside the integration manager's
staging plus its read-back boundary: commits hold the index's real
spellings (asserted via `git show --name-only` in every test), while the
port reports the canonical handoff spellings to the unchanged gate.
`dirLinks` stays truthful — a regular `Docs/` directory reports no link
and commits STATE.md, exactly like `docs/`.

Kept behavior (NB-7, NB-8): link detection folds case
(`firstLinkComponent`, `entryLinkRawTarget`, `indexClaudeLinksAgents`
unchanged); a redirect target resolves only by the exact index spelling.

## Per-item changes and tests

All six probes run through `openFactoryPort` (the factory-built docs
port), real SQLite and real git, with `core.ignorecase=true` set in the
fixture worktree. Each asserts: the run hands off (exactly 1 snapshot
plus a completed owner selection), what the commit holds (real paths via
`git show --name-only`, event paths/reasons), that nothing outside the
repository changed (an `own.txt` sentinel), and that no write landed in
a file the commit does not record (`git status --porcelain` clean, or
the exact commit file list where the layout keeps an unrelated
plumbing-only entry).

| Item | Change | Test |
|---|---|---|
| DOCS-dir: regular capital `Docs/` dir hands off | resolve + read-back above | `docs-policy-v2-handoff-project-links.test.ts`: "C2d/probe DOCS-dir" — commit holds `Docs/project/STATE.md`, event paths canonical, STATE.md verifies, status clean, selection completes |
| D-walk-projdir: regular `docs/Project/` dir hands off | same | project-links: "C2d/probe D-walk-projdir" — commit holds `docs/Project/STATE.md`, otherwise as above |
| F-LC-agents: lowercase `agents.md` link to `NOTES.md` redirects through its own spelling | link-target folding + redirect bookkeeping | `docs-policy-v2-handoff-entry-links.test.ts`: "C2d/probe F-LC-agents" — `agentsSectionViaLink` names the redirect, commit holds `NOTES.md` (not the link), link bytes untouched |
| D-rd-lcagents: lowercase `claude.md` regular file takes the line | own-spelling staging + folded entry facts | entry-links: "C2d/probe D-rd-lcagents" — commit holds `claude.md` with the pointer line, no link reason, M-6 omission does not fire |
| F-collide: colliding `Docs` link + `DOCS/` tree prefers the link | `commitTreeEntryFolded` link preference | project-links: "C2d/probe F-collide" — `stateSkippedReason` names the link, commit holds entry files only, colliding layout proven via `ls-tree` |
| D-rd-collide: redirect into colliding `notes.md` refused | collision refusal in `isEntryLinkRedirectTarget` | entry-links: "C2d/probe D-rd-collide" — skip reason recorded, `NOTES.md` bytes untouched, commit holds entry files only |
| v1 DOCS-dir | same staging (shared `stageProjectDocWrites`) | `project-doc-commit.test.ts`: "v1 Architect documents commit through the index's Docs spelling (C2d DOCS-dir)" — rev-list +1, commit holds `Docs/project/STATE.md` |

No harness change was needed (`openFactoryPort`, `driveHandoff`,
`selectHandoffOwner`, `commitEntryLinkMode`,
`checkoutEntryLinkAsPlainFile`, `checkoutDirLinkAsRealLink` already
cover the layouts). No new full `NativeBuildManager` test (zero added;
the limit is untouched).

## Changed files (sha256, final bytes)

- `71321e3403271643653dfd8efcd2c40a5518480c526692d40d6584d95e44d9bc` runner-v2/src/integration-manager.ts
- `50912c0f185b5058a73fc3084f6205fb98c664243cef06b14426f529c18865fe` runner-v2/test/docs-policy-v2-handoff-project-links.test.ts
- `bee029b7ce545b6b6323e0e96cf3d0ed2159ecc7754bd9434b99fab45b8339b5` runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts
- `88658507802c3c880b284e75d11b95e5748cf94598ce28d94c420ecaab9496f5` runner-v2/test/project-doc-commit.test.ts

Encoding: LF, no BOM, `git diff --check` clean (only pre-existing
autocrlf warnings). `project-docs.ts` untouched (`205421e1...` as at
r5). No events added, removed, or reworded; every stored log replays
unchanged (proven by the untouched-file suites below).

## Suites (worker-run, NODE_TEST_CONTEXT cleared)

Focused (each `--test-concurrency=1`):

- C2d/probe DOCS-dir: pass 1/1 (76.9 s).
- C2d/probe D-walk-projdir: pass 1/1 (77.0 s).
- C2d/probe F-collide: pass 1/1 (71.3 s; one assertion fixed
  mid-session — a Windows `readlink` backslash comparison in the test
  only, no product change).
- C2d/probe F-LC-agents: pass 1/1 (73.2 s).
- C2d/probe D-rd-lcagents: pass 1/1 (68.1 s).
- C2d/probe D-rd-collide: pass 1/1 (68.3 s).
- v1 C2d DOCS-dir: pass 1/1 (2.2 s).

Validation (five files, `--test-concurrency=4`, NODE_TEST_CONTEXT
cleared) — first run: 112 tests, 110 pass, 2 fail
(`duration_ms 2159640`, ~36 min). Both failures are the pre-existing
specs-link probes A1/A2
(`docs-policy-v2-handoff-project-links.test.ts:267, :303`):
`specCopySkipped` was `spec_tip_unreadable` instead of `write_failed`.
Root cause in this packet's first cut: the generic
`resolveSpellingInTree` folded the dynamic spec-copy filename, and
`caseVariants` on ~20 letters produced millions of pathspecs, breaking
the `ls-tree` call inside `readIntegrationTipFile`, which the runtime
maps to `spec_tip_unreadable`. Reproduced deterministically in
isolation, fixed by the `caseVariants` bound above; A1+A2 then pass
2/2 in isolation (`--test-concurrency=1`, 196.7 s). Re-run of all five
files after the bound: 112 tests, 111 pass, 1 fail
(`duration_ms 2314641`, ~39 min). All 7 C2d tests green; the other 4
files green in full. The single failure is the pre-existing handedit
probe (`entry-links.test.ts:75`, "a hand-edited STATE.md is detected"):
0 snapshots on its first drive. The bound cannot affect it (only short
fixed names involved — behavior identical to the first run, where it
passed), and it passes in isolation post-fix (115.9 s), so this is the
known parallel-load transient class (r4/r5 "Process launch was not
proven" / ECONNRESET family). Confirmation: the entry-links file alone
with `--test-concurrency=4`: 20/20 green (`duration_ms 1515770`,
~25 min), including handedit and all three C2d entry probes.

Static gates (after the bound, final bytes): `tsc -p
runner-v2/tsconfig.json --noEmit` exit 0; eslint on all four changed
files exit 0; `git diff --check` clean.

Suites not run: the large-tree file
(`docs-policy-v2-handoff-large-tree.test.ts`) and every native-delivery
file (the controller runs them); the remaining handoff-suite files
(commit, gate, parity, spec-copy) beyond the five-file validation set.

## Prove-red records (sha256 before/after, byte-exact restore)

All three reversions touch only `runner-v2/src/integration-manager.ts`
and ran before the `caseVariants` bound was added (fixed bytes
`044eda89...` throughout; each restore re-hashed to it). The bound only
adds the letter-count guard to `caseVariants`; the three reverted hunks
are byte-identical in the final file (`71321e34...`).

1. Commit with the canonical spelling again (`resolveIndexSpelling`
   forced to `return canonical;`):
   `044eda89...` -> `5326baa7404d4b60648c22649e56d7f291edcdb0f1219023ea6cbdd00dc5db2b`.
   DOCS-dir red: `0 !== 1` snapshots (the run wedges on the pathspec).
   Restored; sha again `044eda89...` (match).
2. First folded match in `commitTreeEntryFolded` (link preference
   removed): `044eda89...` ->
   `5d6dbf586411e0862ae53f0d524cff3f9553d5c70546d7f7edfda2dc541562b2`.
   F-collide red: `0 !== 1` snapshots (the walk takes `DOCS`, finds no
   link, the write wedges). Restored; sha again `044eda89...` (match).
3. Allow a redirect into a case-colliding target (collision scan
   removed): `044eda89...` ->
   `45b6c244264e07e737eec613e515265f81d874c74885c6cac02ee904f23c029b`.
   D-rd-collide red: `agentsSectionCommitted` is `true` (the redirect is
   taken and the colliding target written) instead of `false`.
   Restored; sha again `044eda89...` (match).

## Not done / limits

- With a case-variant docs directory AND a spec copy due in the same
  run, the runtime-resolved `spec:` line names the canonical spec path
  while the commit holds the index spelling (same class as the C2c
  K-ignored residual: the event carries no false `specPath`, and the
  handoff completes). No test covers that combination; all C2d probes
  run without a spec due (no artifacts provisioned).
- A redirect target under a case-variant directory (link text
  `Docs/notes.md` vs tracked `docs/notes.md`) is refused and skipped
  with a reason under the unchanged NB-8 exact-spelling rule, rather
  than resolved. Same handoff outcome, recorded reason.
- `canonicalHandoffSpelling` normalizes only the kernel's handoff
  paths (`AGENTS.md`, `CLAUDE.md`, `docs/project/STATE.md`,
  `docs/project/specs/*.md`); redirect targets and user files always
  keep their real spellings.
- Each snapshot now spends a few extra audited git calls per write
  (exact plus folded `ls-tree` per level, insensitive checkouts only);
  roughly +10 s per handoff test on this machine (DOCS-dir 77 s vs the
  ~60 s shape of neighboring probes). PX-1 owns the host-call cost.
- r5 minors carried over, still open: m-7 (refused append is a pump
  error), m-11 (empty-commit refusal wording), J-docs permanence,
  T-1 (W-CI helper port wording — untouched by this packet).

## Repair cycle 1 (r1 wedges B1-B3, escalation, minors)

Base: HEAD `0ec56592` (C2d wip `88266a9a`, C2e wip on top). Lane A
implementation worker; no commits, stages, stashes, or pushes; all
changes uncommitted. C2e's tests stay green (retry,
integration-manager, and project-links/project-doc-commit suites
below); no event type or reducer branch added, removed, or reworded.

B1 (v1 completion wedge, `integration-manager.ts`
`projectDocEntryPointFacts` `:2928`): the README fact read
`docs/project/README.md` by the exact spelling, so a v1 batch into a
`Docs/` repository landed while the completion gate reported "missing
docs/project/README.md" forever. The fact now reads through the
commit's own spelling like the entry facts: the exact `cat-file`
first (exact-case repositories spend the same single call as before),
then `resolveSpellingInTree` plus one `cat-file` on a miss on a
case-insensitive checkout. Test: the v1 DOCS-dir test in
`project-doc-commit.test.ts:1444` now writes all four entry documents,
asserts `result.entryPoint.readme === true`, and feeds the manager's
real facts into `buildCompletionReadiness` for a `Docs/` repository
(expects ready, no issues), with a new exact-`docs/` control test
(`:1503`, unguarded) asserting the same. Prove-red: with the fold
reverted (`421a42ca...` -> `ab4d959a...`) the test is red
(`readme false !== true`); restored byte-exact (`421a42ca...` match).

B2 (false acceptance, `readHandoffSnapshotFile` `:925-959`): the
changed-path mapping reported every folded spelling under
`docs/project/STATE.md` while the content came from the stale exact
entry, so the gate accepted an old digest. The mapping now
canonicalizes to `docs/project/STATE.md` only for the spelling the
content read resolved to (`contentPath`: the exact path when the
exact `git show` succeeds, else the resolved spelling) — zero extra
git calls, and byte-identical to the resolve-based candidate in every
layout. Test: the reviewer's FA-1 probe as
`project-links.test.ts:1175` (manager-level through the factory-built
port): the commit changes `docs/project/state.md` (NEW) while the
exact entry keeps OLD, the read-back reports OLD bytes that verify on
their own but paths that exclude the canonical name,
`describeSnapshotCommitFacts` says `stateChanged === false` with no
invented reason, and the worktree holds NEW in the committed
spelling's physical file. Prove-red: with the guard reverted
(`421a42ca...` -> `2556bfee...`) the test is red (the canonical name
is reported); restored byte-exact. Two STATE.md spellings keep the
read-back fail-closed by controller decision; the escalation skip
below covers directory levels only (see the narrowing note).

B3 (entry-file wedge, `project-docs.ts:503`,
`build-runtime.ts:525`): the gate compared the redirect target to
exactly `CLAUDE.md`, so `AGENTS.md` (or `agents.md`) linked to a
lowercase `claude.md` paused with `handoff_snapshot_failed` every
attempt. Both identity checks fold case now (the fold applies only to
the comparison; link detection and the redirect itself still require
the exact index entry). The reviewer's checked fix, verbatim. Tests:
`entry-links.test.ts` B3-L09/L10 (manager commit through the
factory-built port plus the shared describer and
`handoffEntryFileStatus`, asserting both lines committed, the commit
holding `claude.md` + `docs/project/STATE.md`, clean status, and an
untouched project). Prove-red: with both folds reverted
(`359f5587...` -> `68b570db...`, `98f9290c...` -> `c1827407...`)
B3-L09 is red (gate returns null); both restored byte-exact. The
reviewer's 16-layout matrix (`m1.test.mts`, reused read-only from the
r1 scratchpad against the patched tree) passes 16/16 accept —
L09/L10 flip from pause to accept, L07/L08 now commit only
`agents.md` + `docs/project/STATE.md` (the m-1 fix below satisfies
the pointer through the link instead of merging it).

Escalation, colliding `docs/` + `Docs/` directories (CD-15): every
attempt wedged on the STATE.md pathspec (the write stages under the
other spelling). The kernel now skips STATE.md with the shared
commit-tree-derived `handoffStateSkipReason` (as CD-17 does):
`commitStateLinkComponents` (`:2559`) and
`commitStateNonLinkBlocker` (`:2617`, new kind `case-collision`)
report a directory-level case collision the way they report a link,
via the shared `commitTreeEntryResolved` level helper (`:2851`;
exact-first on sensitive checkouts, one folded multi-name `ls-tree`
on insensitive ones — the same call the miss path already spent, so
the common path adds no call and misses spend one fewer). The AR-R05
gate accepts the recorded reason unchanged. The v1 Architect path
refuses with a clear error naming the two spellings (`:1147`) and is
otherwise unchanged. Test: `project-links.test.ts:1245` (C-1 shape:
1 snapshot, `stateSkippedReason ===
handoffStateSkipReason("docs")`, empty digest, commit holds only the
entry files, no STATE.md under either spelling, owner selection
completes). Narrowing found by validation: reporting the collision
at the STATE.md file level too skipped the FA-1 write and made the
B2 probe unstatable, so only directory levels report (a guard
`level < parts.length - 1` in both walks); two STATE.md spellings
stay B2 fail-closed.

Escalation, colliding entry files (CD-15): `AGENTS.md` + `agents.md`
both tracked substituted one entry's bytes for the other's and paused
every attempt at the gate with a dirty tree. The kernel now skips the
colliding non-link entry with the recorded
`handoffEntryCollisionSkipReason` (`project-docs.ts:441`, the single
wording source for stager and tree re-description):
`commitEntryCollisionSpellings` (`:2876`, one 512-pathspec `ls-tree`
for both entries, zero calls on a sensitive checkout) feeds a
once-per-snapshot HEAD lookup at stage time (`:1068`) and the commit
facts in `documentCommitResult` (`:2520`); reuse/withdrawn commits
re-derive the identical wording from the same facts
(`commitEntrySkipReasonsFromTree` `:2668`, link layouts keep link
wording first). The describer accepts a stage skip only with the
tree's corroborating spellings (`project-docs.ts:602-625`), and
`handoffEntryFileStatus` accepts the recorded skip on the same
corroboration (`build-runtime.ts:500-501,536-537`); anything else
still pauses fail-closed. Test: `entry-links.test.ts:886` (C-2
shape: 1 snapshot, `agentsSectionCommitted === false` with the
tree-derived reason, `claudeLineCommitted === true`, commit holds
`CLAUDE.md` + `docs/project/STATE.md`, both colliding bytes
untouched, owner selection completes). Scope note: the escalation's
gate acceptance needs the two describer/gate hunks above; they are
escalation-only (B3's own hunks are the two one-line folds). The v1
Architect path never skips a colliding entry (its completion gate
could not accept the skip) and is unchanged.

Minors: m-1 (`:3698`, M-6 set): `linkTargetPointsAtAgentsDotMd` folds
(a link to the index's own `agents.md` satisfies the pointer through
the link) and the M-6 omission compares folded — L07/L08 no longer
self-import. m-2 (`:760`): the dropped-spec skip record keeps the
canonical path (the runtime matches
`entry.path.startsWith("docs/project/specs/")` exactly). m-5: the v1
DOCS-dir test carries a linux skip guard (the write aliases into
`Docs/`), as do FA-1, B3-L09/L10, C-1, and C-2 (all need a
case-insensitive checkout); the DOCS-dir control and all pre-existing
tests are unguarded and unchanged. m-6: the README fact is recorded
in B1 above. m-4: no extra `child_process` in product code (one
`ls-tree` per new lookup, all through the audited executor); the
count after the change is 48 manager git calls per snapshot with
`docs/` present (was 43 at HEAD) and 44 with an empty repo (was 39),
+0 on a case-sensitive checkout. Attributed by a before/after
command tally (pristine-HEAD manager in /tmp against the patched
tree): B1's miss walk +4 (exact `cat-file` still first, so +0 when
the README exists), the two collision lookups +2 (stage prefetch and
commit facts, insensitive only), minus 1 from the folded-all
consolidation on miss levels. Every added call is load-bearing
(`ls-tree` has no `icase` magic — verified: `pathspec magic not
supported by this command` — so the walk cannot be a one-shot).
Known wording limit, disclosed: a directory-collision skip records
the shared `handoffStateSkipReason` ("symbolic link or junction"),
following the C2e F-matrix precedent for non-link blockers; a
distinct collision wording would need a describer reason the packet
scope does not cover.

Per-item tests (all through `openFactoryPort` with
`core.ignorecase=true`, real SQLite and real git; nothing written
outside the repository in any test; LF; no harness change —
additive helpers were not needed):

| Item | Test |
|---|---|
| B1 + v1 completion facts | `project-doc-commit.test.ts:1444` (extended: readme facts + `buildCompletionReadiness` ready) and `:1503` (exact-`docs/` control) |
| B2 FA-1 fail-closed | `docs-policy-v2-handoff-project-links.test.ts:1175` |
| B3 lowercase targets | `docs-policy-v2-handoff-entry-links.test.ts` B3-L09/L10 loop + reviewer 16/16 matrix probe (scratch, read-only reuse) |
| Escalation C-1 colliding dirs | `docs-policy-v2-handoff-project-links.test.ts:1245` |
| Escalation C-2 colliding entries | `docs-policy-v2-handoff-entry-links.test.ts:886` |

## Validation (repair cycle 1, final bytes)

- New tests by name: B1 pair, B3 pair, FA-1, C-1, C-2 — all green
  (B3 ~73-100 s, FA-1 ~73 s, C-1 ~92 s, C-2 ~79 s, B1 ~6-13 s each
  on this machine).
- `docs-policy-v2-handoff-entry-links.test.ts`: 24/24 green, exit 0
  (21 existing incl. F-LC-agents, D-rd-lcagents, D-rd-collide,
  C2e/m-4, plus B3-L09, B3-L10, C-2), `--test-concurrency=4`.
- `docs-policy-v2-handoff-project-links.test.ts`: 22/22 green,
  exit 0 (20 existing incl. DOCS-dir, D-walk-projdir, F-collide,
  F-docs-file, F-project-file, F-state-dir, plus FA-1, C-1),
  `--test-concurrency=4`.
- `docs-policy-v2-handoff-retry.test.ts` (22 tests) +
  `integration-manager.test.ts` (36 tests): combined run exit 0,
  `--test-concurrency=4` (reuse/withdrawn paths green under the new
  re-derivation and describer rules).
- `project-doc-commit.test.ts`: 21/21 green in 101 s,
  `--test-concurrency=4`.
- `tsc -p runner-v2/tsconfig.json --noEmit`: clean. `eslint` on all
  six changed files: clean. `git diff --check`: clean for the packet
  files (the only hits are pre-existing trailing whitespace in
  `evidence/muse-pipeline-2026-09-29.md`, modified before this
  repair and outside the writable set).
- Not run (per the packet brief): the large-tree file and the
  native-delivery files — the controller runs them.

## Changed files (sha256, final bytes)

- `421a42caa41bd750fb6c394e57565a7db3cddaf6860a72defa89dcb260769a03` runner-v2/src/integration-manager.ts
- `359f55877aa4b0bbc58a5fc83344b60c098dfa87804a1efd572024ac9214d1b3` runner-v2/src/project-docs.ts
- `98f9290cb4af3d9d6257b3e00a22c046efb9a025557612c0882c10d7ff7c04a4` runner-v2/src/build-runtime.ts
- `a983d81345b269f0251c812b0377ed152fcf786ca6562188550ca39b2afc21c6` runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts
- `0064e61867759f0b021ea2fc96eeae9789a6a7cbf434c38ae86ceb8df100a128` runner-v2/test/docs-policy-v2-handoff-project-links.test.ts
- `3cf2a050bcfbbf7fdd69db45cfb313bbeeb76a0c71cce53402a8e4461ed954e8` runner-v2/test/project-doc-commit.test.ts

Encoding: LF, no BOM. No events added, removed, or reworded; every
stored log replays unchanged (proven by the untouched-file suites
above). No commits, stages, stashes, or pushes.

## Not done / limits (repair cycle 1)

- v1 Architect colliding layouts: a colliding `docs`/`Docs` tree or
  colliding entry files on the v1 path refuse (STATE.md) or report
  missing facts (entries) instead of skipping — the v1 completion
  gate could not accept a skip, so only the kernel (AR-R05) skips.
  The kernel is the CD-15 run-handoff path the controller decided.
- Two STATE.md spellings (B2/FA-1) pause fail-closed on every
  attempt by controller decision; reachable only through index
  plumbing (a worker change under `docs/project` is still refused
  before cherry-pick).
- A link spelling plus a regular sibling (say `AGENTS.md` as a link
  with `agents.md` regular) keeps the link machinery on both the
  fresh and reuse paths; the collision skip fires for non-link
  entries only, so no working redirect regresses.
