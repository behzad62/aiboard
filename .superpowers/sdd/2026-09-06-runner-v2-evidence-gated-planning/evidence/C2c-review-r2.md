# C2c - independent code re-review r2

Reviewer: fresh-context independent re-reviewer (round 2). I did not write this code and did not do round 1. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `62362265`; C2c uncommitted.
Inputs: `C2c-review-r1.md`; repair briefs `c2c-repair1a-muse.txt` and `c2c-repair1b2-muse.txt`; `evidence/C2c.md` "Repair cycle 1, part A" and "part B"; plan CD-4, CD-15, CD-17 and the C2c section; the worker's log `D:\tmp\c2c-partb-full.log`.

Files under review match the part-B hashes exactly (integration-manager `aef48359`, build-runtime `eef5b605`, project-docs `16ede81f`, scheduler-store `d248e1dc`, docs-policy-v2-handoff test `2927467b`, project-doc-commit test `ed3f622c`). I edited no source or test file. Every probe ran from test files in my scratchpad that import the worktree modules by absolute URL, so nothing was written into the repository. Every probe fixture lives under the system temp directory, and every "outside" directory is inside that fixture root.

**Verdict: REPAIR — 3 blocking**

Most of the round-1 items are fixed: BL-1, M-1, M-2, M-3, M-4 (normal path), M-5, A3n and A4 hold under every probe, and nothing reached an outside directory in any layout I tried. Three new defects block acceptance. All three are stuck runs in code changed by this repair cycle, and each is backed by a failing probe:
- **NB-1**: the M-6 change re-breaks BL-2 for the common "AGENTS.md is a link to CLAUDE.md" layout. A reused snapshot commit can never be recorded again.
- **NB-2**: the CD-17 STATE.md skip cannot be re-derived on the reuse path when STATE.md itself is a link, or when the docs link is spelled `Docs` (case-insensitive checkout).
- **NB-3**: the new per-component check lists the whole `docs/` index. With a large docs tree (over 4 MiB of `ls-files` output), every snapshot fails and every v1 Architect document commit throws. The v1 part is an undeclared regression.

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| NB-1 (stuck run; regression of BL-2 caused by M-6) | `build-runtime.ts:2511-2519` (current stop). `agentsRedirectTarget` comes only from `result.redirected`, and `claudeSkip` only from `result.skipped` or a CLAUDE.md link target. A reused commit carries neither (`integration-manager.ts:667-675`). Since M-6 (`integration-manager.ts:1033-1054`), the merged CLAUDE.md holds no `@AGENTS.md` line, so `handoffEntryFileStatus` returns null. The withdrawn-stop path already re-derives this from the tree (`build-runtime.ts:2757-2771`); the current stop does not. | **B2**: a link-mode `AGENTS.md` pointing at a regular `CLAUDE.md`. The commit lands, then the snapshot read fails once (`failNextSnapshotReadOnce`, the C2a B4 shape). **B2-real**: the same with a real link made by git (`core.symlinks=true`). A crash between the commit and the append takes the same path. | Resume reuses the commit, records it, and the handoff completes. Round 1 ran the same B2 probe and it recovered. | B2 and B2-real: 3 resumes each, and every one pauses with `commit <sha> lacks the v2 AGENTS.md section or the CLAUDE.md line`. 0 snapshots; the owner's selection is refused (`The kernel handoff snapshot is required ...`). B2-control (no injected failure) completes, so only the reuse path is broken. Other reuse layouts recover: B1, B1c, B3 (both files link to NOTES.md), B4 (AGENTS.md links to `docs/notes.md`) and A4-reuse. | On the current stop, when no stage-time CLAUDE.md reason exists and the tree proves that AGENTS.md is a link into CLAUDE.md holding the section, pass `agentsRedirectTarget: "CLAUDE.md"` and the omission reason. Use the same `withdrawnAgentsIntoClaude` derivation the withdrawn path uses, ideally as one shared helper. Add B2 (link-mode and real link) as factory-port regression tests that resume to 1 snapshot and a completed selection. |
| NB-2 (stuck run; CD-17 reuse re-description is incomplete) | Stage time uses `firstLinkComponent` (`integration-manager.ts:2641`): every component down to the file itself, with worktree lstat (case-insensitive on NTFS) and index. On reuse, the runtime can only re-describe the STATE.md skip from `dirLinks` (`integration-manager.ts:2316-2322`: exact-case `docs`, `docs/project`, `docs/project/specs`) at `build-runtime.ts:2446-2449`. The withdrawn path has the same gap (`build-runtime.ts:2737-2748`). | **S1-reuse**: a committed link-mode `docs/project/STATE.md` (to `../../shared.txt`), then the snapshot read fails once. **CI-reuse**: a committed capital-`Docs` real link to an outside directory (git-native; Windows and macOS default checkouts are case-insensitive), then the read fails once. | Resume records the reused commit with the STATE.md skip reason and completes, as the fresh paths S1, S1-out and CI do, and as A4-reuse does. | S1-reuse: 3 resumes, each pausing with `holds a STATE.md that failed its digest check` (the link blob is read back as STATE.md). CI-reuse: 3 resumes, each pausing with `holds no docs/project/STATE.md`. 0 snapshots and the owner is refused in both. | Derive the reuse reason from the same fact set the stager uses: include `docs/project/STATE.md` itself in the commit-tree link check, and match the directory components case-insensitively when the checkout is (`core.ignorecase`), or list the parent tree and compare case-folded names. Share the helper with the withdrawn path. Add S1-reuse and CI-reuse as regression tests. |
| NB-3 (stuck run plus an undeclared v1 regression; new in part B) | `firstLinkComponent` passes every component, including `docs`, to `indexEntryModes`, which runs `git ls-files -s -z -- docs docs/project ...` (`integration-manager.ts:2649`, `:2536`). That lists the whole `docs/` subtree. Output over the default 4 MiB cap (`git-runtime-runner.ts:96`) throws `output_limit`, even with `allowFailure` (`:61-66`). Before C2c, only `docs/project` and below were listed, and that directory is runner-owned. | **G1**: 40,000 tracked files under `docs/generated/` (`ls-files` output 4,720,000 bytes). This is a realistic size for a committed generated site or API docs (GitHub Pages `/docs`). | The snapshot commits and the handoff completes; v1 Architect document commits behave as at HEAD. | Every attempt (the first plus 2 resumes) pauses with `Git output exceeded 4194304 bytes ...`. 0 snapshots, and the owner is refused. The v1 `commitProjectDocuments` call throws the same error. **G1-control** (the same 40k files under `site/generated/`): the snapshot commits (1 snapshot) and v1 commits. That isolates the cause to the `docs` component query. | Query only the component entry itself. In a scratch repository, `git ls-files -s -z -- <c> ':(exclude)<c>/*'` returns exactly the entry: a link entry is listed, and a directory returns nothing. `git-execution-policy.ts` has no pathspec restriction, but the policy's handling of the magic should be confirmed. Add G1 as a regression test (about 3.5 minutes), or add a smaller one with an injected low `maxOutputBytes`. |

