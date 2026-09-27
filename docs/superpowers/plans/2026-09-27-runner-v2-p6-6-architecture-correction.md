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
  (plan `:297` "unrelated-change reuse") to exact-identity reuse. Semantic reuse
  (`decideApplicability`) moves to P7.
- **Workers.** Owner 2026-09-27: "start with muse, not mimo". Muse Code
  (`muse-spark-1.3-contributor`, `--reasoning-effort xhigh`) implements new packets.

### Controller decisions

- **CD-1 — Docs policy v2 scope.** v2 is stamped on runs stamped planning policy v1 (the new
  policy). Legacy-planning runs keep docs v1 exactly. T7a decides which production runs get
  the new policy (section 6).
- **CD-2 — Scope guard is a finding, secrets are refused.** EX-4 packet 2(a) refused out-of-scope
  paths. The parent non-goal (plan `:62`, "no rigid worker file whitelist") and the owner's
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
  opt-out; a per-run `export_only` option writes no handoff files (S2 §3.4, §12 risk 2).
- **CD-6 — One acceptance record.** `delivery.*` stays the only acceptance record. The eight
  unproduced T2 planning event types and T2 validation/acceptance projections are frozen as
  reserved (S2 A1, F4, §12 risk 9).
- **CD-7 — Production-path proof in every packet.** Every packet's Definition of Done includes
  at least one test built through `NativeBuildFactory` and driven by `BuildRuntime.step` on the
  real SQLite store (seeded policy is allowed before T7a). T7a adds the unseeded end-to-end test.
  "Library only" is never an accepted end state without a named wiring packet (S2 §7.5).
- **CD-8 — C1 starts with the planning review.** C1 is a new pure module with no dependents in
  flight. It starts while the independent planning review runs; a review change to C1 becomes a
  brief update, not a restart.

---

## 3. Requirement ledger

Each row has one owning packet. Acceptance evidence goes to `evidence/<packet>.md`.

