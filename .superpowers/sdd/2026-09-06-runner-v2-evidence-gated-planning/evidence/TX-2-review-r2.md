# TX-2 review r2 — slim the docs-policy-v2 handoff suite (test-only), repair cycle 1

- Reviewer: Claude Sonnet 5.5 (extra-high effort), independent fresh-context reviewer, round 2. I did not write this code and did not do round 1.
- Date: 2026-09-29.
- Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `83f89cf5`. TX-2 is uncommitted.
- Inputs: `evidence/TX-2-review-r1.md`; `evidence/TX-2.md` (section 11 plus corrections in sections 1, 5, 7, 9, 10); the plan section "TX-2" (`docs/superpowers/plans/2026-09-27-runner-v2-p6-6-architecture-correction.md`); briefs `tx2-brief-muse.txt` and `tx2-repair1-muse.txt`; `evidence/test-time-profile-2026-09-29.md`; the old file from `git show HEAD:runner-v2/test/docs-policy-v2-handoff.test.ts`; the worker's run stream `tx2-repair1.jsonl` (its edit tool results carry a unified diff of every edit).
- Nothing was edited in the worktree except this file. No commit, stage, stash or push. Probes ran on scratch copies in my own scratch folder (worktree modules imported by absolute file URL). The scratch folder is deleted at the end. The probe tests removed their own fixtures.

sha256 at start and at end (identical):

| File | sha256 |
|---|---|
| runner-v2/test/docs-policy-v2-handoff-gate.test.ts | `ca39be0752055e5ba26b13d84247e1efedd2d746e8cc51b2235d0960ab96eff5` |
| runner-v2/test/docs-policy-v2-handoff-commit.test.ts | `c673c8dd0f79f4d8774d664a6b2abaee7aa0b5c5a8501d2a74a1b146b750c6e5` |
| runner-v2/test/docs-policy-v2-handoff-retry.test.ts | `bf5d84e3bacd01bb68c39ac6fa295ab96bf468b47a5372f012599ee593f25d42` |
| runner-v2/test/docs-policy-v2-handoff-entry-links.test.ts | `b007f17c89b6d380d9be3684c03ea8ae4827765d47d6793182e65c00d84560ee` |
| runner-v2/test/docs-policy-v2-handoff-spec-copy.test.ts | `133c994dd07be3b8364352946d15f1be2dea7dcc05fdfff1a0f985acc54fa579` |
| runner-v2/test/docs-policy-v2-handoff-project-links.test.ts | `075a6841ef2d51bcd12ea2a76f6b9715b7e334490cdd0685f42d26a3c8c2d470` |
| runner-v2/test/docs-policy-v2-handoff-large-tree.test.ts | `7f8f4ed52067c3acc2cad1a059be5f90af36a790c956654ebdeef4b785ce5b2a` |
| runner-v2/test/docs-policy-v2-handoff-parity.test.ts | `146054d1d877c9527a8ed38a907d46a83415b39c26a989a380cc04a1c245dbd3` |
| runner-v2/test/support/handoff-snapshot-harness.ts | `43f4ad1ee352b90bc31a1d551811cbdfd8db3397ddeec53960e49c5766c3788d` |
| runner-v2/src/build-runtime.ts | `a85a24c540e2b0b12519812014afc444d46a8a6d716d411dd1af554aec1061b2` |

All 10 match the values in TX-2.md section 9 and section 7. `git diff --stat -- runner-v2/src` is empty at start and end.

**Verdict: ACCEPT**

All seven checks pass. Round 1's blocking finding B-1 is resolved. No new blocking finding. One r1 minor (m-4) is only partly resolved, and there are three cosmetic new items. None needs another worker cycle, but the follow-up list below should be applied before the commit.

## How I got the exact cycle-1 delta

I had no copy of the cycle-0 files. The worker's run stream holds a unified diff for each edit it applied. I reverse-applied the 28 edits that touched code to the current six changed files. The rebuilt files match round 1's recorded cycle-0 sha256 for all six (harness `c9f2496e…`, retry `dc6e1326…`, project-links `61e27c1b…`, spec-copy `2584d787…`, large-tree `43f56f90…`, parity `78f60d88…`). So the diff below is exact and complete: the worker changed nothing else in those files. The gate, commit and entry-links files are unchanged from round 1 (same sha256).

I also compared every old test body from HEAD with the new bodies. The three tests that TX-2.md names as the manager-ordering proof (`C2a B1+M6`, `C2a B1: with the snapshot commit forced to fail`, `C2b repair B1-R/G2-prod`) are byte-identical to HEAD.

## Status of round 1 findings

