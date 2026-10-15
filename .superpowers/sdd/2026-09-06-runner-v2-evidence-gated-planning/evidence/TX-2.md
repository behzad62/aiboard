# TX-2 evidence — slim the docs-policy-v2 handoff suite (test-only)

Packet: RUNNER V2 P6.6 TX-2, lane A (continuation run). Worker: Muse Code.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`
(branch `codex/runner-v2-p6-6`, HEAD `83f89cf5`). Nothing committed, staged,
stashed or pushed. No file outside `runner-v2/test` and this evidence file
was touched; `runner-v2/src` was modified only for the byte-exact prove-red
below and restored (sha256-verified).

Result: `runner-v2/test/docs-policy-v2-handoff.test.ts` (84 tests) is split
into 8 topic files plus one shared harness, and deleted. All 86 tests
(84 moved + 2 new parity) pass: 85/86 in one full group run, with the single
group-run failure (G1-flat, load flake) green in the follow-up file run.

## 1. Coverage check (script, not by eye)

`C:\Users\b_a_s\AppData\Local\Temp\p6-6\tx2-coverage.js` extracts every
`test("name", …)` / `it("name", …)` from the old file (from git HEAD after
deletion) and from the 8 new files, then maps old → new.

- OLD total: 84 test names.
- NEW total: 86 (84 + 2 new `parity:` tests, which the brief orders).
- Missing (old name with no new occurrence): **0**.
- Duplicates (old name occurring 2+ times across new files): **0**.
- Extra names not in OLD: exactly the 2 parity tests (new, per brief item 3).
- Renames: **none** — every moved test keeps its exact name.
- Per-file counts: gate 11, commit 9, retry 19, entry-links 17, spec-copy 12,
  project-links 13, large-tree 3 (sums to 84), parity 2.

Assertion meaning is unchanged: moved tests keep their bodies (same seeds,
same fault injection, same git assertions); only the driver changes from a
whole fake build through `NativeBuildManager` to the harness
(`openFactoryPort` + `driveHandoff`, factory-built port, seeded stop), except
the kept end-to-end tests in section 3. Diffs found while validating (risk
seeding, option passthrough, store close, shared parity label) are
scaffolding the factory port requires; each is noted below and none changes
what the test asserts about the kernel.

Correction (repair cycle 1, review r1 B-1): the "meaning unchanged" claim
was wrong for four moved checks that kept manager-ordering messages
("no project mutation precedes the kernel", "the project changes only
after the kernel accepts") on `existsSync(...STATE.md) === false` checks
that cannot fail on the harness (it never auto-applies): G2
(retry.test.ts:526), B2/G3 (retry.test.ts:737, :758) and the W-CI helper
(project-links.test.ts:675). They are reworded to plain untouched-so-far
facts with no ordering claim. The manager-ordering proof lives in the kept
end-to-end tests, not the harness:

| Manager-level assertion | Where it lives now |
|---|---|
| `order ["projectHandoff:1","applied"]` (mutation only after the kernel record) | C2a B1+M6 (commit file, kept byte-identical) |
| `physicalHandoffs 0` + `automatic_project_handoff_failed`, no mutation / no commit left behind | C2a B1 forced-fail (commit file, kept byte-identical) |
| Withdrawn-stop reconciliation + risk re-assessment through the production manager | C2b repair B1-R/G2-prod (project-links file, kept byte-identical; its `order` assertions at project-links.test.ts:167 and :255 replace the ordering checks that G2 and B2/G3 lost) |

Correction (repair cycle 1, review r1 m-1): the second risk seed
`risk:rerun-low` (formerly at retry.test.ts:496 and
project-links.test.ts:728) is removed from both places. It was a record production cannot produce (actor
`build-manager`, key `risk:rerun-low`; production records
`build.risk_assessed` only from the runtime). G2 and the W-CI helper now
use the B2/G3 pattern: the second drive carries `productionRiskVerifier`
(real kernel derivation `deriveNativeVerifierRiskInput`) and the
Architect's real second `complete_run` records stop 2 (no seeded risk
event, no seeded re-request). Both assert the real re-assessment
(`risks.length === 2`, re-assessment keyed by the re-run revision and
generation) and `architect.calls() === 2`.

## 2. File map (what moved where, what each file now drives)

Shared harness: `runner-v2/test/support/handoff-snapshot-harness.ts` — real
temp git repo, the docs port read off a factory-built runtime
(`NativeBuildFactory.create`, never hand-built), real SQLite scheduler log
seeded to the handoff stop, and the runtime's real snapshot step driven
directly (`BuildRuntime.step` via `driveHandoff`, plus `resumeHandoff`,
`pauseHandoff`, `selectHandoffOwner`, `applyAutomaticHandoff`). Fault
injection: read failure once, commit failure (once / N), crash between
commit and event (via read failure), transient lookup failure.

- `docs-policy-v2-handoff-gate.test.ts` (11): gate and reducer units plus the
  answered-run harness test. No manager pump.
- `docs-policy-v2-handoff-commit.test.ts` (9): the kept manager end-to-end
  tests (section 3) plus commit-shape tests on the harness (splice, create,
  tip move, N6 baseline).
- `docs-policy-v2-handoff-retry.test.ts` (19): retry, reuse and crash
  (B3/B4/M3/crash/N1-F/N1-G/B1-G2/m2-H/N2/N4/B2-G3/BL-2/B2/S1/CI/E3/J-docs).
- `docs-policy-v2-handoff-entry-links.test.ts` (17): entry-file links
  (L/L2/L2-real/L3/missing/outside/U1/U2/C9/C11/C7/RD-case, m3, m5, B3-L).
- `docs-policy-v2-handoff-spec-copy.test.ts` (12): spec copy
  (due/opt-out/export_only/in-repo/m4/K/K2/K-ignored/K2b/unreadable/E1-E2/E3).
- `docs-policy-v2-handoff-project-links.test.ts` (13): folder links and case
  variants (G2-prod/A1/A2/A3/A3n/A4/D1/DUP-A4/CI-lm/ALL-SKIP/ALL-SKIP-out/
  W-CI-rm/W-CI-mv). W-CI-rm/mv run on the factory-built port (brief T-1):
  fault injection patches the factory's own integration manager instance.
- `docs-policy-v2-handoff-large-tree.test.ts` (3): ONLY G1, G1-control,
  G1-flat (the slow large-tree tests, isolated so they never hold up the
  others).
- `docs-policy-v2-handoff-parity.test.ts` (2, new): normal handoff and
  reuse-after-failed-read, each run through the full manager AND the
  harness; asserts equal snapshot event fields and equal committed tree.

## 3. Kept full end-to-end tests through NativeBuildManager (6) and why

1. `C2a B1: production-manager plan-only run …` (commit file) — the only
   production create → activate → awaitIdle → selectProjectHandoff path for
   plan_only, incl. kernel commit metadata and trailer assertions.
2. `C2a B1+M6: production-manager finish run …` (commit file) — the only
   production automatic-handoff-applies path (spied project mutation runs
   only after the kernel snapshot exists).
3. `C2a B1: with the snapshot commit forced to fail …` (commit file) — the
   only automatic_project_handoff_failed + selection-refused coverage, and
   the no-mutation / no-commit-left-behind proof.
4. `C2a B2+M4: fail -> resume -> retry …` (commit file) — the only
   manager.resume → retry coverage (the 1 allowed extra; brief permits 2).
5. `C2b repair B1-R/N6-factory …` (commit file) — the baseline handoff
   through the factory port (CD-14 legacy-planning shape).
6. `C2b repair B1-R/G2-prod …` (project-links file) — withdrawn-stop
   reconciliation plus risk re-assessment through the production manager
   with the factory's port and the real kernel risk derivation.
   (The 2 parity tests also pump the full manager on one arm each; that is
   inherent to a parity comparison, not extra kept coverage.)

## 4. Name map (every old test name → its new file; no renames)

#### docs-policy-v2-handoff-gate.test.ts (11 tests)

- C2a: an answered docs-v2 run writes nothing and completes
- C2a M1: the gate binds to the latest handoff request, not an earlier snapshot
- C2a: a seeded docs-v1 run still requires the model-written STATE.md exactly as before
- C2a: run.completed is refused before the kernel event and accepted after it
- C2a: the snapshot gate only fires for non-answered docs-v2 runs
- C2b CD-14: the reducer does not pair docs v2 with planning v1; run options parse
- C2b: run options are recorded in run.policy_configured with durable defaults
- C2b repair m6: the shared selection predicate refuses an unresolved context note
- C2b repair m6: the shared selection predicate refuses an acceptance-contract upgrade
- C2b repair B1-R/P1: the factory-built docs port wires both reconciliation methods
- C2b repair N-3/probe R: the reducer refuses a snapshot record for a sequence that is no stop

#### docs-policy-v2-handoff-commit.test.ts (9 tests)

- C2a B1: production-manager plan-only run commits one kernel STATE.md snapshot in the handoff step
- C2a B1+M6: production-manager finish run snapshots at handoff and the automatic handoff applies afterwards
- C2a B1: with the snapshot commit forced to fail, the project is not mutated
- C2a B2+M4: fail -> resume -> retry returns to the handoff wait with no model call
- C2b repair B1-R/N6-factory: a docs-v2 run without a plan revision hands off the baseline through the factory port
- C2b: the handoff commit splices the v2 entry lines, keeping outside bytes
- C2b: missing AGENTS.md and CLAUDE.md are created with just the section
- C2a: the snapshot moves the v2 document tip on a finish-style revision
- C2b repair CD-14/N6: a docs-v2 run without a plan revision hands off the baseline

#### docs-policy-v2-handoff-retry.test.ts (19 tests)

- C2a B3: two consecutive failures pause again and the next resume retries
- C2a B4: commit lands, the read fails, retry reuses the commit and records its tree
- C2a: a crash between the kernel commit and the event append resumes to one commit and one event
- C2a M3: snapshot reuse requires every runner trailer, not just the key line
- C2b N1 probe F: a withdrawn-stop commit is recorded, never stuck, never mutating
- C2b N1 probe G: a snapshot that breaks the chain is refused before any mutation
- C2b repair B1 probe G2: a withdrawn stop's landed commit is reconciled, the chain continues
- C2b repair m2/probe H: a reused commit's event is derived from the commit, not fresh reads
- C2b N2: an owner pause stacked on a snapshot failure still resumes to retry
- C2b N4: a cherry-picked worker commit quoting the trailers is not reused
- C2b repair B2/G3: a transient reconciliation failure pauses before committing and retries on resume
- C2c repair BL-2/probe B1: a reused skip-layout commit completes after resume
- C2c repair BL-2/probe B1c: a reused CLAUDE.md skip-layout commit completes after resume
- C2c repair cycle 2/probe B2: a reused AGENTS.md-into-CLAUDE.md commit completes after resume
- C2c repair cycle 2/probe B2-real: a reused real AGENTS.md link commit completes after resume
- C2c repair cycle 2/probe S1-reuse: a reused STATE.md-link commit completes after resume
- C2c repair cycle 2/probe CI-reuse: a reused capital-Docs link commit completes after resume
- C2c repair cycle 2/probe E3-throw: a throwing stageability check never fails open
- C2c repair cycle 2/probe J-docs: an out-of-band docs junction pauses fail-closed

#### docs-policy-v2-handoff-entry-links.test.ts (17 tests)

- C2b: a reused commit without the v2 entry lines fails instead of recording
- C2b: a hand-edited STATE.md is detected and named in the next snapshot
- C2b repair m5: a committed CLAUDE.md link to AGENTS.md satisfies the line without writing through it
- C2b repair m3: a non-UTF-8 AGENTS.md survives the kernel splice byte-for-byte
- C2b repair B3/probe L: a link-mode CLAUDE.md under core.symlinks=false is never written
- C2c NF-2/probe L2: a link-mode AGENTS.md to CLAUDE.md writes the section into the target
- C2c NF-2/probe L2-real: a real AGENTS.md link to CLAUDE.md writes the section into the target
- C2c NF-2/probe L3: a CLAUDE.md link to another regular file writes the line into that target
- C2c NF-2: an AGENTS.md link to a missing target is skipped with a reason, and the handoff completes
- C2c NF-2: an AGENTS.md link to an outside target is skipped with a reason, and the handoff completes
- C2c NF-3/probe U1: a commit tree without the CLAUDE.md line is refused despite a live worktree link
- C2c NF-3/probe U2: a commit tree holding a lineless CLAUDE.md is refused despite a live worktree link
- C2c repair M-2/probe C9: a backslash link target from the index blob writes the section into the tracked target
- C2c repair M-5/probe C11: a dot-dot target that resolves inside is skipped with the real reason
- C2c repair M-5/probe C7: a kernel-owned redirect target is skipped with the real reason
- C2c repair cycle 4/probe RD-case: a link to notes.md when the index holds NOTES.md is refused and skipped
- C2c repair cycle 4/probe RD-case-real: a real link to notes.md when the index holds NOTES.md is refused and skipped

#### docs-policy-v2-handoff-spec-copy.test.ts (12 tests)

- C2b: the verbatim spec copy is committed when due
- C2b: the spec copy is skipped when the run opts out
- C2b: export_only writes nothing at handoff and completes
- C2b: the spec copy is skipped when the source is already a repository file
- C2b repair m4: a spec-copy search failure skips the copy, never the commit
- C2b repair N-1/probe K: a blocked spec directory never fails the snapshot
- C2b repair N-2/probe K2: a user's own spec-path file is never overwritten
- C2c NF-1/probe K-ignored: a gitignored specs directory never fails the snapshot
- C2c NF-4/probe K2b: an occupied target and sibling skip the copy as path_occupied
- C2c NF-4: an unreadable spec tip skips the copy instead of failing the snapshot
- C2c repair E1/E2: the stageability check stages nothing and leaves nothing behind
- C2c repair M-4/probe E3: an untracked occupant at the target keeps spec: matching the commit

#### docs-policy-v2-handoff-project-links.test.ts (13 tests)

- C2b repair B1-R/G2-prod: the G2 flow through the production manager with the factory's port
- C2c repair BL-1/probe A1: a committed specs-dir link to an absolute outside target writes nothing outside
- C2c repair BL-1/probe A2: a committed specs-dir link to a relative outside target writes nothing outside
- C2c repair CD-17/probe A3: a committed docs/project link writes nothing outside and still completes
- C2c repair CD-17/probe A3n: a committed docs/project link with no spec due completes with a recorded reason
- C2c repair CD-17/probe A4: a committed docs link writes nothing outside and still completes
- C2c repair M-1/probe D1: a junction above a redirect target refuses the redirect and writes nothing outside
- C2c round 3/probe DUP-A4: a docs link with entry files already current commits empty and completes
- C2c round 3/probe CI-lm: a committed capital-Docs link checked out as a plain file skips STATE.md and completes
- C2c repair cycle 4/probe ALL-SKIP: every write skipped still records an empty snapshot commit and completes
- C2c repair cycle 4/probe ALL-SKIP-out: links to outside files still record an empty snapshot commit and complete
- C2c repair cycle 4/probe W-CI-rm: a withdrawn stop reconciles its committed Docs link after Docs is removed
- C2c repair cycle 4/probe W-CI-mv: a withdrawn stop reconciles its committed Docs link after Docs becomes a real directory

#### docs-policy-v2-handoff-large-tree.test.ts (3 tests)

- C2c repair cycle 2/probe G1: a large docs tree still commits the snapshot and v1 documents
- C2c repair cycle 2/probe G1-control: a large tree outside docs still commits
- C2c round 3/probe G1-flat: 40,000 files directly under docs still commit the snapshot and v1 documents

#### docs-policy-v2-handoff-parity.test.ts (2 tests, NEW per brief item 3)

- parity: a normal handoff agrees between the full manager and the harness
- parity: a reuse after a failed read agrees between the full manager and the harness

## 5. Timing (before/after + the one group run)

Before (controller measurement on the C2c bytes, old file NOT re-run per the
brief — 84 tests in 5 name-split processes): C2a 14 tests 213 s; C2b 30
tests 1,816 s; C2c NF and repair 23 tests 3,150 s; C2c repair cycle 2 8 tests
2,683 s; C2c round 3 and cycle 4 9 tests 1,874 s. Wall 3,150 s, about
9,700 s of test time. G1-flat alone 709 s (first-run worker measurement).

After — the whole handoff group once with `--test-concurrency=6`
(NODE_TEST_CONTEXT cleared), all 8 files in one command:
`node ./node_modules/tsx/dist/cli.mjs --test --test-concurrency=6
runner-v2/test/docs-policy-v2-handoff-{gate,commit,retry,entry-links,
spec-copy,project-links,large-tree,parity}.test.ts`.
Group wall time: **2,329 s**, exit 1 with **85/86 pass** (runner summary:
tests 86, pass 85, fail 0 cancelled/skipped/todo, duration_ms 2329278).
Per-file durations from that run (sum of the file's test durations; tests
run sequentially inside one file, so this approximates the file wall):
gate 11 tests 92 s; commit 9 tests 530 s; retry 19 tests 2,236 s;
entry-links 17 tests 1,846 s; spec-copy 12 tests 1,414 s; project-links 13
tests 1,818 s; large-tree 3 tests ~1,597 s (includes the flaked G1-flat at
603 s with 0 snapshots); parity 2 tests 399 s. Total test time ~9,932 s.

The single group-run failure was G1-flat (603 s, 0 snapshots committed).
G1-flat passes alone in 243 s, and the whole large-tree file passes alone
in 711 s (3/3, wall). Same for the first group run's G1 ECONNRESET
(subprocess IPC under load): green alone in 245 s. Both are cross-file
git-subprocess contention flakes under concurrency 6 (8 heavy git processes
on one machine), not code bugs — see section 8.

Correction (repair cycle 1, review r1 m-6): the "contention-bound"
explanation of per-test cost was wrong. Per-test cost comes from building
a full factory per test and running git through the production execution
host: the controller measured about 1 s per git call, 93% of a harness
test (`evidence/test-time-profile-2026-09-29.md`). Per-group facts the
reviewer found: the kept fixture-port tests took 1.7-4.1 s; the 25 tests
moved onto the factory port took 38-271 s each (about 3,100 s together);
the 14 C2a tests went from 213 s to 630 s. Total test time is
factory-construction plus production-git cost, not contention (contention
only explains the two in-group flakes above, and the group wall number).

Follow-up runs (targeted, not timing substitutes): spec-copy opts-out 54 s
pass; N1-G 55 s + B1-G2 125 s pass; W-CI-rm 122 s + W-CI-mv 121 s pass;
parity file 253 s pass (2/2); G1 245 s pass; G1-flat 243 s pass;
large-tree file 711 s pass (3/3). Every one of the 86 tests is green in a
full-file run.

## 6. Parity result

Both parity tests pass: for a normal handoff and for a reuse after a failed
read, the full-manager arm and the harness arm record equal snapshot event
fields (stop kind, paths, body digest, skip reasons, spec status incl.
specPath/specCopied/specCopySkipped, revision, previousSnapshotEdited,
agents/claude committed flags) AND equal committed trees
(`rev-parse <commit>^{tree}` identical, same file list, same STATE.md
bytes). Two parity-test bugs fixed during validation: the manager-side
scheduler store was never closed (open SQLite handle → EPERM on temp-dir
removal; now `closeStore()` in `finally`) and the two arms used different
fixture labels, which `openFactoryPort` bakes into `package.json` and thus
into every tree hash (now one shared label per test; temp dirs still differ
via mkdtemp).

## 7. Prove-red (sha256 before/after, byte-exact restore)

Target: the reuse path shares the ONE commit-tree describer
(`describeSnapshotCommitFacts` in `maybeCommitHandoffSnapshot`,
`runner-v2/src/build-runtime.ts:2448`).
`runner-v2/src/build-runtime.ts` sha256 before:
`a85a24c540e2b0b12519812014afc444d46a8a6d716d411dd1af554aec1061b2`.
Mutation (temporary, review r1 m-5): when `result.reused === true`, the
reuse path uses a plain STATE-only description
(`{ stateChanged: stored.paths.includes("docs/project/STATE.md") }`)
instead of the shared describer. Mutated sha256:
`fc5f5c035c907ece4f60ab454c38c500804ce7fe55b80b62eb784c3025f4a056`.
Ran `C2c repair BL-2/probe B1: a reused skip-layout commit completes after
resume` (retry file): RED as required — 0 snapshots recorded,
`AssertionError 0 !== 1` ("resume reuses the commit and completes") at
retry.test.ts:793, 77 s. Without the shared describer the reused
skip-layout commit loses its recorded skip reason, the entry gate refuses
it, and the resume pauses instead of completing: the harness guards the
shared describer. Restored the exact original block; sha256 after =
`a85a24c540e2b0b12519812014afc444d46a8a6d716d411dd1af554aec1061b2`
(RESTORE_OK, byte-exact; `git diff --stat -- runner-v2/src/` empty).
Re-ran the same test on the restored source: GREEN (1 pass, 77 s).

Superseded: the earlier prove-red on `C2a B4` (any-reuse →
`stateChanged:false`, RED `0 !== 1` at retry.test.ts:150, 72 s, then
GREEN) only proved reuse works at all; the BL-2/B1 run above replaces it
as the describer guard.

## 8. Validation failures found in this continuation (all fixed)

The first group run (2,351 s wall) went 78/86. Five failures were genuine
first-run migration bugs (fixed, each verified green in isolation, then
green in the second group run); three were environmental:

1. `C2b: the spec copy is skipped when the run opts out` — the test seeded
   `specCopy:false` but `selectHandoffOwner` rebuilt the runtime with
   defaults, tripping "Scheduler run options conflict with the recorded run
   policy". Fix: pass `{ specCopy: false }` through (mirrors the export_only
   test). Test-only scaffolding; assertion meaning unchanged.
2. `C2b N1 probe G`, `C2b repair B1 probe G2`, `W-CI-rm`, `W-CI-mv` —
   `complete_run` failed with "A current build-risk assessment is
   required." Root cause: the factory configures a `risk_based` verifier
   policy, so `buildCompletionReadiness` demands a current `build.risk_
   assessed`; the old non-factory flows had no such policy. Fix: append the
   harness's `lowRiskSeed` after the FV seed (as B2/G3 and G2-prod already
   do). For B1-G2/W-CI a second seed (`risk:rerun-low`, targeting the
   re-run revision) precedes the seeded stop-2 re-request, because guidance
   invalidates the first assessment and the reducer requires readiness on
   the re-request append. Drive 2 still commits at the top of dispatch with
   no second architect turn (`architect.calls()==1` holds).
   (Superseded by the section 1 correction and section 11: the
   `risk:rerun-low` seed is removed, the runtime re-assesses for real, and
   `architect.calls()` is now 2.)
3. Parity EPERM ×2 — unclosed manager-side store (see section 6).
4. Parity tree mismatch ×2 (masked by 3) — distinct labels fork tree hashes
   (see section 6).
5. G1 `SubprocessRuntimeError: launch_not_proven` (cause ECONNRESET) and
   G1-flat 0-snapshots — each occurred once, only inside a full 8-file
   concurrency-6 group run; each passes alone (G1 245 s, G1-flat 243 s)
   and the large-tree file passes as a unit (711 s, 3/3). Environmental
   git-subprocess contention, no code change.

Also done in this continuation: removed 9 unused-import lint warnings
(split leftovers) and fixed the "file N of 7" headers to "of 8".

## 9. sha256 of every new or changed file (final bytes)

- `ca39be0752055e5ba26b13d84247e1efedd2d746e8cc51b2235d0960ab96eff5  runner-v2/test/docs-policy-v2-handoff-gate.test.ts`
- `c673c8dd0f79f4d8774d664a6b2abaee7aa0b5c5a8501d2a74a1b146b750c6e5  runner-v2/test/docs-policy-v2-handoff-commit.test.ts`
- `bf5d84e3bacd01bb68c39ac6fa295ab96bf468b47a5372f012599ee593f25d42  runner-v2/test/docs-policy-v2-handoff-retry.test.ts`
- `b007f17c89b6d380d9be3684c03ea8ae4827765d47d6793182e65c00d84560ee  runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts`
- `133c994dd07be3b8364352946d15f1be2dea7dcc05fdfff1a0f985acc54fa579  runner-v2/test/docs-policy-v2-handoff-spec-copy.test.ts`
- `075a6841ef2d51bcd12ea2a76f6b9715b7e334490cdd0685f42d26a3c8c2d470  runner-v2/test/docs-policy-v2-handoff-project-links.test.ts`
- `7f8f4ed52067c3acc2cad1a059be5f90af36a790c956654ebdeef4b785ce5b2a  runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts`
- `146054d1d877c9527a8ed38a907d46a83415b39c26a989a380cc04a1c245dbd3  runner-v2/test/docs-policy-v2-handoff-parity.test.ts`
- `43f4ad1ee352b90bc31a1d551811cbdfd8db3397ddeec53960e49c5766c3788d  runner-v2/test/support/handoff-snapshot-harness.ts`
- deleted: `runner-v2/test/docs-policy-v2-handoff.test.ts` (84 tests, recoverable from git HEAD for audit).

Checks: `tsc -p runner-v2/tsconfig.json --noEmit` exit 0; eslint on all 9
files exit 0 (no warnings); `git diff --check` exit 0; `git status --short`
shows exactly the deletion + 9 untracked files and one pre-existing
modification (`.superpowers/.../progress.md`, not made by this run and left
untouched). This TX-2.md itself is gitignored (`.gitignore:33:.superpowers/`,
like every other evidence file in this directory) and exists only on disk.
No commit/stage/stash/push performed.

## 10. Not done / limits

- No single 86/86 full-group run exists: the cleanest group run is 85/86
  (wall 2,329 s) with G1-flat as contention flake, green alone (243 s) and
  green in the large-tree file run (711 s, 3/3). Re-running the group for a
  perfect 86/86 is a ~40-minute lottery against the same contention; every
  test is green in a full-file run.
- Wall-time win is modest (3,150 s → 2,329 s). Correction (repair cycle 1,
  review r1 m-6): the group number is per-test factory-construction plus
  production-git cost (about 1 s per git call, 93% of a harness test;
  `evidence/test-time-profile-2026-09-29.md`), not contention. The
  structural win stands: 8 parallel files, no single 3,150 s bottleneck,
  G1s isolated.
- The large-tree file runs separately from the group (repair cycle 1,
  review r1 m-7): its three snapshot-count assertions now print the run's
  pause reason and detail on failure, so a future in-group pause is
  diagnosable without re-running the 40,000-file setup.
- The old 84-test file was deleted; its bytes remain in git history (HEAD)
  and the coverage script + JSON in system temp
  (`C:\Users\b_a_s\AppData\Local\Temp\p6-6\tx2-coverage.{js,json}`).
- Scratch scripts live only in system temp, not the repo, per the brief.

## 11. Repair cycle 1 (review r1 B-1, m-1..m-8; test-only, src unchanged)

All fixes are in the 8 test files, the harness, and this evidence file.
`runner-v2/src` was modified only for the §7 prove-red and restored
byte-exact (sha256 `a85a24c5…`, `git diff --stat -- runner-v2/src/`
empty). Nothing committed, staged, stashed or pushed.

- B-1: the four vacuous ordering checks (G2 retry:526, B2/G3 retry:737
  and :758, W-CI helper project-links:675) reworded to plain
  untouched-so-far facts; §1 corrected with the manager-ordering proof
  table (C2a B1+M6, C2a B1 forced-fail, C2b B1-R/G2-prod).
- m-1: `risk:rerun-low` seed removed from G2 and the W-CI helper; both
  use the B2/G3 real re-assessment pattern (§1 correction above).
- m-2: `scenario()` T1 `scope.excludes` restored to
  `["test/value.test.mjs"]` (harness:101).
- m-3: the harness selection mirrors call the kernel export
  `handoffSnapshotAtCurrentStop(projection)?.head` (as
  `native-build-manager.ts:578-581); the local re-filter is deleted.