| Id | Source | Required outcome | Owner | Acceptance evidence |
|---|---|---|---|---|
| AR-R01 | S2 §3.4, AR-1 | One pure, deterministic renderer produces the snapshot: header (run, revision, stop kind and reason, body digest), what was asked, requirement status table, open work, verification with real counts and exact commands, decisions, notes slot, next action; a plan view for plan-only; a task list when no ledger exists | C1 | Golden and determinism tests |
| AR-R02 | S2 §3.4, §12 r1 | The snapshot is bounded (at most 200 lines / 16 KiB), never truncates header or verification, and neutralizes untrusted text (markers, table breaks, control characters) | C1 | Size-cap and injection tests with fault injection |
| AR-R03 | S2 A16, F6, §11 compat | The reducer accepts docs policy v2 additively; new-policy runs are stamped v2; every v1 log replays unchanged; old code refuses v2 | C2 | Replay-compatibility with a v1 fixture log; stamp test |
| AR-R04 | S2 A4, A6, A7, §3.4, §9, AR-1 | At handoff and plan-only completion the runner commits STATE.md, the static v2 AGENTS.md section, the `@AGENTS.md` line in CLAUDE.md and (CD-5) the spec copy in one kernel commit with runner attribution and an `AIBoard-Generated: handoff-snapshot` trailer; no model call | C2 | Factory test inspecting the commit tree and the model-call record |
| AR-R05 | S2 A6, AR-1 | Under v2 the completion gate stays and only the kernel commit satisfies it; `complete_run` no longer needs a model-written STATE.md; a failed kernel commit pauses the run with a reason and retries on resume | C2 | Gate test plus prove-red |
| AR-R06 | S2 F6 | An answered v2 run writes no project file and needs none to complete | C2 | Answered-run factory test |
| AR-R07 | S2 §12 r3, CD-5 | A hand-edited previous snapshot is detected by its header digest, recorded, and named in the new snapshot; `export_only` and spec opt-out work | C2 | Tests per option and for the edited case |
| AR-R08 | AR-1 | At every stop other than handoff (any pause reason, terminal failure) the runner commits a fresh snapshot on the integration branch, idempotent per stop event, never blocking or changing the stop | C3 | Pause/resume factory tests with real git |
| AR-R09 | AR-1 | At a stop whose reason allows model calls, the runner asks the Architect once for short notes (bounded size and time, no tools, recorded as `handoff_notes` cost); otherwise, or on failure, the snapshot says why there are no notes; at handoff the `complete_run` summary is the notes | C3 | Scripted-Architect tests: notes present, disallowed reason, failure |
| AR-R10 | S2 §9 | Runner-authored integration commits of new-policy runs carry `AIBoard-Run`, `AIBoard-Task` and `AIBoard-Requirements` trailers | C3 | Git log assertion in a factory test |
| AR-R11 | S2 A5, §5 rows 1-2, F9 | The v2 Architect prompt has no docs templates, layout or per-turn STATE.md body; the existing snapshot is given once at triage/planning as labelled untrusted context (at most 4 KiB); v1 prompts are unchanged | C4 | Prompt tests; token count before/after |
| AR-R12 | S2 A11, A17 | Under v2, `write_project_doc` stays available but refuses kernel-owned paths and `docs/project/evidence/**`; its description states the anti-journaling rule | C4 | Tool refusal tests |
| AR-R13 | S2 A8, §5 row 3 | `record_planning_checkpoint` is removed from the new-policy tool surface and prompt; the resume index is derived from the durable read index and plan/review state; a new plan revision is the planning-turn proof after folded guidance; old logs with checkpoints replay | C4 | Tool-list, restart and replay tests |
| AR-R14 | S2 A1, F4, §5 row 11, CD-6 | Unproduced T2 planning event types and projections are marked reserved; a static test fails if a `src/` module starts appending them without updating the reserved list | C4 | Static guard test |
| AR-R15 | S2 A9, §5 rows 4-5, 7 | The kernel stamps plan envelope fields (run, manifest id and digest, policy version, times, review and lineage ids, expected digest); the model authors one side of each link and the kernel derives the other (both sides must agree when given); unused contract fields become optional in the validator, not removed from the type; stored revisions and digests stay valid | C5 | Planning-tool tests; stored-digest test |
| AR-R16 | S2 F2, §5 note | The worker's context and the deliverable reviewer's context contain the compact semantic contract (outcome, scope and exclusions, steps, writable surfaces and resource claims, forbidden surfaces, criteria, definition of done) within a recorded token cap | C5 | Factory test reading the real worker and reviewer context; prove-red |
| AR-R17 | S2 F1, S3 P0 | Production run creation stamps the new planning policy and registers the approved source; one unseeded factory test runs from production run creation to `delivery.review_started`, boundary and `task.acceptance_recorded` | T7a | Unseeded factory test |
| AR-R18 | S2 A13, §3.2 | T7 exports and views render through the C1 renderer; the parent T7 `docs/project/generated/` branch is replaced by the v2 snapshot; an explicit export into the repo happens only on request | T7d | Export parity test |
| AR-R19 | S3 N1, L4a | Test integrity: pinned test command and suite-shrink detection at the boundary unless tied to a plan revision reason | E1 | S3 packet 1 tests |
| AR-R20 | S3 L17, N2, N4, CD-2 | Submission scope findings (blocking, not refusal) and secret/key-file refusal; diary-looking new files flagged | E2 | One fixture per class plus a clean control |
| AR-R21 | S3 N5, N3, L3 | Every runtime of an attempt is an author; unreferenced new source files and test-only diffs raise the tier; one inspection call at every tier | E3 | S3 packet 3 tests |
| AR-R22 | S3 L6 | Encoding safety: BOM kept by `fs.patch`/`fs.write`; submission encoding findings | E4 | S3 packet 4 tests |
| AR-R23 | S3 L10, N3, S2 §7.4 | Mutation survivors on changed lines become blocking findings to disposition; a `verified` claim must cite a location or evidence the session actually read | E5 | Vacuous-test fixture; uncited-verified refusal |
| AR-R24 | S3 L13, L16, S2 §12 r6 | Command evidence records a working-tree fingerprint and a child-environment fingerprint; links taken before later edits are marked stale; PATH entries inside the runner's own install tree and `npm_*`/`INIT_CWD` are removed from project child environments | V1 | S3 L13/L16 tests |
| AR-R25 | AR-4, S2 §7.2 item 7, S3 L7, §12 r7 | Exact-identity reuse within a run (boundary, high-tier depth, final verification), recorded as `reused_from`; content-based evidence digests; the approach-decision "new evidence" rule uses content, tested both directions | V2 | Reuse and invalidation tests; both-direction approach tests |
| AR-R26 | S2 F5, S3 L4d, §12 r5 | Language-neutral execution profile: build/test commands and machine-readable reports for non-`package.json` projects (TRX, `ctest --output-junit`, `pytest --junitxml`, Maven/Gradle JUnit XML, cargo/go where a reader exists); `unknown` only when nothing applies | V3 | Fixture per family; unknown-language floor |
| AR-R27 | S2 A12, §7.2 items 1-3, S3 L7 | ReviewKey dedupe (same key: no new review, prior verdict returned, no cycle charged); interrupted review resumes at its first missing stage when the same runtime continues; a repair diff equal to or reversing a failed attempt's diff is a blocking finding | W1 | Dedupe, resume and oscillation tests |
| AR-R28 | S2 §7.2 item 5, §7.4, S3 L8 | Delta re-review input (fix delta, delta files no finding names, invalidated evidence, then prior findings); the late-finding rule in the reviewer contract | W2 | Delta-context and late-finding tests |
| AR-R29 | AR-3, S2 §5 rows 8-10, S3 L2 | Architect disposition: `review_task` verdicts prefilled from the reviewer and runner evidence; overrides need a reason, and `unverified`→`verified` needs evidence the Architect's session read; `decideUnverifiedClaim` labels each claim; runner evidence pre-linked to criteria; final-verification plans prefilled for detected categories | W3 | Disposition, override and label tests |
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
| F3 T5 unwired | V2 exact reuse, W3 `decideUnverifiedClaim`; deferred to P7: `decideApplicability`, `createValidationEvidenceTools`, RED→GREEN pairing (named in section 8) |
| F4 two acceptance models | C4 freeze (AR-R14, CD-6) |
| F5 `package.json` only | V3 (AR-R26) |
| F6 answered run writes docs | C2 (AR-R06) |
| F7 diff read three times | W2 delta, W3 no Architect diff read |
| F8 full script every boundary | V2 reuse cuts duplicate runs; affected-test selection stays informational; deferred to P7 with data |
| F9 document tip | C3 keeps the tip logic for kernel stop commits; v2 Architect doc writes become rare (AR-R08, R12) |
| §5 row 6 whole-plan re-emit | Deferred to P7 (delta plan revisions) |
| §5 rows 1-5, 7-11 | C2, C4, C5, W3 as in AR-R04, R11, R13, R15, R29, R14 |
| §5 writable surfaces and claims | Shown by C5 (AR-R16), compared by E2 (AR-R20) |
| §7.2 items 1-7 | W1 (1-3), kept (4), W2 (5), W3 (6), V2 (7) |
| §7.4 anti-rubber-stamp | E3 inspection floor, E5 cited reads and survivors; reviewer outcome tracking deferred to P7 |
| §7.4 anti-loop | W1 same key, W2 late-finding rule, CD-4 safe floor, budgets unchanged |
| §7.5 lessons | Small packets (this plan), CD-4, CD-7; the `.superpowers/` diary is an owner choice, no action |
| §8 L1-L18, N1-N5 | Placed by the packets above; backlog rows below |
| §9 AGENTS.md entry, `@AGENTS.md`, spec in repo, plan-only plan | C2 |
| §9 commit trailers | C3 (AR-R10) |
| §9 memory outside the repo | No action (project memory exists) |
| §11 compatibility notes | Constraints in C2, C4, C5 (never delete an event type; v1 replays; checkpoint event stays; fields optional; tip logic stays for v1) |
| §11 AC-25 revision note | AR-R32 |
| §12 risks 1-10 | 1 AR-1 notes + C4; 2 CD-5; 3 AR-R07 (T7c shows the notice); 4 CD-7; 5 V3; 6 V1/V2 constraints; 7 V2 tests; 8 CD-2; 9 CD-6; 10 T10 |

