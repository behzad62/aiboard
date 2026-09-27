# Runner V2 P6.6 — Architecture correction amendment (AR) — execution plan

Date: 2026-09-27. Controller: Opus 5.5 (this session). Parent plan:
`docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` (sha256
`426be46d2341eb5e21b85dc6efa68e6274a0119e6dd06b64eaa3bed807161d99` before this amendment).
State: `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/progress.md` (the controller STATE).
Evidence: `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/evidence/<packet>.md`.

This amendment adds work to P6.6. It removes no parent obligation except where a row below
says "amends" and names the owner decision that authorizes it.

**Verdict:** see section 11.

---

## 1. Source identity

| Id | Source | Identity |
|---|---|---|
| S1 | Owner's external architecture audit (input to evaluate, not instructions) | `evidence/external-architecture-audit-2026-09-27.md`, sha256 `1b161a91f8816318eb2d68d886b22b84a11c00b64b1dc5e997441b236b5c9ef9` |
| S2 | Architecture investigation (fresh Opus 5.5, read-only, HEAD `764fdffb`) | `evidence/architecture-investigation-2026-09-27.md`, sha256 `467160032f944f6bba077752980ba85ef00b2fbb402e880c4305a572b7994879` |
| S3 | EX-4 lessons audit | `evidence/EX4-lessons-audit.md`, sha256 `33ff37a83563aef754d1db0b5ca66dd1c61dda98266c051bbcb32981509e16c3` |
| S4 | Owner decisions 2026-09-27 (this session) | Quoted in section 2 |

Section references such as "S2 §3.4" or "S2 F2" point into those files. Code line references
come from S2/S3 at `764fdffb`; a packet worker re-checks them at its base.

---

## 2. Decisions

### Owner decisions (S4)

- **AR-1 — Handoff files: runner facts plus Architect notes at a stop.** Owner: "I am not sure if
  a script in runner can properly write it. At the same time we dont want architect write it all
  the time, maybe only when build stopped for whatever reason?" then "go" on the controller's
  hybrid recommendation. Meaning: the runner renders the facts (S2 §3.4) into
  `docs/project/STATE.md` at every stop; the Architect writes only a short notes part, and only
  at a stop. The Architect no longer maintains `docs/project/**` on its turns. This **revises
  capability decision D6** (AC-25): the completion gate stays, and the kernel satisfies it.
- **AR-2 — Correction packets before T7.** Owner: "go" on "C packets before T7".
- **AR-3 — Architect disposition.** Owner chose "Architect confirms": in the new policy the
  independent deliverable review is the review; the Architect confirms or overrides prefilled
  verdicts with a reason and does not re-review the full diff.
- **AR-4 — Exact-identity evidence reuse.** Owner chose "Exact match only": reuse a test result
  only for an identical tree, command and environment within one run. **Amends** parent T8
  (parent `:300` "unrelated-change reuse") and parent EP19's unrelated-change reusable case
  (parent `:366`) to exact-identity reuse. Semantic reuse (`decideApplicability`) moves to P7.
  Parent-plan line references in this document use the parent at `ad6028d2` (after the AR
  header note).
- **Workers.** Owner 2026-09-27: "start with muse, not mimo". Muse Code
  (`muse-spark-1.3-contributor`, `--reasoning-effort xhigh`) implements new packets.

### Controller decisions

- **CD-1 — Docs policy v2 scope and the one stamp owner.** Docs v2 goes with planning policy v1
  (the new policy). Legacy-planning runs keep docs v1 exactly. Today nothing in `src/` stamps
  planning v1 (S2 F1), and `configureProjectDocsPolicy` (`build-runtime.ts:1885-1896`) returns
  early on a non-empty log and runs before any planning policy exists (review r1 B-1). So C2
  builds only the v2 reducer, gate and writer, and its tests seed `planning.policy_configured`
  and `project_docs.policy_configured {version: 2}` (CD-7 allows seeding). **T7a is the only
  owner of production stamping:** it stamps planning v1 (appended while `lastSequence ≤ 3`,
  `scheduler-store.ts:3081`) and docs v2 together, and decides which production runs get them.
  `run.initialized` accepts a leading docs stamp only for docs v1 (`scheduler-store.ts:3129-3138`);
  C2 extends that branch to v2 for its seeds and T7a uses it.
- **CD-2 — Scope guard is a finding, secrets are refused.** EX-4 packet 2(a) refused out-of-scope
  paths. The parent non-goal (parent `:64`, "no rigid worker file whitelist") and the owner's
  authority philosophy win: every scope item (out-of-claim path, `forbiddenSurfaces` path,
  instruction file, diary-looking new file) is a **blocking finding** the Architect resolves.
  Only secrets and key files are **refused** (S2 §12 risk 8).