- m-4: the normal parity scenario now selects `keep_integration_branch`
  on both arms (manager `selectProjectHandoff` vs harness
  `selectHandoffOwner`) and compares the outcome. Controller correction
  after review r2 (F-1): this is a selection smoke check (both arms accept
  the same selection and reach the same status), not a revision guard; the
  plan_only scenario skips the revision check, and choice and revision are
  echoed stub values. The test comment says the same.
- m-5: prove-red re-run with the STATE-only describer mutation on
  BL-2/probe B1 (§7; mutated sha256
  `fc5f5c035c907ece4f60ab454c38c500804ce7fe55b80b62eb784c3025f4a056`).
- m-6: timing explanation corrected in §5 and §10 (factory + production
  git, not contention; profile doc cited).
- m-7: the three large-tree snapshot-count assertions print
  `pauseReason` on failure (§10: the file runs separately from the group).
- m-8: the five spec-copy `driveHandoff` calls (K, K2, K-ignored, K2b,
  unreadable tip) moved inside `try`, so a throw closes the fixture.

Validation (targeted, NODE_TEST_CONTEXT cleared, no whole-group run, no
large-tree run):

| Check | Result |
|---|---|
| G2 + B2/G3 (`--test-name-pattern="probe G2:\|B2/G3"`, retry file) | 2/2 pass, 255 s |
| W-CI-rm + W-CI-mv (`--test-name-pattern="W-CI-rm\|W-CI-mv"`, project-links file) | 2/2 pass, 245 s |
| Parity file (incl. the new selection comparison) | 2/2 pass, 254 s |
| Five spec-copy tests (K, K2, K-ignored, K2b, unreadable tip) | 5/5 pass, 351 s |
| BL-2/probe B1 prove-red (mutated src) | RED as required (`0 !== 1`), 77 s |
| BL-2/probe B1 after byte-exact restore | 1/1 pass, 78 s |
| `tsc -p runner-v2/tsconfig.json --noEmit` | exit 0 |
| eslint on the 6 changed files | exit 0, no warnings |
| `git diff --check` | exit 0 |


## 12. Controller validation and acceptance (repair-cycle-1 bytes)

Controller run, started detached so an app restart could not stop it (NODE_TEST_CONTEXT cleared): the 7 files gate, commit, retry, entry-links, spec-copy, project-links and parity together at `--test-concurrency=7`: **83/83 pass**, 2,147 s wall; then the large-tree file alone: **3/3 pass**, 726 s. All 86 tests green in one controller pass. Logs: scratchpad `tx2group/`.

Independent review r2 (`TX-2-review-r2.md`, Sonnet, xhigh effort): **ACCEPT**, 0 blocking. Its cosmetic follow-ups were applied by the controller during the run, comment and evidence text only: N-1 (stale comment removed, project-links W-CI helper), F-1 (parity comment and the section 11 m-4 line reworded: a selection smoke check, not a revision guard), N-2 (section 1 row 3 names the `order` assertions), N-3 (section 8 item 2 marked superseded). The two test files changed only in comments (new sha256: project-links 735734b1…3e434, parity 74231e34…ec782); eslint on both exit 0; `git diff --check` clean.

Rule from this packet (CD-18): the controller runs the large-tree file separately from the other handoff files.

**TX-2 ACCEPTED 2026-09-29.**