S3 items that S2 did not place, kept visible as **backlog after T8** (MEDIUM, one small packet
each, S3 table): L4(b) counts for `run_evidence_command`; L4(c) a `node --test` file with no test
counts as a pass; L9 durable-surface tier signal (its reviewer line goes to T10); L11 402 and
context-overflow classification; L14 `task_size` plan-risk reason; L15 tmpdir and scratch-file
signal.

---

## 5. Phases

| Phase | Packets | Purpose | Entry | Exit (all packets accepted plus) | Unlocks |
|---|---|---|---|---|---|
| C | C1-C5 | Correct the new-policy model while no production run uses it | Owner AR-1, AR-2 | A seeded new-policy factory run reaches handoff and writes only product files plus the kernel handoff files; v1 replay green | T7a; lane B |
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
`architect-tools.ts`, `native-build-factory.ts` — one writer at a time inside a lane; across
lanes, conflicts resolve at the lane B merge.

---

## 6. Packet contracts

Shared rules for every packet (from the parent plan §8 and this session's worker rules): work
only in the lane worktree; never commit, stage, stash or push; real SQLite, advancing clock,
real pump; processes only through the audited execution paths (no `child_process`); preserve
file encodings exactly (no BOM added or removed, no mojibake, no line-ending flips); nothing is
recorded as performed unless it was performed; prove-red records sha256 before and after with a
byte-exact restore; evidence file `evidence/<packet>.md` with sha256 of every changed file,
suites and counts, suites not run, and "not done / limits". Validation: the packet's tests,
importer suites of changed files, `runner-v2` tsc, eslint on changed files, `git diff --check`.
Forbidden unless the packet names them: `progress.md`, package files, UI/client (except T7b-T7d),
other packets' surfaces.

### C1 — Handoff snapshot renderer (AR-R01, AR-R02)

- **Outcome:** `renderHandoffSnapshot(input)` and `handoffSnapshotInputFromProjection(...)` in a new
  `runner-v2/src/handoff-snapshot.ts`. Pure: no I/O, no clock, no model. Wired by C2 (named
  wiring packet, CD-7).
- **Content (S2 §3.4 item 3):** header (generated by AIBoard, run id, described revision, stop kind
  `completed | plan_only | paused | failed | answered_export`, stop reason, the event time of the
  stop, body sha256); what was asked (source title, digest, spec path or copy path); requirement
  table (id, one-line outcome, status accepted / open / conditional pending / not applicable with
  its authorized reason); open work (unaccepted tasks, open blocking findings, external blockers
  with the owner action, exhausted repair issues, pause reason); verification (last final
  verification per category and the latest boundary per task with real counts and the exact
  build/test commands); decisions (`planningDecisions` plus acknowledged owner guidance, one line
  each); notes slot (Architect notes, or "No Architect notes for this stop: <reason>"); next action
  derived from state. Plan-only adds the plan view (phases, tasks with outcome, steps, criteria,
  dependencies). A run without a ledger renders a task list instead of the requirement table.
- **Bounds and safety:** at most 200 lines and 16 KiB; lists truncate with "N more — see AIBoard
  run <id>"; header, open blockers and verification never truncate. Untrusted text (source titles,
  requirement text, notes, summaries) is neutralized: `<!--` and `-->` escaped, `|` and newlines
  escaped in tables, control characters removed, each field capped.
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