## Minor findings

| # | Where | Finding | Suggested fix |
|---|---|---|---|
| m-1 (a recorded fact contradicts the commit) | `build-runtime.ts:2446-2449` | The `dirLinks` fallback runs on the fresh path too, and it includes `docs/project/specs`, which is not an ancestor of STATE.md. **A1, A2, A5**: the event records `stateSkippedReason: "docs/project/STATE.md is not written: docs/project/specs is a symbolic link or junction ..."` next to a real `bodyDigest`, and the commit's paths include `docs/project/STATE.md`. The gate outcome is still right. The worker's A1/A2 tests do not assert that the field is absent. | Fall back only when the commit lists no STATE.md (`stateChanged` false), and only for ancestors of STATE.md or STATE.md itself (see NB-2). Assert the field is absent in A1/A2. |
| m-2 (fail-open; the mechanism behind the worker's E3 red) | `build-runtime.ts:2388-2393` | When `canStageSpecPath` throws, the runtime sets `stageable = true`. **E3-throw** (the E3 occupant plus one injected throw, `A verified process backend ... is unavailable`): the committed STATE.md says `spec: docs/project/specs/source_value.md`, the commit holds no spec file, and the event says `path_occupied`. This is exactly the symptom of the worker's first full run. It breaks the M-4 guarantee under a transient error. | On a check error, treat the path as unstageable (the copy is optional, so render "not recorded"), or pause the snapshot for a retry. |
| m-3 (STATE.md skip accepted without commit-tree backing; out-of-band only) | `build-runtime.ts:2446`: a stage-time reason is used as is. For entry files, `handoffEntryFileStatus` requires the commit-tree link (NF-3); STATE.md has no equivalent check. | **J-docs**: tracked `docs/keep.md`, and the integration worktree's `docs` is replaced out-of-band by a junction. STATE.md is skipped (nothing is written outside: the outside directory still holds only `own.txt`) and the gate accepts. The commit tree holds `040000 tree ... docs`. This is the same runner-worktree-tampering class as U1/U2 and D1, which earlier rounds rated minor. | Accept `stateSkippedReason` only when the commit tree holds a link at that component (case-folded where the checkout is case-insensitive); otherwise pause fail-closed as U1/U2 do. |
| m-4 (reason wording) | skip reasons | **E3** records `write_failed` although the cause is an occupant (`path_occupied`). **D1** says `target sub/notes.md is not a regular tracked file`, but it is tracked; the real cause is the junction above it. **B3** on reuse re-describes the C3 layout as `CLAUDE.md ... is skipped (the target holds no marked line)`, while the fresh path records the M-6 omission. All outcomes are safe. | Name the actual cause, and share one re-description helper across the fresh, reuse and withdrawn paths. |
| m-5 (information) | `resolveEntryLinkTarget` (`integration-manager.ts:2800`) | Backslash normalization also rewrites a POSIX file name that contains a literal backslash. It is safe: the target can only be a tracked regular file inside the repository, and the gate uses the same normalization. | None needed; optionally apply it only on win32 or only to index blobs made on Windows. |
| m-6 (information) | CD-17 wording | The runtime also skips STATE.md when STATE.md itself is a link (S1, S1-out: skipped, outside unchanged, completes). CD-17 lists only the directories. I accept the behavior as within its per-component intent. | The controller records in CD-17 that the file itself is a component. |
| M-7 (carried from r1) | `.gitignore` (`.superpowers/`) | `evidence/C2c.md` and this file are ignored. | `git add -f` at commit time. |

## Pre-existing (not C2c; escalate before T7a)

- **F-matrix (non-link layouts; stuck runs)**: the STATE.md write fails on every attempt (the first plus 2 resumes), with 0 snapshots and the owner refused, when:
  - a tracked regular file is named `docs` (`ENOTDIR ... mkdir docs`);
  - a tracked regular file sits at `docs/project` (`EEXIST ... mkdir docs/project`);
  - a tracked directory sits at `docs/project/STATE.md` (`EISDIR`).
  The mkdir and write code on that path is unchanged from HEAD, and HEAD's `refuseProjectDocLink` reaches the same mkdir or write, so this is not a C2c regression. It contradicts the C2c outcome sentence ("no repository layout leaves a v2 run unable to hand off"), but CD-15 and CD-17 scope only links. As with A3n/A4 in round 1, I list these for the controller to scope rather than counting them as blocking. The natural fix treats a non-directory component like a CD-17 link: skip STATE.md with a recorded reason that is backed by the tree.
- **G1-control, harness handoff**: with 40k tracked files anywhere in the tree, the harness's project handoff (`IntegrationManager.applyToProject`) fails with the same 4 MiB `output_limit` error (`selected: refused: Git output exceeded 4194304 bytes`), independent of docs. This is outside C2c. NB-3 is still a C2c regression, because the v1 document commit and the v2 snapshot worked for this layout before part B.

## Resolution of round-1 items

| Item | Status | Proof (factory-built docs port, `NativeBuildManager`, real SQLite and git) |
|---|---|---|
| BL-1 (spec preview written outside) | **RESOLVED** | A1 (absolute) and A2 (relative) real links at `docs/project/specs`, A5 (link-mode, `core.symlinks=false`), J-specs (Windows junction): the outside directory is empty, the copy is skipped as `write_failed`, STATE.md says `spec: not recorded`, and the run completes. E1: the check writes nothing. |
| BL-2 (reuse wedges skip layouts) | **PARTIAL** | Recovers after 1 resume: B1 (AGENTS.md link to MISSING.md), B1c (CLAUDE.md link to `../outside.md`), B3, B4 and A4-reuse. Still wedges: NB-1 (B2, B2-real) and NB-2 (S1-reuse, CI-reuse). |
| M-1 (redirect through a directory link) | **RESOLVED** | D1 (out-of-band junction at `sub`): the outside `notes.md` is unchanged, the entry is skipped and the run completes. D1-link (committed real link at `sub`): the same. |
| M-2 (Windows backslash targets) | **RESOLVED** | C9: a real link made by git reads back as `docs\notes.md`; the section is written into `docs/notes.md` (its own bytes survive), `agentsSectionViaLink` names it, and the run completes. C9-bs: a link-mode blob holding `docs\notes.md` redirects into `docs/notes.md` and completes. C9-bs-escape: `..\outside.md` is skipped as outside the repository and the run completes. |
| M-3 (preview leftovers) | **RESOLVED** | E1: ignored path false, normal true, tracked-under-ignore true; the index and `git status --porcelain --ignored` are unchanged. E2: after a failure before staging, `git status` is clean. |
| M-4 (`spec:` line vs the committed copy) | **RESOLVED on the normal path**; fails open on a check error (m-2) | E3: `spec: not recorded`, no spec file in the commit, the occupant untouched, completes. My two re-runs of the worker's E3 test pass. E3-throw: see m-2. |
| M-5 (reason wording) | **RESOLVED** | C11: `sub/../CLAUDE.md` is recorded as `uses ".." and is never followed (it resolves inside the repository)`. C7: a `docs/project/STATE.md` target is recorded as `kernel-owned`, and the kernel's STATE.md holds no marker. C8 (regression set): a spec-path target is recorded as `kernel-owned`. The remaining wording nits are in m-4. | |
| M-6 (self-import) | **RESOLVED on the fresh path**; causes NB-1 on reuse | B2-control: completes with the omission recorded. C3 (both files link to NOTES.md): one marker pair, `agentsV2` true, the prefix kept, `@AGENTS.md` omitted and recorded. L2-real (a real link): one marker pair, no `@AGENTS.md` line, the CLAUDE.md prefix kept, and AGENTS.md still a link. C12: an existing section is replaced (the old text is gone, the trailer kept, one marker pair). |
| M-7 | **OPEN** (controller action) | see above |
| A3n (docs/project link wedges the run) | **RESOLVED** | A3 (spec due) and A3n (none): STATE.md is skipped with `docs/project is a symbolic link or junction`, 1 snapshot, the outside directory empty, completed. |
| A4 (docs link writes STATE.md outside) | **RESOLVED** | A4 (real link), A4-lm (link-mode, checked out as a plain file) and CI (`Docs`, case-insensitive): the outside directory is empty and the run completes. v1 matrix: `commitProjectDocuments` refuses a real `docs` link, a link-mode `docs`, a junction `docs` and a `Docs` link, all with `... is refused because docs is a symbolic link or junction.`. The revision count is unchanged and the outside directory is empty in each case. v1-plain still commits `[AGENTS.md, docs/project/STATE.md]`. |

## Safety checks (brief item 2)

- **Nothing is written outside the repository**: holds in every layout probed. That covers A1, A2, A3, A3n, A4, A4-lm, A5, CI, CI-reuse, J-docs, J-specs, S1 (`shared.txt` unchanged), S1-out (outside file unchanged), D1, D1-link, the v1 matrix and C9-bs-escape. It also holds across the stuck runs (NB-1 to NB-3), which fail closed without writing.
- **The gate accepts a skip only with a reason backed by the commit tree**: yes for entry files (`handoffEntryFileStatus` needs the commit-tree link target; B-series). For STATE.md it holds on reuse (by construction from `dirLinks`) but not on the fresh path (m-3: out-of-band only).
- **No layout leaves a run unable to hand off**: violated by NB-1, NB-2 and NB-3. Three non-link layouts also wedge; they are pre-existing (see that section).
- **STATE.md is required unless CD-17 records why**: the reducer (`scheduler-store.ts:9276-9291`, `:9154`) accepts a record without STATE.md only when `stateSkippedReason` is present. Every no-STATE record I produced carried a reason. m-1 is the reverse error: a reason recorded while STATE.md is committed.

## Flakiness judgement (brief item 3)

- **G2-prod and the teardown crash are environmental.** The stack in `D:\tmp\c2c-partb-full.log` runs `NativeBuildFactory.create`, then integration-workspace init, then git, then `selectProcessBackend` (`process-backend.ts:391`), which throws "A verified process backend with required semantic capabilities is unavailable". The Windows job backend's `probe()` calls `probeActiveJobCreateClose()`. That `spawnSync`s `powershell.exe` with a **2,000 ms** deadline (`windows-job-process-host.ts:319-335`, `DEFAULT_ACTIVE_JOB_PROBE_DEADLINE_MS = 2_000`), and any failure maps to "unavailable". Under load (the controller's native-delivery suites ran at concurrency 4 alongside the worker's run and mine), PowerShell start-up can exceed 2 s. No C2c code is on that path. My re-runs under the same kind of load: G2-prod passed 2/2 (279 s, 272 s).
- **E3 is an environmental trigger hitting a real fail-open branch, not a race.** `canStageSpecPath` runs under `serialized` and nothing else touches the path concurrently. The only way to reach the red symptom (`spec:` naming an uncommitted copy) is a throw from the check, which the runtime turns into "stageable". E3-throw reproduces that symptom deterministically (m-2). The worker's E3 test passed 2/2 in my re-runs (138 s, 130 s).
- A related hardening follow-up, outside C2c: a 2 s PowerShell probe deadline is tight on a loaded Windows host, and suites that build many factories are exposed to it.

## v1, replay and hygiene (brief item 4)

- v1: the only behavior changes I observed are the declared `docs` refusals (v1 matrix) **plus NB-3** (an undeclared throw with a large `docs/` tree). The physical-path merge and M-6 are reached only with `skipClaudeAgentsLink` (the kernel path). v1-plain commits as before.
- replay-compatibility, git-caller-audit, lsp-caller-audit, mcp-caller-audit, one-shot-command-routing-static and static-adapter-policy: **42 pass, 0 fail**.
- Runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. eslint on the 5 changed source files and the 2 changed test files: exit 0. `git diff --check`: clean.
- Encoding: no BOM, valid UTF-8, no mixed line endings, and non-ASCII counts equal HEAD for every changed source and test file. `project-docs.ts` is CRLF in the worktree over an LF blob (`core.autocrlf=true`), the same as round 1. `C2b.md` drops by 3 non-ASCII bytes (the NF-7 rewrite, known from r1).
- Not re-run, per the no-duplicate-runs rule: the worker's full docs-policy-v2-handoff (67), project-doc-commit (19) and the 174/106 batches. The files are byte-identical to the evidence hashes, and my probes cover the changed behavior. Also not run: native-delivery-* (the controller's).

