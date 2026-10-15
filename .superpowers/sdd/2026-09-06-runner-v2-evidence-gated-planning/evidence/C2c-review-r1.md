# C2c - independent code review r1

Reviewer: fresh-context independent reviewer. I did not write this code. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `62362265`; C2c changes uncommitted.
Inputs: plan CD-15, CD-16 and the "C2c" section; briefs `c2c-brief-muse.txt`, `c2c-part1-muse.txt`, `c2c-part2-muse.txt`; `evidence/C2c.md` Parts 1 and 2; `C2b-review-r3.md` (NF-1 to NF-5, NF-7).

I hashed all 12 changed files before and after my probes. Every hash matches the "Part 2" list in `evidence/C2c.md`. My probes ran from a temporary test file that I have since deleted. A copy is in my scratchpad as `zz-c2c-r1-probe.test.ts`, with its log in `probe-run1.log`. `git status` is back to the worker's set.

**Verdict: REPAIR — 2 blocking**

All six NF items are resolved on the fresh snapshot path (see the table below). Two new defects block acceptance:
- **BL-1**: the new port method `canStageSpecPath` writes a preview file before any link check. A committed directory link at `docs/project/specs` or `docs/project` therefore gets the approved spec bytes written into a directory outside the repository.
- **BL-2**: CD-15 skip layouts cannot recover through the commit-reuse path. If the commit lands and the event append does not happen (a transient read failure, or a crash), every resume pauses again.

## Blocking findings

| # | Where | Failing input | Expected | Actual | Fix |
|---|---|---|---|---|---|
| BL-1 (write outside the repo, through a link; new in C2c) | `integration-manager.ts:2544-2570` (`canStageSpecPath`). The preview write at `:2559-2566` runs with no `refuseProjectDocLink`, unlike `stageHandoffSpecCopies` `:776`. The runtime calls it before the commit at `build-runtime.ts:2354`. | **A1**: `docs/project/specs` is a committed link (mode 120000, checked out as a real link with `core.symlinks=true`, made with git only) to an absolute directory outside the repository, and a spec copy is due. **A2**: the same with a relative `../../../zz-outside-specs-rel` target. **A3**: `docs/project` is the link. | Nothing is written outside the repository. The copy is skipped with a reason. | A1 and A2: `outsideFilesAfter: ["source_value.md"]`, meaning the approved spec was written into the outside directory. The snapshot still commits (`specCopySkipped: write_failed`, `spec: not recorded`) and the run completes, so the stray file goes unnoticed. A3: `outside/specs/source_value.md` is written. A3n (the same layout with no spec copy due) writes nothing, which isolates the write to `canStageSpecPath`. A5 (the same link as a link-mode plain file under `core.symlinks=false`) writes nothing. | Drop the preview write. `git add --dry-run --ignore-missing -- <path>` answers the ignore question without the file existing, and the Runner git policy allows it (`git-execution-policy.ts:121` refuses only interactive `add` modes). Verified here: an ignored missing path exits 1, a normal missing path exits 0, and a path beyond a link exits 128. Also run the same per-component link refusal as `stageHandoffSpecCopies` first. Add A1 and A2 as regression tests that assert nothing appears outside. |
| BL-2 (stuck run; C2a B4 and crash recovery are broken for CD-15 skip layouts) | `build-runtime.ts:2445-2457` takes the skip reasons only from `result.skipped`. A reused commit (`integration-manager.ts:667-675`) carries no `skipped` and no `redirected`, so `handoffEntryFileStatus` returns `null` (`build-runtime.ts:493`, `:507`). | **B1**: a link-mode `AGENTS.md` pointing at `MISSING.md`, and the factory integration's snapshot read fails once after the commit lands (`failNextSnapshotReadOnce`, the C2a B4 shape). **B1c**: the same with a `CLAUDE.md` link to `../outside.md`. | Resume reuses the commit, records it with the skip reason, and the handoff completes (as B1-control does with no injected failure). | B1 and B1c: 3 resumes. Each pauses with `commit <sha> lacks the v2 AGENTS.md section or the CLAUDE.md line`. There are 0 snapshots and 2 commits, and the owner's selection is refused. The same happens after a crash between the commit and the append. B2 (the redirect layout under the same injection) recovers, because the ViaLink flag comes from the tree. | When a reused commit has no stage-time reason for an entry file, derive the skip reason from the commit tree's link target. The withdrawn-stop path already does this (`build-runtime.ts:2667-2674`). Alternatively, attach the tree-derived reasons in the reuse branch of `commitHandoffSnapshot`. Add B1 as a regression test that resumes to 1 snapshot and a completed selection. |

## Minor findings

