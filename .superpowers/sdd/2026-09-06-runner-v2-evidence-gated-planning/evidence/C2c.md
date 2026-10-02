# C2c evidence — docs hardening (CD-15, CD-16)

Base: `62362265` (`codex/runner-v2-p6-6`). Lane A implementation worker.
No commits, stages, stashes, pushes, or PRs; all changes uncommitted.
(The `progress.md` working-tree modification predates this session.)

Scope note: the controller split C2c into two runs. This file's "Part 1"
covers NF-1 and NF-4 only (spec-copy hardening). Part 2 covers the link
items NF-2/NF-3/NF-5 and NF-7; nothing in this part touches link handling,
the AR-R05 gate, prompts, planning tools, UI/client, package files, or
`progress.md`.

## Part 1 — spec-copy hardening (NF-1, NF-4)

### NF-1: a gitignored specs dir never fails the snapshot

Root cause (C2b review r3, probe K-ignored): `commitHandoffSnapshot`
staged every path in one batch `git add`. With `docs/project/specs/`
gitignored, the add refused the spec path and failed the whole batch, so
every attempt paused with `handoff_snapshot_failed` and the run wedged
(0 snapshots, owner refused).

Change (`runner-v2/src/integration-manager.ts:696-749`): the spec copy
stages in its own `git add` (entry paths first, still strict). A failing
spec add drops only the spec paths from the commit and records one
`spec copy skipped (write_failed): git add failed for <path> (<git
detail>).` entry per path on the commit result; the runtime maps it to
`specCopySkipped: "write_failed"` (the reason carries no `(path_occupied)`
marker). STATE.md and the entry lines still commit. No new git command
and no `child_process`: the extra add runs through the audited `this.git`
path with `allowFailure`, like every other read.

Test (`runner-v2/test/docs-policy-v2-handoff.test.ts:3827`, "C2c
NF-1/probe K-ignored"): factory-port run (`openFactoryPort`, the docs
port `NativeBuildFactory.create` builds, never hand-built), real SQLite
and git, `.gitignore` holding `docs/project/specs/` committed to the
integration worktree. 1 snapshot, `specCopySkipped: "write_failed"`, no
`specCopied`, no `specPath`, commit files exactly `[AGENTS.md,
CLAUDE.md, docs/project/STATE.md]`, handoff selects `completed`.

### NF-4: the `spec:` line names the real copy