| # | r1 finding | Status | Evidence |
|---|---|---|---|
| B-1 | Four moved checks kept manager-ordering messages on checks that cannot fail on the harness | RESOLVED | Now `retry.test.ts:526`, `:737`, `:758` and `project-links.test.ts:675`. The messages no longer claim an ordering ("the project is still untouched before the explicit apply", "...while paused before any commit", "...(the harness never auto-applies)"). Each has a comment saying it is an untouched-so-far fact and naming where the ordering proof lives. TX-2.md section 1 now has the correction and a table of where each manager-level assertion lives now. The line numbers in TX-2.md match the files. Kept tests confirmed: `commit.test.ts:267` (`order ["projectHandoff:1","applied"]`), `commit.test.ts:296-342` (`physicalHandoffs 0`, `automatic_project_handoff_failed`, no mutation), `project-links.test.ts:167` and `:255` (G2-prod `order []` and `["projectHandoff:2","applied"]`). See N-2 for a small wording gap in the table. |
| m-1 | Second risk seed `risk:rerun-low` | RESOLVED | No `rerun-low` anywhere in `runner-v2/test`. The only `build.risk_assessed` seed left is `lowRiskSeed` for stop 1 (`harness:177`, key `risk:baseline-low`). `fvRerunSeed` seeds no risk event. Probes A and B (below) prove the second assessment comes from the runtime. |
| m-2 | `scenario()` `scope.excludes` changed | RESOLVED | `harness:101` is `["test/value.test.mjs"]` again, the same as HEAD's old file (line 129). |
| m-3 | Selection mirror re-implemented the manager's revision | RESOLVED | `selectHandoffOwner` and `applyAutomaticHandoff` now call `handoffSnapshotAtCurrentStop(projection)?.head ?? projection.integrationRevision`. That is the same expression as `native-build-manager.ts:578-581`. The local `currentStopSnapshotHead` helper is deleted. The import is from `src/scheduler-store.js`. |
| m-4 | Parity does not cover the selection mirror | PARTIAL | A selection step exists and can fail, but it cannot detect a wrong revision in the mirror. See F-1. Not blocking. |
| m-5 | Prove-red target and record | RESOLVED | See item 5 below. |
| m-6 | Timing explanation | RESOLVED | Sections 5 and 10 now say per-test cost is factory construction plus production git (about 1 s per call, 93% of a harness test). This matches `test-time-profile-2026-09-29.md` (54 git calls, 54.8 s of 59.2 s, about 1,014 ms each, factory create 14.8 s). The per-group facts match round 1 (fixture-port tests 1.7-4.1 s; 25 moved tests 38-271 s each, about 3,100 s together; 14 C2a tests 213 s to 630 s). |
| m-7 | Large-tree assertions print no pause detail | RESOLVED | The three assertions now print `JSON.stringify(driven.projection.pauseReason)`. The type is `{reason, taskId?, detail?}` (`scheduler-store.ts:904`), so the reason and detail are both printed. TX-2.md section 10 says the file runs separately from the group. |
| m-8 | Five spec-copy drives outside `try` | RESOLVED | K, K2, K-ignored, K2b and unreadable-tip now call `driveHandoff` as the first line inside `try`. No assertion changed. |
| m-9 | Three kept e2e tests use the hand-built `gitDocsPort` | Informational | Unchanged. |
| m-10 | Some moved tests seed the stop | Informational | Unchanged. |

## The seven checks

**1. B-1.** Resolved as in the table. The reworded checks are honest but they are still unconditional on the harness. That is fine: round 1 allowed "reword as a plain untouched-so-far fact".