- **CD-3 — Lanes.** Lane A runs C1→C5 then T7a→T7d, T10, T8. Lane B runs R1, R2, R3 after C5 is
  accepted, in worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-r` (branch
  `codex/runner-v2-p6-6-r` from the lane A commit that accepted C5), and merges into lane A before
  T10. The controller may run lane B serially instead when only one worker is available.
- **CD-4 — Review policy for these packets (S2 §7.4, §7.5).** One independent review per packet.
  A fix re-review checks each prior finding and the fix delta in both directions. After the first
  review, a new blocking finding on unchanged, already-reviewed code is allowed only when it is
  critical (security, data loss, false acceptance) or backed by a failing test; other late
  findings go to the packet's follow-up list. A component with a safe fail-closed floor is
  accepted when it fails closed on unknown input.
- **CD-5 — Spec copy and commit option.** The verbatim spec copy is on by default with a per-run
  opt-out; a per-run `export_only` option writes no handoff files at any stop (S2 §3.4, §12
  risk 2). S2 proposed a per-project zero-files opt-out; a per-run option is the smaller first
  step. CD-2 and CD-5 are controller decisions the owner has not confirmed; T7c shows both
  defaults to the owner in the run options.
- **CD-6 — One acceptance record.** `delivery.*` stays the only acceptance record. The eight
  unproduced T2 planning event types and T2 validation/acceptance projections are frozen as
  reserved (S2 A1, F4, §12 risk 9).
- **CD-7 — Production-path proof in every packet.** Every packet that changes runtime behavior has
  in its Definition of Done at least one test built through `NativeBuildFactory` and driven by
  `BuildRuntime.step` on the real SQLite store (seeded policy is allowed before T7a). A pure module
  is exempt only when its wiring packet is named (C1 → C2). T7a adds the unseeded end-to-end test.
  "Library only" is never an accepted end state without a named wiring packet (S2 §7.5).
- **CD-8 — C1 starts with the planning review.** C1 is a new pure module with no dependents in
  flight. It starts while the independent planning review runs; a review change to C1 becomes a
  brief update, not a restart. **C1 cannot be accepted before this plan is PLAN READY.**
- **CD-9 — Stop snapshots never touch an answered run (review r1 B-3).** AR-1 says "every stop";
  OA-5/EP39 says an answered run makes zero project mutation, and its `apply_to_project`
  (`native-build-factory.ts:1823-1826`) would carry any integration-branch commit into the
  project. Resolution: OA-5 wins for runs that are not builds. C3 commits a stop snapshot only
  after the triage decision `build` (under either run policy, `build` or `plan_only`); before
  triage, while a `clarify` triage is pending, or on an answered run it records the skip reason
  and writes nothing. AR-1 is about continuing a build; an answered run
  has no build to continue.
- **CD-10 — Shape changes after T7a (review r1 B-5, S2 §11 note 3).** Premise: no P6.6 code reaches
  `main` or a user before T8 is accepted; the branch merges only after T8. Under that premise,
  lane-B changes to new-policy tool inputs and event semantics stay fixture updates, as C5 does
  (T9 precedent). If the owner merges P6.6 before T8, every later new-policy shape change bumps
  the planning-policy version and adds replay fixtures.
- **CD-11 — Mid-run document tip under v2 (review r1 M-5).** AR-1 supersedes S2 §11's "v2 runs never
  create a mid-run document tip": stop snapshots are mid-run kernel commits. The tip clear
  (`scheduler-store.ts:4404-4407`) and tip set (`:9012-9024`) are not version-gated; only
  `latestIntegratedTaskSequence` (`:4408-4410`) is gated on `projectDocsPolicyVersion === 1`. C2
  and C3 make the new kernel-commit event set the tip and extend the gated bookkeeping to v2.
- **CD-12 — EP06 contract fields stay required (review r1 B-4).** S2 §5 row 7 proposed making
  unused contract fields optional. That would weaken parent EP06 (parent `:353`), and no owner
  decision authorizes it. C5 instead gives those fields consumers (the worker and reviewer
  contexts, including `validation` rationale for the reviewer) and makes only kernel-supplied
  envelope fields optional for the model.
- **CD-13 — C2 runs as two packets (2026-09-27, after C1 needed seven reviews).** C2a: steps 1-4
  and 7 (reducer v2, kernel-commit method, `project_docs.handoff_snapshot_committed`, the gate with
  STATE.md, answered runs). C2b: steps 5, 6 and 8 (AGENTS.md section, `@AGENTS.md` line, spec copy,
  run options, hand-edit detection) and the full AR-R05 tree check. Same requirements, smaller reviews.

---

## 3. Requirement ledger

Each row has one owning packet. Acceptance evidence goes to `evidence/<packet>.md`.

| Id | Source | Required outcome | Owner | Acceptance evidence |
|---|---|---|---|---|
| AR-R01 | S2 §3.4, AR-1 | One pure, deterministic renderer produces the snapshot: header (run, revision, stop kind and reason, body digest), what was asked, requirement status table, open work, verification with real counts and exact commands, decisions, notes slot, next action; a plan view for plan-only; a task list when no ledger exists | C1 | Golden and determinism tests |
| AR-R02 | S2 §3.4, §12 r1 | The snapshot is bounded (at most 200 lines / 16 KiB), never truncates header or verification, and neutralizes untrusted text (markers, table breaks, control characters) | C1 | Size-cap and injection tests with fault injection |
| AR-R03 | S2 A16, F6, §11 compat | The reducer accepts docs policy v2 additively; a run seeded with planning v1 and docs v2 follows the v2 path; every v1 log replays unchanged; old code refuses v2 (production stamping is T7a's, CD-1) | C2 | Replay-compatibility with a v1 fixture log; seeded v2 factory test |
| AR-R04 | S2 A4, A6, A7, §3.4, §9, AR-1 | At handoff and plan-only completion the runner commits STATE.md, the static v2 AGENTS.md section, the `@AGENTS.md` line in CLAUDE.md and (CD-5) the spec copy in one kernel commit with runner attribution and an `AIBoard-Generated: handoff-snapshot` trailer; no model call; a new additive event `project_docs.handoff_snapshot_committed` (runner actor; idempotency key from the stop event's sequence; stop kind; commit, parent and head; body digest; paths) records it and moves the v2 document tip (CD-11) | C2 | Factory test inspecting the commit tree, the event and the model-call record |
| AR-R05 | S2 A6, AR-1, AC-25 | v2 form of AC-25: a docs-v2 run that is not answered cannot record `project.handoff_selected` or `run.completed` until `project_docs.handoff_snapshot_committed` exists for the handed-off revision and that commit's tree holds `docs/project/STATE.md`, the marked AGENTS.md section and the marked `@AGENTS.md` line (README is not required under v2); an answered run is exempt (OA-5); an `export_only` run satisfies the gate by its recorded run option; `complete_run` no longer needs a model-written STATE.md; a failed kernel commit pauses the run with `handoff_snapshot_failed` and retries on resume | C2 | Gate test plus prove-red |
| AR-R06 | S2 F6 | An answered v2 run writes no project file and needs none to complete | C2 | Answered-run factory test |
| AR-R07 | S2 §12 r3, CD-5 | A hand-edited previous snapshot is detected by its header digest, recorded, and named in the new snapshot; `export_only` and spec opt-out work | C2 | Tests per option and for the edited case |
| AR-R08 | AR-1, CD-9, CD-5 | At every stop other than handoff (any pause reason, cancel, terminal failure) of a run after the triage decision `build` (either run policy; CD-9), the runner commits a fresh snapshot on the integration branch through the C2 kernel-commit path, idempotent per stop event, never blocking or changing the stop; before triage, while a `clarify` triage is pending, on an answered run, with `export_only`, or for C2's own `handoff_snapshot_failed` pause it records the skip reason and writes nothing | C3 | Pause/resume factory tests with real git; answered-run tree-hash test; `export_only` test |
| AR-R09 | AR-1 | At a stop whose reason allows model calls, the runner asks the Architect once for short notes (bounded size and time, no tools, recorded as `handoff_notes` cost); otherwise, or on failure, the snapshot says why there are no notes; at handoff the `complete_run` summary is the notes | C3 | Scripted-Architect tests: notes present, disallowed reason, failure |
| AR-R10 | S2 §9 | Runner-authored integration commits of new-policy runs carry `AIBoard-Run`, `AIBoard-Task` and `AIBoard-Requirements` trailers | C3 | Git log assertion in a factory test |
| AR-R11 | S2 A5, §5 rows 1-2, F9 | The v2 Architect prompt has no docs templates, layout or per-turn STATE.md body; the existing snapshot is given once at triage/planning as labelled untrusted context (at most 4 KiB); v1 prompts are unchanged | C4 | Prompt tests; token count before/after |
| AR-R12 | S2 A11, A17 | Under v2, `write_project_doc` stays available but refuses kernel-owned paths and `docs/project/evidence/**`; its description states the anti-journaling rule | C4 | Tool refusal tests |
| AR-R13 | S2 A8, §5 row 3 | **Amends** the parent `PlanningCheckpoint` mechanism (EP09, parent `:356`; authorized by the owner's "go" on phase C, AR-2, which named this cut): `record_planning_checkpoint` is removed from the new-policy tool surface and prompt; the resume index is derived from the durable read index and plan/review state and still reports covered and remaining sections, completed planning contracts, outstanding work and next action; a new plan revision is the planning-turn proof after folded guidance; old logs with checkpoints replay | C4 | Tool-list, derived-index, restart and replay tests |
| AR-R14 | S2 A1, F4, §5 row 11, CD-6 | Unproduced T2 planning event types and projections are marked reserved; a static test fails if a `src/` module starts appending them without updating the reserved list | C4 | Static guard test |
| AR-R15 | S2 A9, §5 rows 4-5, CD-12 | The kernel stamps plan envelope fields (run, manifest id and digest, policy version, times, review and lineage ids, expected digest, and `requiredBase`, which the kernel supplies); the model may omit them and, when it gives them, they must match; the model authors one side of each link and the kernel derives the other (both sides must agree when given); EP06 fields stay required; stored revisions and digests stay valid | C5 | Planning-tool tests; stored-digest test |
| AR-R16 | S2 F2, §5 row 7 and note, CD-12 | The worker's context holds the compact semantic contract (outcome, scope and exclusions, inputs, outputs, steps, writable surfaces and resource claims, forbidden surfaces, criteria, definition of done, cleanup); the deliverable reviewer's context holds outcome, scope, criteria, definition of done, review criteria, integration checks, negative-proof applicability and the validation rationale (`validation.targetedRationale` / `affectedScopeRationale`); both within a recorded token cap | C5 | Factory test reading the real worker and reviewer context; prove-red |
| AR-R17 | S2 F1, S3 P0, CD-1 | Production run creation stamps planning policy v1 (log sequence ≤ 3) and docs v2 together and registers the approved source; one unseeded factory test runs from production run creation to `delivery.review_started`, boundary and `task.acceptance_recorded` | T7a | Unseeded factory test; stamp test |
| AR-R18 | S2 A13, §3.2 | **Amends** parent T7 "Documentation folder boundary" (parent `:286`, authorized by AR-1): for docs-v2 runs, T7 exports and views render through the C1 renderer, the `docs/project/generated/` branch is replaced by the v2 snapshot, and an explicit export into the repo happens only on request; docs-v1 runs keep the parent behavior unchanged | T7d | Export parity test; v1 export test |
| AR-R19 | S3 N1, L4a | Test integrity: pinned test command and suite-shrink detection at the boundary unless tied to a plan revision reason | E1 | S3 packet 1 tests |
| AR-R20 | S3 L17, N2, N4, CD-2 | Submission scope findings (blocking, not refusal) and secret/key-file refusal; diary-looking new files flagged | E2 | One fixture per class plus a clean control |
| AR-R21 | S3 N5, N3, L3 | Every runtime of an attempt is an author; unreferenced new source files and test-only diffs raise the tier; one inspection call at every tier | E3 | S3 packet 3 tests |
| AR-R22 | S3 L6 | Encoding safety: BOM kept by `fs.patch`/`fs.write`; submission encoding findings | E4 | S3 packet 4 tests |
| AR-R23 | S3 L10, N3, S2 §7.4, EP45 | Mutation survivors on changed lines become findings that need a reviewer disposition before approval; a disposition "not a real gap" with a rationale releases the survivor (OA-11/EP45: survivors are reviewer evidence, not automatic blockers); a `verified` claim must cite a location or evidence the session actually read | E5 | Vacuous-test fixture; release-by-disposition test; uncited-verified refusal |
| AR-R24 | S3 L13, L16, S2 §12 r6 | Command evidence records a working-tree fingerprint and a child-environment fingerprint; links taken before later edits are marked stale; PATH entries inside the runner's own install tree and `npm_*`/`INIT_CWD` are removed from project child environments | V1 | S3 L13/L16 tests |
| AR-R25 | AR-4, S2 §7.2 item 7, S3 L7, §12 r7 | Exact-identity reuse within a run (boundary, high-tier depth, final verification), recorded as `reused_from`; content-based evidence digests; the approach-decision "new evidence" rule uses content, tested both directions | V2 | Reuse and invalidation tests; both-direction approach tests |
| AR-R26 | S2 F5, S3 L4d, §12 r5 | Language-neutral execution profile: build/test commands and machine-readable reports for non-`package.json` projects (TRX, `ctest --output-junit`, `pytest --junitxml`, Maven/Gradle JUnit XML, cargo/go where a reader exists); `unknown` only when nothing applies | V3 | Fixture per family; unknown-language floor |
| AR-R27 | S2 A12, §7.2 items 1-3, S3 L7 | ReviewKey dedupe (same key: no new review, prior verdict returned, no cycle charged); interrupted review resumes at its first missing stage when the same runtime continues; a repair diff equal to or reversing a failed attempt's diff is a blocking finding | W1 | Dedupe, resume and oscillation tests |
| AR-R28 | S2 §7.2 item 5, §7.4, S3 L8 | Delta re-review input (fix delta, delta files no finding names, invalidated evidence, then prior findings); the late-finding rule in the reviewer contract | W2 | Delta-context and late-finding tests |
| AR-R29 | AR-3, S2 §5 rows 8-10, S3 L2 | Architect disposition: `review_task` verdicts prefilled from the reviewer and runner evidence; overrides need a reason, and `unverified`→`verified` needs evidence the Architect's session read; `decideUnverifiedClaim` labels each claim; runner evidence pre-linked to criteria; final-verification plans prefilled for detected categories; the new-policy Architect prompt no longer tells the Architect to read the submitted diff (`agent-prompts.ts:590-597`) | W3 | Disposition, override, label and prompt tests |
| AR-R30 | S2 §11 T10, S3 L8, L9, N4, §12 r10 | T10 adds: v2 prompt wording, the anti-journaling tool description, the both-directions fix re-review line, the durable-state reviewer line, untrusted labelling, the worker's compact task view, and a check of Claude Code's AGENTS.md behavior on the owner's version | T10 | T10 disposition table |
| AR-R31 | S2 §11 T8, AR-4 | T8 adds: v2 build with restart ends with only product files, the snapshot, the entry lines and the optional spec copy; an answered run adds no file; a plan-only snapshot holds the plan; a pause snapshot with notes; a v1 docs log replays; non-JS fixtures pass the boundary; reuse per AR-4 | T8 | T8 report |
| AR-R32 | AR-1, AC-25 | Capability design D6 carries a revision-5 note pointing to this amendment | Controller (this plan) | The note exists |

---

## 4. Every finding in S2 and where it goes

"No action" means S2 verified it as already correct. "Deferred" names the later owner.

| S2 item | Disposition |
|---|---|
| A1 dead T2 events | C4 freeze (AR-R14, CD-6) |
| A2, A3 | No action (true, correct today) |
| A4 AGENTS check requires `evidence/` | C2 v2 static text (AR-R04) |
| A5 docs text on every turn | C4 (AR-R11) |
| A6 STATE.md gate | C2 (AR-R05) |
| A7 second state representation | C2, C3: the snapshot is a rendered view (AR-R04, AR-R08) |
| A8 planning checkpoints | C4 (AR-R13) |
| A9 contract envelope | C5 (AR-R15) |
| A10 automatic evidence | Partly done at T6a; V1, V2, W3 (AR-R24, R25, R29) |
| A11 anti-journaling | C4 tool rule (AR-R12), E2 diary-file finding (AR-R20), T10 text (AR-R30) |
| A12 review dedupe and delta | W1, W2 (AR-R27, R28) |
| A13 T7 generated views | T7d (AR-R18) |
| A14 review-round counts | CD-4 for this plan; W2 late-finding rule in the runner |
| A15 timing | AR-2 |
| A16 v1/v2 | C2 (AR-R03) |
| A17 `write_project_doc` optional | C4 (AR-R12) |
| A18 zero files vs continuity | AR-1 |
| F1 new policy unreachable | T7a (AR-R17) |
| F2 worker sees one line | C5 (AR-R16) |
| F3 T5 unwired | V2 exact reuse, W3 `decideUnverifiedClaim`; deferred to P7 (named in section 8): `decideApplicability`, `createValidationEvidenceTools`, RED→GREEN pairing, `validation-observation.ts` `assessObservationForAcceptance` / `recordFaultInjection` / `recordFlakyIsolation`, and `validation-policy.ts` |
| F4 two acceptance models | C4 freeze (AR-R14, CD-6) |
| F5 `package.json` only | V3 (AR-R26) |
| F6 answered run writes docs | C2 (AR-R06) |
| F7 diff read three times | W2 delta, W3 no Architect diff read |
| F8 full script every boundary | V2 reuse cuts duplicate runs; affected-test selection stays informational; deferred to P7 with data |
| F9 document tip | CD-11: C2 and C3 extend the tip logic to v2 kernel commits (AR-1 supersedes S2's "no mid-run tip for v2"); v2 Architect doc writes become rare (AR-R08, R12) |
| §5 row 6 whole-plan re-emit | Deferred to P7 (delta plan revisions) |
| §5 rows 1-5, 8-11 | C2, C4, C5, W3 as in AR-R04, R11, R13, R15, R29, R14 |
| §5 row 7 unused contract fields | CD-12: fields stay required (EP06); C5 gives them consumers (AR-R16) |
| §5 writable surfaces and claims | Shown by C5 (AR-R16), compared by E2 (AR-R20) |
| §7.2 items 1-7 | W1 (1-3), kept (4), W2 (5), W3 (6), V2 (7) |
| §7.4 anti-rubber-stamp | E3 inspection floor, E5 cited reads and survivors; reviewer outcome tracking deferred to P7 |
| §7.4 anti-loop | W1 same key, W2 late-finding rule, CD-4 safe floor, budgets unchanged |
| §7.5 lessons | Small packets (this plan), CD-4, CD-7; the `.superpowers/` diary is an owner choice, no action |
| §8 L1-L18, N1-N5 | Placed by the packets above; backlog rows below |
| §9 AGENTS.md entry, `@AGENTS.md`, spec in repo, plan-only plan | C2 |
| §9 commit trailers | C3 (AR-R10) |
| §9 memory outside the repo | No action (project memory exists) |
| §11 compatibility notes | Section 6 shared rules (never delete an event type or reducer branch; v1 replays) for every packet; C4 checkpoint event stays; CD-12 fields stay required; CD-11 tip logic; note 3 (shape changes after T7) CD-10 |
| §11 AC-25 revision note | AR-R32 |
| §12 risks 1-10 | 1 AR-1 notes + C4; 2 CD-5 (T7c shows the default); 3 AR-R07 (T7c shows the notice); 4 CD-7; 5 V3; 6 V1/V2 constraints; 7 V2 tests; 8 CD-2; 9 CD-6; 10 T10 |
| OA-5/EP39 vs "every stop" (found by review r1) | CD-9, AR-R08 |

S3 items that S2 did not place, kept visible as **backlog after T8** (MEDIUM, one small packet
each, S3 table): L4(b) counts for `run_evidence_command`; L4(c) a `node --test` file with no test
counts as a pass; L9 durable-surface tier signal (its reviewer line goes to T10); L11 402 and
context-overflow classification; L14 `task_size` plan-risk reason; L15 tmpdir and scratch-file
signal.

---

## 5. Phases

| Phase | Packets | Purpose | Entry | Exit (all packets accepted plus) | Unlocks |
|---|---|---|---|---|---|
| C | C1-C5 | Correct the new-policy model while no production run uses it | Owner AR-1, AR-2; this plan PLAN READY (C1 may start earlier per CD-8; nothing is accepted before) | A seeded new-policy factory run pauses, resumes and reaches handoff and writes only product files plus the kernel handoff files; an answered run writes nothing; v1 replay green | T7a; lane B |
| T7 | T7a-T7d | Parent T7, split in four (owner lesson: about four packets) | Phase C | Parent T7 acceptance plus AR-R17, AR-R18 | T10 (with lane B merged) |
| R1 | E1-E5 | Safety guards (S3 HIGH packets plus E5) | C5 accepted | Each guard proven red then green | R2 |
| R2 | V1-V3 | Evidence: fingerprints, exact reuse, non-JS profile | R1 | Reuse and non-JS fixtures green | R3 |
| R3 | W1-W3 | Review economics | R2 | Dedupe, delta and disposition proven | Merge into lane A, then T10 |
| T10 | parent T10 + AR-R30 | Prompt hygiene | T7 and R3 merged | Parent T10 acceptance | T8 |
| T8 | parent T8 + AR-R31 | Final gate | T10 | Parent T8 acceptance | P6.6 complete |

Dependency graph (acyclic): C1→C2→C3→C4→C5→T7a→T7b→T7c→T7d; C5→E1→E2→E3→E4→E5→V1→V2→V3→W1→W2→W3;
{T7d, W3}→T10→T8. C4 and C5 follow C3 because they share `agent-prompts.ts`, `build-runtime.ts`
and planning tools. Lane B packets touch `scheduler-store.ts` and `build-runtime.ts` like T7a;
the controller merges lane B into lane A before T10 and runs the affected suites at the merge.

Serialized surfaces: `scheduler-store.ts`, `build-runtime.ts`, `agent-prompts.ts`,
`architect-tools.ts`, `native-build-factory.ts`, `integration-manager.ts` — one writer at a time
inside a lane; across lanes, conflicts resolve at the lane B merge. Lane B write set (coarse):
`delivery-execution.ts`, `delivery-acceptance.ts`, `change-set.ts`, `filesystem-tools.ts`,
`evidence-tools.ts`, `execution-host.ts`, `native-deliverable-review.ts`, `final-verification-*.ts`,
`scheduler-store.ts` (review, author and evidence records), `build-runtime.ts`, `architect-tools.ts`
(`review_task`), `agent-prompts.ts` (review blocks), `repair-approach-contracts.ts` (V2),
`execution-isolation-provider.ts` and `oci-execution-isolation-provider.ts` (V1 environment scrub),
new guard modules and their tests. A lane B brief may add a file that is not a serialized surface,
with the reason recorded in its evidence. At the lane
B merge the controller also re-runs T7a's unseeded factory test with the lane B guards active.

---

## 6. Packet contracts

Shared rules for every packet (from the parent plan §8 and this session's worker rules): work
only in the lane worktree; never commit, stage, stash or push; real SQLite, advancing clock,
real pump; processes only through the audited execution paths (no `child_process`); preserve
file encodings exactly (no BOM added or removed, no mojibake, no line-ending flips); nothing is
recorded as performed unless it was performed; never delete an event type or reducer branch, and
every stored log replays unchanged (S2 §11); prove-red records sha256 before and after with a
byte-exact restore; evidence file `evidence/<packet>.md` with sha256 of every changed file,
suites and counts, suites not run, and "not done / limits". Validation: the packet's tests,
importer suites of changed files, `runner-v2` tsc, eslint on changed files, `git diff --check`.
Forbidden unless the packet names them: `progress.md`, package files, UI/client (except T7b-T7d),
other packets' surfaces.

### C1 — Handoff snapshot renderer (AR-R01, AR-R02)

- **Outcome:** `renderHandoffSnapshot(input)`, `handoffSnapshotInputFromProjection(...)` and
  `verifyHandoffSnapshotDigest(text)` in a new `runner-v2/src/handoff-snapshot.ts`. Pure: no I/O,
  no clock, no model. Wired by C2 (named wiring packet, CD-7). Body digest: sha256 of the body
  below the header line, with line endings normalized to LF and trailing whitespace at the end
  removed; the verifier normalizes the same way and matches only the exact generated header line.
- **Content (S2 §3.4 item 3):** header (generated by AIBoard, run id, described revision, stop kind
  `completed | plan_only | paused | cancelled | failed | answered_export | in_progress` (the last for
  on-demand exports of a running run; kinds come from the real run state), stop reason, the event time of the
  stop, body sha256); what was asked (source title, digest, spec path or copy path); requirement
  table (id, one-line outcome, status accepted / open / conditional pending / not applicable with
  its authorized reason); open work (unaccepted tasks, open blocking findings, external blockers
  with the owner action, exhausted repair issues, pause reason); verification (last final
  verification per category and the latest boundary per task with real counts and the exact
  build/test commands); decisions (`planningDecisions` plus acknowledged owner guidance, one line
  each); notes slot (Architect notes, or "No Architect notes for this stop: <reason>"); next action
  derived from state. Plan-only adds the plan view (phases, tasks with outcome, steps, criteria,
  dependencies). A run without a ledger renders a task list instead of the requirement table.
- **Bounds and safety:** at most 200 lines and 16 KiB. Never truncated: the header; the exact
  counts (open blocking findings, external blockers, exhausted repair issues, unaccepted tasks,
  requirements by status); every external blocker with its owner action; one line per
  final-verification category. Other lists truncate with "N more — see AIBoard run <id>", lowest
  value first, so the cap always holds; if the never-truncated set alone exceeds the cap, lists keep
  their exact counts and truncate too. Untrusted text is neutralized: single-line fields lose line
  breaks and C0/C1 controls and U+2028/U+2029; notes and summaries render as a `> ` blockquote of
  at most 30 lines and 2,000 characters; `<!--`/`-->` and table `|` are escaped; each field capped.
- **Steps:** read S2 §3.4; inspect `SchedulerProjection` (`scheduler-store.ts`), `PlanningProjection`
  (`planning-projection.ts`), the final-verification and boundary records (`delivery-acceptance.ts`,
  `final-verification-runtime.ts`), the handoff summary (`architect-tools.ts` `complete_run`;
  `project.handoff_requested` payload), `planningDecisions` (`planning-contracts.ts:948`); define the
  input type from real fields only; implement; test.
- **Writable:** `runner-v2/src/handoff-snapshot.ts`, `runner-v2/test/handoff-snapshot.test.ts`,
  `evidence/C1.md`. **Forbidden:** every other file.
- **Tests:** golden output for a new-policy fixture (three requirements: accepted, open,
  conditional; one external blocker; final verification with counts); plan-only fixture; no-ledger
  fixture; determinism (same input twice, and shuffled insertion order, give identical bytes);
  size cap; injection (notes containing the AGENTS marker, `|`, newlines and control characters);
  input adapter test built from a projection rebuilt from real SQLite events.
- **Red proof:** the new tests fail before the module exists; fault injection: remove the
  neutralizer, the injection test goes red; restore byte-exact.
- **DoD:** all tests green; deterministic; bounded; no I/O imports (a test asserts the module
  imports only pure modules).

### C2 — Docs policy v2: the kernel writes the handoff files (AR-R03 to AR-R07)

Runs as C2a then C2b (CD-13).

- **Outcome:** v2 per S2 §3.4 items 1-4, AR-1 and the v2 form of AC-25 (AR-R05) for runs seeded
  with planning v1 and docs v2; v1 untouched. Production stamping is T7a's (CD-1).
- **Steps:**
  1. Reducer accepts `project_docs.policy_configured` version 2 (`scheduler-store.ts:2865-2867,
     5256-5265`), additively. Do not change `configureProjectDocsPolicy` (`build-runtime.ts:1885-1896`);
     tests seed both policy events (CD-1).
  2. Kernel commit path: add a sibling method to `commitProjectDocuments`
     (`integration-manager.ts:609-686`, which hardcodes the Architect author and identity at `:43`,
     `:664-674`), for example `commitHandoffSnapshot`, that writes several files in one commit
     with a runner identity, `AIBoard-Author: runner` and the `AIBoard-Generated: handoff-snapshot`
     trailer. The Architect path stays unchanged. The method writes the stop key as an
     `AIBoard-Snapshot-Key` trailer and, like `findDocumentCommit` (`integration-manager.ts:1739`),
     returns an existing commit for that key, so a crash between the commit and the event append
     does not create a second commit.
  3. New additive event `project_docs.handoff_snapshot_committed` (runner actor; idempotency key
     from the stop event's sequence, no timestamp; stop kind; commit, parent and head; body
     digest; paths). Its reducer branch moves `projectDocs.documentTip` for v2 (CD-11), so
     `project.handoff_selected` (`revisionMatchesIntegrationOrDocumentTip`,
     `scheduler-store.ts:2211-2218`) accepts the post-snapshot head.
  4. Gate (AR-R05): under v2 skip `projectDocumentationReadiness` in `complete_run` readiness
     (`scheduler-store.ts:1987, 2009, 2033, 2200, 2220-2245`); after `project.handoff_requested` and
     at plan-only completion the runner renders C1 (the notes are the `complete_run` summary),
     commits through step 2 and appends step 3's event; `project.handoff_selected` and
     `run.completed` are refused until that event exists for the handed-off revision; a failed
     commit pauses with `handoff_snapshot_failed` and retries on resume.
  5. Files: AGENTS.md v2 static section via `spliceMarkedArchitectSection`
     (`project-docs.ts:185-199`) with the S2 §3.4 item 1 text and a v2 satisfaction check (the v1
     check `agentsMarkedSectionSatisfies`, `:202-214`, stays for v1); the CLAUDE.md marked line
     `@AGENTS.md`; spec copy `docs/project/specs/<source-id>.md` only when the approved source is not
     already a repository file and the run did not opt out.
  6. Run options `specCopy` (default true) and `handoffFiles: "commit" | "export_only"` (default
     "commit"), recorded in the run policy.
  7. Answered v2 runs (OA-5): no docs requirement, nothing written.
  8. Hand-edit detection (AR-R07): before writing, if `docs/project/STATE.md` at the tip fails
     `verifyHandoffSnapshotDigest` (C1) or has no generated header, record it in step 3's event and
     add the line "The previous snapshot was edited outside AIBoard; see this file's git history."
- **Writable:** `project-docs.ts`, `scheduler-store.ts`, `build-runtime.ts`,
  `integration-manager.ts` (new kernel-commit method; the Architect path unchanged),
  `native-build-factory.ts` (wiring), run-policy types, `handoff-snapshot.ts` (adapter fixes only),
  tests, `evidence/C2.md`. **Forbidden:** prompts and tool surface (C4), planning tools (C4/C5), UI.
- **Tests:** seeded v2 factory run to handoff: one kernel commit with exactly the expected files,
  the event, runner identity and trailer, and no model call for it; `project.handoff_selected` and
  `run.completed` refused before the event; commit failure pauses and resume retries; plan-only v2
  snapshot holds the plan; answered v2 run writes nothing and completes; `export_only` completes
  with no file; spec opt-out; spec already in repo; hand-edited snapshot detected and named; v1
  fixture log replays unchanged; a seeded v1 run still needs the model-written STATE.md; a crash
  between the kernel commit and the event append resumes to one commit and one event.
- **Red proof:** disable the v2 gate; `run.completed` without the event succeeds and the gate test
  goes red; restore.
- **DoD:** tests green; replay-compatibility suite green; no `docs/project/evidence` or `plans`
  written under v2; at least one factory test (CD-7).

### C3 — Snapshot at every stop, Architect stop notes, commit trailers (AR-R08 to AR-R10)

- **Outcome:** AR-1's "when the build stops for whatever reason" part, within CD-9 and CD-5.
- **Steps:**
  1. List every transition into `paused` (`scheduler-store.ts` sites `:3120, 3788, 4061, 4148,
     4929, 5176` at `764fdffb`; `:5000` is the handoff request, which is C2's stop), every cancel
     and every terminal failure. Classify each stop reason as notes-allowed (for example repair
     limit, external blocker, owner pause, failed final verification) or notes-denied (budget
     window exhausted, provider or credit failure, cancel, unknown reasons by default). Record the
     table in the evidence.
  2. Skip rule (CD-9, CD-5): no snapshot before the triage decision `build`, while a `clarify`
     triage is pending, on an answered run, with `handoffFiles: "export_only"`, or for C2's own
     `handoff_snapshot_failed` pause (C2 retries that commit itself); record the skip reason
     durably.
  3. Notes: bounded investigation — find the existing one-shot model-call path outside the
     Architect loop (for example the plan critic or verifier paths) and use it for the Architect's
     runtime with a fixed short prompt ("notes for the next tool: what matters, traps, what to try
     next"), no tools, at most 2,000 characters and a time bound; record the cost as purpose
     `handoff_notes` (EP40); store the text as a new additive event `handoff.notes_recorded`
     (Architect actor, idempotency key from the stop event's sequence).
  4. After the notes (or their denial or failure), render C1 with stop kind `paused`, `cancelled`
     or `failed` and commit STATE.md (plus the entry lines when missing) on the integration branch
     through C2's kernel-commit method and event. The commit must never block or change the stop;
     a failure records a finding. The next stop writes a new snapshot.
  5. Prove that integration, final verification and handoff still target the right revisions after
     a mid-run kernel commit (CD-11).
  6. Trailers: add `AIBoard-Run`, `AIBoard-Task` and `AIBoard-Requirements` where the runner
     authors integration commits for new-policy runs (if integration fast-forwards worker commits,
     add them where the runner creates the task commit; record which).
- **Writable:** `build-runtime.ts`, `scheduler-store.ts`, `integration-manager.ts`,
  `native-build-factory.ts`, the chosen one-shot call module (call site only), tests,
  `evidence/C3.md`. **Forbidden:** C4/C5 surfaces, UI.
- **Tests:** repair-limit pause writes a snapshot with open work and scripted-Architect notes;
  budget-exhaustion pause writes a snapshot with the "no notes" line and makes no model call; a
  notes failure still writes the snapshot; cancel writes a snapshot without notes; replaying the
  log or resuming twice creates no duplicate commit; pause → snapshot → resume → task integrates →
  final verification passes on the right revision → handoff snapshot; pause during triage →
  answer → `apply_to_project` leaves the project tree hash unchanged; `export_only` pause writes
  nothing; trailers in `git log`; legacy runs unchanged.
- **Red proof:** remove the notes-denied check; the budget-exhaustion test sees a model call and
  goes red; restore. Remove the CD-9 skip; the answered-run tree-hash test goes red; restore.
- **DoD:** tests green; stop table in the evidence; no stop blocked by a snapshot failure; factory
  tests (CD-7).

### C4 — Architect bookkeeping cut (AR-R11 to AR-R14)

- **Outcome:** under v2 the Architect does no docs or checkpoint bookkeeping; v1 unchanged.
- **Steps:** under v2, drop the docs section (`agent-prompts.ts:59-72, 552-553, 902, 931-934`) and
  add one line about `write_project_doc`; give the existing snapshot (at most 4 KiB, labelled
  untrusted, from the base revision) at triage and planning turns only; `write_project_doc`
  (`architect-tools.ts:390`, `build-runtime.ts:3671`) under v2 refuses `docs/project/STATE.md`, spec
  copies, the marked sections and `docs/project/evidence/**`; remove `record_planning_checkpoint`
  from the new-policy tool list and prompt (`planning-tools.ts:412-522`, `agent-prompts.ts:82`);
  derive the resume index from the read index and plan/review state
  (`planning-projection.ts:746-774`), keeping its reported facts (covered and remaining sections,
  completed planning contracts, outstanding work, next action), and make the inventory listing
  read it; for new runs accept a new plan revision as the planning-turn proof
  (`scheduler-store.ts:1200-1207`) while old logs with checkpoint proofs still replay; mark the
  reserved T2 types (`scheduler-store.ts:1053-1060`) and add the static guard test.
- **Writable:** `agent-prompts.ts`, `architect-tools.ts`, `planning-tools.ts`,
  `planning-projection.ts`, `scheduler-store.ts` (planning-turn proof, reserved marks),
  `build-runtime.ts` (tool registration), tests, `evidence/C4.md`. **Forbidden:** C2/C3 logic,
  contract validator (C5), UI.
- **Tests:** v2 prompt has no docs section and v1 prompt is byte-identical; per-role token counts
  before and after in the evidence; tool list without the checkpoint tool; the derived index
  reports completed planning contracts, outstanding work and next action; restart mid-planning
  resumes from the read index (real SQLite); old checkpoint log replays; refusals per path; static
  reserved-type guard; one factory test where a seeded v2 Architect plans without the checkpoint
  tool and without docs text (CD-7).
- **Red proof:** re-add the checkpoint tool to the list; the tool-list test goes red; restore.
- **DoD:** tests green; token counts recorded; v1 prompts byte-identical; factory test (CD-7).

### C5 — Contract envelope and contract delivery (AR-R15, AR-R16)

- **Outcome:** the model writes only the semantic contract; the kernel stamps the envelope; the
  worker and the reviewer see the contract (F2). EP06 fields stay required (CD-12).
- **Steps:** kernel stamps the envelope fields and `requiredBase` (`planning-contracts.ts:938-959`,
  `planning-tools.ts:616-625`; `task-scheduler.ts:733-738`); make only those kernel-supplied fields
  optional for the model (given values must match); derive mirrored links
  (`planning-contracts.ts:867-904, 916-927, 654-655`); keep `REQUIRED_TEXT_LIST_FIELDS`
  (`planning-contracts.ts:658-666`) and the other EP06 fields required; carry a contract reference
  on the scheduler task (`scheduler-store.ts:1417-1430`, `BuildTask` / `task-contracts.ts`) and
  render the AR-R16 blocks into the worker context (`agent-prompts.ts` `buildWorkerContext` /
  `workerContextSections` `:165-169`, called from `native-worker-driver.ts:531-553`) and the
  deliverable-review context (`native-deliverable-review.ts:492-500`) within a token cap recorded
  under EP40; update T3a/T3b fixtures and the coverage reviewer input (the new policy is
  unshipped, so fixture updates follow the T9 precedent, `progress.md`; CD-10).
- **Writable:** `planning-contracts.ts`, `planning-tools.ts`, `scheduler-store.ts` (task bridge),
  `task-contracts.ts` (contract reference only), `agent-prompts.ts` (worker contract block only),
  `native-worker-driver.ts`, `native-deliverable-review.ts`, T3a/T3b/T6a tests and fixtures,
  `evidence/C5.md`. **Forbidden:** other prompt text, UI.
- **Tests:** a revision without envelope fields is accepted and stamped; a given envelope value
  that does not match is refused; one-sided links derive; mismatching sides refused; a missing
  EP06 field is still refused; a stored old revision's digest still validates; factory test reads
  steps, scope, writable surfaces and definition of done in the real worker context and review
  criteria and scope in the reviewer context; token cap.
- **Red proof:** drop the contract block from the worker context; the factory test goes red.
- **DoD:** tests green; factory test (CD-7); stored digests valid.

### T7a-T7d — parent T7 split (AR-R17, AR-R18)

The parent T7 contract (plan §5 T7) stays binding. Its items split as follows; each packet gets
a full brief at its start from the parent text plus these lines.

- **T7a Production enablement:** production run creation stamps planning policy v1 (log sequence
  ≤ 3) and docs v2 together (CD-1), and registers the approved source through the real
  provisioning path; bounded investigation with an owner confirmation if it changes the default
  for every new run: which production entries create new-policy runs; the unseeded end-to-end
  factory test (AR-R17).
- **T7b APIs and client:** authenticated, idempotent source, plan-readiness and explicit-start
  controls; stale reconnect cannot start an old plan; unauthorized user or worker cannot mutate
  acceptance; on-demand export API through C1.
- **T7c UI:** planning-ready vs delivery-complete, requirements and blockers, answered-run view and
  answer-review opt-in, per-pass purpose and token cost, review independence and ladder rungs,
  docs v2 run options and their defaults (CD-5, CD-2 shown to the owner), the hand-edited-snapshot
  notice; old completed builds remain readable without newly invented coverage.
- **T7d Exports, cards and user docs:** section-10 exports and copy-ready cards through C1
  (AR-R18); native launch chips only when a real host API supports non-executing preparation;
  `docs/runner-v2/evidence-gated-planning.md` user docs; the parent T7 validation items: the
  Playwright source→plan→review→export→explicit-start journeys and the production build at the
  final integrated UI gate.

### Lane B briefs (R1-R3)

Each lane B packet gets a full brief at its start, written by the controller from S3/S2 and this
section, with writable and forbidden surfaces (inside the lane B write set, section 5), red proof
and DoD, following the section 6 shared rules and CD-7. The controller reviews the brief against
this contract before dispatch.

### R1 — E1-E5 (lane B)

E1-E4 follow S3 "Recommended packets" 1-4 exactly, with CD-2 applied to E2(a): every scope item is
a blocking finding, never a refusal; secrets and key files are refused with the reason redacted.
E2 also flags new files that look like harness diary (progress, evidence, review or test-output
records) as blocking findings (S2 A11). **E5:** S3 L10 (survivors on changed lines are findings
that need a reviewer disposition before approval; "not a real gap" with a rationale releases them,
OA-11/EP45) and S3 N3 backlog (a `verified` claim must cite a location or evidence id the reviewing
session actually read, checked against the tool ledger). Tests: as listed in S3 for each packet;
E5 vacuous-test fixture, release-by-disposition and uncited-verified refusal.

### R2 — V1-V3 (lane B)

- **V1:** S3 L13 (working-tree fingerprint via a temporary index `write-tree`; stale-link marking at
  submission) and S3 L16 (PATH/npm scrub recorded in the child-environment audit); a
  child-environment fingerprint (runtime version, lockfile digest, relevant variables) in every
  command evidence record.
- **V2:** AR-4 exact-identity reuse keyed by (tree id, exact command, environment fingerprint)
  within one run, recorded as `reused_from`; typical hits: fast-forward integration reuses the
  high-tier run; final verification reuses the last boundary on the same tree. Content-based
  evidence digests; the approach-decision "new evidence" rule uses them; tests both directions (a
  rerun with the same output is not new; the same command with a different output is new). Never
  reuse across runs; fall back to running when any fingerprint part is missing.
- **V3:** S2 §11 V4 text: non-`package.json` detection and report readers, `unknown` only when
  nothing applies. Fixtures: C# TRX, CMake `ctest` JUnit, Python `pytest --junitxml`, one
  Maven or Gradle JUnit XML, and an unknown-language floor fixture.

### R3 — W1-W3 (lane B)

- **W1:** ReviewKey `hash(semantic-contract digest, base tree, head tree or diff digest,
  evidence-content digest, tier, reviewer-policy version)`; same key refuses a new review and
  returns the prior verdict, charging no cycle; stage-level resume when the same reviewer runtime
  continues (a different runtime restarts from the first pass); S3 L7 repair-diff fingerprint.
- **W2:** delta re-review input per S2 §7.2 item 5; the late-finding rule (S2 §7.4 second loop
  bullet) in the reviewer contract and in the kernel's finding intake.
- **W3:** AR-3 disposition per S2 §7.2 item 6 and §5 rows 8-10; remove the new-policy Architect
  instruction to read the submitted diff (`agent-prompts.ts:590-597`; the Architect may still open
  it); wire `decideUnverifiedClaim`
  (S3 L2) so each claim carries a mechanical label and a reviewer `verified` on an
  `unverified_claim` link is refused; pre-link runner evidence to criteria; prefill
  final-verification plans for detected categories.

---

## 7. Validation, review, integration and repair

- Parent plan §8 applies. Session rules apply: the controller runs only the tests the worker did
  not run green on the same code; the controller runs importer suites of changed files and the
  suites the worker could not run.
- Review: one independent fresh-context Opus 5.5 review per packet, narrow scope (the packet
  contract, its diff and its evidence). CD-4 governs re-reviews.
- Repair: three cycles per blocking issue. Easier repairs go to Muse; if a complicated repair fails
  in round 2, the controller does round 3 itself (owner rule). Muse and the controller never edit
  at the same time.
- Integration: lane A commits each accepted packet on `codex/runner-v2-p6-6`. Lane B commits on its
  branch; the controller merges it into lane A before T10 and runs the importer suites of every file
  both lanes changed plus replay-compatibility.
- Acceptance: a packet is accepted only when its criteria have evidence, its review has no
  unresolved mandatory finding, and progress.md records it with the commit.

## 8. P7 and later (kept visible, not dropped)

P7: semantic reuse (`decideApplicability`) with data, including parent EP19's unrelated-change
reusable case (AR-4); a wiring decision for the rest of the T5 library (`createValidationEvidenceTools`,
RED→GREEN pairing, `validation-observation.ts` `assessObservationForAcceptance` /
`recordFaultInjection` / `recordFlakyIsolation`, `validation-policy.ts`); a prior-run digest at triage (snapshot plus `git log <revision>..HEAD`);
delta plan revisions; a diff-on-demand verdict pass; reviewer outcome tracking; affected-test
selection as more than information (F8); a real continuation test by a fresh Claude Code or Codex
session with no AIBoard access; token tuning per gate. After T8: the S3 backlog rows in section 4.

## 9. Durable state and resume

progress.md is STATE: one line per packet transition (assigned, in review, accepted with commit).
Evidence per packet in `evidence/<packet>.md`; review records `evidence/<packet>-review-r<N>.md`;
worker briefs in `C:\Users\b_a_s\AppData\Local\Temp\p6-6\` are working copies, and the packet
contract here is the authority. Resume: read progress.md, this plan's section for the next packet,
the packet evidence, then `git status` and `git log` of the lane worktree; reconcile before acting.

## 10. Launch cards

- **Controller:** owns progress.md, assignments, merges and acceptance. Next action: C1 repair
  cycle 1 (Muse), then C1 re-review r2; then C2.
- **Lane A worker card:** worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch
  `codex/runner-v2-p6-6`; packet contract = section 6 of this plan; shared rules = section 6
  preamble; evidence to `evidence/<packet>.md`; do not commit.
- **Lane B worker card:** worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-r`,
  branch `codex/runner-v2-p6-6-r`, base = lane A commit that accepted C5; packets R1→R3 in order;
  same rules.

## 11. Planning review and verdict

Review r1 (`evidence/AR-plan-review-r1.md`, fresh Opus 5.5): PLAN COVERAGE GAPS — 5 blocking,
15 minor. Dispositions: B-1 → CD-1, AR-R03, AR-R17, C2 step 1, T7a; B-2 → C2 steps 2-3, AR-R04;
B-3 → CD-9, AR-R08, C3 step 2 and tests; B-4 → CD-12, AR-R15, AR-R16, C5; B-5 → CD-10.
M-1 line references fixed (parent `:300`, `:64`, `:366`); M-2 Outcome/DoD for C4/C5 and CD-7
wording; M-3 C5 writable; M-4 `cancelled` stop kind and `export_only` in C3; M-5 CD-11 and the
shared event/reducer rule; M-6 AR-R05 and the capability revision-5 note; M-7 AR-R18 and the
parent header note; M-8 AR-R13 and the C4 derived-index test; M-9 AR-R23 and E5; M-10 lane B
write set, brief rule and merge re-run; M-11 W3 step and AR-R29; M-12 T7c/T7d; M-13 CD-5; M-14
section 4 F3 row and section 8; M-15 CD-8.

Review r2 (`evidence/AR-plan-review-r2.md`, fresh Opus 5.5, targeted): PLAN COVERAGE VERIFIED —
all 20 r1 findings resolved, no blocking finding, 7 minor. Dispositions: N-1 C1 Outcome owns
`verifyHandoffSnapshotDigest` and the digest rule; N-2 C2 step 2 snapshot-key trailer and a crash
test; N-3 CD-9, AR-R08, C3 step 2 use the triage decision `build` and name `clarify`; N-4 CD-12 and
AR-R16 give `validation` a reviewer consumer; N-5 capability note names CD-9 and marks `export_only`
owner-pending; N-6 lane B write set and phase C entry; N-7 CD-1 `lastSequence ≤ 3` and
`:3129-3138`, CD-11 tip gating, C3 skips C2's own failure pause. The C1 contract also records the
C1 repair-cycle-1 controller decisions (stop kinds incl. `in_progress`; what never truncates;
neutralizing rules).

PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION STARTED (owner "go"; C1 in repair cycle 1).
