# C2a — independent code re-review r2 (targeted, plan CD-4)

Reviewer: fresh-context independent reviewer. I did not write this code and did not do round 1. Date: 2026-09-27.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `278fd627`. The C2a changes are uncommitted.
Inputs: `evidence/C2a-review-r1.md`, repair brief `c2a-repair1-muse.txt`, `evidence/C2a.md` § "Repair cycle 1", and the AR plan (§2 AR-1/CD-1/CD-9/CD-11/CD-13, AR-R03..R06, §6 C2 steps 1-4 and 7).
I re-measured the sha256 of all ten changed or new files. All ten match `evidence/C2a.md`.

**Verdict: ACCEPT**

All four blocking findings and every in-scope minor finding are fixed. I re-ran the round-1 probes A-E against the new code, and all five now show the fixed behaviour. Probe A runs through the production `NativeBuildManager` and factory with no manual step. I found no new blocking issue. There are six new MINOR follow-ups. N1 must be fixed before docs policy v2 is switched on in production. Production still stamps docs v1 (`configureProjectDocsPolicy` is unchanged), so no production run can reach N1 today.

## Resolution table

| # | Status | How verified |
|---|---|---|
| B1 production wiring | RESOLVED | `afterArchitect` is now async. It commits the snapshot in the same step that records `project.handoff_requested` (`build-runtime.ts:2730-2745`). The manager checks `assertHandoffSnapshotGate` before `handle.projectHandoff` (`native-build-manager.ts:571-575`); both the owner's selection and the automatic handoff go through this path. **Probe A** (factory + production manager, create → activate → awaitIdle, no manual step): `{"status":"paused","handoff":"requested","architectCalls":1,"snapshotEvents":1}`, and the owner's selection is `accepted -> completed`. The worker's no-mutate test (99 forced failures) shows `physicalHandoffs 0` and no STATE.md in the project. The worker recorded prove-red (1). |
| B2 retry returns to the handoff wait | RESOLVED | In `applyHandoffSnapshotCommitted` (`scheduler-store.ts:9182`), a `running` run goes back to `paused`. **Probe B**: after resume, the retry shows status `paused`, handoff `requested`, `pauseReason` null. The next step returns `{"status":"paused"}`, Architect calls stay at 1, and the selection completes. |
| B3 per-attempt failure key | RESOLVED | **Probe C**: the pause keys are `handoff-snapshot-failed:17:17` and `handoff-snapshot-failed:17:19`. The second resume is accepted and the third attempt commits (1 snapshot, 1 Architect call). The worker recorded prove-red (2). |
| B4 snapshot describes the stop | RESOLVED | The snapshot renders from the projection rebuilt up to the stop event (`build-runtime.ts:2002`). The digest and paths are read back from the commit itself (`:2040-2080`, `integration-manager.ts:698`). **Probe D** (the commit lands, then the *commit* port throws, then the retry reuses the commit): 1 commit, 1 event, event `bodyDigest` = committed header digest = `1d95b769…` (`match:true`). The committed file verifies and does not contain `handoff_snapshot_failed`. |
| M1 gate bound to the latest stop | RESOLVED | `requestedSequence` plus `handoffSnapshotAtCurrentStop`. **Probe E** (pure reducer, only a stop-1 snapshot, stop 2 requested): the selection is `refused: The kernel handoff snapshot is required…`. |
| M2 same revision in the event and the file | RESOLVED | A new optional field `HandoffSnapshotFacts.revision` plus a one-expression change in `handoff-snapshot.ts:1282`. The change is minimal. The worker's tests assert `revision: revision_value` and the baseline revision appear in the committed header. The C1 suite is green (53/53, below). |
| M3 reuse only runner commits | RESOLVED | `findSnapshotCommit` requires all four trailers, and B4's read-back then checks the commit's tree. The worker's M3 test covers this. A residual gap is listed as N4. |
| M4 failure cause recorded | RESOLVED | Probe B pause detail: `"Injected handoff snapshot commit failure."`. It is the message only, on one line, capped at 300 characters. How it was implemented is noted as N3. |
| M5 later pause leaks into STATE.md | RESOLVED | **Probe D2**: a failed commit, then an owner pause stacked on top, then a backstop retry. The committed STATE.md mentions neither `handoff_snapshot_failed` nor the owner's reason. |
| M6 test quality | RESOLVED | All 14 tests drive the production manager with no manual step, and each blocking finding has a regression test. The CD-11 finish-run case is covered by `C2a B1+M6`: the automatic handoff selects the post-snapshot head through the moved document tip. |
| M7 AGENTS/CLAUDE splice | DEFERRED to C2b, as the brief instructs | — |
| M8 static audit | RESOLVED | `native-build-factory.ts:3751` now passes `execute: unavailableGitRunner`. `git-caller-audit` passes 14/14. |
| M9 CD-1 pairing | DEFERRED to T7a, as the brief instructs | — |