- **Outcome:** v2 per S2 §3.4 items 1-4 and AR-1 for new-policy runs; v1 untouched.
- **Steps:** reducer accepts `project_docs.policy_configured` version 2 (`scheduler-store.ts:2865-2867,
  5256-5265`); stamp v2 where runs are stamped (`build-runtime.ts:595, 1885-1896`) when the run is
  stamped planning policy v1 (CD-1); under v2 skip `projectDocumentationReadiness` in
  `complete_run` readiness (`scheduler-store.ts:1987, 2009, 2033, 2200, 2220-2245`) and add the v2
  gate: after `project.handoff_requested` (and at plan-only completion) the runner renders C1 and
  commits the handoff files through the integration-manager commit path
  (`integration-manager.ts:609-686`) with runner attribution and the trailer; the owner's
  handoff choice (`apply_to_project` / `keep_integration_branch`) and `run.completed` are refused
  until that commit is recorded for the handed-off revision; a failed commit pauses with
  `handoff_snapshot_failed` and retries on resume; AGENTS.md v2 static section via
  `spliceMarkedArchitectSection` (`project-docs.ts:185-199`) with the S2 §3.4 item 1 text; the
  CLAUDE.md marked line becomes `@AGENTS.md`; spec copy `docs/project/specs/<source-id>.md` only
  when the approved source is not already a repository file and the run did not opt out; per-run
  options `specCopy` (default true) and `handoffFiles: "commit" | "export_only"` (default
  "commit") recorded in the run policy; answered v2 runs have no docs requirement and write
  nothing; hand-edit detection by the header digest (AR-R07).