**2. m-1, real re-assessment.**
- Code: the runtime records `build.risk_assessed` with key `build-risk:${targetRevision}:${finalVerification.generationId}` (`build-runtime.ts:1866`) and actor `runner/build-runtime`. G2 asserts `risks[1].idempotencyKey === build-risk:${baseline}:generation-c2a-finish-rerun`. The generation id comes from `fvRerunSeed` (`harness:360`). No seed can produce that key.
- Probe A (scratch copy of the retry file; G2's second drive without `independentVerifier`): G2 went RED with `Build completion is not ready: A current build-risk assessment is required.` (122 s). The Architect's real `complete_run` is refused unless the runtime re-assessed.
- Probe B (same mutation on the W-CI helper in the project-links file; ran W-CI-rm): RED with the same message (119 s).
- So without the runtime's re-assessment both tests fail. Both also assert `risks.length === 2` and `architect.calls() === 2` (stop 1 plus the real re-request).

**3. m-3, which tests depend on the changed mirror.** 58 of the 86 tests call `selectHandoffOwner` or `applyAutomaticHandoff` (56 directly, plus W-CI-rm and W-CI-mv through the helper). The worker re-ran 10 of them after the change: G2, B2/G3, W-CI-rm, W-CI-mv, parity normal, and the five spec-copy tests. The other 48 have not been run since the mirror changed:
- gate: 1 (answered run)
- commit: 3 (splices entry lines, moves document tip, CD-14/N6)
- retry: 13 (B3, crash, N1-F, N1-G, N2, BL-2/B1, B1c, B2, B2-real, S1-reuse, CI-reuse, E3-throw, J-docs)
- entry-links: 15 (all except "a reused commit without the v2 entry lines" and "m3 non-UTF-8")
- spec-copy: 3 (opts-out, export_only, M-4/E3)
- project-links: 10 (A1, A2, A3, A3n, A4, D1, DUP-A4, CI-lm, ALL-SKIP, ALL-SKIP-out)
- large-tree: 3 (G1, G1-control, G1-flat)

Two of them call `applyAutomaticHandoff` as well: N1 probe G (retry) and ALL-SKIP-out (project-links).

I do not expect any behavior change. The old local helper found the first snapshot at the current stop. The kernel export returns the last snapshot at the current stop that passes the qualification predicate. They differ only if a stop has two records or an unqualified record. The reducer refuses both: `scheduler-store.ts:9299` (STATE.md or link reason required), `:9315` (entry proof required) and `:9330` (one record per stop). So every reachable projection gives the same head. The controller's group run is the check for the 48.

**4. m-4.** See F-1. The step can fail (a refused selection throws; a status difference fails). But two of the four compared fields are not computed by the arms. `choice` is the input string. `integrationRevision` is the stub result's `"unused"` on both arms, and `project.handoff_selected` records `payload.integrationRevision` verbatim (`scheduler-store.ts:5119-5138`). For a `plan_only` run the acceptance predicate ignores the revision (`scheduler-store.ts:9183`, `:9219`). Probe C confirms it (below).

**5. m-5.** TX-2.md section 7 records: sha256 before `a85a24c5…`, the mutation, mutated sha256 `fc5f5c03…`, the RED result (`0 !== 1`, `resume reuses the commit and completes`, `retry.test.ts:793`, 77 s), the byte-exact restore and the GREEN re-run. I checked each part:
- I re-applied the recorded mutation (the STATE-only description instead of `describeSnapshotCommitFacts` on `result.reused === true`) to the current `build-runtime.ts` in scratch. The result has sha256 `fc5f5c035c907ece4f60ab454c38c500804ce7fe55b80b62eb784c3025f4a056`, exactly the recorded value.
- The worker's run stream shows the sha256 before (`a85a24c5…`), the mutated sha256, the RED output at that line and 77 s, `RESTORE_OK`, and the GREEN re-run. `retry.test.ts:793` holds the message `resume reuses the commit and completes`.
- Now: `build-runtime.ts` is `a85a24c5…` and `git diff --stat -- runner-v2/src` is empty.
- It is the same mutation round 1 used, and round 1 saw the same RED.

**6. m-2, m-6, m-7, m-8.** Done as asked, see the table. The timing text in sections 5 and 10 matches the profile document.

**7. No new weakening.** I diffed each changed body against cycle 0 (exact, rebuilt) and against HEAD's old file.
- G2 (`retry`): removed the `risk:rerun-low` seed and the seeded stop-2 `project.handoff_requested`. Added the real re-assessment and the assertions `risks.length === 2`, the re-assessment key, `verifierCalls <= 3`, and `architect.calls() === 2` (was `1`; the extra call is the real second `complete_run`). All other assertions are unchanged. The old `order` spy is gone by design (see B-1). Net: stronger, because stop 2 is now recorded by the real Architect turn.
- W-CI helper (`project-links`): the same change. HEAD's helper had only the `order []` check; the rest is unchanged, and W-CI-rm and W-CI-mv bodies are byte-identical to HEAD. The helper adds `architect.calls() === 2`.
- B2/G3: only the three reworded messages and comments changed in cycle 1. Against HEAD the `order` assertions are gone (moved) and the rest is kept, including `risks.length === 2` and the key check.
- spec-copy, large-tree, harness (`scope.excludes`, kernel call): no assertion dropped. Only the drive position, message text and the kernel call changed.
- The parity test gained a step; no assertion was removed.
- `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. `eslint` on the 9 files: exit 0. `git diff --check`: exit 0. All 9 files: LF only, ASCII only, no BOM, final newline.

## Findings

| # | Finding | Location | Evidence | Expected | Actual | Fix |
|---|---|---|---|---|---|---|
| F-1 (minor, non-blocking; resolves r1 m-4 only in part) | The parity selection step cannot detect a wrong revision in the harness mirror, and the comment says it guards the mirror. | `parity.test.ts:113-123`; TX-2.md section 11 (m-4 line) | The normal parity scenario is `plan_only`. For `plan_only` the predicate skips the revision check (`scheduler-store.ts:9183`, `:9219`). Both arms record the stub `integrationRevision: "unused"` and pass `choice` in, so those two comparisons compare constants. **Probe C:** in a scratch copy of the harness I changed `selectHandoffOwner` to pass the literal `"WRONG-REVISION-PROBE"` to `assertProjectHandoffSelectionAccepted`. `parity: a normal handoff agrees…` still PASSED (228 s). | A step that can fail when the mirror computes a wrong revision, or a comment that claims less. | The step only fails if one arm refuses the selection or ends in a different status. | Reword the comment and TX-2.md to say it checks that both arms accept the same selection and reach `completed`. If a revision guard is wanted, add a `finish`-policy parity arm (where `revisionMatchesIntegrationOrDocumentTip` bites). Since m-3 the mirror calls the same kernel export as the manager, so the drift risk is small. |
| N-1 (cosmetic) | Stale comment in the W-CI helper. | `project-links.test.ts:643-644` | It says "The seeded stop-2 re-request below means the second drive commits at the top of dispatch, before any re-assessment could run." No seeded re-request exists now; the drive re-assesses first. The same comment in G2 was removed. | No comment that contradicts the code. | Comment is wrong. | Delete those two comment lines. |
| N-2 (evidence wording) | TX-2.md section 1 table row 3 does not name the ordering assertions. | TX-2.md line 53 | Row 3 says "Withdrawn-stop reconciliation + risk re-assessment through the production manager". The assertions that replace G2's and B2/G3's lost `order` checks are `project-links.test.ts:167` (`order []`) and `:255` (`["projectHandoff:2","applied"]`). | The table names the real replacement. | Row is accurate but vague. | Add "(order assertions at project-links.test.ts:167 and :255)" to row 3. |
| N-3 (evidence wording) | TX-2.md section 8, item 2 still describes the removed `risk:rerun-low` seed and says `architect.calls()==1 holds`. | TX-2.md lines 339-343 | Both statements are false after cycle 1 (`calls() === 2`, no seed). They read as current. | History marked as superseded. | Not marked. | Add "(superseded by section 1 correction and section 11)" to that item. |

## Probes (all in my scratch folder; deleted afterwards)

- **A. G2 without the runtime re-assessment.** Scratch copy of `retry.test.ts` with relative imports rewritten to absolute file URLs; only G2's `driveOpts` lost `independentVerifier`. Result: RED, `A current build-risk assessment is required.` (122 s). Confirms the tests need the runtime's re-assessment.
- **B. W-CI-rm without the runtime re-assessment.** Same mutation on the helper in `project-links.test.ts`. Result: RED, same message (119 s).
- **C. Wrong revision in the harness mirror.** Scratch copy of the harness where `selectHandoffOwner` passes `"WRONG-REVISION-PROBE"`; the parity file imports that copy. Result: `parity: a normal handoff…` PASSED (228 s). Shows F-1.
- **Reconstruction.** Reverse-applied the worker's 28 code edits to the six changed files; all six match round 1's cycle-0 sha256. Re-derived the mutated `build-runtime.ts` sha256 (`fc5f5c03…`) from the recorded mutation.
- **Test-body comparison.** Compared the old test bodies (HEAD) with the new bodies by strict text equality: at least 17 are byte-identical, including the three ordering-proof tests and W-CI-rm and W-CI-mv. This is a lower bound, because a block can include helper code that follows a test in the old file (round 1 counted 19). I read the diffs against HEAD for G2, B2/G3, the W-CI helper, the five spec-copy tests and the three large-tree tests.

I did not run the whole group, the large-tree file or any native-delivery file. The three probes ran while the controller's group run was going, so their times include load.

## Follow-up list

Blocking: none.

Apply before the commit (cheap, no re-review of behavior needed; a diff check is enough):
1. F-1: reword `parity.test.ts:113-118` and the TX-2.md m-4 line to say the step is an accept/complete smoke check, not a revision guard. Optionally add a `finish`-policy arm later.
2. N-1: delete `project-links.test.ts:643-644`.
3. N-2 and N-3: the two TX-2.md wording fixes.

For the controller:
4. The group run is the only check of the 48 mirror-dependent tests listed in check 3. Run the large-tree file apart from the group, as TX-2.md section 10 says.
5. m-9: new full-manager tests in C2d/C2e should use the factory port.