| # | Where | Finding | Suggested fix |
|---|---|---|---|
| M-1 (out-of-band; same root cause as BL-1) | `isEntryLinkRedirectTarget` (`integration-manager.ts:2447-2460`) checks only the final path component. A redirected write skips `refuseProjectDocLink` (`:992-1018`). | **D1**: `sub/notes.md` is tracked, and the worktree `sub` is replaced out-of-band by a junction to an outside directory. `AGENTS.md` is a link-mode entry to `sub/notes.md`. Result: the marked section is spliced into the outside `notes.md` (`outsideHasMarker: true`), `git add` stages it, the commit holds it, and the gate accepts. This needs an edit to the runner-owned worktree, the same class as U1/U2, which r3 rated minor. A git-native route through a case-colliding tree with real links (for example on macOS) is plausible, but I did not demonstrate it here. | Before a redirected write, check every component of the target path for links (the `refuseProjectDocLink` loop over all components), or check realpath containment. |
| M-2 (Windows) | `entryLinkRawTarget` prefers `readlink` (`:2424-2426`), and `resolveEntryLinkTarget` refuses any backslash (`:2724`). | **C9**: git for Windows stores a real link to `docs/notes.md` with the target `docs\notes.md`. The entry file is skipped as "outside the repository", although the target is a regular tracked file inside it that CD-15 says to write into. It is safe and the handoff completes, but both the reason and the outcome are wrong. Root-level targets (L2-real, C9b) are unaffected. | Use the index blob target when the index holds mode 120000 (it is what the commit tree carries), or normalize `\` to `/` for `readlink` results on win32. |
| M-3 | `canStageSpecPath` | "Stages nothing" holds (E1: the index is unchanged). "Modifies nothing" does not: E1 leaves `?? normal-b.md` and `!! ignored-a.md` behind. **E2**: after a snapshot commit that fails before staging, `?? docs/project/specs/source_value.md` stays in the integration worktree. It agrees with the real stage for the ignored, normal and tracked-under-ignore cases. | This is fixed by the BL-1 change (no preview). |
| M-4 (NF-4 residual) | `resolveHandoffSpecCopyPath` decides from tip blobs, while `writeHandoffSpecCopy` decides from worktree bytes (`integration-manager.ts:795-829`). | **E3**: an untracked file with other bytes sits at the target. STATE.md says `spec: docs/project/specs/source_value.md`, but the commit holds only `source_value-5d5744ae0c440dd3.md`. The event's `specPath` is correct. One source of this layout is an E2 leftover followed by changed spec bytes. | Resolve from the same inputs the stager uses, or make the stager honor the resolved path. |
| M-5 (reason wording) | skip reasons | `sub/../CLAUDE.md` is reported as "outside the repository" (C11). A tracked `docs/project/STATE.md` target is reported as "not a regular tracked file" (C7; it is kernel-owned). Both outcomes are safe. | Name the actual reason. |
| M-6 (information) | the merged same-file section | With AGENTS.md linked to CLAUDE.md, CLAUDE.md gets one marked section holding the AGENTS body plus `@AGENTS.md`, which imports the file into itself (L2-real, C9b). Both v2 checks read true, there is one marker pair, and the splice is idempotent (C12). | Optional: omit the pointer when AGENTS.md resolves to CLAUDE.md, or record it. |
| M-7 (information) | `.gitignore:33` (`.superpowers/`) | `evidence/C2c.md` is ignored (`!!`). Sibling evidence files are force-added. | The controller must use `git add -f` when committing. |

## Pre-existing (not C2c; escalate before T7a)

- **A4**: a committed `docs` directory link. `refuseProjectDocLink` checks only `docs/project` and below (`integration-manager.ts:2578-2584`), so STATE.md is written through `docs` into the outside directory (`project/STATE.md`). Then `git add` fails with "beyond a symbolic link" on every attempt, so the run is stuck and the owner is refused. It writes outside the repository and it is a stuck run. C2c did not change that code.
- **A3n**: a committed `docs/project` directory link is refused on every attempt, so the run is stuck (no write). This is outside CD-15's entry-file scope, but it contradicts "no layout leaves a run unable to hand off".

## Resolution of the brief's items

| Item | Status | Proof |
|---|---|---|
| NF-1 (gitignored specs) | **RESOLVED** | K-ignored: 1 snapshot, `write_failed`, committed paths `[AGENTS.md, CLAUDE.md, docs/project/STATE.md]`, `spec: not recorded`, completed. K (a tracked file at `specs`): the same. |
| NF-2 / CD-15 | **RESOLVED on the fresh path**; BL-2 on reuse; M-1 and M-2 | L2, L2-real, L3, C2, C3, C9b, C11 (`./CLAUDE.md`) and C12 write into the regular in-repository target, never through the link (the link bytes and link-ness are unchanged). A missing target, `../outside.md`, an absolute outside file (C6: the outside file is unchanged), a directory (C4), `.git` and `.git/config` (C5: `.git` unchanged), STATE.md (C7), a spec path (C8), a chain (C2) and a cycle (C1) are all skipped with a reason. STATE.md commits and the selection completes in every one of these. Same-file collisions (C3, L2-real): one marker pair, both checks true, the target's own bytes kept. |
| NF-3 (commit tree only) | **RESOLVED** | U1 and U2: 0 snapshots, `lacks the v2 ... line`, owner refused, link never written through. The link facts on the gate path come only from `commitEntryLinkTarget` / `commitEntryTargetHoldsSection`. `claudeLinksAgents` and `entryLinkRawTarget` are used only at stage time. A skip reason is accepted only with a commit-tree link (`build-runtime.ts:493`, `:507`), and a redirect only with its ViaLink proof. The m5 test now commits the link. |
| NF-4 (`spec:` line) | **RESOLVED**, with the M-4 residual | K2: `spec:` names the digest sibling, which is committed. K2b: `path_occupied`, no `specPath`, `spec: not recorded`. K-ignored: `not recorded`. |
| NF-5 | **RESOLVED** (declared, tested) | M: a real link, refused as at HEAD. M2: a link-mode plain file, refused with the unchanged message and not written. The test is `project-doc-commit.test.ts` "C2c NF-5". |
| NF-7 | **RESOLVED** | The C2b.md note is corrected. Only the stop-1 `lowRiskSeed` remains (`docs-policy-v2-handoff.test.ts:3416`, `:3565`), and `risk:rerun-low` is gone. |
| `canStageSpecPath` | Wired and required (`native-build-factory.ts:1708`, `build-runtime.ts:556`); stages nothing; agrees with the real stage | See BL-1 and M-3. It is not side-effect free. |
| v1 unchanged except NF-5 | **Yes** | Every v1 caller passes exactly one write (`build-runtime.ts:2191`, `:2818`), so the physical-path merge cannot change v1 bytes. M, M2 and J (v1 CRLF: 0 lone LF, 15 CRLF, check passes) hold. |
| native-delivery-factory 17/17 | **Valid for the final bytes; not re-run** | The worker's log `c2c-part2.jsonl` shows the suite launched (task `01a0e632e3d2`, UUIDv7 time) about 5.7 minutes before the first prove-red edit (`01a0e6382464`). After the launch, the only `runner-v2/src` writes are the prove-red edits to `integration-manager.ts` and their byte-exact restores; everything else is evidence files. The module is imported statically at process start. The suite's only runner-v2 dynamic import is `delivery-execution.js`, which was not mutated, and its child processes run fixture-project commands only. The final hash is `82e99de9`, which matches. |

## Probes (real SQLite and git, `NativeBuildManager`, the docs port that `NativeBuildFactory.create` builds; links created with git, including `core.symlinks=false` and `true`)

- The r3 probes re-run on the new code:
  - L: completed; the CLAUDE.md link is untouched.
  - L2: completed; committed paths `[CLAUDE.md, STATE.md]`.
  - L2-real: completed; AGENTS.md is still a link.
  - L3: completed; the line is in `docs/rules.md`.
  - U1 and U2: refused.
  - K and K-ignored: `write_failed`, `not recorded`.
  - K2: the sibling, named correctly.
  - K2b: `path_occupied`, `not recorded`.
  - N6: completed.
  - R: the bogus stop is refused.
  - M and M2: refused.
  - J: the prefixes are kept, 0 lone LF.
- A1, A2, A3, A3n, A4, A5, B1, B1c, B1-control, B2, C1 to C12, D1, E1, E2, E3: results as in the tables above.
- `git add --dry-run --ignore-missing` in a scratch repository: ignored and missing gives exit 1, normal and missing gives exit 0, beyond a link gives exit 128, and nothing is written. Git for Windows creates real links with backslash targets (`lnk -> ..\outside`).

## Suites and checks (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- replay-compatibility, git-caller-audit, lsp-caller-audit, mcp-caller-audit, one-shot-command-routing-static and static-adapter-policy: **42 pass, 0 fail** (run after deleting my probe file).
- Runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. eslint on the 5 changed source files: exit 0. `git diff --check`: clean.
- Encoding (all 13 files): no BOM, no mixed endings, valid UTF-8, no mojibake. Non-ASCII counts equal HEAD, except C2b.md, which drops by 3 (one em dash removed by the NF-7 rewrite). `project-docs.ts` is CRLF in the worktree and its HEAD blob is LF. That matches `core.autocrlf=true` checkout: the unchanged `risk-policy.ts` is also `w/crlf`, and `--ignore-cr-at-eol` gives the same 29/3 numstat.
- Not re-run: docs-policy-v2-handoff (54), the other worker batches and native-delivery-factory. The worker ran them green on byte-identical files, and my probes cover the named layouts independently.
