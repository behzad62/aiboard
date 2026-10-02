

# C2b evidence — docs policy v2 entry lines, spec copy, run options, hand-edit detection, C2a follow-ups

- Packet: RUNNER V2 P6.6 PACKET C2b (lane A, implementation worker).
- Base: `d35371a1` (branch `codex/runner-v2-p6-6`), the C2a commit.
- Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`. Nothing committed, staged, stashed, or pushed; all changes uncommitted.
- Plan: `docs/superpowers/plans/2026-09-27-runner-v2-p6-6-architecture-correction.md` (AR-1, CD-1, CD-5, CD-9, CD-11, CD-13; AR-R04, AR-R05 full form, AR-R07; section 6 C2 steps 5, 6, 8).
- Prior work: `evidence/C2a.md`, `evidence/C2a-review-r1.md`, `evidence/C2a-review-r2.md` (N1-N6, M7, M9).

## 1. Requirement coverage

| ID | Requirement | Implementation | Test |
|----|-------------|----------------|------|
| AR-R04 | Kernel commit writes v2 AGENTS.md section + marked `@AGENTS.md` line via splice | `commitHandoffSnapshot` stages through shared `stageProjectDocWrites` (integration-manager.ts); static `V2_AGENTS_SECTION_BODY`, `V2_CLAUDE_POINTER_LINE` (project-docs.ts) | C2b entries + missing-files tests; project-docs v2 test |
| AR-R05 full | Gate requires STATE.md + AGENTS section + CLAUDE line from the commit tree; README not required; answered exempt | `handoffSnapshotAtCurrentStop` requires `agentsSectionCommitted && claudeLineCommitted`; writer reads entry facts back from the commit via `documentCommitResult` | Gate matrix refusals; reuse-without-entries failure test |
| AR-R07 | Hand-edit detection from the tip commit; notice line in next snapshot | `readIntegrationTipFile` (blob bytes) + `verifyHandoffSnapshotDigest`; `previousSnapshotEdited` renderer line (handoff-snapshot.ts) | C2b hand-edit test (edited flagged, clean not flagged) |
| CD-5 spec | Verbatim copy to `docs/project/specs/<source-id>.md` only when not already a repo file and not opted out | Artifact-store bytes by manifest digest; `findTrackedFileWithDigest`; `sanitizeSpecSourceId`; text-only guard | Copy written / opt-out skip / in-repo skip tests |
| CD-5 options | `specCopy` (default true), `handoffFiles` commit/export_only (default commit), recorded in run policy | `NativeBuildSpec` fields + `parseRunPolicyOptions` + `run.policy_configured` payload; `specCopyOf`/`handoffFilesOf` accessors; factory wiring; `export_only` early-return + gate exemption | Options recording test; M9 test (parser); export_only test |
| CD-1 (M9+N6) | Reducer refuses docs-v2 stamp without planning v1; legacy keeps v1 | `project_docs.policy_configured` main branch; creation-first stamp stays lenient | M9 test (refusal, acceptance after planning v1, legacy v1, creation-first) |
| N1 | Shared predicate; withdrawn commits recorded; F+G regressions | `assertProjectHandoffSelectionAccepted` (reducer + manager); withdrawn-stop history record; `handoffSnapshotAtCurrentStop` exported | Probe F + probe G tests |
| N2 | Resume exemption = v2 + requested + no snapshot for stop | `handoffSnapshotRetryPending`; `resume()` uses it; export_only/answered excluded | Stacked-pause test |
| N3 | Additive pause detail | No change (as recorded) | Untouched |
| N4 | Trailer-block-only identity-checked reuse | `commitTrailerBlock` + runner author/committer check in `findSnapshotCommit` | N4 cherry-pick test; M3 tests still green |
| M7 | No whole-file overwrite of entry files | Shared `stageProjectDocWrites` for Architect + kernel paths | Prove-red 1; entries test |
| v1 unchanged | v1 text/checks/gate byte-identical behavior | No v1 line touched (additive only) | v1 answered test + replay suite green |

## 2. Design choices (recorded decisions)

- **AGENTS v2 text** (static constant, ASCII only):
  `This project was built with AIBoard. Read docs/project/STATE.md first: it is a generated snapshot and names the exact revision it describes; changes after that revision are in git log. You do not need to keep a journal. If you finish an item listed under Open work, you may tick it in the same commit.`
  CLAUDE.md marked body is the single line `@AGENTS.md` (the documented import form). v2 satisfaction: marked section contains the static body (AGENTS) / a trimmed `@AGENTS.md` line (CLAUDE). v1 text and v1 checks are untouched; v2 content provably fails the v1 checks (project-docs test).
- **Spec-copy decision ("already a repository file")**: the approved source's bytes live in the artifact store under the manifest `artifactDigest` (same key the Architect read path uses); origin/identity live in the planning source manifest (`sourceId`, `artifactDigest`, `mediaType`, `encoding`). The source counts as already a repository file exactly when a tracked blob at the integration tip has the same byte length (via `git ls-tree -r -l`, same-size blobs only — the bound) and the same sha256. Copy path `docs/project/specs/<sanitized source-id>.md` (unsafe chars to `_`; empty/dot-only means no copy). Guard: only `text/*` + `utf-8` sources are copied (never corrupt a non-text source through a string write); missing/unverifiable bytes skip the copy and record the skip — a conditional copy never fails the handoff. The event records `specPath` (copy path, or the existing repo path) and `specCopied: true` only when a copy was committed.
- **Option storage**: `run.policy_configured` payload carries `specCopy`/`handoffFiles` (always written by the runtime, defaults `true`/`"commit"`). The reducer stores them only when present, so pre-C2b logs replay with accessor defaults and unchanged projections. `NativeBuildSpec` carries the same optional fields (validated; legacy specs stay valid). The recorded values govern the run (runtime reads the projection, not its constructor).
- **Shared N1 predicate**: `assertProjectHandoffSelectionAccepted(projection, revision)` = completion-ready + revision-match + snapshot gate with the exact reducer messages. The reducer calls it; the manager calls it before any project mutation with the revision the selection will carry (current-stop snapshot `head`, else canonical). A non-continuing snapshot (probe G) is refused pre-mutation.
- **Withdrawn-commit record**: a snapshot event for a stop in `projectHandoffHistory` (withdrawn) is recorded into history and moves the tip on continuation, but touches no run state (no pause clear, no running-to-paused flip) and never satisfies a later gate (the gate binds to the latest request).
- **M9 scoping**: enforced on non-first stamps (the only point a late violation can be introduced). The creation-first stamp stays lenient: T7a stamps both policies together at creation and seeded runs stamp docs v2 at sequence 1 (planning.policy_configured cannot be a first event, and legacy plan.created cannot follow a planning-v1 stamp without a ready plan, so stamp-time strictness everywhere would make legal creations and all C2a seeds unrepresentable). N6 is closed by the same pairing (production can no longer introduce docs v2 without planning v1 after creation).
- **Hand-edit line**: `The previous snapshot was edited outside AIBoard; see this file's git history.` Fixed static text after the header (never truncated, unforgeable); digest-covered; optional input field keeps every existing C1 render byte-identical.
- **Trailer parsing (N4)**: trailer block = trailing contiguous `Key: value` lines; all four trailers must be members; author/committer must equal the runner identity. A `-x` cherry-pick line or quoted mid-body lines are not trailers.
- **Run-policy recovery**: `configureRunPolicy` no longer re-appends on recovery (the re-append conflicted with the additive payload shape); it returns early after a loud conflict check. First creation records; recorded values govern.

## 3. Changed files (sha256, final bytes)

- `42e93d211a88eb60bd01d2a3eaa7f3bd0996a2f2b3acdff04134c4d2a4e58960` runner-v2/src/project-docs.ts
- `0acc95615dee8106fe18a1977ed260913a5c97901fd290892de136e3eca95f5d` runner-v2/src/scheduler-store.ts
- `0b9928fae5814071abb586ec14ecd442190e5d5cf919d195f32507584df2a619` runner-v2/src/build-runtime.ts
- `9f50fc89802020afb6b102d1bc586598e9b1bedb3bc72cc5cff8750616febd92` runner-v2/src/integration-manager.ts
- `28423203051825d022ac2eed0a521dcaad7ae65dd9bf32d3d7ca16d1d0541f9b` runner-v2/src/native-build-manager.ts
- `754c1156955f232bfcecf4c44f3c33b7310f55d5ef69be102ad733a23ed0adf0` runner-v2/src/native-build-factory.ts
- `aececcd46c35695eb5298d370a48d996e3d4a324bc1ce72aba4d2cab9b143963` runner-v2/src/build-spec.ts
- `5d7ff0c5801869c86c09c0690d7617da1eda7651b1b47bced60f16a3c1746163` runner-v2/src/handoff-snapshot.ts
- `4f4dad53639d9725f0ab329f399e7876aa6ef04c56530924004e0dfe2a55b12f` runner-v2/test/docs-policy-v2-handoff.test.ts
- `0988c07b8da64d0e9ebfb3ef641a6231c136f831218b158187f4f4d56b852e53` runner-v2/test/handoff-snapshot.test.ts
- `d3841c55192099ac98f96fb988f1a4d2b77a97f900cd3b04f02f185db6485a6f` runner-v2/test/project-docs.test.ts
- `29ff2596e28111a9a4498c10e35865e70f012643d4222d94bffa070199555a6f` runner-v2/test/project-doc-commit.test.ts
- `62ba40f62c47ecc51d689b4047e867e7384fa23fcce390d10ed35ccd9cfab08f` runner-v2/test/build-runtime.test.ts
- `dc66db3c61e6af7a18937541debf81ddadf9558a7074b4ce969c6fdb617aaa1f` runner-v2/test/request-triage.test.ts

Encoding: every CRLF file kept CRLF with zero mixed endings and unchanged non-ASCII counts; LF files kept LF; new evidence file LF. `git diff --check` clean; no encoding-only hunks (verified per-file line-ending counts against the base survey and `git diff` review).
Forbidden areas untouched: agent-prompts.ts, Architect surface, planning-tools.ts, planning-contracts.ts, UI/client, package files, progress.md (the pre-existing progress.md modification predates this session), configureProjectDocsPolicy still stamps v1.

## 4. Suites (all run by the worker, real SQLite/git/clock, production manager flows)

On final bytes unless noted:

- runner tsc (`tsc -p runner-v2/tsconfig.json --noEmit`): clean.
- eslint on all 8 changed src files + 6 changed test files: clean.
- docs-policy-v2-handoff.test.ts: 28/28 (14 C2a + 14 C2b).
- project-docs + handoff-snapshot + project-doc-commit + integration-manager: 124/124.
- native-build-manager + build-runtime + scheduler-store: 117/117.
- request-triage + build-spec-store: 47/47.
- replay-compatibility + git/lsp/mcp-caller-audit + one-shot-command-routing-static + static-adapter-policy: 42/42 (every stored v1 log replays unchanged).
- final-verification-completion + process-recovery-control + delivery-acceptance + git-production-managers (nearest further importers): 44/44.
- native-delivery-factory.test.ts (long): 17/17, exit 0 (completed after the worker's summary; started on bytes differing from final only as described in limits).

## 5. Prove-red records (sha256 before/after, byte-exact restore)

1. Splice vs overwrite. Mutated `commitHandoffSnapshot` to whole-file overwrite (file sha `9f50fc89...` at mutation time). The byte-for-byte entries test went red: `tests 1, pass 0, fail 1` (no snapshot recorded — the overwritten entry files fail the commit-tree read-back, so the run pauses instead of recording). Restored; sha again `9f50fc89802020afb6b102d1bc586598e9b1bedb3bc72cc5cff8750616febd92` (match).
2. Shared predicate removal. Reverted the manager pre-check to the gate-only form. The probe-G test went red with the predicted failure: `physicalHandoffs 1 !== 0` ("no project mutation precedes the refusal") — without the predicate the project is mutated, then the selection is refused. Restored; the diff is exactly the C2b pre-check hunk (verified by `git diff`; no PROVE-RED text remains).

## 6. Not done / limits

- native-delivery-factory finished 17/17 after the worker's summary. It ran on bytes differing from final only in `configureRunPolicy` recovery (append-always vs skip-if-recorded) and the ls-tree size filter (always-null vs working search); neither path is reachable in that suite (no docs-v2 runs, no spec-copy search), and both are covered on final bytes by the suites above.
- Full 279-file suite not run: the brief's named suites plus the nearest importer suites were run (402 tests total, all green). 67 test files import the touched modules; the unrun remainder (planning/delivery/final-verification peripherals, CLI, control-server, etc.) only touch the additive, default-preserving paths.
- Spec copy is text-only (`text/*`, utf-8) by design; non-text approved sources skip the copy and record the skip rather than risk byte corruption through a string write.
- Probe G as specified (branch ahead of canonical with no tip) is reachable in production only through out-of-band branch writes; the fix refuses it pre-mutation with the kernel's own rule and leaves the run at the handoff wait (refused, not terminally stuck).
- N3 left as recorded (additive; no change).

## Repair cycle 1

- Review: `evidence/C2b-review-r1.md`, verdict REPAIR (1 blocking B1, 9 minor m1-m9). All ten fixed in this one pass, same no-commit rules. Controller decision CD-14 applied (m1/N6).
- Base for this cycle: the C2b working tree (C2b.md sections 1-7); 7 files changed below, all others byte-identical to the C2b section-3 hashes (verified: native-build-manager, native-build-factory, build-spec, handoff-snapshot.test, project-doc-commit.test, build-runtime.test, request-triage.test unchanged).

### Per finding (change + proving test)

| # | Change (file:line) | Test that proves it |
|---|---|---|
| B1 | Lookup-only `findHandoffSnapshotCommit` (integration-manager.ts:2152, never commits); `reconcileWithdrawnSnapshotCommits` before the next stop commits (build-runtime.ts:2371, called at :2114); shared `appendHandoffSnapshotCommitted` (build-runtime.ts:2448); reducer treats a non-current stop's record as history while a later stop is requested (`isCurrentStop`, scheduler-store.ts:9315) | `C2b repair B1 probe G2` (docs-policy-v2-handoff.test.ts:2344): stop-1 commit lands, read-back fails, guidance withdraws, FV re-runs green on the unchanged canonical revision, re-request. Two snapshot events, second.parent == first.commit, tip == second.commit, automatic handoff applies (`order ["projectHandoff:2","applied"]`, 1 model call), project holds the reconciled STATE.md |
| CD-14 (m1) | M9 refusal REMOVED (scheduler-store.ts, `project_docs.policy_configured` case): the reducer does not pair docs-v2/planning-v1; T7a owns production stamping (CD-1). N6 closed in the runtime: `handedOffRevision` (build-runtime.ts:2323) uses the stop integration revision, else the recorded baseline via `readIntegrationBaselineRevision` (integration-manager.ts:2171); pause stays only as fail-closed fallback | `C2b CD-14` (docs-policy-v2-handoff.test.ts:2767, probe-I shape accepted) and `C2b repair CD-14/N6` (:3008): legacy-planning docs-v2 run with no integration revision hands off the baseline, 1 snapshot, no pause, selection completes |
| m2 | Reuse marked explicitly (`reused: true`, integration-manager.ts, kernel reuse path); event derives `previousSnapshotEdited` from the committed notice line (`PREVIOUS_SNAPSHOT_EDITED_NOTICE_LINE`, handoff-snapshot.ts:267) and the spec claim from the commit via `specCopyClaimFromCommit` (build-runtime.ts:2340), never fresh reads | `C2b repair m2/probe H` (docs-policy-v2-handoff.test.ts:2480): hand-written tip + due spec copy, commit lands, read fails, resume reuses. Event has previousSnapshotEdited true + specCopied true; branch has 2 commits (no duplicate) |
| m3 | `spliceMarkedArchitectSectionBytes` (project-docs.ts:239): marker search on raw bytes, outside bytes untouched (non-UTF-8 included), section takes the file's own EOL, missing file created with just the section. Staging uses it (integration-manager.ts:871). The v1 Architect path shares it (strictly safer: identical behavior on UTF-8, preservation otherwise); the string overload is unchanged for in-memory callers | Unit `marked-section byte splice keeps outside bytes and matches EOL` (project-docs.test.ts:766) + path test `C2b repair m3` (docs-policy-v2-handoff.test.ts:2630: Latin-1 prefix byte-exact through the real kernel commit, entry proof true) |
| m4 | `sanitizeSpecSourceId(sourceId, digest?)` (build-runtime.ts:448): Windows reserved stems (CON/PRN/AUX/NUL/COM1-9/LPT1-9, any case, with/without extension) and empty/dot-only fall back to `spec-<16 hex>`; stems capped at 100 chars. Every non-copy outcome records `specCopySkipped` (opted_out/no_manifest/missing_bytes/digest_mismatch/non_text_source/unsupported_encoding/tracked_search_failed/unusable_source_id/commit_blob_mismatch/spec_blob_unreadable); search failures skip instead of pausing. `specCopied` only after the committed blob hashes to the source digest (`specCopyClaimFromCommit`) | Sanitize asserts in `C2b CD-14` test; `C2b repair m4` (docs-policy-v2-handoff.test.ts:2537: search throws, snapshot still commits, reason recorded, no copy claimed); specCopied assertions in the m2 test |
| m5 | `claudeLinksAgents` (integration-manager.ts:2125): a worktree CLAUDE.md linking to AGENTS.md skips the CLAUDE write with a recorded reason; `documentCommitResult` sets `claudePointerV2ViaAgentsLink` (project-docs.ts:187); runtime records `claudeLineViaLink`, gate accepts. Never writes through the link; any other link still refused as before | `C2b repair m5` (docs-policy-v2-handoff.test.ts:2587): link layout snapshots, reason recorded, link still a link afterwards, selection completes |
| m6 | Context-note + acceptance-upgrade refusals moved INTO `assertProjectHandoffSelectionAccepted` (scheduler-store.ts:9175); the `project.handoff_selected` case keeps only actor/requested/choice checks and calls the predicate, so the manager pre-check is the whole acceptance rule | `C2b repair m6` x2 (docs-policy-v2-handoff.test.ts:2908,2953): predicate and reducer case refuse both states. scheduler-store.test.ts `selected-unresolved` now expects the structural refusal first (requested check precedes the shared rule); note-on-selected coverage moved to the m6 tests with a requested setup |
| m7 | N4 test uses the four EXACT trailer lines mid-body + cherry-pick line (docs-policy-v2-handoff.test.ts:2724); the pre-N4 line-set rule would reuse that message | Same test (red without the N4 fix by construction: exact lines are contained mid-body) |
| m8 | Corrected below (no code change) | - |
| m9 | Em dash restored in the moved T9/EP39 comment (scheduler-store.ts predicate); non-ASCII bytes 105 == HEAD | Byte survey (all touched files equal HEAD counts; no mixed endings; `git diff --check` clean) |

### Changed files (sha256, repair-cycle final bytes)

- `cb6c6c98090886fb833a9d2d86d80bae6a50564f194091659046b4b3ecc4bd8c` runner-v2/src/project-docs.ts
- `b6a0d7b1a06369ccc25b82cb4b03007ccffd6a373c873fcfb3a82dcdd9d96e89` runner-v2/src/scheduler-store.ts
- `f4b997d7b1b6dee838974072dd2f68d0aae354bde29bc21a18dd6299aa0c623d` runner-v2/src/build-runtime.ts
- `03849007b9db98c3f1a0208471ad2321fb5830f03cbfd832831f0b9b3dc34d32` runner-v2/src/integration-manager.ts
- `58b77a736ad7fdded3fd4928fd639734e862eea7ce3d76e592541ad15ca72fed` runner-v2/src/handoff-snapshot.ts
- `a64aa531e9204c7c5ce19aa50d09863ab26ddd3e4eb50febbaf2f61c47b32d92` runner-v2/test/docs-policy-v2-handoff.test.ts
- `973c6ffc43fdf7350afbfdf966b78c466740c27f796b1ce3b640067643caafef` runner-v2/test/project-docs.test.ts
- `571e1e4f35359db3d0ebb0e15b793cc7b5af51ad4019994358739ac3ab909fd9` runner-v2/test/scheduler-store.test.ts

### Suites (worker-run, real SQLite/git/clock, production manager flows, final bytes)

- docs-policy-v2-handoff.test.ts: 36/36 (28 cycle-0 + G2, m2, m4-tracked, m5, m3-path, m6x2, N6).
- project-docs.test.ts: 18/18. scheduler-store + request-triage + build-spec-store: 78/78. build-runtime + integration-manager: 65/65. native-build-manager: 58/58. project-doc-commit + handoff-snapshot + replay-compatibility + git/lsp/mcp-caller-audit + one-shot-command-routing-static + static-adapter-policy: 112/112. final-verification-completion + process-recovery-control + delivery-acceptance + git-production-managers: 44/44. t6b-repair-boundary + planning-state + t6b-repair-factory: 42/42.
- runner tsc: clean. eslint on all changed src + test files: clean. `git diff --check`: clean.
- native-delivery-factory.test.ts (long): 17/17 green on the final bytes above (worker-run, ~26.5 min, real SQLite/git/clock).

### Prove-red records (sha256 before/after, byte-exact restore)

1. Withdrew-stop history removal: `build-runtime.ts` f4b997d7... -> 5ab39f70... (`reconcileWithdrawnSnapshotCommits` call replaced with `false`). The G2 test went red: `1 !== 2` (only the re-request snapshot; the landed stop-1 commit never recorded, chain broken). Restored; sha again f4b997d7... (match).
2. String-based splicing: `integration-manager.ts` 03849007... -> d8cffd9a... (bytes splice replaced with the faithful old utf8-decode + `spliceMarkedArchitectSection` + `""` fallback). The m3 path test went red on its byte assertion: `bytes outside the markers are kept exactly` false (E9 became U+FFFD). Restored; sha again 03849007... (match). (A first attempt crashed on the missing CLAUDE.md null read instead; discarded in favor of this faithful mutation.)

### Corrected claims (review m1/m8/B1)

- "N6 is closed by the same pairing" (C2b.md section 2) was not true and the M9 refusal covered only non-first stamps. Correct statement: the reducer enforces no pairing (CD-14); N6 is closed by the runtime baseline fallback, proven by the N6 test.
- `configureRunPolicy` recovery IS reached by native-delivery-factory (it seeds `run.policy_configured` under key `policy`; native-delivery-factory.test.ts:135). The C2b.md section-6 "unreachable" claim was wrong.
- Probe G as specified is reachable in production through the runner's own commit once the read-back fails and guidance withdraws (probe G2), not only through out-of-band branch writes. Fixed by reconciliation, proven by the G2 test.

### Not done / limits

- Full 279-file suite not run: the brief's named suites plus the nearest importer suites above (453 + 17 factory tests total, all green).
- Spec copy stays text-only (`text/*`, utf-8); a committed blob that git normalizes records the path with `commit_blob_mismatch` instead of the copy claim.
- The m5 link layout is detected in the worktree; a link introduced between staging and read-back resolves fail-closed (snapshot failure, retry).
- N3 left as recorded (additive; no change). T7a production stamping untouched (still v1 here, per the brief's forbidden list).
- Nothing committed, staged, stashed, or pushed; all changes uncommitted.

## Repair cycle 2

- Review: `evidence/C2b-review-r2.md`, verdict REPAIR (3 blocking B1-R, B2, B3; 8 minors N-1 to N-8). All fixed in this one pass, same no-commit rules. A second worker session continued this cycle after a login switch; the remaining work (P1/G2-prod greens, prove-red records, validation, this section) was completed on the same uncommitted bytes.
- Base for this cycle: the C2b working tree (sections 1-7 plus Repair cycle 1); 15 runner files changed below (8 src, 7 test).

### Per finding (change + proving test)

| # | Change (file:line) | Test that proves it |
|---|---|---|
| B1-R | Factory port wires both methods (native-build-factory.ts:1700-1704); both REQUIRED on `ProjectDocsPort` (build-runtime.ts:480,487 — no `?`, so a missing wiring is TS2741, never a silent skip) | `C2b repair B1-R/P1` (docs-policy-v2-handoff.test.ts:3275: factory-built port exposes all 8 keys; baseline lookup and null lookup behave) |
| B1-R/G2 | Same wiring; round-1 G2 through the production manager with the factory's port (never hand-built: `openFactoryPort`, docs-policy-v2-handoff.test.ts:701) | `C2b repair B1-R/G2-prod` (:3292): stop-1 commit lands + read fails, guidance withdraws, FV re-runs green, re-request → 2 snapshots, second.parent == first.commit, tip == second.commit, `completed`/`apply_to_project`, project holds the reconciled STATE.md |
| B1-R/N6 | Baseline fallback through the factory port (`handedOffRevision`, build-runtime.ts:2343) | `C2b repair B1-R/N6-factory` (:3741): no plan revision, no integration revision → hands off the recorded baseline, 1 snapshot, no pause |
| B2 | Fail closed: reconciliation throws on any unclassifiable withdrawn stop (lookup/read/verify/entry/facts, build-runtime.ts:2407-2436); the caller pauses the current stop pre-commit with `handoff_snapshot_failed` naming the failure and retries on resume (:2101-2107) | `C2b repair B2/G3` (:3431): one transient lookup failure at stop 2 → pause names `withdrawn-stop reconciliation failed`, 0 commits, chain intact; resume → 2 chained snapshots, handoff completes |
| B3/N-6 | Link-ness from git, not the checkout: `claudeLinksAgents` (integration-manager.ts:2242) consults the worktree symlink AND the index mode via `indexClaudeLinksAgents` (:2274, `ls-files -s`, mode 120000, target from the blob); staging skips the write with a recorded reason (:954-960); the commit-tree fact `commitClaudeLinksAgents` (:2286, `ls-tree` mode 120000) feeds the gate (`documentCommitResult`, :2181-2197), which also honors a live worktree symlink so the uncommitted-symlink layout (m5) keeps working | `C2b repair B3/probe L` (:3563): link-mode CLAUDE.md under `core.symlinks=false` (plain-file checkout, 120000 index entry) is never written; commit keeps mode 120000 with target `AGENTS.md`; `claudeLineViaLink` recorded; selection completes. `C2b repair m5` (:2784, real symlink) stays green |
| N-1 | A spec-copy stage failure never fails the snapshot: `stageHandoffSpecCopies`/`writeHandoffSpecCopy` report instead of throwing (integration-manager.ts:741-810); the runtime maps the recorded skip (build-runtime.ts:2287-2294) | `C2b repair N-1/probe K` (:3634): tracked file at `docs/project/specs` → 1 snapshot, `specCopySkipped "write_failed"`, no copy claimed, commit holds only the entry files + STATE.md |
| N-2 | A user's own bytes at the spec path are never overwritten: digest-suffixed sibling, else `path_occupied` (integration-manager.ts:786-806) | `C2b repair N-2/probe K2` (:3683): user's file survives byte-for-byte; copy lands at `source_value-<digest16>.md` with `specCopied: true` |
| N-3 | Reducer accepts a snapshot record only for the current request's stop or a withdrawn stop's `requestedSequence` (scheduler-store.ts:9226-9237) | `C2b repair N-3/probe R` (:3810): a bogus-sequence record is refused, tip never moves |
| N-4 | v1 Architect path keeps the HEAD refusal: only the kernel path skips a CLAUDE.md link (integration-manager.ts:949-952,1016-1018); `result.skipped` surfaces to the Architect | `v1 Architect documents keep the HEAD refusal…` (project-doc-commit.test.ts:1372) |
| N-5 | Multi-line splice bodies normalize LF to the file's EOL (project-docs.ts:239) | `byte splice normalizes a multi-line body…` (project-docs.test.ts:793; CRLF file, 0 lone LF) |
| N-7 | No-request fallback of `handoffSnapshotAtCurrentStop` never selects a record (scheduler-store.ts:9126-9128); the older gate test's snapshot fixtures now carry the matching stop-10 request (docs-policy-v2-handoff.test.ts:1739-1801) | Gate test (:1707) green; no live producer reaches the fallback |
| N-8 | Corrected claims, below | - |

### Changed files (sha256, repair-cycle final bytes)

- `1307829855ac8563db4e0aeb5a8f599c3b1335c04b67cacb53741663c6cef154` runner-v2/src/build-runtime.ts
- `aececcd46c35695eb5298d370a48d996e3d4a324bc1ce72aba4d2cab9b143963` runner-v2/src/build-spec.ts
- `58b77a736ad7fdded3fd4928fd639734e862eea7ce3d76e592541ad15ca72fed` runner-v2/src/handoff-snapshot.ts
- `349a916390b472cf3a268560596607900e04e1422e1a09e1582ea37f7c91b85c` runner-v2/src/integration-manager.ts
- `d71815802011531a849dfc45e06d17390c6fd47a5fbecdb2a43812e06a8aa742` runner-v2/src/native-build-factory.ts
- `28423203051825d022ac2eed0a521dcaad7ae65dd9bf32d3d7ca16d1d0541f9b` runner-v2/src/native-build-manager.ts
- `9d22de260d19b84f42ec663ce68cfea25e8cc6c55006cbb8e8238c8b8f448ede` runner-v2/src/project-docs.ts
- `6d1bf279a4f3e34697afe5df57677612ba186637a70845b4d71e8bbc0df7b44a` runner-v2/src/scheduler-store.ts
- `dd3573a0ab91619ca9cd8e063cb5c25c846d785728b2f6e4fce997db271b2dc3` runner-v2/test/build-runtime.test.ts
- `673f35c0efcd7773294df6255d2f81d42fa6beac35ca9d72babc55a992fad3cd` runner-v2/test/docs-policy-v2-handoff.test.ts
- `0988c07b8da64d0e9ebfb3ef641a6231c136f831218b158187f4f4d56b852e53` runner-v2/test/handoff-snapshot.test.ts
- `186c4e35e283b7934acc4854051ab992b3cfcc5f29190b38640ca9eb93ea816f` runner-v2/test/project-doc-commit.test.ts
- `227129ecf31d1376fbea248534fc913184bd8125e66eecd09330ae63b12202bd` runner-v2/test/project-docs.test.ts
- `0cefcd5e3cf72c79c70ab90c8138b0f7489a213d8d4edc838fa7789cd3bd8d75` runner-v2/test/request-triage.test.ts
- `b9371aa52eeb9ac303efec5a22249f2b0b1cea3c99c78e53c4141bd34ff51aad` runner-v2/test/scheduler-store.test.ts

### Suites (worker-run, real SQLite/git/clock, production manager flows, final bytes)

- docs-policy-v2-handoff.test.ts: 44/44 (31 cycle-0/C2a/C2b-r1 + P1, G2-prod, G3, L, K, K2, N6-factory, R, risk-seeded finish flows, N-7 gate fixtures).
- handoff-snapshot + project-docs + project-doc-commit + build-runtime + request-triage + scheduler-store + build-spec-store: 196/196.
- integration-manager + native-build-manager + replay-compatibility + git/lsp/mcp-caller-audit + one-shot-command-routing-static + static-adapter-policy: 137/137.
- runner tsc: clean. eslint on all 15 changed files: clean. `git diff --check`: clean.
- native-delivery-factory.test.ts (long): 17/17 green on the final bytes above (worker-run, ~25.9 min, real SQLite/git/clock).

### Prove-red records (sha256 before/after, byte-exact restore)

1. Factory wiring removed (`findHandoffSnapshotCommit` line deleted): native-build-factory.ts d7181580… → c37e1f51…. `tsc` fails (exit 2, TS2741: property `findHandoffSnapshotCommit` missing but required in `ProjectDocsPort`). G2-prod goes red (tsx needs no cast: 0 snapshots vs 2 — reconciliation cannot classify, fail-closed pause instead of completion). Restored; sha again d7181580… (match).
2. `continue` restored on a reconciliation lookup failure (build-runtime.ts 13078298… → 8351cf32…): G3 goes red (no `handoff_snapshot_failed` pause at stop 2 — the stop commits over the unrecorded withdrawn commit instead of pausing). Restored; sha again 13078298… (match).
3. Worktree-lstat-only link detection (`indexClaudeLinksAgents` fallthrough → `false`; integration-manager.ts 349a9163… → 8989d327…): probe L goes red (0 snapshots — the write-through path fails the snapshot instead of skipping with a recorded reason). Restored; sha again 349a9163… (match).

### Corrected claims (N-8)

- "G2 through the production manager" (Repair cycle 1): held only for the test's hand-built port. Now true of the factory's port, proven by `B1-R/G2-prod` through `NativeBuildFactory.create`'s own runtime port.
- "N6 closed" (Repair cycle 1): held only for the test port. Now true in production wiring, proven by `B1-R/N6-factory` (baseline handed off through the factory port, no pause).
- Fixture note: the factory configures the production `risk_based` verifier policy at create, so the finish factory tests seed a kernel-computed low-risk assessment (`lowRiskSeed`, docs-policy-v2-handoff.test.ts:197, via `assessBuildRisk`, never hand-written) after the green FV generation — and re-seed it after guidance invalidates it. Correction (C2c NF-7): the "mirroring what the production manager records before completion" clause was inaccurate. Only the runtime records `build.risk_assessed` (build-runtime.ts, key `build-risk:<revision>`); the manager records nothing. Packet FX-1 removed the re-seed (`risk:rerun-low`): the harness runtime now re-assesses through the real kernel derivation after the FV re-run. Without the stop-1 seed the flows stop at completion-readiness, which is production behavior, not a C2b defect.

### Not done / limits

- Full 279-file suite not run: the brief's named suites plus the importer suites above (196 + 137 + 44 handoff + 17 factory = 394 tests total, all green).
- The m5/B3 link-flag note: an uncommitted worktree symlink never reaches a commit tree, so `documentCommitResult` also honors the live worktree determination for the `ViaAgentsLink` flag; the write decision stays fail-closed from either source. The L layout's flag comes from the commit tree alone.
- Line-ending note: several files are LF in the working copy against CRLF blobs; git normalizes on add (core.autocrlf=true). No mixed endings inside any file (`git diff --check` clean).
- Nothing committed, staged, stashed, or pushed; all changes uncommitted.

## Acceptance (controller)

Review r3 (`C2b-review-r3.md`): **ACCEPT, 0 blocking.** B1-R, B2 and B3 are resolved on the production path (probes with the port NativeBuildFactory builds). Follow-ups NF-1 to NF-7 go to packet C2c (docs hardening) and packet FX-1 (NF-6, the pre-existing risk re-assessment livelock), both before T7a. Controller decision CD-15 (NF-2) is recorded in the plan.
