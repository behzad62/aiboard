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