Root cause (C2b review r3): STATE.md rendered before staging decided the
spec path, so the `spec:` line could name a path the commit does not
hold (K: the bare target; K2: the user's own file instead of the digest
sibling; K2b: the user's file while the event carried that path with
`specCopySkipped: "path_occupied"`, against the field doc "Absent when
no copy was written").

Change (`runner-v2/src/build-runtime.ts:2265-2283`,
`resolveHandoffSpecCopyPath` at `:2438-2468`): the final spec path is
decided from the integration tip blobs before rendering, through the
existing required port method `readIntegrationTipFile` (no new port
method, no factory change). Absent target: the copy lands there. Target
holding the wanted bytes: the tree already holds it, so no write is
needed and the line still names it. Target holding other bytes: the copy
moves to the digest-suffixed sibling (the same name kernel staging uses),
unless that is taken too, when the copy is skipped as `path_occupied`.
An unreadable tip skips the copy as `spec_tip_unreadable` with a reason
instead of failing the snapshot. On any skip the facts omit `specPath`,
so STATE.md renders `spec: not recorded`. Event rule (`:2385-2390`):
`commitClaim.specPath ?? (specWrite !== undefined ? undefined :
specPath)` — a copy that was attempted but landed nowhere (the NF-1
dropped add) omits `specPath` while the skip reason is still recorded;
the already-a-repository-file path still records its repo path.

Tests (all factory-port, real SQLite/git):
- K (`C2b: the verbatim spec copy is committed when due`, pre-existing):
  unchanged assertions still green — event `specPath` is the target,
  `specCopied: true`, STATE.md names the target.
- K2 (`C2b repair N-2/probe K2`, extended at `:3814-3817`): STATE.md now
  asserts `spec: docs/project/specs/source_value-<digest>.md`, the real
  copy; event `specPath` is the sibling; the user's file survives.
- K2b (new, `:3876`, "C2c NF-4/probe K2b"): target and digest sibling
  both hold other bytes. 1 snapshot, `specCopySkipped:
  "path_occupied"`, no `specCopied`, no `specPath`, STATE.md holds
  `spec: not recorded`, commit files entry-only, selection completes.
- Tip-unreadable (new, `:3931`): spec tip reads throw (STATE.md tip read
  intact). 1 snapshot, `specCopySkipped: "spec_tip_unreadable"`, no
  `specPath`, `spec: not recorded`, selection completes.

### Changed files (sha256, final bytes)

- `69fb11a471ae5c24c9e2ab8b1ff24848723d1aa36e8d8a421a1a88763ebc3869` runner-v2/src/integration-manager.ts
- `3d1f95149d82598ee9398822911c8fed326a07320a7b4a2523c8cf93511216e0` runner-v2/src/build-runtime.ts
- `eb33989aa79cea498df2bd0d4a3af559f5b4a5e4e54eef7dbb413744af27ff11` runner-v2/test/docs-policy-v2-handoff.test.ts

Encoding: all three files LF with zero mixed endings, same as their HEAD
bytes (HEAD lone-LF counts 2608/4576/3932; current 2629/4637/4090 — the
deltas are the hunks above). No BOM, no non-ASCII change. `git diff
--check` clean.

### Suites (worker-run, NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- docs-policy-v2-handoff.test.ts: 47/47 (44 pre-existing + 3 new).
- integration-manager + project-doc-commit + replay-compatibility +
  git/lsp/mcp-caller-audit + one-shot-command-routing-static +
  static-adapter-policy: 96/96 aggregate, 0 fail.
- build-runtime.test.ts: 28/28.
- runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- eslint on all 3 changed files: exit 0.
- native-delivery-factory: NOT run in this part (per brief; the
  controller runs it after part 2).

### Prove-red records (sha256 before/after, byte-exact restore)

Backups held outside the repo; restores copied back and re-hashed.

1. Single batch `git add` (pre-C2c behavior):
   `69fb11a4...` -> `4cd19cf9027defcdef47010a833c5c8d87c79db4f6c19630d2a9c4cd9b7d9ce3`
   (NF-1 block replaced with one `git add -- ...paths`). K-ignored went
   red: `0 !== 1` ("the ignored copy never fails the snapshot commit" —
   the snapshot never commits). Restored; sha again `69fb11a4...`
   (match).
2. Render STATE.md before deciding the spec path (pre-C2c behavior):
   `3d1f9514...` -> `9e66c1589714e3d70f76e961556c58216bf9048efe3dd178d8c8fe7a9a16ec41`
   (resolution bypassed to always target+write). K2 went red
   (`specPath`/sibling mismatch) and K2b went red ("the snapshot records
   no spec path" false — the render named the occupied target).
   Restored; sha again `3d1f9514...` (match).

### Not done / limits

- K-ignored residual: the `spec:` line still names the intended target
  path while the commit holds no copy (the ignore outcome is known only
  at stage time, after the render; deciding it earlier would need a new
  port method and factory wiring, outside this part's writable set). The
  event is exact (`specCopySkipped` with the git reason, no `specPath`,
  no `specCopied`), and the brief's K-ignored assertions
  (commits/skipped/completes) hold.
- Part 2 owns NF-2/NF-3/NF-5/NF-7; the live-worktree OR in
  `documentCommitResult` and the v1 link refusal are untouched.
- Full 279-file suite not run: the brief's named suites above (171 tests
  total, all green).

## Part 2 — entry-file links and evidence (NF-2, NF-3, NF-5, NF-7, part-1 residual)

Base: `62362265` plus the uncommitted Part 1 above. Lane A
implementation worker. No commits, stages, stashes, pushes, or PRs; all
changes uncommitted. (The `progress.md` working-tree modification
predates this session.)

Scope note: Part 1 (NF-1, NF-4) is kept byte-identical in behavior; the
only Part-1 test touched is the K-ignored residual assertion (now
`spec: not recorded`). The m5 test is changed as NF-3 requires (the link
is committed; factory port). Part-1 evidence shas below are re-listed
because Part 2 edits the same files.

### NF-2 per CD-15: the runner never writes through a link

Change (`runner-v2/src/integration-manager.ts`, `stageProjectDocWrites`
at `:959`, kernel path only):
- An AGENTS.md/CLAUDE.md write whose entry file is a link -- a real
  worktree symlink (`entryLinkRawTarget` at `:2415`, readlink) or a git
  link entry, mode 120000, checked out as a plain file
  (`core.symlinks=false`, index blob) -- resolves its raw target
  (`resolveEntryLinkTarget` at `:2722`: dot-only spellings resolve;
  absolute, drive-letter, backslash, and any `..` escape return null).
- A target that is a regular tracked file inside the repository
  (`isEntryLinkRedirectTarget` at `:2447`: index mode present and not
  120000, on-disk regular file and not itself a link, never a spec-copy
  or STATE.md path) receives the marked section spliced into the TARGET
  path directly (`:959-1050`); the redirect is recorded
  (`redirected: [{ path, target, reason }]`, propagated onto the commit
  result at `:750`). The existing CLAUDE-links-to-AGENTS skip is kept
  verbatim (checked first, same reason string).
- Any other link (missing, outside, untracked, itself-a-link, or a
  kernel-owned target) skips that entry file with a recorded reason
  naming the raw target and why.
- Two entry writes landing on one physical file (AGENTS.md linking to
  CLAUDE.md) merge into one marked section, AGENTS.md body first and the
  pointer line on its own line after it, so both v2 checks read true
  from the merged section. No other write combination can collide.
- The v1 Architect path (`commitProjectDocuments`,
  `skipClaudeAgentsLink: false`) is untouched: every link still throws
  in `refuseProjectDocLink` exactly as before (see NF-5).

Commit-tree proof (`documentCommitResult` at `:2249`): per entry file
the commit tree contributes its raw link target if mode 120000
(`commitEntryLinkTarget` at `:2375`, `agentsLinkTarget` /
`claudeLinkTarget` on the entry point) plus a ViaLink flag when the
regular-file target blob (single hop) holds the marked section or line
(`commitEntryTargetHoldsSection` at `:2391`, `agentsSectionV2ViaLink` /
`claudePointerV2ViaLink`; the legacy `claudePointerV2ViaAgentsLink`
kept). Types in `runner-v2/src/project-docs.ts` (`:187-210`).

Gate (`runner-v2/src/scheduler-store.ts`, gate only): the record gains
`agentsSectionViaLink` (`:432`); the reducer accepts each entry file by
its committed flag or its recorded link reason (`:9273-9281`, reason
validated non-empty) and records both (`:9310-9316`); the AR-R05 gate
(`handoffSnapshotAtCurrentStop` at `:9142`) accepts the recorded reason
for that file. STATE.md stays required throughout.

Runtime (`runner-v2/src/build-runtime.ts`, `handoffEntryFileStatus` at
`:471`, shared by the current stop at `:2445` and withdrawn-stop
reconciliation at `:2667`): direct, via-link (redirect reasons count
only with their ViaLink proof), or legacy CLAUDE-to-AGENTS satisfy the
file; otherwise the recorded skip reason satisfies it only when the
commit tree corroborates the link (`agentsLinkTarget` /
`claudeLinkTarget` present) -- anything else pauses fail-closed. The
event carries `agentsSectionViaLink`/`claudeLineViaLink` and explicit
`false` committed flags for skipped files (`:2500-2503`,
`appendHandoffSnapshotCommitted` at `:2737-2762`).

Tests (all through `NativeBuildManager` with the docs port
`NativeBuildFactory.create` builds, real SQLite and git, in
`runner-v2/test/docs-policy-v2-handoff.test.ts`):
- L2 (`C2c NF-2/probe L2`): link-mode AGENTS.md to CLAUDE.md
  (`core.symlinks=false`, index 120000, committed). The section is
  written into CLAUDE.md (merged with the pointer line; the target's
  own bytes survive), `agentsSectionViaLink` names the target,
  `agentsSectionCommitted: true`, the worktree link file still holds
  `CLAUDE.md`, commit files `[CLAUDE.md, docs/project/STATE.md]`,
  handoff completes.
- L2-real (`C2c NF-2/probe L2-real`): a real committed AGENTS.md
  symlink. Same assertions plus the link stays a link afterwards.
- L3 (`C2c NF-2/probe L3`): link-mode CLAUDE.md to NOTES.md (another
  tracked regular file). The line is written into NOTES.md
  (`claudeLineViaLink` names it), commit files
  `[AGENTS.md, NOTES.md, docs/project/STATE.md]`, handoff completes.
- Missing target: committed AGENTS.md link to MISSING.md. Skipped with
  `... is not a regular tracked file`, `agentsSectionCommitted:
  false`, commit entry-only, handoff completes.
- Outside target: committed AGENTS.md link to `../outside.md`. Skipped
  with `... is outside the repository`, handoff completes.
- No layout wedges: every layout above (and both links skipped at once
  by construction) still commits STATE.md and completes.

### NF-3: the gate reads link facts from the commit tree only

Change (`documentCommitResult` at `:2249`): the
`|| (await this.claudeLinksAgents())` live worktree/index fallback is
deleted. The legacy CLAUDE-to-AGENTS flag now comes from the commit
tree alone (`commitEntryLinkTarget`), like every other link fact.

Test changes: the m5 test is rewritten as `C2b repair m5: a committed
CLAUDE.md link ...` on the factory port -- symlink committed with
`git add` (mode 120000 asserted) instead of the old untracked-worktree
layout -- with the same reason assertion plus a commit-tree 120000
assertion. The old layout becomes refusal probe U1.

Tests (factory port, real SQLite/git):
- U1 (`C2c NF-3/probe U1`): untracked worktree CLAUDE.md symlink, the
  commit tree holds no CLAUDE.md. 0 snapshots,
  `handoff_snapshot_failed`, the owner's selection is refused
  (`/kernel handoff snapshot/`).
- U2 (`C2c NF-3/probe U2`): tracked regular CLAUDE.md without the line,
  replaced in the worktree by an uncommitted symlink. 0 snapshots,
  paused, selection refused, the link never written through.

### Part-1 residual: K-ignored now renders `spec: not recorded`

Change: new required port method `canStageSpecPath({ path, content })`
(`runner-v2/src/build-runtime.ts:556`; implemented in
`runner-v2/src/integration-manager.ts:2544`; wired in
`NativeBuildFactory`'s docs port at
`runner-v2/src/native-build-factory.ts:1708`, factory wiring only). The
check stages the copy's bytes as a worktree preview (written only when
the path is absent, never over existing bytes), then answers with a
dry-run `git add` -- which stages nothing -- predicting the stage-time
add exactly. `git check-ignore` would answer this directly but sits
outside the Runner Git policy (`git-execution-policy.ts`
`ALLOWED_COMMANDS`), so the dry-run add is the policy-held equivalent.
The runtime asks after resolving the spec path and before rendering
(`runner-v2/src/build-runtime.ts:2352-2368`): an unstageable path
skips the copy as `write_failed` with no `specPath`, so STATE.md
renders `spec: not recorded`; the event matches the NF-1 outcome. An
unreadable answer defers to the stage-time truth (the separate spec
`git add` still drops it). Every other `ProjectDocsPort` literal in the
test tree carries the method (delegate where an integration manager is
in scope, behavior-preserving stub otherwise); the P1 factory-port test
now asserts all nine keys.

Test: the K-ignored test gains the STATE.md assertion (`spec: not
recorded`); all other K-ignored assertions unchanged.

### NF-5: the v1 link-mode refusal is declared

The v1 Architect path (`commitProjectDocuments`,
`skipClaudeAgentsLink: false`) refuses a link-mode CLAUDE.md checked
out as a plain file (`core.symlinks=false`): `refuseProjectDocLink`
consults the worktree lstat AND the index modes, so mode 120000 still
throws the unchanged message although the write-through it prevents
(lstat-only detection) is gone. Strictly safer than HEAD, and the only
v1 behavior change in this packet.

Test (`runner-v2/test/project-doc-commit.test.ts`, `C2c NF-5 ...`):
link-mode CLAUDE.md to AGENTS.md, checked out as a plain file holding
`AGENTS.md`, index 120000. `commitProjectDocuments` rejects with the
exact historical refusal, the rev-list count is unchanged, and the
checkout bytes are untouched.

### NF-7: evidence correction

`evidence/C2b.md` "Corrected claims" fixture note (NF-7 correction
only; no other C2b.md change): the "mirroring what the production
manager records before completion" clause was inaccurate -- only the
runtime records `build.risk_assessed` (`build-runtime.ts`, key
`build-risk:<revision>`); the manager records nothing. Packet FX-1
removed the re-seed (`risk:rerun-low`); the harness now re-assesses
through the real kernel derivation.

### Changed files (sha256, final bytes, parts 1 and 2 together)

Part-1 files changed again in part 2 (new hashes supersede the Part-1
section); the rest are new in part 2.

- `82e99de9cf6a9fc1e1b1bbb2234565f96b044d1bfafd1a97f7a110f5347349de` runner-v2/src/integration-manager.ts
- `f67e0e383ecb99d4f00163cd10cb026eaf382dec3858e8ab05194543fde9e665` runner-v2/src/build-runtime.ts
- `eb1ab45fe307e3d6cb96d4fcb5c87d7bde1f51827939cf41bbccdbc4b8ca625f` runner-v2/src/project-docs.ts
- `15fe17b13660b3b4bed46d261d20705e9d95853a6ea280d01e09c5dc9a262f08` runner-v2/src/scheduler-store.ts
- `1980602e6e15608c820e50febd0f03498897ec5b09bc453f28ab55348df78daa` runner-v2/src/native-build-factory.ts
- `fc72ded8537c335914c164504daa70e2e06f999aaf71b6b7318022570ab8ae27` runner-v2/test/docs-policy-v2-handoff.test.ts
- `4c058ab5a3191b97e478851286e6ef2ff243c4f18e02116d927be0b0813e5a40` runner-v2/test/project-doc-commit.test.ts
- `44362f5b2ddd8cf2ea14357ffc8cede21dfdaf9fd0a783d5fed5c4648c0f2aa6` runner-v2/test/build-runtime.test.ts
- `837a508684408dc41d5e1d787ce86df5f5c11303106ee3fba70731c53b85a977` runner-v2/test/request-triage.test.ts
- `1e69a8f28c5fbb376c8213b3e4ae8a7aee88c090bf24f6a293f2db60b13035f3` runner-v2/test/handoff-rerequest.test.ts
- `6026d3830a3e71be98a9cd19cdc44c62d91651876ab4a5b2f46a0342fe42a68e` runner-v2/test/build-risk-reassessment.test.ts
- `16706bf554d87f36e346aa4f5072a3c9ff56b1474988c2a86e57abb3722a48b8` evidence/C2b.md (NF-7 correction only)
- `9ea0018f4b14928a0a5079f6c86281cadc31ea7858a1bd950722beea05bd69d4` evidence/C2c.md (this file excluding this bullet: a file cannot contain its own hash; every other byte is final)

Encoding: project-docs.ts kept CRLF with zero lone LF; every other
touched file LF with zero mixed endings; no BOM anywhere. `git diff
--check` clean.

### Suites (worker-run, NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- docs-policy-v2-handoff.test.ts: 54/54 (47 part-1 incl. m5 rewrite + 7
  new: L2, L2-real, L3, missing-target, outside-target, U1, U2).
