# C2b - independent code re-review r3 (repair cycle 2)

Reviewer: fresh-context independent reviewer. I did not write this code and did not do rounds 1 or 2. Date: 2026-09-28.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `d35371a1`; C2b changes uncommitted.
Inputs: `C2b-review-r2.md` (B1-R, B2, B3, N-1 to N-8), brief `c2b-repair2-muse.txt`, `evidence/C2b.md` "Repair cycle 2", plan CD-4, CD-13, CD-14, AR-R04, AR-R05, AR-R07, section 6 C2.
I measured the sha256 of all 15 changed runner-v2 files before and after my probes. All match the "Repair cycle 2" hashes. My probes ran from a temporary test file that I have since deleted; a copy is in my scratchpad as `zz-c2b-r3-probe.test.ts`. `git status` is back to the worker's set.

**Verdict: ACCEPT**

All three blocking findings are resolved on the production path, proven with the port that `NativeBuildFactory.create` builds. The minors below are not blocking. Two of them are stuck-run classes (NF-1 and NF-2). They matter only once T7a stamps docs v2 in production, and they must be closed before that. NF-2 needs a controller design decision. NF-6 is a pre-existing livelock outside C2b, found while judging deviation (a). Route it to the controller.

## Resolution table

| # | Brief requirement | Status | Proof (probe, production manager, real SQLite and git) |
|---|---|---|---|
| B1-R | Wire both methods in the factory port and make them required; P1, G2-prod and N6 with the factory's port | **RESOLVED** | `native-build-factory.ts:1703-1704` wires both. `build-runtime.ts:480,487` makes them required, and the factory is the only production constructor of a `ProjectDocsPort`. **P1** (a real `NativeBuildFactory` plan-only run whose own runtime steps itself): the port has 8 keys, including `findHandoffSnapshotCommit` and `readIntegrationBaselineRevision`. An unknown key returns `null`, the baseline matches, and there is 1 snapshot with 1 Architect call; the selection completes. **G2-prod**: see the Probes section. It reaches `completed`/`apply_to_project` with two chained snapshots. **N6** (factory port): the recorded revision equals the baseline, there are no failure pauses, and the selection completes. |
| B2 | Fail closed: an unclassifiable withdrawn stop pauses the current stop before commit, with the detail named; resume retries | **RESOLVED** | `build-runtime.ts:2104-2107` pauses on any throw, and `reconcileWithdrawnSnapshotCommits` throws for a lookup or read throw, an unverifiable STATE.md, missing entry lines, or missing facts. **G3**: stop 2 pauses with `withdrawn-stop reconciliation failed for stop 15: lookup threw (...)`. There are 0 snapshots and still 1 commit, and the owner's selection is refused. After resume, the snapshots are stop 15 then stop 30, S2.parent == S1, and the tip is S2. The run reaches `completed`/`apply_to_project` with one physical handoff, and the project holds S2's STATE.md. |
| B3 | Link-ness from git, never written into; the link satisfies the line with a recorded reason; the gate reads the fact from the COMMIT tree; probe L | **RESOLVED for the write-through and the L layout; the N-6 fold is PARTIAL** (NF-3) | **L** (factory port, `core.symlinks=false`, worktree file holds `AGENTS.md`): 1 snapshot, `claudeLineViaLink` recorded, and the committed paths are `[AGENTS.md, docs/project/STATE.md]`. CLAUDE.md is not written: the tree keeps `120000` with target `AGENTS.md`, and the disk bytes are still `AGENTS.md`. The selection completes. However, `documentCommitResult` (`integration-manager.ts:2199`) ORs the commit-tree fact with the live worktree/index determination, so the gate does not read the fact from the commit tree alone (see deviation (b)). |
| N-1 | A spec write or stage failure never fails the snapshot | **PARTIAL** (NF-1) | **K** (a tracked file at `docs/project/specs`): 1 snapshot, `specCopySkipped:"write_failed"`, no copy claimed, completes. **K-ignored** (`.gitignore` holds `docs/project/specs/`, a case r2 N-1 named explicitly): `git add -- ... docs/project/specs/source_value.md failed with exit code 1: The following paths are ignored`. That gives 3 failure pauses over 2 resumes, 0 snapshots, and the owner refused. The run is stuck. |
| N-2 | Never overwrite a user's file at the spec path | **RESOLVED for the bytes**; a new minor in the rendered text (NF-4) | **K2**: the user's file survives, and the copy lands at `source_value-5d5744ae0c440dd3.md` with `specCopied:true`. **K2b** (both paths occupied): `specCopySkipped:"path_occupied"`, no write. |
| N-3 | The reducer accepts only the current stop or a withdrawn stop's sequence | **RESOLVED** | **R**: the bogus stop 2 is refused ("Handoff snapshots require a requested project handoff."). The current stop is accepted (tip `bbbbbbbb`, status paused). |
| N-4 | v1 keeps the HEAD refusal | **RESOLVED**, with an undeclared v1 change (NF-5) | **M** (a real committed link): `threw: Project document path CLAUDE.md is refused because CLAUDE.md is a symbolic link or junction.` The link survives, and no commit is made (HEAD behavior). |
| N-5 | Multi-line bodies take the file's EOL | **RESOLVED** | **J** (v2 path through the factory port and the v1 path): the Latin-1 and CRLF prefixes are kept. CLAUDE.md has 0 lone LF and 5 CRLF, and a second splice is identical. The v1 CRLF AGENTS.md has **0 lone LF** and 15 CRLF, and `v1AgentsSatisfied:true`. |
| N-6 | (folded into B3) | **PARTIAL** | See NF-3. |
| N-7 | The no-request fallback never selects a record | **RESOLVED** | By inspection: `handoffSnapshotAtCurrentStop` returns `undefined` when there is no request (`scheduler-store.ts:9128`). |
| N-8 | Correct the cycle-1 claims | **RESOLVED**, with one inaccurate sentence (NF-7) | "Corrected claims" now holds for the factory port (P1, G2-prod, N6 re-proven here). The fixture note's "mirroring what the production manager records before completion" is not accurate (see deviation (a)). |