- **Writable:** `project-docs.ts`, `scheduler-store.ts`, `build-runtime.ts`,
  `integration-manager.ts` (commit call only), `native-build-factory.ts` (wiring), run-policy
  types, `handoff-snapshot.ts` (adapter fixes only), tests, `evidence/C2.md`.
  **Forbidden:** prompts and tool surface (C4), planning tools (C4/C5), UI.
- **Tests:** v2 factory run to handoff: one kernel commit with exactly the expected files, no model
  call for it; completion refused before the commit; commit failure pauses and resume retries;
  plan-only v2 snapshot holds the plan; answered v2 run writes nothing; `export_only`; spec
  opt-out; spec already in repo; hand-edited snapshot detected and named; v1 fixture log replays
  unchanged; legacy-planning runs still stamped v1.
- **Red proof:** disable the v2 gate; completion without the kernel commit succeeds and the gate
  test goes red; restore.
- **DoD:** tests green; replay-compatibility suite green; no `docs/project/evidence` or `plans`
  written under v2.

### C3 — Snapshot at every stop, Architect stop notes, commit trailers (AR-R08 to AR-R10)

- **Outcome:** AR-1's "when the build stops for whatever reason" part.
- **Steps:** list every transition into `paused` (`scheduler-store.ts` sites `:3120, 3788, 4061,
  4148, 4929, 5000, 5176` at `764fdffb`) and every terminal failure; classify each stop reason as
  notes-allowed (for example repair limit, external blocker, owner pause, failed final
  verification) or notes-denied (budget window exhausted, provider/credit failure, cancel,
  unknown reasons by default); record the table in the evidence. Bounded investigation: find the
  existing one-shot Architect model-call path (how the runtime calls a single model pass outside
  the Architect loop, for example the plan critic or verifier paths); use it with a fixed short
  prompt ("notes for the next tool: what matters, traps, what to try next"), no tools, at most
  2,000 characters and a time bound; record the cost as purpose `handoff_notes` (EP40); store the
  text as a new event `handoff.notes_recorded` (Architect actor, idempotency key from the stop
  event's sequence). After notes (or their denial or failure) render C1 and commit STATE.md (plus
  the entry lines when missing) on the integration branch when the run has an integration branch;
  the commit must never block or change the stop; a failure records a finding. On resume nothing
  special happens; the next stop writes a new snapshot. Keep the document-tip logic
  (`scheduler-store.ts:2211-2218, 4404-4407`) working for these kernel commits; prove that final
  verification and integration still target the right revisions. Add the three trailers where the
  runner authors integration commits for new-policy runs (if integration fast-forwards worker
  commits, add them where the runner creates the task commit; record which).