## Probes

Scratch files `r2-p1`, `r2-p2a`, `r2-p2b1`, `r2-p2b2`, `r2-p3` and `r2-p3c` (`.test.ts`) and their logs are in my scratchpad (`...\scratchpad\r2c2c\`). The harness is the round-1 one (`openFactoryPort`, `planOnlyThroughFactoryPort`, `failNextSnapshotReadOnce`). Links are made with git (`update-index --cacheinfo 120000`, checked out with `core.symlinks=true` or `false`), and junctions with `symlinkSync(..., "junction")`.

| Probe | Result |
|---|---|
| B2 / B2-real | **FAIL (NB-1)**: 3/3 resumes pause, 0 snapshots, the owner is refused |
| B2-control | completed; `claudeLineViaLink` = the M-6 omission |
| S1-reuse / CI-reuse | **FAIL (NB-2)**: 3/3 resumes pause (`digest check` / `holds no STATE.md`) |
| S1 / S1-out / CI | completed with `stateSkippedReason`, `bodyDigest ""`, paths `[AGENTS.md, CLAUDE.md]`, nothing outside |
| G1 | **FAIL (NB-3)**: 3/3 attempts `Git output exceeded 4194304 bytes`; v1 throws |
| G1-control | snapshot committed and v1 committed (the harness apply step hits the separate pre-existing cap) |
| A1 / A2 / A5 | completed, outside empty, `write_failed`, `spec: not recorded`; **m-1** (a false `stateSkippedReason`) |
| A3 / A3n / A4 / A4-lm | completed, outside empty, reason names the linked component |
| A4-reuse | 1 resume, then completed with the reason re-described from `dirLinks` |
| J-docs | completed with nothing outside; **m-3** (the commit tree holds a regular `docs` tree) |
| J-specs | completed, outside empty, `write_failed` |
| V1 matrix | 4 link forms refused with no commit and nothing outside; plain commits |
| B1 / B1c / B3 / B4 | 1 resume, then completed with 1 snapshot and no second commit |
| D1 / D1-link | outside file unchanged, entry skipped, completed |
| E1 / E2 / E3 | no index or status change / clean status after a failure / `spec: not recorded`, completed |
| E3-throw | **m-2**: `spec:` names a copy the commit lacks |
| C3 / C9 | completed (see M-6 / M-2 rows) |
| C9-bs / C9-bs-escape | redirect into `docs/notes.md` / skipped as outside; both completed |
| C11 / C7 | completed; M-5 wording (`..` never followed / kernel-owned) |
| L2-real / C12 | completed; one marker pair, no self-import, the prefix and trailer kept |
| C-regress C1, C2, C4, C5, C8 | all completed with a recorded reason or redirect (cycle, chain, directory, `.git` / `.git/config`, spec path) |
| F-matrix (a `docs` file, a `docs/project` file, a directory at STATE.md) | pre-existing: 3/3 attempts fail (`ENOTDIR` / `EEXIST` / `EISDIR`) |
| Worker's E3 and G2-prod, 2 iterations each | 4/4 pass under load |
| Static and replay suites | 42/42 |

## Follow-up list

1. NB-1: re-derive the M-6 omission on the current-stop reuse path, with one helper shared with the withdrawn path. Regression tests B2 and B2-real.
2. NB-2: include STATE.md itself and case-folded components in the commit-tree facts, on both the current and withdrawn paths. Regression tests S1-reuse and CI-reuse.
3. NB-3: bound the per-component index query (exclude the subtree). Regression test G1 (or a small-cap variant), with a v1 assertion.
4. m-1: no `stateSkippedReason` when STATE.md is committed; assert it in A1/A2.
5. m-2: fail closed (skip the copy, or pause) when `canStageSpecPath` throws; E3-throw as a test.
6. m-3: corroborate the STATE.md skip against the commit tree (J-docs as a test).
7. m-4: reason wording (E3, D1, reuse re-descriptions).
8. Controller: record in CD-17 that the file itself is a component (m-6); `git add -f` for the evidence files (M-7).
9. Escalate (pre-existing): the F-matrix non-link layouts; the 4 MiB cap in the project handoff for large trees (G1-control); the 2 s PowerShell probe deadline under load.