## The worker's deviations

**(a) `lowRiskSeed` in the G2-prod and G3 tests.** It is faithful for the C2b path and hides no C2b blocker. It does mask a pre-existing production livelock.
- The seeded assessment is kernel-computed (`assessBuildRisk`), and the reducer refuses any assessment that disagrees with the recomputation. It only affects completion readiness *before* `complete_run`. The snapshot and reconciliation code runs after the request.
- My G2-prod and G3 give the same outcomes with no risk policy and no seed. They use the factory's port object with a separate harness log that has no factory `risk_based` policy. So the C2b logic does not depend on the seed.
- The second seed (`risk:rerun-low`, `docs-policy-v2-handoff.test.ts:3401,3525`) uses an idempotency key that production cannot produce. In production only the runtime records `build.risk_assessed` (`build-runtime.ts:1724`, key `build-risk:${targetRevision}`); the manager records nothing, contrary to the evidence note.
- **Probe RA**: the real `BuildRuntime` with a production-shaped `IndependentVerifierDriver` (the real `deriveNativeVerifierRiskInput`) runs to the handoff. Guidance with `no_plan_change` follows, then a green FV re-run on the same revision. The result is 20 `assessRisk` calls in 20 steps and still 1 risk event (the store dedupes the identical key and payload). There is no current risk, the Architect is never re-invoked, and `runUntilBlocked` returns `step_allowance_yielded`.
- So the G2 flow cannot re-request in production today. This is NF-6: pre-existing (`fe0e8b92`), outside C2b, and it affects v1 finish runs too. The G2/B1 reconciliation still matters, because the same withdrawn-stop shape arises when guidance changes the plan and the revision moves on.