## Fix-delta analysis (both directions)

- **async `afterArchitect`.** All 28 call sites are `return this.afterArchitect(...)` inside async methods, and none sits inside a try/catch that would lose a rejection. Steps are serialized by `stepQueue`. The `dispatchStep` backstop runs only when no snapshot exists for the current stop, and the commit reuses an existing one by key. Result: no double commit (probes A-D all show exactly 1 commit). The one way to lose an event is a reducer rejection of the append, covered by N1 and Probe F.
- **Recovery.** If the process crashes after `project.handoff_requested` but before the commit, the supervisor is still `running`. On restart `shouldAutoRun` activates the run, the pump reaches the `dispatchStep` backstop, and the snapshot commits. The worker's crash test covers the variant where the commit already landed.
- **Replay.** The new event type appears only in v2 logs. The v1 fixture replays unchanged (AC-18, 3/3 green).
- **Manager gate before `handle.projectHandoff`.** A missing snapshot is now refused before any project mutation. One path can still mutate the project before the kernel accepts: a *recorded* snapshot whose parent is neither the canonical revision nor the document tip (N1, Probe G). The same apply-then-validate order already exists on the v1 path; C2a adds a new way to reach it.
- **B2 reducer change.** It fires only when all three hold: docs v2, handoff `requested`, status `running`. That combination arises only after the resume exemption for `handoff_snapshot_failed`. `paused`, `failed` and `stopped` runs are left alone, and a run with no requested handoff is refused earlier in the reducer. It cannot pause a run in any other state.
- **`handoff-snapshot.ts` (accepted in C1).** The change is minimal and additive. The C1 tests are green.
- **v1 behaviour.** It is unchanged in decisions. Every new branch returns early unless `projectDocsPolicyVersion === 2`. The v1 projection gains two additive fields: `projectHandoff.requestedSequence`, and `pauseReason.detail` (N3). No test or client code does an exact-shape comparison on these fields.

## New findings (all MINOR follow-ups)

| # | Class | Where | Detail and suggested fix |
|---|---|---|---|
| N1 | MINOR: must be fixed before T7a stamps docs v2 in production (project mutation or stuck handoff, race-dependent) | `build-runtime.ts` (snapshot event append after the commit, not guarded); `scheduler-store.ts` `applyHandoffSnapshotCommitted` (requires a *requested* handoff and records a snapshot that does not continue the chain); `native-build-manager.ts:575` (pre-check `record.revision === integrationRevision`) | **Probe F**: user guidance lands while the kernel commit is in flight. The step throws `Handoff snapshots require a requested project handoff.`, the kernel commit stays on the integration branch, and no event records it. **Probe G** (production manager, finish run, integration branch one commit ahead of the canonical revision): the snapshot is recorded with a parent that does not continue the chain, so `documentTip` stays null. The manager pre-check passes, and `applyToProject` mutates the project (`physicalHandoffs 1`, STATE.md present in the project). The reducer then refuses with "…does not match the verified integration revision." and the run parks at `automatic_project_handoff_failed`; every retry repeats this. Fix: make the manager pre-check match the reducer's post-apply acceptance (for finish/budgeted runs, require the current-stop snapshot `commit` to be the document tip, or its `parent` to be the canonical revision or tip). Also record, or otherwise handle, a kernel commit whose event append was rejected, for example by accepting the snapshot event for a withdrawn stop into history. |
| N2 | MINOR | `build-runtime.ts:694-696` | The resume exemption depends on the *current* pause reason. If an owner pause is stacked on a `handoff_snapshot_failed` pause, resume is refused ("awaiting … handoff selection"; Probe D2). Only an activate call reaches the backstop. Through the control server this is probably unreachable, because the supervisor is already paused. Suggestion: base the exemption on "v2, handoff requested, no snapshot for the current stop". |
| N3 | MINOR (scope) | `scheduler-store.ts:4957` | M4 was implemented by carrying `detail` from every `run.paused` event. Delivery-gate pauses (`pauseForDeliveryGate`) already sent `detail`, so replaying existing logs now fills in `pauseReason.detail` there too. The change is additive, and every suite that reads `pauseReason` is green (274/274 below). Recorded here for traceability. |
| N4 | MINOR | `integration-manager.ts:1881` | The trailer lines can match anywhere in the message body. A worker commit cherry-picked with `-x` whose multi-line summary contains all four lines would pass the check; it would still also need a STATE.md with a valid digest. Suggestion: also require the runner author/committer identity, or parse only the trailer block. |
| N5 | MINOR (evidence accuracy) | `runner-v2/test/docs-policy-v2-handoff.test.ts` | Line endings are mixed: lines 896-1067 are CRLF and the rest are LF. The evidence claims "LF … no mixed EOL". `core.autocrlf=true` normalizes the file on `git add`, so the committed blob will be LF. The problem is cosmetic. |
| N6 | MINOR (depends on M9/T7a) | `build-runtime.ts:2004-2009` | A docs-v2 plan-only run with legacy planning has no revision to record. It would pause with "no handed-off revision recorded at the stop" on every retry. It is reachable only if the CD-1 pairing is not enforced. |