- **Writable:** `build-runtime.ts`, `scheduler-store.ts`, `integration-manager.ts`,
  `native-build-factory.ts`, the chosen one-shot call module (call site only), tests,
  `evidence/C3.md`. **Forbidden:** C4/C5 surfaces, UI.
- **Tests:** repair-limit pause writes a snapshot with open work and scripted-Architect notes;
  budget-exhaustion pause writes a snapshot with the "no notes" line and makes no model call; a
  notes failure still writes the snapshot; replaying the log or resuming twice creates no
  duplicate commit; pause → snapshot → resume → task integrates → final verification passes on
  the right revision → handoff snapshot; trailers in `git log`; legacy runs unchanged.
- **Red proof:** remove the notes-denied check; the budget-exhaustion test sees a model call and
  goes red; restore.
- **DoD:** tests green; stop table in the evidence; no stop blocked by a snapshot failure.

### C4 — Architect bookkeeping cut (AR-R11 to AR-R14)

- **Steps:** under v2, drop the docs section (`agent-prompts.ts:59-72, 552-553, 902, 931-934`) and
  add one line about `write_project_doc`; give the existing snapshot (at most 4 KiB, labelled
  untrusted, from the base revision) at triage and planning turns only; `write_project_doc`
  (`architect-tools.ts:390`, `build-runtime.ts:3671`) under v2 refuses `docs/project/STATE.md`, spec
  copies, the marked sections and `docs/project/evidence/**`; remove `record_planning_checkpoint`
  from the new-policy tool list and prompt (`planning-tools.ts:412-522`, `agent-prompts.ts:82`);
  derive the resume index from the read index and plan/review state
  (`planning-projection.ts:746-774`) and make the inventory listing read it; for new runs accept a
  new plan revision as the planning-turn proof (`scheduler-store.ts:1200-1207`) while old logs with
  checkpoint proofs still replay; mark the reserved T2 types (`scheduler-store.ts:1053-1060`) and
  add the static guard test.
- **Writable:** `agent-prompts.ts`, `architect-tools.ts`, `planning-tools.ts`,
  `planning-projection.ts`, `scheduler-store.ts` (planning-turn proof, reserved marks),
  `build-runtime.ts` (tool registration), tests, `evidence/C4.md`. **Forbidden:** C2/C3 logic,
  contract validator (C5), UI.
- **Tests:** v2 prompt has no docs section and v1 prompt is byte-identical; per-role token counts
  before and after in the evidence; tool list without the checkpoint tool; restart mid-planning
  resumes from the read index (real SQLite); old checkpoint log replays; refusals per path; static
  reserved-type guard.
- **Red proof:** re-add the checkpoint tool to the list; the tool-list test goes red; restore.

### C5 — Contract envelope and contract delivery (AR-R15, AR-R16)

- **Steps:** kernel stamps the envelope fields (`planning-contracts.ts:938-959`,
  `planning-tools.ts:616-625`); derive mirrored links (`planning-contracts.ts:867-904, 916-927,
  654-655`); make unused fields optional in the validator only (`planning-contracts.ts:627-666,
  668-804`); render a compact semantic contract into the worker context (`scheduler-store.ts:1417-1430`,
  `native-worker-driver.ts:531-541`) and the deliverable-review context
  (`native-deliverable-review.ts:492-500`) within a token cap recorded under EP40; update T3a/T3b
  fixtures and the coverage reviewer input (the new policy is unshipped, so fixture updates follow
  the T9 precedent, `progress.md`).