- project-doc-commit.test.ts: 18/18 (incl. the new NF-5 link-mode
  refusal).
- project-docs + handoff-snapshot: 73/73.
- build-runtime.test.ts: 28/28. scheduler-store.test.ts: 31/31.
- integration-manager + handoff-rerequest: 44/44.
- build-risk-reassessment + request-triage: 39/39.
- native-build-manager + replay-compatibility + git/lsp/mcp-caller-audit
  + one-shot-command-routing-static + static-adapter-policy: 100/100.
- native-delivery-factory.test.ts (long): 17/17, exit 0, on the final
  bytes (~26 min). The two prove-red mutations below were applied and
  restored byte-exact while this suite was running; the suite process
  imports sources at startup and its summary is fail 0 on bytes
  identical before and after.
- runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- eslint on all 11 changed code/test files: exit 0.
- `git diff --check`: clean.
- Not run: the full 279-file suite; the brief's named suites plus the
  importer suites above (404 tests total, all green).

### Prove-red records (sha256 before/after, byte-exact restore)

Backups held outside the repo (runtime temp); restores copied back and
re-hashed to the before value.

1. Restore the worktree link fallback in the gate
   (`documentCommitResult` gains `if ((await
   this.claudeLinksAgents())) entryPoint.claudePointerV2ViaAgentsLink =
   true`):
   `82e99de9cf6a9fc1e1b1bbb2234565f96b044d1bfafd1a97f7a110f5347349de`
   -> `22c58d38b0843fa3d7a7303c7365e4064e6d781642baeeab0ee4239a64e06526`.
   U1 goes red: 1 snapshot recorded vs 0 expected (the false gate
   acceptance the fallback allows). Restored; sha again `82e99de9...`
   (match).
2. Write through the link instead of the target (redirected ops keep
   `physicalPath: write.path`):
   `82e99de9cf6a9fc1e1b1bbb2234565f96b044d1bfafd1a97f7a110f5347349de`
   -> `23cd0a40e74a1023aa81ea11c61144b8738f9e934d6934c3fe8b0abfc04dcacb`.
   L2-real goes red: 0 snapshots vs 1 (the through-link write lets the
   pointer splice clobber the section under the same markers, so the
   commit tree proves nothing and the run pauses fail-closed).
   Restored; sha again `82e99de9...` (match).

### Not done / limits

- `git check-ignore` is deliberately NOT used for the pre-render
  stageability check: it sits outside the Runner Git policy
  (`git-execution-policy.ts` `ALLOWED_COMMANDS`), so the port answers
  with a worktree preview plus a dry-run `git add` instead (first
  implemented with `check-ignore`, caught by the policy in the K-ignored
  run, then reworked; K-ignored is green on the final bytes).
- Chained entry links (a link whose target is itself a link) skip the
  entry file with a recorded reason instead of following the chain, by
  construction; single-hop redirects verify from the commit tree.
- A redirect target can never be a spec-copy path or STATE.md (refused
  as a redirect target, skipped with a reason instead), so entry
  staging and the spec commit path cannot collide.
- C2b.md line 209 (the m5/B3 "live worktree determination" note) is now
  superseded by NF-3 but left untouched: this packet's C2b.md writ is
  NF-7 only, and the supersession is recorded here instead.
- Full 279-file suite not run (see Suites).
- Nothing committed, staged, stashed, or pushed; all changes
  uncommitted.

## Repair cycle 1, part A — spec-copy preview and the reuse path (BL-1, BL-2, M-3, M-4)

Base: `62362265` plus the uncommitted C2c above (part-A worker starts
from the reviewed bytes). Lane A implementation worker, repair run 1 of
2 (part B owns link-path hardening). No commits, stages, stashes,
pushes, or PRs; all changes uncommitted.

Scope: the spec-copy preview and the commit-reuse path only.
`refuseProjectDocLink`, entry-link resolution/redirects, the gate, the
factory wiring, and every other file are untouched.

### BL-1 + M-3: the preview write is gone