Follow-up list: N1 before T7a (or in C2b if the controller prefers); N2-N4 and N6 with T7a; N5 needs no action (normalized on commit).

## Probes (real SQLite, real git, advancing clock)

Temporary file `runner-v2/test/zz-c2a-r2-probe.test.ts`. It reused the new test's helpers and was deleted after use; a copy is in the reviewer scratchpad. `git status` is back to the worker's set, and the hashes are unchanged. All 8 probes ran (8/8):

- **A**: factory + production manager, no manual step. 1 snapshot event after the pump, 1 Architect call, and the owner's selection completes.
- **B**: failure → resume → retry. The run is `paused`/`requested` with no pause reason. The next step is `paused` with no model call, and the selection completes.
- **C**: two failures with a resume between them. Two distinct pause keys, the second resume is accepted, and the third attempt commits.
- **D**: the commit lands, then the commit port throws, then the retry reuses the commit. 1 commit, 1 event, and the digests match.
- **D2**: failure, then an owner pause stacked on it, then the backstop retry. STATE.md is free of later pauses. Resume is refused while the owner pause stands (N2). The selection completes.
- **E**: stale-stop selection is refused.
- **F**: guidance arrives during the commit. The step throws and the kernel commit is left behind with no event (N1).
- **G**: a snapshot that does not continue the chain on a finish run. The project is mutated, then the selection is refused (N1).

## Suites (NODE_TEST_CONTEXT cleared, `--test-concurrency=1`)

- `docs-policy-v2-handoff`, `replay-compatibility`, `handoff-snapshot` (C1), `git-caller-audit`, `lsp-caller-audit`, `mcp-caller-audit`, `one-shot-command-routing-static`, `static-adapter-policy`: **109 pass, 0 fail**.
- Suites that read `pauseReason` or touch the handoff and that the worker's evidence does not list: `delivery-acceptance`, `t6b-repair-boundary`, `t6b-repair-runtime`, `t6b-repair-scaled-limit`, `repair-cycles`, `process-recovery`, `planning-review`, `native-architect-runtime`, `task-scheduler`, `verifier-contracts`, `guidance-review`: **274 pass, 0 fail**.
- Encoding: no BOM. Non-ASCII byte counts equal HEAD for every changed file. The changed source files keep their EOL (CRLF, and LF for `handoff-snapshot.ts` and `request-triage.test.ts`). The new test file has mixed EOL (N5). `git diff --check` is clean.
- Not rerun, because the worker already ran them green on byte-identical files (hashes match): `native-build-manager`, `build-runtime`, `project-doc-commit`, `request-triage`, `scheduler-store`, `integration-manager`, `control-server`, tsc, eslint, and `native-delivery-factory` (about 27 minutes).