- **Writable:** `planning-contracts.ts`, `planning-tools.ts`, `scheduler-store.ts` (task bridge),
  `native-worker-driver.ts`, `native-deliverable-review.ts`, worker context modules, T3a/T3b/T6a
  tests and fixtures, `evidence/C5.md`. **Forbidden:** prompts beyond the contract block, UI.
- **Tests:** a revision without envelope fields is accepted and stamped; one-sided links derive;
  mismatching sides refused; a stored old revision's digest still validates; factory test reads
  steps, scope, writable surfaces and definition of done in the real worker context and scope in
  the reviewer context; token cap.
- **Red proof:** drop the contract block from the worker context; the factory test goes red.

### T7a-T7d — parent T7 split (AR-R17, AR-R18)

The parent T7 contract (plan §5 T7) stays binding. Its items split as follows; each packet gets
a full brief at its start from the parent text plus these lines.

- **T7a Production enablement:** production run creation stamps planning policy v1 and docs v2,
  and registers the approved source through the real provisioning path; bounded investigation with
  an owner confirmation if it changes the default for every new run: which production entries
  create new-policy runs; the unseeded end-to-end factory test (AR-R17).
- **T7b APIs and client:** authenticated, idempotent source, plan-readiness and explicit-start
  controls; stale reconnect cannot start an old plan; on-demand export API through C1.
- **T7c UI:** planning-ready vs delivery-complete, requirements and blockers, answered-run view and
  answer-review opt-in, per-pass purpose and token cost, review independence and ladder rungs,
  docs v2 run options (CD-5), the hand-edited-snapshot notice.
- **T7d Exports, cards and user docs:** section-10 exports and copy-ready cards through C1
  (AR-R18); `docs/runner-v2/evidence-gated-planning.md` user docs.

### R1 — E1-E5 (lane B)

E1-E4 follow S3 "Recommended packets" 1-4 exactly, with CD-2 applied to E2(a): every scope item is
a blocking finding, never a refusal; secrets and key files are refused with the reason redacted.
E2 also flags new files that look like harness diary (progress, evidence, review or test-output
records) as blocking findings (S2 A11). **E5:** S3 L10 (survivors on changed lines are blocking
findings with a required disposition) and S3 N3 backlog (a `verified` claim must cite a location
or evidence id the reviewing session actually read, checked against the tool ledger). Tests: as
listed in S3 for each packet; E5 vacuous-test fixture and uncited-verified refusal.

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
- **W3:** AR-3 disposition per S2 §7.2 item 6 and §5 rows 8-10; wire `decideUnverifiedClaim`
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

P7: semantic reuse (`decideApplicability`) with data; `createValidationEvidenceTools` and RED→GREEN
pairing wiring decision; a prior-run digest at triage (snapshot plus `git log <revision>..HEAD`);
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

- **Controller:** owns progress.md, assignments, merges and acceptance. Next action: planning
  review of this plan (CD-8: C1 runs alongside).
- **Lane A worker card:** worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch
  `codex/runner-v2-p6-6`; packet contract = section 6 of this plan; shared rules = section 6
  preamble; evidence to `evidence/<packet>.md`; do not commit.
- **Lane B worker card:** worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-r`,
  branch `codex/runner-v2-p6-6-r`, base = lane A commit that accepted C5; packets R1→R3 in order;
  same rules.

## 11. Verdict

PLAN BLOCKED — independent planning coverage review of this amendment pending; owner: controller;
unblock action: run the fresh-context review against S2, S3 and S4 and fix its findings.