Root cause (review r1): `canStageSpecPath` wrote the copy's bytes as a
worktree preview before any link check, so a committed directory link
at `docs/project/specs` (or `docs/project`) carried the approved spec
outside the repository; the check also left `??`/`!!` preview files
behind (M-3).

Change (`runner-v2/src/integration-manager.ts:2517-2593`): the check
writes nothing, ever. It validates the path, refuses when any component
from the repository root down (`docs`, `docs/project`,
`docs/project/specs`, the file itself) is a link -- worktree lstat AND
index mode 120000, so a link-mode entry checked out as a plain file
under `core.symlinks=false` still refuses (`specPathHasLinkComponent`
at `:2568`) -- then answers with `git add --dry-run --ignore-missing`,
which stages nothing and predicts the stage-time add exactly (ignored
paths refuse with exit 1, normal missing paths pass with exit 0, paths
beyond a link fail with 128; verified in a scratch repo). The
non-interactive `add` is allowed by the Runner git policy
(`git-execution-policy.ts:121` refuses only interactive modes). The
stage-time `refuseProjectDocLink` in `stageHandoffSpecCopies` still
refuses independently, so the commit path is doubly guarded.

Tests (factory port, real SQLite/git, links made with git and checked
out as real links under `core.symlinks=true`):
- A1 (`docs-policy-v2-handoff.test.ts:4409`): committed
  `docs/project/specs` link to an absolute outside directory, spec copy
  due. Outside directory stays empty, 1 snapshot,
  `specCopySkipped: "write_failed"`, no `specPath`, commit files
  entry-only, STATE.md `spec: not recorded`, handoff completes.
- A2 (`:4447`): same with a relative outside target. Same assertions.
- A3 (`:4486`): committed `docs/project` link, spec copy due. Nothing
  is written outside; the run pauses fail-closed with
  `handoff_snapshot_failed` (STATE.md cannot stage through a link) and
  the selection is refused. Completion for this layout needs the Part-B
  link-path hardening (the review's pre-existing A3n, escalated); the
  Part-A guarantee -- no outside write -- holds.
- E1/E2 (`:4590`): direct port calls on ignored and normal paths change
  neither `git status --porcelain --ignored` nor the index, and no
  preview file exists afterwards.

### BL-2: the reuse path re-describes skip reasons from the commit tree

Root cause (review r1): a reused snapshot commit carries no
stage-time `skipped`/`redirected`, so `handoffEntryFileStatus`
returned null and every resume of a CD-15 skip layout paused again.

Change (`runner-v2/src/build-runtime.ts:2445-2466`): the current-stop
path keeps stage-time reasons first, and a missing entry-file reason
falls back to a commit-tree re-description in the withdrawn-stop
wording (`... is a symbolic link to <target>; the entry is skipped
(the target holds no ...)`). Direct and via-link facts already come
from the tree; `handoffEntryFileStatus` still requires commit-tree
corroboration, so nothing unproven is accepted.

Tests (factory port, `failNextSnapshotReadOnce` after the commit lands):
- B1 (`docs-policy-v2-handoff.test.ts:4517`): link-mode AGENTS.md to
  `MISSING.md`. First attempt pauses with 0 snapshots and the commit
  landed; resume reuses it (rev-list count unchanged), records the
  tree-derived skip reason (`agentsSectionCommitted: false`), and the
  handoff completes.
- B1c (`:4554`): link-mode CLAUDE.md to `../outside.md`. Same shape,
  `claudeLineCommitted: false`, completes with the commit reused.

### M-4: the stager honors the resolved path

Root cause (review r1, probe E3): the resolver decided from tip blobs
while the stager re-decided from worktree bytes, so an untracked file
with other bytes at the target gave STATE.md `spec: <target>` with the
commit holding the digest sibling.

Change: `writeHandoffSpecCopy`
(`runner-v2/src/integration-manager.ts:796-816`) stages exactly the
runtime-resolved path, or skips it as `path_occupied` when it holds
different bytes -- it never diverts to a sibling of its own. The
pre-render check reports a worktree occupant as unstageable
(`canStageSpecPath` at `:2551-2552`), so the skip lands before STATE.md
renders. The digest-sibling decision stays where it was (the runtime
resolver, from tip blobs); every existing sibling test (K, K2, K2b)
still passes through it unchanged.

Test: E3 (`docs-policy-v2-handoff.test.ts:4614`): untracked other bytes
at the target, spec due. 1 snapshot, no `specCopied`, no `specPath`,
STATE.md `spec: not recorded`, commit files entry-only, the occupant
untouched, handoff completes.

### Changed files (sha256, final bytes)

- `f7542c8ec476e1c333025775ce87a94e8a8355e34c8e22974e53dedff89b4cb0` runner-v2/src/integration-manager.ts
- `7d6e314b1a24ddebe2092bdeceda0de08ae5254bd4e2c001575a92a7c9accc42` runner-v2/src/build-runtime.ts
- `9c804c98cfced9869ef4a37af8b4d269f9b561926a39dd4ad1fdc487a6a5bfa9` runner-v2/test/docs-policy-v2-handoff.test.ts
- (this file appended below the Part-2 hash bullet: a file cannot
  contain its own hash; every other byte is final)

Encoding: all three code/test files LF with zero mixed endings, no BOM.
`git diff --check` clean. No new files.

### Suites (worker-run, NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- docs-policy-v2-handoff.test.ts: 61/61 (54 pre-existing + 7 new:
  A1, A2, A3, B1, B1c, E1/E2, E3), on the final bytes.
- integration-manager + build-runtime + project-doc-commit +
  replay-compatibility + git/lsp/mcp-caller-audit: 117/117, 0 fail.
- runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- eslint on all 3 changed files: exit 0.
- `git diff --check`: clean.
- native-delivery-factory: NOT run in this part (per brief).

### Prove-red records (sha256 before/after, byte-exact restore)

Backups held under `/tmp` (outside the repo); restores copied back and
re-hashed to the before value; scratch files removed afterwards.

1. Preview write restored (mkdir + writeFile before the link check):
   `f7542c8e...` -> `9eb283182ab54f1ba0d64c5f52271b549bf3515881205a276679f86c8dd5d22d`.
   A1 went red: the outside directory held `["source_value.md"]`
   instead of `[]`. Restored; sha again `f7542c8e...` (match).
2. Commit-tree skip reasons dropped (stage-time reasons only):
   `7d6e314b...` -> `b0f9686edb0098e0f55f4038381217d497d8e95c47c6148647817966077bcc96`.
   B1 went red: 0 snapshots after resume (`0 !== 1`, the stuck run).
   Restored; sha again `7d6e314b...` (match).

### Not done / limits

- A3 completion (a committed `docs/project` link still wedges STATE.md
  staging) is the review's pre-existing A3n, escalated before T7a, and
  belongs to Part-B link-path hardening; Part A asserts the fail-closed
  behavior plus no outside write.
- M-1, M-2, M-5, M-6, M-7 and pre-existing A4 are untouched (Part B or
  out of scope).
- `native-build-factory.ts` and every other C2c file are byte-identical
  to the reviewed bytes; the `ProjectDocsPort` interface is unchanged,
  so no other test stub needed edits.
- Full 279-file suite not run (see Suites).
- Nothing committed, staged, stashed, or pushed; all changes
  uncommitted.

## Repair cycle 1, part B — link-path hardening (CD-17, M-1, M-2, M-5, M-6)

Base: `62362265` plus the uncommitted C2c (parts 1, 2) plus part A above.
Lane A implementation worker, repair run 2 of 2 (finishes C2c repair cycle
1). No commits, stages, stashes, pushes, or PRs; all changes uncommitted.

Scope: link-path hardening only. Part A (BL-1, BL-2, M-3, M-4) is kept
except the A3 test, which CD-17 promotes from fail-closed pause to
completion (the brief requires it). The split factory delivery files
(`native-delivery-factory.test.ts`,
`native-delivery-report-{counts,runners,paths}.test.ts`,
`support/delivery-factory-scenario.ts`) are untouched as instructed.