**(b) The live worktree OR in `documentCommitResult` for `claudePointerV2ViaAgentsLink`.**
- **No write-through.** The write decision is fail-closed from both sources: the skip applies only when the worktree symlink or the index `120000` entry resolves to AGENTS.md, and `refuseProjectDocLink` refuses any other symlink or `120000` entry. In L, U1 and U2, CLAUDE.md is never written.
- **N-6 is reopened for out-of-band layouts, with a false gate acceptance.**
  - **U1**: an untracked worktree symlink (the m5 test's own layout, `docs-policy-v2-handoff.test.ts:2792`). The commit tree has **no CLAUDE.md** (`<absent>`, `?? CLAUDE.md`), yet the snapshot records `claudeLineViaLink` and the selection completes.
  - **U2**: a tracked regular `CLAUDE.md` (`# user rules, no pointer`) replaced by an uncommitted symlink. The commit tree holds `100644` with no `@AGENTS.md` line (`blobHasPointer:false`), yet the gate accepts and the selection completes.
  - Both break AR-R05's "that commit's tree holds ... the marked `@AGENTS.md` line". Both need an uncommitted change inside the runner-owned integration worktree, which no runner path makes: the worktree is created from committed revisions, and the kernel never stages the link. The committed-link case is fully covered by `commitClaudeLinksAgents`. **MINOR** (NF-3).

## Fix delta, both directions

- **Permanent reconciliation failure (G3-perm).** The lookup always throws from stop 2 on:
  - Each of 3 resumes pauses again (0 snapshots, 1 commit, chain intact).
  - A second guidance, FV re-run and re-request (stop 51) also pauses.
  - The owner's selection is refused, and there is no cancel or abandon in `NativeBuildManager`.
  - So yes: while the failure persists there is no in-product exit. This is the same liveness contract AR-R05 gives a failed kernel commit. Once the cause clears, the next resume records stop 15 as history and commits stop 51 on it (`chained:true`), and the run completes with one physical handoff.
  - Reconciliation adds no new permanent class: a withdrawn stop's commit can fail classification only for a cause that already paused that stop (entry lines and digest are deterministic from its tree). The one exception needs an out-of-band change (the U layout removed later).
  - The general gap (no exit from a permanently failing snapshot) is a design follow-up. It is not a C2b defect.
- **Chain integrity**: G2-prod, G3 and G3-perm all end with `chained:true` and `tipIsLast:true`. Every commit has runner identity (`AIBoard Integrator`), and there are no duplicate commits.
- **v1**:
  - M: the HEAD refusal is unchanged.
  - J: the v1 CRLF output has no mixed endings, and the v1 check passes.
  - Replay-compatibility is green.
  - One undeclared v1 change (NF-5): a link-mode entry checked out as a plain file (`core.symlinks=false`) is now refused on the v1 Architect path (**M2**: `threw: ... CLAUDE.md is refused ...`). At HEAD, `lstat`-only detection wrote through it (the B3 corruption). Strictly safer, but not declared in the evidence.
- **Static and replay**: see Suites.

## New findings (all MINOR for C2b)

| # | Where | Finding | Suggested fix |
|---|---|---|---|
| NF-1 (N-1 remnant, stuck-run class) | `integration-manager.ts:696` (one `git add` for every path) | A gitignored spec directory fails `git add` for the whole batch, every attempt (probe K-ignored). r2 N-1 named this case, and the brief says "write or stage failure". | Skip spec paths that `git check-ignore` matches, recording `specCopySkipped` with the reason, or stage the spec path in its own `git add` and drop it on failure. |
| NF-2 (stuck-run class, common layout; needs a decision) | `refuseProjectDocLink` (`integration-manager.ts:2371-2399`) plus the AR-R05 entry-line gate | An `AGENTS.md` link, real (L2-real) or link-mode under `core.symlinks=false` (L2), or a CLAUDE.md link to anything but AGENTS.md (L3): every snapshot is refused, every resume re-pauses, and the owner cannot select. `AGENTS.md -> CLAUDE.md` is a common repo layout. The real-link case dates from cycle 0; the link-mode case became a refusal this cycle (it was the B3 write-through). | This needs a controller or plan decision before T7a. For example: treat `AGENTS.md -> CLAUDE.md` symmetrically to m5 (write the v2 section into the regular target, record the reason, and satisfy the pointer via the link). Alternatively, give the owner an exit from a permanently failing snapshot. |
| NF-3 (N-6 residual) | `integration-manager.ts:2199` | The live worktree/index OR lets the gate accept a commit tree without the line (U1, U2). Reachable only through an out-of-band edit of the runner-owned worktree. | Read the flag from the commit tree only, and change the m5 test to commit the link (the realistic layout). |
| NF-4 | `build-runtime.ts:2186-2196`, `:2291` | STATE.md is rendered before staging decides the spec path, so its `spec:` line can be wrong. K: it names `docs/project/specs/source_value.md`, which cannot exist. K2: it names the user's own notes file, while the copy is the digest sibling. K2b: it names the user's file, and the event carries `specPath` = the user's file with `specCopySkipped:"path_occupied"`, which contradicts the field doc "Absent when no copy was written". | Decide the final path before rendering, for example by reading the tip blob at the target and the sibling. On a skip, render "not recorded" and omit `specPath`. |
| NF-5 | `refuseProjectDocLink` on the v1 path | Undeclared v1 change (M2): a link-mode plain-file checkout is now refused. It is strictly safer. | Declare it in the evidence. |
| NF-6 (outside C2b, pre-existing; escalate) | `build-runtime.ts:1716-1731` (`build-risk:${targetRevision}`) with the guidance invalidation (`scheduler-store.ts:9836`) | After guidance on an unchanged revision, re-assessment livelocks (probe RA). This affects every finish run with the independent verifier, v1 included. | Route to the controller as its own packet. For example, key the assessment per FV generation or per invalidation. |
| NF-7 | `evidence/C2b.md` "Corrected claims", fixture note | "mirroring what the production manager records before completion" is inaccurate: the runtime records it, and after guidance on the same revision it cannot (NF-6). | Correct the note. |

**Follow-up list, in priority order:**
1. NF-6: escalate. A pre-existing livelock outside C2b.
2. NF-2: a controller decision before T7a.
3. NF-1.
4. NF-4.
5. NF-3.
6. NF-5 and NF-7 (evidence only).

## Probes

Real SQLite, real git, advancing clock, production `NativeBuildManager`, and the docs port object from `NativeBuildFactory.create`. P1 runs the factory's own runtime. G, K, L and U drive a harness runtime around the factory's port, with a separate log that has no factory policies. RA and M use `openGitRepo`.

- **P1**: 8 port keys; both new methods are `function`; `unknownKeyLookup:null`, `baselineMatches:true`, snapshots 1, `architectCalls:1`, selection `completed`.
- **G2-prod**:
  - Stop 1: `paused/requested/handoff_snapshot_failed`, 0 snapshots, 1 commit.
  - Stop 2: `completed/selected`, snapshots `15:f61e07f9<-b8dba094` then `30:3880df31<-f61e07f9`, `chained:true`, `tipIsLast:true`.
  - One physical handoff; the project holds S2's STATE.md; `architectCalls:1`.
  - The pump error "The kernel handoff snapshot is required ..." is the refused automatic handoff at stop 1, as expected.
- **G3**:
  - Stop 2: paused, detail `withdrawn-stop reconciliation failed for stop 15: lookup threw (...)`, 0 snapshots, 1 commit, owner refused.
  - After resume: `completed/apply_to_project`, chained, tip last, one physical handoff, the project holds S2's STATE.md.
- **G3-perm**:
  - 3 resumes, and each gives `handoff_snapshot_failed`, 0 snapshots, 1 commit.
  - Guidance plus re-request while failing: paused, 0 snapshots.
  - After clearing: snapshots 15 then 51, chained, completed, one physical handoff, 5 lookup failures, 6 failure pauses in total.
- **RA**:
  - Stop 1: risk low, 1 risk event, 1 snapshot.
  - After guidance and the FV re-run: `step_allowance_yielded`, status running, handoff null, `riskCurrent:null`, history `[invalidated]`, still 1 risk event, 20 `assessRisk` calls, Architect calls unchanged at 1.
- **L, L2, L2-real, L3, U1, U2, K, K-ignored, K2, K2b, N6, R, M, M2, J**: results as in the tables above.

## Suites (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- replay-compatibility, git-caller-audit, lsp-caller-audit, mcp-caller-audit, one-shot-command-routing-static and static-adapter-policy: **42 pass, 0 fail**. v1 logs replay unchanged.
- Runner `tsc -p runner-v2/tsconfig.json --noEmit`: exit 0. `git diff --check -- runner-v2`: clean.
- Encoding: every changed file has no BOM, no mixed endings, and the same non-ASCII byte count as HEAD.
- Not re-run, because the worker ran them green on byte-identical files (hashes verified): docs-policy-v2-handoff (44), the 196 and 137 batches, and native-delivery-factory (17). My probes had no concrete concern in native-delivery-factory's scope.
