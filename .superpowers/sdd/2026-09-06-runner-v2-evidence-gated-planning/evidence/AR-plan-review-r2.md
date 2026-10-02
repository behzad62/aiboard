# AR plan review r2 — targeted re-review of the r1 corrections

Reviewer: fresh-context Opus 5.5, read-only. Date 2026-09-27.
Workspace `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `95a1a2be`.
`runner-v2/` is unchanged since `764fdffb` (`git diff --stat 764fdffb HEAD -- runner-v2/` is empty; the in-flight
C1 files are untracked and were not reviewed. I grepped only their export list to check one plan reference, N-1).

Scope, per plan-standard §7 ("re-review only corrections and affected coverage") and plan CD-4: r1
(`evidence/AR-plan-review-r1.md`, read in full), fix commit `95a1a2be` (`git diff ad6028d2 95a1a2be -- docs/`), the
plan (read in full at HEAD), the capability design revision-5 note (`:46-58`) and the parent plan AR header note
(`:5`). Unchanged, already-reviewed text was not re-audited. No file other than this report was written. No test was
run.

**PLAN COVERAGE VERIFIED**

All 5 blocking and 15 minor r1 findings are resolved. None of the fixes weakens an owner decision (AR-1..AR-4, the
owner quotes) or a parent obligation. Every parent obligation the plan changes is labelled "amends" and names the
authority behind it: T8/EP19 (AR-4), T7 `:286` (AR-1), EP09 (AR-2; S2 `:30` and `:379` show the approved C packets
named the checkpoint cut). The fixes introduce no blocking contradiction. There are 7 new MINOR findings below. They
are wording, ownership or precision items, and a packet brief or the packet review can close each one.

## Resolution of r1 findings

| r1 id | Resolved | Note |
|---|---|---|
| B-1 | Yes | CD-1 makes T7a the only owner of production stamping. C2 only adds the reducer, gate and writer, and its tests seed both policy events (C2 step 1). AR-R03 (C2, seeded test) and AR-R17 (T7a, stamp test) no longer overlap. Residual precision issue: see N-7. |
| B-2 | Yes | C2 step 2 adds a sibling kernel-commit method with a runner identity, `AIBoard-Author: runner` and the `AIBoard-Generated` trailer, and leaves the Architect path unchanged. The writable surface is widened to that method. Step 3 names `project_docs.handoff_snapshot_committed` (runner actor, stop-sequence key, commit/parent/head, digest, paths) and moves the v2 document tip. I checked that `project.handoff_selected` records the integration manager's current revision (`build-runtime.ts:873-880`), so after the snapshot commit the tip check passes. Residual: N-2 (crash window). |
| B-3 | Yes | CD-9 records the conflict and resolves it in favour of OA-5. AR-R08, C3 step 2, the tree-hash test and the second red proof carry it out. The rule holds up in code: triage is `answer \| build \| clarify` (`scheduler-store.ts:726`), and a `build` run can never flip back to answered (`:3167-3175`). A snapshot therefore reaches an integration branch only on a run that can never become answered. Wording: N-3. |
| B-4 | Yes | CD-12 keeps the EP06 fields required. AR-R15 is limited to kernel envelope fields plus `requiredBase` and derived link sides. C5 keeps `REQUIRED_TEXT_LIST_FIELDS` (`planning-contracts.ts:658-666`, verified) and adds a "missing EP06 field is still refused" test. `requiredBase` is kernel-supplied: `task-scheduler.ts:733-738` uses it only as a fallback after the allocation base. Residual: N-4. |
| B-5 | Yes | CD-10 records premise (a) with fallback (b), and the §4 row maps note 3 to CD-10. I checked the premise: `git log main` has no P6.6 commit, and `764fdffb` is contained only in `codex/runner-v2-p6-6`. |
| M-1 | Yes | Parent `:64`, `:286`, `:300`, `:353`, `:356`, `:366` all match their cited text at `ad6028d2`. The one-line header edit in `95a1a2be` did not shift any line. The revision basis is stated in AR-4. |
| M-2 | Yes | C4 and C5 now have an Outcome and a DoD. C4's DoD has a factory test. CD-7 is reworded with the C1→C2 exemption. |
| M-3 | Yes | C5 writable names `agent-prompts.ts` (worker contract block), `task-contracts.ts` (`BuildTask` is at `:75`) and the call site `native-worker-driver.ts:531-553`. |
| M-4 | Yes (plan) | C1 lists `cancelled`. C3 step 2 skips `export_only`, and a test covers it. Process note: the C1 worker brief (`Temp\p6-6\c1-brief-muse.txt`, 11:28) predates `95a1a2be` (11:47), and the in-flight module has no `cancelled` stop kind. Per CD-8 this must reach C1 through its review/repair. |
| M-5 | Yes | CD-11 records the supersession. The event/reducer rule is now in the §6 shared rules. Precision: N-7. |
| M-6 | Yes | AR-R05 and the revision-5 note carry matching v2 AC-25 wording (both events gated, snapshot event for the handed-off revision, STATE.md + AGENTS section + `@AGENTS.md` line, no README, answered exempt, `export_only`). Residual: N-5. |
| M-7 | Yes | AR-R18 is labelled "amends parent T7 `:286` (AR-1)", keeps v1 behaviour and adds a v1 export test. The parent header note lists the change. |
| M-8 | Yes | AR-R13 is labelled as an amendment of EP09 `:356`. The C4 steps and tests keep the derived-index facts. |
| M-9 | Yes | AR-R23 and E5 cite OA-11/EP45, release by disposition, and add a test. |
| M-10 | Yes | Lane-B write set, brief-at-start rule and merge re-run of the T7a unseeded test are added. Residual: N-6. |
| M-11 | Yes | W3 step and AR-R29 prompt test. `agent-prompts.ts:595` holds the diff-read line (verified). |
| M-12 | Yes | T7b: unauthorized mutation. T7c: old builds readable. T7d: native chips, Playwright journeys, production build. The parent T7 contract stays binding for the remaining items. |
| M-13 | Yes | CD-5 records CD-2 and CD-5 as unconfirmed, and T7c shows the defaults. Residual: N-5(b). |
| M-14 | Yes | The §4 F3 row and §8 name every remaining T5 export (verified: `evidence-applicability.ts:89,236`, `evidence-tools.ts:51`, `validation-observation.ts:205,395,452`, `validation-policy.ts`) and EP19. |
| M-15 | Yes | CD-8, the §10 launch card and `progress.md` state that C1 cannot be accepted before PLAN READY. |

## Cross-checks requested

- **CD-9 vs AR-R08/C3:** consistent (build/plan-only only; skip before triage, on answered runs and with `export_only`). Wording issue: N-3.
- **CD-1 vs T7a/AR-R17:** consistent, one owner. Precision issue: N-7.
- **CD-12 vs AR-R15/AR-R16/C5:** consistent. Gap: N-4.
- **AC-25 v2 in AR-R05 vs the capability note:** the gate wording matches. The note's framing does not match CD-9 and CD-5: N-5.
- **Ledger and §4 traceability:** every AR-R row has one owner. Every §4 row points at existing CD or AR-R ids. The §11 disposition list matches the text changes.

## New findings

| Id | Class | Location | Problem | Fix |
|---|---|---|---|---|
| N-1 | MINOR | C2 step 8 vs C1 Outcome | C2 step 8 calls `verifyHandoffSnapshotDigest` "(C1)". C1's Outcome names only `renderHandoffSnapshot` and `handoffSnapshotInputFromProjection`, and C2 may change `handoff-snapshot.ts` for "adapter fixes only". The in-flight module happens to export it (`:401`), but no contract owns it. | Add `verifyHandoffSnapshotDigest` and the body-digest rule to C1's Outcome/DoD (a brief update per CD-8). |
| N-2 | MINOR | C2 steps 2-3, C3 idempotency | The existing doc path survives a crash between the git commit and the event append by finding the commit by a request-id trailer (`integration-manager.ts:626`, `findDocumentCommit` `:1739`). The new kernel commit has a stop-sequence key but no rule for this crash window. C3's "resuming twice" test covers only the case where the event already exists. | The sibling method writes the key as a trailer and returns an existing commit for that key. Add a crash-between-commit-and-event test. |
| N-3 | MINOR | CD-9, AR-R08, C3 step 2 | "Triage outcome is a build or plan-only" mixes two concepts. `plan_only` is a run policy (`scheduler-store.ts:1273, 4981`); triage is `answer \| build \| clarify`. A `plan_only` run can also be answered (T9, `:4983`). A pending `clarify` is not named. | Reword as "triage decision `build` (under either run policy); no snapshot before triage, while a `clarify` triage is pending, or on an answered run". |
| N-4 | MINOR | CD-12, AR-R16 | CD-12 says C5 gives "those fields" consumers. AR-R16 covers inputs, outputs and cleanup (worker) and review criteria, integration checks and negative-proof applicability (reviewer), but not `validation` (EP06 "scoped validation": `targetedRationale`/`affectedScopeRationale`, `planning-contracts.ts:592-595, 647`). No `src/` code reads that field. | Add `validation` to the worker context (or the reviewer context), or record why it stays unconsumed. |
| N-5 | MINOR | Capability design revision-5 note (`:46-58`) | (a) It still says the runner commits STATE.md "at every stop", without CD-9's carve-outs (before build triage, answered). (b) It records the `export_only` AC-25 exemption as settled, while CD-5 says the owner has not confirmed it. | (a) Add "except before a build triage and on answered runs (P6.6 CD-9)". (b) Mark `export_only` as "controller decision CD-5, owner confirmation pending (T7c)", or get the owner's confirmation before T7a enables it. |
| N-6 | MINOR | §5 lane-B write set; phase C entry | (a) The lane-B write set leaves out `repair-approach-contracts.ts`, where V2's approach-decision "new evidence" rule lives. It also leaves out `execution-isolation-provider.ts` and `oci-execution-isolation-provider.ts`, which V1's child-environment scrub may need. Briefs must stay "inside the lane B write set". (b) The phase C entry "this plan PLAN READY" contradicts CD-8, which lets C1 start earlier. | (a) Add those files, or let a lane-B brief extend the set with a recorded reason for files that are not serialized surfaces. (b) Add "(C1 may start earlier per CD-8; nothing is accepted before)". |
| N-7 | MINOR | CD-1, AR-R17, T7a; CD-11; C3 | (a) `scheduler-store.ts:3081` refuses `planning.policy_configured` when `lastSequence > 3`, so the event may sit at sequence 4. "Log sequence ≤ 3" is stricter than the code. Also, `run.initialized` accepts a leading docs stamp only for docs v1 (`:3129-3138`); T7a's production stamp of docs v2, and any C2 seed where docs v2 is the first event, must extend that branch. (b) CD-11 says the tip bookkeeping is "gated on v1 at `:4404-4409`". In fact the tip clear (`:4404-4407`) and tip set (`:9012-9024`) are ungated; only `latestIntegratedTaskSequence` (`:4408-4410`) is v1-gated. (c) C3 does not say that the new `handoff_snapshot_failed` pause (C2) is excluded from stop snapshots. Without that, C3 would retry the failing kernel commit under a different key. | (a) Say "appended while `lastSequence ≤ 3`" and name `:3129-3138` for T7a and C2. (b) Correct the CD-11 citation (the outcome is unchanged: the new event's reducer sets the v2 tip). (c) C3 skips the `handoff_snapshot_failed` pause; C2 owns the retry. |

## Code references spot-checked at HEAD

| Reference | Result |
|---|---|
| `integration-manager.ts:43` `ARCHITECT_DOC_IDENTITY` | Correct |
| `integration-manager.ts:664-674` commit args (`AIBoard-Author: architect` `:668`, env `:674`) | Correct |
| `integration-manager.ts:609-686` `commitProjectDocuments`; `:626`/`:1739` `findDocumentCommit` | Correct (N-2) |
| `agent-prompts.ts:165-169` `buildWorkerContext` / `workerContextSections` | Correct |
| `agent-prompts.ts:590-597` current-submission block, diff-read line `:595` | Correct |
| `native-build-factory.ts:1823-1826` `apply_to_project` → `applyToProject()` | Correct |
| `scheduler-store.ts:3081` planning-policy sequence rule | Correct site; the rule is `lastSequence > 3` refused (N-7a) |
| `scheduler-store.ts:3129-3138` `run.initialized` docs-v1 exception | Not cited by the plan (N-7a) |
| `task-scheduler.ts:733-738` `acceptedBaseRevision` fallback to `contract.requiredBase` | Correct |
| `planning-contracts.ts:658-666` `REQUIRED_TEXT_LIST_FIELDS` | Correct |
| `planning-contracts.ts:627-656` `ExecutionTaskContract` (`validation` `:647`) | Correct (N-4) |
| `native-worker-driver.ts:531-553` worker context input and call | Correct |
| `native-deliverable-review.ts:492-500` reviewer sections | Correct |
| `task-contracts.ts:75` `BuildTask` | Correct |
| `scheduler-store.ts:2211-2218` tip match; `:4404-4410` tip clear / v1 sequence; `:9012-9024` tip set | Correct (N-7b) |
| `scheduler-store.ts:2861-2872`, `:5252-5266` docs policy v1-only | Correct |
| `scheduler-store.ts:3155-3250` triage, no build→answer flip | Correct (supports CD-9) |
| `scheduler-store.ts:4973-5000`, `:5004-5060` handoff request/selection; `build-runtime.ts:873-880` selection payload | Correct |
| `build-runtime.ts:595-597`, `:1855-1870`, `:1885-1896` stamp and initialize order | Correct |
| Parent plan `:64, :286, :300, :353, :356, :366` (at `ad6028d2` and HEAD) | Correct |
| T5 exports named in §4 F3 and §8 | All exist |