### CD-17 (review pre-existing A4, A3n): a linked docs folder never blocks or leaks

Change (`runner-v2/src/integration-manager.ts`):
- New `firstLinkComponent` (`:2641`): every component from the repository
  root down to the file itself, from the worktree (lstat) AND the index
  (mode 120000), with a readlink probe for Windows junctions (`isJunction`
  at `:2868`; lstat reports those as directories). `specPathHasLinkComponent`
  (`:2627`, BL-1) delegates to it.
- Kernel handoff path (`stageProjectDocWrites`, `:986`): a non-entry write
  under a linked component is skipped with `"<path> is not written:
  <component> is a symbolic link or junction; the handoff proceeds without
  it."` -- nothing is written under the link. Entry files live at the root
  and keep their CD-15 handling.
- `refuseProjectDocLink` (`:2674`): every component from the root (docs,
  docs/project, ...), so the v1 Architect path refuses a `docs` link with
  the unchanged message; v1 otherwise unchanged (still throws).
- `documentCommitResult` (`:2316`): commit-tree `dirLinks` (docs,
  docs/project, docs/project/specs held as mode 120000) for the
  commit-reuse path.

Change (`runner-v2/src/project-docs.ts:229`, CRLF preserved):
`dirLinks?: string[]` on `ProjectDocCommitResult`.

Change (`runner-v2/src/build-runtime.ts`): the current stop re-describes a
STATE.md skip from `result.dirLinks` when a reused commit carries no
stage-time reason (`:2446`, BL-2 pattern); a commit with no fresh STATE.md
but a recorded link reason records `bodyDigest: ""` with
`stateSkippedReason` instead of pausing (`:2463`); entry-file checks still
run first and still pause fail-closed (`:2517`). The withdrawn-stop
reconciliation records the same history shape (`:2738`).

Change (`runner-v2/src/scheduler-store.ts`, gate only):
`HandoffSnapshotRecord.stateSkippedReason` (`:414`); the reducer accepts it
(paths may omit STATE.md, digest may be `""`, `:9276-9339`);
`handoffSnapshotAtCurrentStop` accepts the recorded reason the way it
accepts `export_only` (`:9154`).

Tests (factory port, real SQLite/git, links made with git):
- A4 (`docs-policy-v2-handoff.test.ts:4561`): committed `docs` link to an
  absolute outside dir, spec due. Outside stays empty, 1 snapshot,
  `stateSkippedReason` names `docs`, `bodyDigest: ""`,
  `specCopySkipped: "write_failed"`, commit files `[AGENTS.md, CLAUDE.md]`,
  selection completes.
- A3 (`:4494`, rewritten, was fail-closed): committed `docs/project`
  link, spec due. Now 1 snapshot, completes, reason names `docs/project`.
- A3n (`:4531`): same layout with no spec due -- completes with a reason.
- v1 A4 (`project-doc-commit.test.ts:1444`): committed `docs` link; the v1
  Architect batch is refused (`... because docs is a symbolic link or
  junction.`), rev-list unchanged, nothing outside.
- Gate unit (`:1792`): a record with `stateSkippedReason` and no STATE.md
  passes; the reason-less no-STATE record still throws.

### M-1: a redirected entry-file write checks the target's directories

`isEntryLinkRedirectTarget` refuses when any ancestor component of the
target is a link (`integration-manager.ts:2496`, via `firstLinkComponent`
on the dirname), so a directory link or junction on the way to the target
refuses the redirect.

Test D1 (`docs-policy-v2-handoff.test.ts:4597`): tracked `sub/notes.md`,
worktree `sub` replaced out-of-band by a junction to an outside dir holding
its own `notes.md`, AGENTS.md link-mode to `sub/notes.md`. The outside file
is byte-identical afterwards, the entry is skipped with a reason,
1 snapshot, selection completes.

### M-2 (Windows): the index blob owns the link target; backslashes normalize

`entryLinkRawTarget` takes the target from the index blob when the index
holds mode 120000 (the commit-tree truth) instead of readlink
(`integration-manager.ts:2441`); `resolveEntryLinkTarget` normalizes `\` to
`/` first while still refusing absolute paths, drive letters, and every
`..` escape (`:2800`).

Test C9 (`docs-policy-v2-handoff.test.ts:4639`): AGENTS.md link entry
holding `docs\notes.md`, regular tracked `docs/notes.md`. The section is
written into the target (own bytes survive), `agentsSectionViaLink` names
`docs/notes.md`, the link bytes are untouched, selection completes.

### M-5: the skip reason names the real cause

`entryLinkSkipDetail` (`integration-manager.ts:2848`): a kernel-owned
target (`docs/project/STATE.md`, spec copies) says kernel-owned; a `..`
target that lexically resolves inside (`linkTargetResolvesInsideAllowingDotDot`
at `:2822`) says it uses `..` and is never followed; otherwise outside /
not-a-regular-file as before. Outcomes unchanged (still skips).

Tests: C11 (`:4676`, `sub/../CLAUDE.md` -- `..` wording, completes); C7
(`:4702`, tracked `docs/project/STATE.md` target -- kernel-owned wording,
the kernel still writes its own STATE.md, completes).

### M-6: no @AGENTS.md self-import in the merged section

When AGENTS.md resolves into a physical file, the CLAUDE.md pointer body is
dropped from the merge and the omission is recorded
(`integration-manager.ts:1027-1054`); a same-file CLAUDE.md redirect record
is removed so `redirected` stays honest. `handoffEntryFileStatus` accepts
the recorded omission for the CLAUDE.md line when the commit tree proves
the AGENTS.md redirect into CLAUDE.md (`build-runtime.ts:475,514-528`,
`linkRawResolvesToClaudeDotMd` at `:540`). Withdrawn-stop reconciliation
re-describes the same omission (`:2757-2769`).

Tests: L2 and L2-real updated -- the merged CLAUDE.md holds the AGENTS.md
section with no pointer line, `claudeLineCommitted: true` with the omit
reason; every earlier assertion (link untouched, own bytes survive, commit
files, completion) unchanged.

### Changed files (sha256, final bytes, whole packet)

- `aef48359e21dae180d67a1146799c098bfb57b3209617a924d4fdb2458845bdd` runner-v2/src/integration-manager.ts
- `eef5b6056a779dbc97e1e8098d9785cf40322de984a9b0895d6297c8696656c5` runner-v2/src/build-runtime.ts
- `16ede81fe4a5d321060a2262f80e6f83b2b1488892b15aba6c8751f023535003` runner-v2/src/project-docs.ts
- `d248e1dc268febddf5925129f58cd9e2e2996995dad3eb4ed478a4da87d88aff` runner-v2/src/scheduler-store.ts
- `2927467b668711cde2937e4ca824e689d55390a8488ccc4a17a34420ed5f59d3` runner-v2/test/docs-policy-v2-handoff.test.ts
- `ed3f622cbbf66d77c68ff94067e54d2261d7f38d16d2322dbea211972c6a06a1` runner-v2/test/project-doc-commit.test.ts
- (this file appended below its own hash bullet pattern: a file cannot
  contain its own hash; every other byte is final)

Encoding: project-docs.ts CRLF with zero lone LF (as at HEAD); every other
touched file LF with zero mixed endings; no BOM anywhere. `git diff
--check` clean.

### Suites (worker-run, NODE_TEST_CONTEXT cleared, --test-concurrency=1)

- docs-policy-v2-handoff.test.ts: 67 tests -- 66 pass in the full-file run
  plus G2-prod 1/1 solo (see limits); every Part-B test green (A3, A3n, A4,
  D1, C9, C11, C7, updated L2/L2-real, gate unit) and every earlier C2c
  test green (K-ignored, K, K2, K2b, tip-unreadable, L2 family, L3,
  missing/outside skips, U1, U2, A1, A2, B1, B1c, E1/E2, E3, R).
- project-doc-commit.test.ts: 19/19 (incl. new v1-A4 refusal).
- project-docs + handoff-snapshot + build-runtime + scheduler-store +
  replay-compatibility + git/lsp/mcp-caller-audit +
  one-shot-command-routing-static + static-adapter-policy: 174/174.
- integration-manager + handoff-rerequest + build-risk-reassessment +
  native-build-manager: 106/106.
- runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- eslint on all 6 changed code/test files: exit 0.
- `git diff --check`: clean.
- Not run: native-delivery-* (per brief; the controller runs them in
  parallel with the review) and the full 279-file suite.

### Prove-red records (sha256 before/after, byte-exact restore)

Backups held under `D:\tmp` (outside the repo); restores copied back and
re-hashed to the before value; scratch files removed afterwards.

1. Per-component check narrowed to docs/project and below again
   (`firstLinkComponent` skips the `docs` component):
   `aef48359e21dae180d67a1146799c098bfb57b3209617a924d4fdb2458845bdd`
   -> `f66ef3011002e7771bb43b95690c61931f64cb03423b0f4ec769cc61afb050d9`.
   A4 went red: the outside directory held `["project"]` instead of `[]`
   (STATE.md written through the `docs` link). Restored; sha again
   `aef48359...` (match).
2. Ancestor check on the redirect target dropped (pre-M-1
   `isEntryLinkRedirectTarget`):
   `aef48359e21dae180d67a1146799c098bfb57b3209617a924d4fdb2458845bdd`
   -> `390f949de4f5497fc2ba8ac0a26b284b2852b8d4a2fd8488d09b4b5b21aaa161`.
   D1 went red: the outside `notes.md` gained the marked Architect section
   through the junction. Restored; sha again `aef48359...` (match).

### Not done / limits

- Transient process-backend failures in long runs (environmental, no code
  defect; full log at `D:\tmp\c2c-partb-full.log`, scratch): E3 went red
  once in the first full-file run (a `canStageSpecPath` git throw defers to
  stageable-true, matching the symptom) then passed solo and in the second
  full run; G2-prod failed once in fixture setup (`No verified backend
  satisfies invocation`) then passed solo (1/1, 193s); the second full run
  completed all 67 tests (66 pass + the G2-prod setup flake) but the process
  crashed in final teardown with the same backend error before printing the
  summary. Every test is green on re-run; nothing was changed to obtain
  green.
- Withdrawn-stop + dir-link and withdrawn-stop + M-6 corners are
  implemented (same re-description pattern as BL-2) but have no dedicated
  factory layout test.
- M-7 (this evidence file is gitignored) still needs `git add -f` by the
  controller at commit time.
- Full 279-file suite not run (see Suites).
- Nothing committed, staged, stashed, or pushed; all changes
  uncommitted.

## Controller run (CD-18)

The four native-delivery files (`native-delivery-factory.test.ts`, `native-delivery-report-{counts,runners,paths}.test.ts`) on the final C2c bytes, `--test-concurrency=4`, run next to review r2: 17 tests, 17 pass, 0 fail, 1,102 s wall.

## Repair cycle 2 — one commit-tree describer (r2 NB-1, NB-2, NB-3, m-1 to m-4)

Base: `62362265` plus the uncommitted C2c (parts 1, 2, repair cycle 1 A/B)
above. Lane A implementation worker, repair run for re-review r2. No
commits, stages, stashes, pushes, or PRs; all changes uncommitted. (The
`progress.md` working-tree modification predates this session.)

Scope: the r2 blocking and minor findings only. The TX-1 delivery files
are untouched (not edited, not run). `scheduler-store.ts` needed no change
(the gate already accepts a recorded `stateSkippedReason` and refuses a
reason-less no-STATE record).

### The root cause: one describer for all three paths

The fresh path, the commit-reuse path and the withdrawn-stop path each
described a snapshot commit differently, so every reuse layout needed its
own patch. They now share one function,
`describeSnapshotCommitFacts`
(`runner-v2/src/project-docs.ts`), which derives every recorded fact from
the COMMIT TREE plus the stop's stage-time inputs (which may only confirm
the tree, never replace it):

- STATE.md is recorded as written, or skipped with the canonical reason
  for the tree's first ancestor-or-self link (`handoffStateSkipReason`).
  A committed STATE.md never carries a reason (m-1); a stage-time reason
  with no commit-tree backing records nothing, so the caller pauses
  fail-closed exactly as U1/U2 do (m-3, probe J-docs).
- Each entry file keeps its stage-time reason only when the tree holds
  the link; otherwise the skip -- and the M-6 self-import omission
  (`HANDOFF_CLAUDE_SELF_IMPORT_OMISSION`, NB-1) -- is re-described from
  the tree in the single wording (m-4).
- A redirect reason counts only with its ViaLink proof, re-described from
  the tree when the stop carries no stage-time record (reuse).
- Link-target normalization (`resolveHandoffLinkTarget`) and the
  CLAUDE.md-sibling check (`handoffLinkRawTargetsClaudeDotMd`) moved into
  `project-docs.ts` so the stager and the describer spell the same target;
  the local copies in `integration-manager.ts` / `build-runtime.ts` now
  delegate or are removed.

Commit-tree facts (`runner-v2/src/integration-manager.ts`,
`documentCommitResult`): the `dirLinks` walk now covers `docs`,
`docs/project` and `docs/project/STATE.md` itself (NB-2: the file counts;
m-1: `specs` never did), each level listing only its parent tree, with
names compared case-folded where the checkout is case-insensitive (a
committed `Docs` link backs the same skip; detected by a pure-filesystem
lstat probe, `checkoutIgnoresCase`, since `config` sits outside the Runner
Git policy).

Per-component index check (NB-3, `indexEntryModes`): each component is
queried as `<path> ':(exclude)<path>/*'` -- exactly the entry, never the
subtree -- in one git call per path. A combined single call was tried
first and rejected: an ancestor exclude swallows a nested exact hit
(`:(exclude)docs/*` matches `docs/project/STATE.md` itself), which
re-broke the S1 layout the same run. With 40,000 tracked files under
`docs/generated/` every query stays a few lines; the v1 Architect
document commit (`refuseProjectDocLink` shares the check) behaves as at
HEAD again.

Check errors fail closed (m-2, `runner-v2/src/build-runtime.ts`): a
`canStageSpecPath` throw counts the path as not stageable -- STATE.md
renders `spec: not recorded` and the reason is recorded -- never as
stageable. The port answer carries `unstageableReason`, so a worktree
occupant records `path_occupied` (m-4, E3) while every other refusal
records `write_failed`.

Skip wording (m-4): every reason names the real cause -- the E3 occupant
is `path_occupied`, the D1 refusal names the junction above the target
(`entryLinkSkipDetail` takes the ancestor link), the B3/M-6 reuse
re-description is the recorded omission -- all from the one describer.

### Tests (all through `NativeBuildManager` with the docs port `NativeBuildFactory` builds, real SQLite and git)

- B2 (`docs-policy-v2-handoff.test.ts`, "repair cycle 2/probe B2"):
  link-mode AGENTS.md to CLAUDE.md, snapshot read fails once. Resume
  reuses the commit (rev-list unchanged), records the tree-derived
  redirect plus the M-6 omission, 1 snapshot, selection completes.
- B2-real: same with a real git link (`core.symlinks=true`); the link
  stays a link afterwards.
- S1-reuse: committed link-mode `docs/project/STATE.md` (to
  `../../shared.txt`), read fails once. Resume records the reused commit
  with the STATE.md skip naming the file itself, `bodyDigest: ""`,
  `shared.txt` byte-identical, completes.
- CI-reuse: committed capital-`Docs` real link to an outside directory,
  read fails once. Resume re-describes the skip case-folded from the
  commit tree, outside empty, completes.
- G1: 40,000 tracked files under `docs/generated/`. The snapshot commits
  (1 snapshot, full paths, no `stateSkippedReason`) and completes; the v1
  `commitProjectDocuments` batch commits exactly once on the same tree.
- G1-control: 40,000 tracked files under `site/generated/`: the snapshot
  commits and completes.
- E3-throw: the E3 occupant plus one injected `canStageSpecPath` throw:
  1 snapshot, no `specCopied`, no `specPath`, `spec: not recorded`, the
  occupant untouched, completes (never fails open).
- J-docs: tracked `docs/keep.md` with the worktree `docs` replaced
  out-of-band by a junction. 0 snapshots, `handoff_snapshot_failed`, the
  outside directory still holds only `own.txt`, the owner selection is
  refused.
- A1/A2 now assert no `stateSkippedReason` next to a committed STATE.md
  (m-1); D1 asserts the reason names the junction (m-4); E3 asserts
  `specCopySkipped: "path_occupied"` (m-4).

### Changed files (sha256, final bytes)

- `a85a24c540e2b0b12519812014afc444d46a8a6d716d411dd1af554aec1061b2` runner-v2/src/build-runtime.ts
- `23d392d902e0505bf06270ced786b8434a42603b4b73790625328bb3b10a9933` runner-v2/src/integration-manager.ts
- `205421e1759b67a66fae0322dfd4f988a3be8504abcfec3f560d15040eca93a2` runner-v2/src/project-docs.ts
- `f63caa16f69dea6013bbaedbf61db906585bd4dd877d046e85098013229b795e` runner-v2/test/docs-policy-v2-handoff.test.ts
- (this file appended below its own hash bullet pattern: a file cannot
  contain its own hash; every other byte is final)

Encoding: project-docs.ts CRLF with zero lone LF (as at HEAD); every other
touched file LF with zero mixed endings; no BOM anywhere; non-ASCII counts
equal HEAD for every touched file (23/0/6/0). `git diff --check` clean.

### Suites (worker-run, NODE_TEST_CONTEXT cleared)

- docs-policy-v2-handoff.test.ts: 75/75 on the final bytes -- 73/73 in the
  full-file run with `--test-concurrency=4` and `--test-skip-pattern`
  "cycle 2/probe G1" (exit 0), plus G1 and G1-control 2/2 solo
  (exit 0, 1,011 s).
- project-doc-commit + integration-manager + build-runtime +
  scheduler-store + handoff-rerequest + build-risk-reassessment +
  replay-compatibility + git/lsp/mcp-caller-audit + project-docs +
  handoff-snapshot: 233/233 aggregate, 0 fail (exit 0).
- runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0.
- eslint on all 4 changed code/test files: exit 0.
- `git diff --check`: clean.
- Not run: native-delivery-* (per brief; the controller runs them) and the
  full 279-file suite.

### Prove-red records (sha256 before/after, byte-exact restore)

Backups held under `C:\Users\b_a_s\AppData\Local\Temp\p6-6` (outside the
repo); restores copied back and re-hashed to the before value.

1. Reuse path skips the shared describer (current-stop entry facts read
   straight from the stage-time arrays again, the NB-1 shape):
   `a85a24c5...` -> `4705c993f98793f7f08d1672956896463a719916d97b75d11a8fa48f0ccb5cab`.
   B2 went red: 0 snapshots after resume (`0 !== 1`, the stuck run).
   Restored; sha again `a85a24c5...` (match).
2. Per-component check lists the whole directory again (single combined
   `git ls-files -s -z -- ...paths`, no excludes):
   `23d392d9...` -> `36cce19fa60d0b3a2bf5e463561b03fc53af8b55f4c83f57715c2347505da018`.
   G1 went red: 0 snapshots (`0 !== 1`, the output-limit pause).
   Restored; sha again `23d392d9...` (match).

### Not done / limits

- The mid-run S1-reuse red (combined-call excludes swallowing the nested
  exact hit) is recorded above as a rejected variant, not a separate
  prove-red: the per-path queries are the shipped form.
- Withdrawn-stop + M-6 and withdrawn-stop + dir-link corners still have no
  dedicated factory layout test (carried from cycle 1); both paths now
  share the describer with the tested current-stop reuse path.
- M-7 (this evidence file is gitignored) still needs `git add -f` by the
  controller at commit time.
- Full 279-file suite not run (see Suites).
- Nothing committed, staged, stashed, or pushed; all changes
  uncommitted.

## Controller run after C2c repair cycle 2 (CD-18)

Six native-delivery files (`native-delivery-factory.test.ts`, `native-delivery-factory-tiers.test.ts`, `native-delivery-report-{counts,runners,paths,parity}.test.ts`) on the final bytes, `--test-concurrency=6`, next to review r3: 19 tests, 19 pass, 0 fail, 632 s wall (before: about 1,600 s serial, 1,005 s four-way).

## Repair cycle 3 (controller)

Input: `C2c-review-r3.md` (REPAIR, 3 blocking NB-4, NB-5, NB-6; m-4 partial). Per the owner's rule (a complicated packet that failed its round-2 repair), the controller did round 3.

| Finding | Change | Test |
|---|---|---|
| NB-4 an empty snapshot commit (STATE.md skipped for a recorded reason, entry files already current) was refused by the reducer as a pump error | `scheduler-store.ts` snapshot reducer: `paths` may be empty when `stateSkippedReason` is recorded; without a skip reason STATE.md must still be among the paths. The gate (`handoffSnapshotAtCurrentStop`) already accepts the recorded reason. | "C2c round 3/probe DUP-A4" (`docs` link + AGENTS.md/CLAUDE.md already holding the v2 section and line: one snapshot with `paths: []`, the skip reason, nothing outside, completes) |
| NB-5 the commit-tree walk listed each parent tree whole (`ls-tree <commit>:docs`) | `integration-manager.ts` `commitStateLinkComponents`: each level queries only the exact entry (`ls-tree <treeRef> -- <name>`, new `commitTreeEntry`); on a case-insensitive checkout the other spellings come from the worktree's own `readdir` of that one parent (new `caseFoldedWorktreeNames`), each then queried exactly | "C2c round 3/probe G1-flat" (40,000 files directly under `docs/`: the snapshot commits, the v1 document commit lands) |
| NB-6 the stage-time index check was exact-case, so a committed `Docs` link checked out as a plain file gave `ENOTDIR` | `integration-manager.ts` `indexEntryModes`: on a case-insensitive checkout both pathspecs use `:(icase)` (`:(icase)<p>` and `:(exclude,icase)<p>/*`) and the entry is keyed by the requested spelling | "C2c round 3/probe CI-lm" (committed `Docs` link-mode entry, `core.symlinks=false`, `core.ignorecase=true`: STATE.md skipped with the CD-17 reason, nothing outside, completes; v1 gives the declared CD-17 refusal) |

m-4 partial (B3 reuse wording, W-B1 wording) stays a follow-up: the outcomes are correct and only the reason text differs.

Validation (controller, NODE_TEST_CONTEXT cleared): the three new tests 3/3 (DUP-A4 81 s, G1-flat 505 s, CI-lm 90 s); runner tsc exit 0; eslint on the changed files exit 0.

Prove-red (each: mutate, run the one test, restore from a byte copy, sha256 compared): NB-4 restore `paths.length === 0 ||` → DUP-A4 red (`actual: 0, expected: 1` snapshots), `scheduler-store.ts` `abe0dfc9…5e5ba` before and after; NB-6 drop the `:(icase)` pathspecs → CI-lm red (0 snapshots), `integration-manager.ts` `e0c8fb79…3ffb` before and after; NB-5 list the whole parent tree again → G1-flat red (0 snapshots), `integration-manager.ts` `e0c8fb79…3ffb` before and after.

## Repair cycle 4 (Muse, lane A)

Input: `C2c-review-r4.md` (REPAIR, 3 blocking NB-7, NB-8, NB-9). All production flow through NativeBuildManager. RD-case, RD-case-real, ALL-SKIP and ALL-SKIP-out use the docs port NativeBuildFactory builds; W-CI-rm and W-CI-mv use the hand-built `gitDocsPort` around the fixture IntegrationManager (controller correction after review r5 T-1: the factory-port versions of the same flow, the reviewer's F-W-CI-rm and F-W-CI-mv, pass; moving these two tests onto `openFactoryPort` is assigned to TX-2); real SQLite and real git (links with core.symlinks true and false; core.ignorecase where noted); no child_process in new code; nothing written outside the repository in any test; encodings and line endings preserved (changed files LF).

| Finding | Change | Test |
|---|---|---|
| NB-7 the case-folded commit-tree walk took other spellings from the live worktree, so a withdrawn stop describing an older commit missed a committed `Docs` link | `integration-manager.ts` `commitStateLinkComponents` (:2337): the folded fallback queries the COMMIT tree itself — new `commitTreeEntryFolded` (:2439) asks `git ls-tree <treeRef> -- <every case variant>` in one call per level (16 for `docs`, 128 for `project`, 128 for `STATE.md`; new `caseVariants` (:3044)), then uses the entry found. `caseFoldedWorktreeNames` removed (no other caller). | "C2c repair cycle 4/probe W-CI-rm" (committed `Docs` real link, stop 1 lands, withdrawn, `Docs` removed by a recorded later integration revision, FV re-runs, stop 2 commits STATE.md, run completes) and "…/W-CI-mv" (same, `Docs` replaced by a real `docs/` directory) |
| NB-8 `:(icase)` in `indexEntryModes` also fed `isEntryLinkRedirectTarget`, so a link to `notes.md` with `NOTES.md` tracked redirected and wedged on a pathspec commit | `integration-manager.ts` `indexEntryModes` (:2701): entries keyed by the index's own (real) spelling, never the requested one. New `findIndexEntry` (:2752): link detection folds case (the CD-17 directory check in `firstLinkComponent` (:2873), the link-ness of AGENTS.md/CLAUDE.md in `entryLinkRawTarget` (:2625) and `indexClaudeLinksAgents` (:2566) with the blob read by the real spelling); a redirect target resolves only by exact spelling (`isEntryLinkRedirectTarget` (:2669)), so the case-variant link is refused and the entry skipped with a reason exactly as at round-3 bytes | "C2c repair cycle 4/probe RD-case" (link-mode `AGENTS.md → notes.md`, tracked `NOTES.md`: redirect refused, `AGENTS.md` skipped with `target notes.md is not a regular tracked file`, run hands off) and "…/RD-case-real" (same with a real link) |
| NB-9 every handoff write skipped threw `Project document commit wrote nothing` on the kernel path | `integration-manager.ts` `commitHandoffSnapshot` (:695): when every write is skipped with a recorded reason, record the empty snapshot commit (the `paths: []` shape the round-3 reducer accepts) instead of throwing. Nothing else can be staged into it: the index must be clean (`git diff --cached --quiet`, else the original throw), and the commit carries every runner trailer so key reuse still finds it. The v1 Architect path (:1159) keeps the throw | "C2c repair cycle 4/probe ALL-SKIP" (`docs` real link outside, `AGENTS.md → MISSING.md`, `CLAUDE.md → AGENTS.md`: one snapshot with `paths: []`, tree-equal to its parent, run hands off) and "…/ALL-SKIP-out" (`docs` link-mode entry outside, both entry files link-mode entries to outside files) |

Harness notes: the `Docs` link target is committed with forward slashes (a backslash blob checks out with slashes, leaving the worktree disagreeing with the index); the later `Docs` change is recorded as the new integration revision (`integration.revision_advanced`) with FV re-run against it, as production records any later integration commit — a raw HEAD move without it leaves the document chain dangling (the probe's noted artifact).

Validation (NODE_TEST_CONTEXT cleared): new tests 6/6 (RD-case 108 s, RD-case-real 103 s, ALL-SKIP 101 s, ALL-SKIP-out 104 s, W-CI-rm 8 s, W-CI-mv 7 s); round-3 tests 3/3 (DUP-A4 112 s, G1-flat 709 s, CI-lm 117 s); project-doc-commit + 3 audit suites 50/50; integration-manager 37/37; scheduler-store + handoff-snapshot 85/85; replay-compatibility + handoff-rerequest 10/10; runner tsc exit 0; eslint on the changed files exit 0; git diff --check clean. Not run (per brief): the whole docs-policy-v2-handoff file, the native-delivery files (controller's parallel scope).

Prove-red (each: mutate, run the one test, restore from a byte copy, sha256 compared): NB-7 take spellings from the worktree again → W-CI-rm red (`actual: 0, expected: 2` snapshots); NB-8 fold case for redirect targets again → RD-case red (`actual: 0, expected: 1` snapshots); NB-9 restore the `wrote nothing` throw on the kernel path → ALL-SKIP red (`actual: 0, expected: 1` snapshots). `integration-manager.ts` `717dcc…f18b32` before and after each; test file untouched by the mutations.

Changed-file sha256: `integration-manager.ts` `717dcce99510a530c31a0aa426389d8a7f63dc20a6cb586b0f6a5af8c1ff8b32`, `docs-policy-v2-handoff.test.ts` `2e92648354ba0f4524eef5c6a6e77665e0f332675ba367c234489d7fd0d0b34e`. No other source file changed (scheduler-store, build-runtime, project-docs untouched — the round-3 reducer already accepts `paths: []`, the runtime already re-derives every fact from the commit tree).

Not done / limits: round-3 follow-ups m-7, m-8 (partly: W-CI-rm/mv now cover the withdrawn path but only for the link layout), m-4 wording, and the r4 minors/escalations (DOCS-dir case-variant real paths, F-matrix, 4 MiB cap) stay open as the review filed them; v1 unchanged (project-doc-commit suite green, including the NF-5/CD-17 refusals).

## Controller validation and acceptance (cycle-4 bytes)

Bytes: `integration-manager.ts` 717dcce9…8b32, `docs-policy-v2-handoff.test.ts` 2e926483…b34e, `scheduler-store.ts` abe0dfc9…e5ba, `build-runtime.ts` a85a24c5…61b2, `project-docs.ts` 205421e1…93a2, `native-build-factory.ts` 1980602e…8daa (same at the start and the end of review r5).

Controller runs (NODE_TEST_CONTEXT cleared; all seven groups at the same time, next to review r5; 3,150 s wall in total):

| Group | Tests | Pass | Fail | Wall |
|---|---|---|---|---|
| docs-policy-v2-handoff, `^C2a` | 14 | 14 | 0 | 213 s |
| docs-policy-v2-handoff, `^C2b` | 30 | 30 | 0 | 1,816 s |
| docs-policy-v2-handoff, `^C2c (NF\|repair (?!cycle))` | 23 | 23 | 0 | 3,150 s |
| docs-policy-v2-handoff, `^C2c repair cycle 2` | 8 | 8 | 0 | 2,683 s |
| docs-policy-v2-handoff, `^C2c (round 3\|repair cycle 4)` | 9 | 9 | 0 | 1,874 s |
| native-delivery-*.test.ts (6 files, concurrency 6) | 20 | 20 | 0 | 783 s |
| git-production-managers, native-build-manager, git-runtime-integration, project-docs, build-runtime, native-build-initialization (concurrency 3) | 108 | 108 | 0 | 269 s |

The five name patterns cover all 84 tests of the handoff file (14 + 30 + 23 + 8 + 9). Logs: scratchpad `r4suites/`.

Independent review r5 (`C2c-review-r5.md`, fresh Opus 5.5): **ACCEPT**, 0 blocking. Dispositions: T-1 evidence sentence corrected above; moving W-CI-rm/mv onto the factory port assigned to TX-2. m-9, m-10, m-11, minor 4, the r4 minors m-4/m-7/m-8 and the escalations (case-variant real paths, F-matrix, 4 MiB apply cap) assigned to the new packets C2d and C2e (plan CD-19) before T7a. J-docs permanence stays fail-closed (out of scope per CD-19).

**C2c ACCEPTED 2026-09-29.**
