# Runner V2 architecture investigation — durable truth, model labor, review economics

Date: 2026-09-27. Investigator: fresh-context Opus 5.5 (read-only).
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch `codex/runner-v2-p6-6`, HEAD `764fdffb`.
Paths are relative to `runner-v2/src/` unless they start with `docs/`, `.superpowers/` or `test/`.
No source, test, plan or progress file was changed. No test was run. Every code claim below comes from reading the code at HEAD.

Inputs read in full: the external audit; the P6.6 plan (all 488 lines); the owner amendment (OA-1..OA-18);
the agent-capability design (D6 revision 4, D8); `progress.md`; `session-lessons-audit-list.md` (L1–L18);
`evidence/EX4-lessons-audit.md` (delivered by the controller during this work, used in section 8);
T5/T6a/T6b evidence and review rounds (skimmed for scope and outcome).

This is not an implementation plan. Section 10 only sizes and orders the work.

---

## 1. Executive summary

- The audit is mostly right about the **direction**. Its thesis holds: models should decide meaning, and the kernel should record what happened.
- The audit is wrong or outdated on some **facts**. T6a/T6b already make the runner run the acceptance tests itself, with real counts. The model does not author branches, claims or environment fingerprints today.
- The audit's "zero files in the repo" goal conflicts with a real owner need: another tool must be able to continue the project. That need is valid. It does not need a model-written diary.
- My recommendation: **thin semantic plan, thick kernel, one generated handoff.** The kernel writes one short snapshot file at handoff, from its own records. The model never writes status or evidence files. The completion check stays, but the kernel satisfies it, so it cannot be forgotten.
- The investigation found larger problems than the audit did:
  1. **The new-policy flow is not reachable in production** (EX4 P0, verified). Nothing in `src/` emits `planning.policy_configured` or `planning.source_registered`. T7 turns it on.
  2. **Workers never see most of the task contract.** The Architect writes steps, scope, writable files and a definition of done. The worker receives only the one-line outcome, the dependencies and the criteria.
  3. **T5's evidence-reuse library is not wired** (EX4, verified). No evidence is ever reused. The full test script runs after every integrated task and again at the end.
  4. **The runner's automatic test evidence only works for `package.json` projects.** A C#, C++, Go, Rust, Java or Python project gets `unknown` at the boundary check, which can never pass. T8's non-JS fixtures will hit this.
  5. **Reviews re-read the whole diff three times** per review, and a fix round re-reads it again. There is no "same input, no new review" rule, although the owner already requires one (OA-6).
- Because of finding 1, **now is the cheapest moment to change the new-policy model.** No production run uses it yet. After T7, every change needs a new policy version and replay support.
- I recommend four small packets **before T7** (handoff renderer, docs policy v2, drop planning checkpoints, contract envelope + contract delivery to workers). EX4's four safety packets and four evidence/review packets go **before T8**. Prompt text goes to T10. Measurement-driven tuning goes to P7.
- The owner has four decisions to make (section 9). The biggest one reverses part of capability decision D6, so it needs the owner's explicit word.

---

## 2. Verified-claims table (audit → HEAD `764fdffb`)

Verdicts: **true**, **partly true**, **false**, **outdated**.

| # | Audit claim | Verdict | Evidence (file:line) |
|---|---|---|---|
| A1 | `planning-projection.ts` holds canonical state for source manifests, ledger, plan revisions, read index, assignments, validations, acceptances, coverage reviews and a derived resume index | **partly true** | The shapes exist (`planning-projection.ts:358-418`). Assignments are live (`task-scheduler.ts:755`). But eight planning event types have **no producer anywhere in `src/`**: validation intent/observed/interrupted/reconciled, recovery_reconciled, reference_recorded, acceptance_recorded/reopened (`scheduler-store.ts:1053-1060`; grep finds no append site). Live acceptance runs through `task.acceptance_recorded` / `phase.acceptance_recorded`, appended by the runner (`build-runtime.ts:2424, 2543`). So validations/acceptances in the planning projection are a second, dead model. |
| A2 | `planning-tools.ts` writes planning facts as scheduler events | **true** | Reads `planning-tools.ts:281-294`, ledger `:391-407`, checkpoint `:506-519`, draft `:585-598`, revise `:686-701`. |
| A3 | Evidence lives in SQLite outside the target project | **true** | Stores are under the runner state directory (`native-build-factory.ts:367-414`). |
| A4 | `project-docs.ts` defines README, STATE, specs/, plans/, decisions.md, evidence/ | **true** | `project-docs.ts:16-23`. The AGENTS.md section check requires **every** layout line, including `evidence/ — proof that work was verified` (`project-docs.ts:202-214`). The update sentence tells every agent to keep specs, plans and decisions current and update STATE.md last (`:28-29`). |
| A5 | `agent-prompts.ts` always tells the Architect to maintain these, and to write STATE.md last | **true** | Text at `agent-prompts.ts:59-72`. The section is `required` on **every** Architect turn, whatever the policy, triage or run type (`:552-553`). Measured: 2,211 characters (about 550 tokens), plus the committed STATE.md text up to 4 KiB (`:902, 931-934`). |
| A6 | `scheduler-store.ts` refuses completion when STATE.md was not committed after the latest integrated change | **true** | `projectDocumentationReadiness` (`scheduler-store.ts:2220-2245`), called for plan-only (`:1987`), answered (`:2009`), and normal runs (`:2033, 2200`). Every new run is stamped docs policy v1 unconditionally (`build-runtime.ts:595, 1885-1896`). It applies even to a pure question (`scheduler-store.ts:1125-1129`). |
| A7 | This creates a second mandatory state representation beside the event store | **true** | D6 itself says the database is the truth for gates and a document approves nothing (capability design `docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md:233-235`), yet STATE.md is mandatory (AC-25, `:320`). |
| A8 | `record_planning_checkpoint` is model labor; the projection already knows covered sections, next section, etc. | **true, with one caveat** | Readiness uses the durable read index, not checkpoints (`planning-projection.ts:960-966`; `build-runtime.ts:2755-2757`). The read tool already records every full read durably (`planning-tools.ts:268-294`). Checkpoints feed only the resume index (`planning-projection.ts:746-774`), which only the inventory listing reads (`planning-tools.ts:204-208`). Worse, that resume index takes "covered" from the model's checkpoints, not from the real read index — a weaker source. Caveat: a checkpoint is one of three accepted "planning turn" proofs after folded user guidance (`scheduler-store.ts:1200-1207`); a new plan revision already serves the same purpose (carry-forward N-E, `progress.md:10`). |
| A9 | The task contract is huge; split it into an AI-authored semantic plan and a kernel-owned envelope (branch, base, worktree, claims, fingerprints) | **partly true** | Size: 22 top-level fields, 20 required non-empty (`planning-contracts.ts:627-666, 668-804`). But branch, worktree, claim generation and write-claim resolution are **already kernel-owned** (`task-scheduler.ts:707-760`). The model does author mechanical fields: `requiredBase` (used only as a last fallback, `task-scheduler.ts:733-738`), the revision's `runId`, manifest id and digest, policy version and timestamps (`planning-contracts.ts:938-959`), and **both sides** of every requirement↔task↔phase link, which the kernel then cross-checks (`:867-904`). The bigger problem, which the audit missed, is in finding F2 below. |
| A10 | Evidence should be produced automatically by the runner | **partly outdated** | Already automatic for acceptance: the boundary check runs build + the full test script on a clean checkout of the integrated revision (`delivery-execution.ts:872-947`); high-tier review runs tests + the mutation probe (`:698-760`); "tests passed" needs this run's own report with ≥1 executed and 0 failed (`delivery-acceptance.ts:77-124`). Still model-driven: which commands a worker runs and how it links them to criteria (`worker-lifecycle-tools.ts:77-81`), and the Architect's per-criterion verdicts (`architect-tools.ts:2150-2185`). T5's `ValidationObservation` pipeline is not wired (F3). And the automatic path only understands `package.json` (F5). |
| A11 | Add a mechanically enforced anti-journaling policy (administrative artifact budget 0) | **not present; hard form conflicts with an owner position** | No such mechanism exists. Only `docs/project/**` is protected, at integration (`integration-manager.ts:495-504, 1996-2000`). A hard path fence conflicts with the approved non-goal "no rigid worker file whitelist" (plan `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md:62`). The largest diary source is the harness itself (D6); removing that needs no fence. |
| A12 | Same source + same diff + same evidence = no new review; fix re-review gets finding IDs and the delta | **partly true** | Exists: a re-review records its own findings first, then receives prior findings and checks each ID (`native-deliverable-review.ts:552-562`). Missing: dedupe beyond "same attempt and same change set" (`scheduler-store.ts:6352-6358`); an interrupted review restarts **all** passes (`:6373-6380`); the fix re-review gets the **full** cumulative diff, not the delta (`native-deliverable-review.ts:509-514`). The owner already requires this: "No reviewer re-reads input that has not changed since its last accepted review" (OA-6, amendment `:211-213`; EP40, plan `:385`). |
| A13 | Generated PLAN/STATE views should live outside Git by default | **outdated as a criticism of T7** | T7 already says generated views are served on request; only an explicit export goes into the repo, under `docs/project/generated/` (plan `:281-284`). The in-Git problem is D6's model-written STATE.md, not T7. |
| A14 | The P6.6 folder has 46 files / ~950 KB, 38 of them review files; T5 had 12 rounds | **outdated numbers, true pattern** | Before EX4 and this report, `evidence/` held 57 files, 47 of them reviews (~770 KB of review text). Rounds: T5 12, T6a 8, T6b 5. See section 7.5. |
| A15 | Amend P6.6 before T6/T7/T8 | **outdated** | T6a (`7d21be0b`) and T6b (`764fdffb`) are committed. Because of P0 (F1), "before T7" is the right cut. |
| A16 | Keep v1 docs policy for legacy runs; add v2 | **true and feasible** | The reducer accepts only version 1 today (`scheduler-store.ts:2865-2867, 5256-5265`). A v2 value is additive, and old code refuses it — the desired behavior. |
| A17 | Expose `write_project_doc` only when an authorized documentation output exists | **true that it is always exposed; the fix is too strict** | Always on the Architect surface (`build-runtime.ts:3671`; `architect-tools.ts:390`). I recommend keeping it optional rather than removing it (owner: no unnecessary limits). |
| A18 | Zero execution-state files in the target repo by default | **conflicts with an owner requirement** | Owner D6 (capability design `:207-210`, `:236-240`): another harness must find spec, plan, decisions and state. "Zero" fails that. "One generated snapshot" meets it (section 4). |

### Findings the audit missed (all verified)

| # | Finding | Evidence |
|---|---|---|
| F1 | **P0 (EX4): the new-policy flow does not run in production.** No `src/` code appends `planning.policy_configured` or `planning.source_registered`; only tests do (12 test files mention the policy event). | Reducer only: `scheduler-store.ts:3073-3106`; `planning-projection.ts:1404-1406`. Consequence: T3–T6b run only on test-seeded runs. New-policy shapes can still change without breaking any production log. |
| F2 | **The worker never sees the contract's steps, scope, writable/forbidden files, inputs/outputs, definition of done or validation rationale.** The ready contract becomes a `BuildTask` with only `outcome.user`, `dependencies` and `acceptance.criteria`. The worker context is that `BuildTask`. The deliverable reviewer sees the objective and criteria only. | `scheduler-store.ts:1417-1430`; `native-worker-driver.ts:531-541`; `native-deliverable-review.ts:492-500`. Fields with no consumer except the coverage reviewer: `outcome.system`, `scope`, `inputs`, `outputs`, `steps`, `definitionOfDone`, `validation`, `negativeProofApplicability`, `reviewCriteria`, `integrationChecks`, `cleanup`, `lineage`, `requirementCriteriaMap` (grep of `src/`). `forbiddenSurfaces` is stored and never read (EX4 L17). |
| F3 | **T5's observation/applicability/policy modules are library-only** (EX4 L3, confirmed). | No importer in `src/` of `validation-observation.ts`, `evidence-applicability.ts`, `validation-policy.ts`; `createValidationEvidenceTools` (`evidence-tools.ts:51`) is never registered. |
| F4 | **Two acceptance/validation models coexist in the schema.** The T2 planning ones (A1) are dead; the T6a `delivery.*` ones are live. | `scheduler-store.ts:1053-1060` vs `delivery-acceptance.ts:276-287`. |
| F5 | **The automatic test path is `package.json`-only.** The execution profile detects build/test commands only from `package.json` scripts; the report planner refuses a project without one. The boundary passes only if every check is `passed`, and `unknown` cannot be waived. | `final-verification-profile.ts:215-244`; `delivery-execution.ts:236-241`; `build-runtime.ts:2509`; `delivery-acceptance.ts:98-103`; EX4 L4(d). So a new-policy run on a C#/CMake/Go/Rust/Java/Python project cannot complete, and T8's required non-JS fixtures (plan `:300`) will fail. |
| F6 | **An answered question must write STATE.md, README, the AGENTS.md section and the CLAUDE.md pointer**, although an answered run must change nothing in the project (EP39, plan `:384`). If the owner then chooses `apply_to_project`, those files land in the project. | `scheduler-store.ts:1125-1129, 2007-2010`; handoff allowed for answered runs `:4973-5002`. |
| F7 | **Each review reads the full diff at least three times**: findings pass, verdict pass, then the Architect's `review_task`. | `native-deliverable-review.ts:509-514` (diff added before the `findings` early return at `:535`, so both passes get it); Architect told to read it: `agent-prompts.ts:593-597`. |
| F8 | **Boundary and high-tier depth always run the whole test script**; the affected-test selection is informational. | `delivery-acceptance.ts:126-149`; `build-runtime.ts:2503-2509`. T5 review rounds r6–r12 were mostly about Gradle/Kotlin parsing in `affected-tests.ts` (their "Scope" sections), whose output production only records. |
| F9 | **D6 commits documents on the integration branch mid-run**, which forced a "document tip" concept into integration and final verification. | `build-runtime.ts:1101-1116`; `scheduler-store.ts:2211-2218, 4404-4407`. |

---

## 3. What "done" and "truth" should mean — durable truth (question 2)

### 3.1 One canonical state

The canonical state is the **kernel's stores, outside the repository**:

- the scheduler event log (SQLite, append-only, replayed into the projection) — source manifest, read index, ledger, plan revisions, coverage reviews, readiness, claims, delivery reviews, boundaries, acceptances, repair issues, triage, answer, final verification, handoff;
- the evidence store (runner-run commands, test reports, counts);
- the artifact store (source bytes, diffs, reports);
- the agent-session store and context manifests;
- project memory (per project, across runs: learnings, defect classes, model outcomes).

Nothing else is authoritative. A file in the repo never approves, never blocks and never replays.

### 3.2 Derived views (disposable, regenerated on demand)

Architect planning status (already derived, `agent-prompts.ts:731-900`); UI and API views (T7); PLAN/STATE/JSON exports and launch cards (T7); the audit bundle; the **handoff snapshot** (below). All are pure renderings of the canonical state. Delete one and nothing is lost.

### 3.3 What may exist in the target repository

| Class | Examples | In the repo? | Who writes it |
|---|---|---|---|
| (a) Product deliverables | code, tests, config, build files | Yes | Workers, through tasks, reviewed |
| (b) Source- or user-required documentation | a README section, an ADR, API docs the spec asks for; docs the repo's own rules require (e.g. a CHANGELOG entry) | Yes, when required | Workers, as normal tasks mapped to requirements, reviewed like code |
| (c) Cross-harness continuity | one generated snapshot; a static entry point in `AGENTS.md`; one line in `CLAUDE.md`; optionally a verbatim copy of the approved spec | Yes, small and generated | **The kernel**, at handoff |
| (d) Harness diary | evidence logs, test output, review files, task reports, planning checkpoints, lane journals, plans of finished work | **Never** | Stays in AIBoard; exportable on demand |

### 3.4 The minimal form of (c)

**What must another harness find?** Five things: how to work in this repo; what was asked; what is done and what is open; how it was verified; why key choices were made. Nothing else.

**The continuity bundle (all generated, no model journaling):**

1. **`AGENTS.md` marked section (static text, kernel-written, ~5 lines).** It says: this project was built with AIBoard; read `docs/project/STATE.md` first; it is a snapshot of revision `<sha>`; changes after that are in `git log`; you do not need to keep a journal; if you finish an item listed under "Open work", you may tick it in the same commit. AGENTS.md is the cross-tool standard (Codex, Cursor, Jules, Amp and others).
2. **`CLAUDE.md` marked line.** Use the documented import form `@AGENTS.md`, so Claude Code loads the rules itself. (Recent Claude Code releases reportedly also read AGENTS.md when there is no CLAUDE.md; reports disagree, so keep the line. Verify at T10.)
3. **`docs/project/STATE.md` — the handoff snapshot, rendered from the projection.** Target ≤ 200 lines. Contents:
   - header: generated by AIBoard, run id, date, the exact revision it describes, run outcome (completed / plan-only / paused / failed);
   - what was asked: source title, digest, and where the spec is (its repo path, or the copy in item 4);
   - requirement table: id, one-line outcome, status (accepted / open / conditional pending / not applicable with its authorized reason);
   - open work: unaccepted tasks, open blocking findings, external blockers with the required owner action, exhausted repair issues;
   - verification: last final-verification result per category with real counts (for example "tests: 142 run, 0 failed at `<sha>`") and the exact build/test commands used — the most useful facts for another tool;
   - decisions: the plan's `planningDecisions` and the owner's acknowledged guidance, one line each — already written during planning, no new model labor;
   - the Architect's handoff summary — already required by `complete_run` and stored on the handoff (`architect-tools.ts:2362-2401`; `scheduler-store.ts:4995-4997`);
   - next action, derived from state.
   For a **plan-only** run the plan is the product, so the snapshot also renders the ready plan (phases, tasks with outcome, steps and criteria, dependencies). For an **answered** run nothing is written; the answer stays in AIBoard.
4. **Optional verbatim spec copy** `docs/project/specs/<source-id>.md`, only when the approved source is not already a file in the repo. Default on, with a per-run opt-out for private specs (owner decision OD-1).

**Who writes it:** the runner, through the existing integration-manager commit path (`integration-manager.ts:609-686`), with runner attribution and an `AIBoard-Generated: handoff-snapshot` trailer. No model call. The existing marker splice (`project-docs.ts:185-199`) is reused for AGENTS.md and CLAUDE.md.

**When:** once, at handoff — after `complete_run` records the summary and before the owner chooses `apply_to_project` or `keep_integration_branch`; and at plan-only completion. Never mid-run, so the document-tip coupling (F9) is not needed for v2 runs. The same renderer serves an **on-demand export** (T7 API/UI/CLI) for any run state, including paused or failed runs, without committing.

**How stale may it be:** it is exact for the revision it names, and allowed to go stale after that. It says so in its header. The next AIBoard run on the same project reads it as untrusted context at triage, together with `git log <revision>..HEAD`, and regenerates it at its own handoff. Git history is the journal between runs; no tool has to maintain one.

**Committed, exported, or both:** **both.** Committed at handoff by default, because that is the owner's requirement; exported on demand for everything else. A per-project opt-out gives the audit's "zero files" behavior to users who want it.

**How this answers the owner's worry.** D6 rejected "runner-generated exports as the only documentation" because "an Architect that forgets to document is exactly what P6.6 exists to prevent" (capability design `:248-251`). A generated snapshot cannot forget: the kernel renders it from the complete record. The hard completion check stays; only the actor changes, from the model to the kernel. It also cannot state a false status, which a model-written STATE.md can.

---

## 4. Recommended target architecture

### 4.1 Principle

**Thin semantic plan, thick kernel, one generated handoff.**
Models decide what the work means. The kernel stamps identities, runs checks, records evidence, decides admission and acceptance, and renders every view. The repository holds the product, the documentation the product needs, and one generated snapshot for the next tool.

### 4.2 Diagram

```
 APPROVED SOURCE (immutable artifact) ──┐     USER GUIDANCE / OWNER DECISIONS (events)
                                        ▼                         │
 ┌──────────────── AIBoard KERNEL — canonical state, outside the repository ───────────────┐
 │ scheduler event log (SQLite, append-only, replayed)                                     │
 │   planning: manifest · read index · ledger · plan revisions · coverage reviews · ready  │
 │   delivery: claims · reviews (ReviewKey) · boundaries · acceptances · repair issues     │
 │   run: triage · answer · final verification · handoff summary                           │
 │ evidence store: runner-run commands, test reports, counts, tree fingerprints            │
 │ artifact store · session store · context manifests · project memory (cross-run)         │
 └────────▲───────────────────────────────────────────────────────────────┬────────────────┘
          │ semantic decisions only (tools append events;                 │ pure renderers
          │ the kernel validates, stamps, executes, records)              ▼
 ┌────────┴───────────────────────┐          ┌──────────────────────────────────────────────┐
 │ Architect: triage, ledger,     │          │ VIEWS: Architect status · UI/API · PLAN/STATE│
 │   tasks, dispositions, repair  │          │ export · launch cards · audit bundle ·       │
 │   approach, handoff summary    │          │ HANDOFF SNAPSHOT                             │
 │ Workers: code + chosen checks  │          └───────────────────────┬──────────────────────┘
 │ Reviewers (fresh context):     │                                  │ once, at handoff /
 │   coverage, deliverable,       │                                  │ plan-only completion
 │   verifier                     │                                  ▼
 └────────────────────────────────┘   TARGET REPOSITORY
                                       product code, tests, config
                                       source/user-required docs (written by tasks, reviewed)
                                       AGENTS.md marked section (static) · CLAUDE.md "@AGENTS.md"
                                       docs/project/STATE.md (generated snapshot of revision X)
                                       docs/project/specs/<source>.md (verbatim copy, opt-out)
                                       NOT: evidence · reviews · task reports · checkpoints ·
                                            logs · plans of finished work
```

### 4.3 Who authors what

**The model authors meaning:** triage; the requirement ledger's semantics (purpose, observable outcome, obligation kind, applicability, acceptance conditions); the task decomposition (outcome, scope, steps, criteria, dependencies, expected writable files and shared resources, investigations); review findings and claim verdicts (independent reviewers); dispositions of findings; repair approach decisions; recheck-or-repair on a failed boundary; external blockers; not-applicable proposals (owner-authorized); final-verification applicability for categories the runner could not detect; the handoff summary; memory promotion.

**The kernel authors mechanics:** all identities and envelopes (run, manifest ids and digests, policy version, timestamps, base revision, branch/worktree, claims and generations, digests); the reverse side of every link (requirement→tasks, phase→tasks, phase→requirements); read coverage and resume position; evidence (runner-run checks, real counts, tree fingerprints); reuse decisions based on exact identity; acceptance records; repair charging; cleanup; every document and export.

---

## 5. Model labor vs kernel labor (question 3)

Token figures are estimates (about 4 characters per token) unless marked measured.

| # | Bookkeeping the model does today | Where | Kernel could… | Cost today | Reliability today |
|---|---|---|---|---|---|
| 1 | Write and keep `docs/project/STATE.md`, README, the AGENTS.md section and the CLAUDE.md pointer | `agent-prompts.ts:59-72`; gate `scheduler-store.ts:2220-2245` | render at handoff (section 3.4) | Measured ~550 tokens of instructions + up to ~1,000 tokens of STATE text on **every** Architect turn (`agent-prompts.ts:552-553, 902`); each write re-emits the whole file (`project-docs.ts` replaces whole files) and costs a turn; four writes even for a pure question (F6) | Forgetting blocks completion (extra loop); a model-written status can be false; mid-run doc commits add the document-tip coupling (F9) |
| 2 | Copy template text (AGENTS body, CLAUDE line, README) into tool calls | `agent-prompts.ts:64-71` | write the templates itself | ~300-600 output tokens per run | Template drift fails the exact-statement check (`project-docs.ts:202-214`) |
| 3 | `record_planning_checkpoint` (covered sections, finished contracts, remaining work, next action) | `planning-tools.ts:412-522`; prompt `agent-prompts.ts:82` | derive from the read index and plan/review state | a tool turn per checkpoint | Monotonic-checkpoint rules already produced a bug (N6, `progress.md:12`); resume "covered" is taken from the model, not from real reads (`planning-projection.ts:746-774`) |
| 4 | Plan envelope: `runId`, manifest id and digest, policy version, `createdAt`, every `decidedAt`, `coverageReviewId`, `repairBudgetLineageId`, and `expectedDigest` on revise | `planning-contracts.ts:938-959`; `planning-tools.ts:616-625` | stamp them | small per revision | Stale or mistyped identity → refusal → retry turn |
| 5 | Both sides of every link: requirement→tasks and task→requirements; phase→requirements and requirement→phase; phase→tasks and task→phase; `requirementCriteriaMap` | `planning-contracts.ts:867-904, 916-927, 654-655` | author one side, derive the other | tens of tokens per link, repeated in each revision | A whole class of symmetry errors, each a refused call and a retry |
| 6 | Re-emit the **whole** plan revision (all requirements, tasks, phases) on every `revise_planning_plan` | `planning-tools.ts:603-704` | accept a delta and rebuild the snapshot + digest | ~400-900 tokens per task; a 10-task plan ≈ 5-9k output tokens per revision, repeated per coverage-review round | Large outputs raise truncation and copy-error risk |
| 7 | Contract fields no one consumes (F2): `outcome.system`, `inputs`, `outputs`, `validation.*`, `negativeProofApplicability`, `reviewCriteria`, `integrationChecks`, `cleanup.*`, `lineage`; `requiredBase` used only as a fallback | `planning-contracts.ts:627-656`; `task-scheduler.ts:733-738` | make optional; keep only what a consumer reads | a large part of item 6 | Busywork that looks like rigor; the coverage reviewer judges text the worker never sees |
| 8 | Worker links each criterion to evidence ids | `worker-lifecycle-tools.ts:77-81` | pre-link runner-run evidence (boundary, depth) to criteria; the worker adds criterion-specific links | small | Real but irrelevant evidence can be linked (EX4 L2) |
| 9 | Architect `review_task` verdict per criterion, with evidence ids, after the independent reviewer already judged each claim; the Architect re-reads the diff | `architect-tools.ts:2150-2240`; `agent-prompts.ts:593-597` | prefill from the reviewer's claim verdicts and runner evidence; the Architect confirms or overrides (OD-3) | one full diff read per task at the Architect's (usually most expensive) rate | Two semantic judges without clear precedence |
| 10 | Final-verification plan per category (status, rationale, inspected paths) and a per-category review that echoes runner facts | `architect-tools.ts:1539-1580, 1786-1830` | pre-fill detected categories; ask the model only for undetected categories and its risk rationale | moderate | Mechanical echo, little judgment |
| 11 | `ValidationIntent` (Architect actor in the T2 table) | `planning-projection.ts:119`; no producer | derive from the affected-test ladder; do not ask the model | 0 today (unwired) | Would be model-authored mechanics if wired as designed |

**Genuine judgment — keep with the model:** items listed in 4.3. Two fields in the contract are judgment but mechanical in use: `writableSurfaces` and `sharedResourceClaims`. They are the model's prediction of what the task will touch, and the kernel uses them for admission (`task-resource-claims.ts:225-238`). Keep them, and make them useful: show them to the worker and reviewer, and compare them with the submitted change (EX4 L17).

**Net effect.** Planning output shrinks to the semantic core. The Architect stops paying ~1-1.5k tokens of docs context per turn. Several failure-and-retry classes (symmetry, stale digests, template drift, forgotten STATE.md) disappear rather than being checked.

---

## 6. Keep / change / remove

| Mechanism | Decision | Note |
|---|---|---|
| Source manifest, bounded section reads, durable read index | **Keep** | The read index becomes the only source of read coverage. |
| Requirement ledger, plan revisions with digests, coverage review blind-first, readiness gate | **Keep** | Change the input shape only (items 4-7 above). |
| Triage and the answer path | **Keep** | Remove the docs gate for answered runs (F6). |
| Claims and admission (T4) | **Keep** | Also show claims to the worker; compare with the change (EX4 packet 2). |
| Deliverable review ordering, fresh session per pass, distinct-model preference, OA-4 tiers | **Keep** | Add ReviewKey dedupe, stage resume, delta re-review (section 7). |
| Boundary checks with real counts | **Keep** | Add exact-identity reuse; add non-`package.json` detection (F5). |
| Runner-recorded task/phase acceptance | **Keep** | This is the one acceptance authority. |
| Repair budgets (3 per root cause; run cap 3 + tasks), approach decisions with the new-evidence rule, flaky isolation, OA-17 cleanup | **Keep** | Base "new evidence" on evidence content, not new ids (EX4 L7). |
| Final verification and the independent verifier | **Keep** | Reuse the last boundary's build/test result when the tree is identical. |
| Project memory, defect classes, model track record | **Keep** | Internal cross-run continuity. |
| Docs policy v1 (model-maintained `docs/project/**`, STATE.md gate) | **Change** to v2 for new runs | Kernel-generated snapshot; the gate is kept and satisfied by the kernel; v1 runs replay unchanged. |
| Docs instructions on every Architect turn | **Change** | v2: none; one line that `write_project_doc` exists for genuinely needed docs. |
| `write_project_doc` | **Change** | Optional. In v2 it refuses the kernel-owned snapshot and spec copy, and `docs/project/evidence/**`. Its description states the anti-journaling rule. |
| AGENTS.md section text | **Change** | Static v2 wording (section 3.4); drop `evidence/` and "keep plans current" from the checked statements. |
| CLAUDE.md pointer | **Change** | Use `@AGENTS.md`. |
| Resume index | **Change** | Derive from the read index and plan/review state. |
| Execution task contract | **Change** | Semantic core authored; envelope stamped; mirrored links derived; unused fields optional; the semantic contract is **delivered** to worker and reviewer (F2). |
| Architect `review_task` in the new policy | **Change** (OD-3) | Disposition with prefilled verdicts. |
| `record_planning_checkpoint` tool | **Remove from the tool surface and prompt** | Keep the event type and reducer so old logs replay. |
| `evidence/` and `plans/` in the default layout | **Remove** (v2) | Plans appear only in a plan-only snapshot. |
| Unproduced T2 planning event types (F4) | **Freeze** | Keep in the reducer for replay; do not build T7 views on them; mark them reserved. |
| T5 `decideApplicability` (semantic reuse) | **Defer** (OD-4) | Wire `decideUnverifiedClaim` (EX4 L2) earlier; it is cheap and mechanical. |
| Mid-run document commits and the document tip | **Remove for v2** | Kept for v1 replay. |

---

## 7. Review economics (question 4)

### 7.1 What happens today

Per task in the new policy: an independent deliverable review of 2 passes (low/medium) or 3 (high), each in a fresh session (`native-deliverable-review.ts:397-429`); the full diff in both the findings and verdict passes (F7); the Architect's `review_task` with the diff again; then the boundary runs build + the full test script (F8); at high tier the review already ran the full test script and the mutation probe (`delivery-execution.ts:698-760`). A fix round repeats all of it on the full cumulative diff. An interrupted review restarts from its first pass (`scheduler-store.ts:6373-6380`). Final verification runs build and tests again at the end.

### 7.2 Design

1. **ReviewKey.** `hash(task semantic-contract digest, base tree id, head tree id or diff digest, evidence-content digest, review tier, reviewer-policy version)`. The evidence digest uses evidence **content** (command, tree fingerprint, exit code, report counts, failing test ids), not evidence ids, so re-running the same check does not look like new evidence.
2. **Same key → no new review.** If a completed review has the same key, the kernel refuses to start another one and returns the prior verdict and findings. An unchanged resubmission is refused with "no change since review R". This is exactly OA-6 ("no reviewer re-reads input that has not changed", amendment `:211-213`). It charges no repair cycle.
3. **Resume at stage level.** Each pass already opens a fresh, empty session. So an interrupted review can resume at the first missing stage, reusing the durable records of finished stages, **if the same reviewer runtime continues**. A different runtime restarts from the first pass. Independence is unchanged.
4. **Batched repair (keep).** One rejection sends all open findings of the task to one worker attempt. The kernel charges one cycle per root-cause issue (`build-runtime.ts:3283-3344`). This is already correct.
5. **Delta re-review.** A fix re-review gets, in order: the criteria; the **fix delta** (prior reviewed head → new head); a runner-computed list of delta files that no prior finding names; the evidence that was invalidated (tree fingerprint changed); then, after it records its own view, the prior findings to check one by one. The full cumulative diff is available by tool, and included up front only at high tier or when the delta touches files outside the prior findings (over-correction signal, L8). The reviewer answers both directions: is each finding resolved, and did anything change beyond what the findings required?
6. **Architect disposes, not re-reviews (OD-3).** The independent review is the review. `review_task` arrives with verdicts prefilled from the reviewer's claim verdicts and the runner's evidence. The Architect confirms or overrides. An override needs a rationale; turning `unverified` into `verified` needs evidence the Architect's own session read (tool ledger). The Architect may always open the diff.
7. **Exact-identity evidence reuse.** Key a test result by (checkout tree id, exact command, environment fingerprint: runtime version, lockfile digest, relevant variables). Within one run, the same key reuses the result, recorded as `reused_from`. Typical hits: a fast-forward integration reuses the high-tier review run; final verification reuses the last boundary's build and tests on the same tree. This needs no judgment and cannot be wrong if the fingerprint is complete.

### 7.3 Preserving independence, real counts and budgets

- Independence: fresh session per pass, distinct model preferred, blind-first ordering — all unchanged. Dedupe reuses a verdict about identical input; it never lets a non-independent session judge.
- Real counts: a reused result is a report **from this run** on an identical tree, command and environment, so the owner's rule (≥1 real test, 0 failures, this run's report) still holds. Cross-run reuse is not allowed.
- Budgets: 3 cycles per root cause and the run cap of 3 + tasks are unchanged. Dedupe prevents charging a cycle for a no-change resubmission; delta review makes each cycle cheaper; stage resume stops transient failures from re-buying whole reviews.

### 7.4 Against rubber-stamping and loops

Rubber-stamping:
- at least one inspection call at every tier, including low (EX4 packet 3c);
- a `verified` claim must cite a file location or evidence the session actually read (tool ledger);
- mutation-probe survivors on changed lines become findings the reviewer must dispose of (EX4 L10);
- track reviewer outcomes too, not only author outcomes: a reviewer whose approvals later fail a boundary or final verification gets a higher tier for its reviews, or is chosen later.

Loops:
- the same-key rule stops identical re-reviews;
- **after the first review, a new blocking finding on unchanged, already-reviewed code is allowed only if it is critical (security, data loss) or backed by evidence of a regression.** Other late findings are recorded as non-blocking and routed to a follow-up task or to the final reconciliation. This stops the "moving target";
- a component with a safe floor (fail closed to the full suite, `unknown`, `not_available`) is accepted when it fails closed on unknown input. Exhaustive precision is P7 tuning, not a blocker;
- the per-issue budget still ends any remaining loop.

### 7.5 What the P6.6 review rounds say (T5: 12, T6a: 8, T6b: 5)

- **Packets were too big.** T5 bundled seven libraries; T6a bundled review, execution, boundary, acceptance and wiring. The owner already drew this lesson ("four packets, not two").
- **Reviewer scope drifted.** T5 rounds r6-r12 were mostly adversarial probing of Gradle/Kotlin parsing in `affected-tests.ts`, whose result production treats as informational (F8). Each round found new shapes; several found over-corrections of the previous fix (T5-review-r6 "over-correction check"). A rule like 7.4's second loop bullet would have ended T5 around r5.
- **"Built but not wired" escaped review twice.** T6a r1 found the deliverable review not wired into the factory; T5 was accepted with its reuse APIs unwired (F3); the whole new policy is still unreachable (F1). The fix: every packet's definition of done includes one **unseeded** factory test through the production path (EX4's T7 ask), and "library-only" is never an accepted end state without a named wiring packet.
- **The harness's own process keeps a large diary in Git** (`.superpowers/` has 2,793 tracked files). That is an owner choice for AIBoard's development, not a product defect, but it is the same incentive the audit warns about.

---

## 8. Robustness check — L1–L18 and EX4 (question 5)

"Today" is EX4's verdict for the new-policy path. "Target" is the recommended architecture **including** the EX4 packets placed in section 10.

| Row | Today (EX4) | Target | Better / equal / worse | Why |
|---|---|---|---|---|
| L1 half the work "done" | handled | stronger | **better** | The worker now receives scope, steps and definition of done (F2), so it knows what "all" is; the reviewer sees scope too. |
| L2 evidence claimed, never performed | partly | stronger | **better** | Runner evidence pre-linked; `decideUnverifiedClaim` labels each claim mechanically. |
| L3 built, not wired | partly (HIGH) | stronger | **better** | Unreferenced-new-file signal (EX4 3b); in the runner itself, the unseeded-production-test rule per packet; no authored fields without a consumer. |
| L4 zero tests "passed" | partly | stronger | **better** | Suite-shrink / test-command pin (EX4 1); non-`package.json` detection removes the permanent `unknown` (F5). Real counts unchanged. |
| L5 blames the sandbox | handled | same | equal | Runner-run checks remain the authority. |
| L6 encoding damage | not handled (HIGH) | handled | **better** | EX4 4 (BOM kept by `fs.patch`, diff encoding check). Independent of the docs change. |
| L7 same failed fix repeated | partly | stronger | **better** | ReviewKey and content-based evidence digests: a re-run of the same check is not "new evidence"; an identical diff is refused; diff fingerprint per repair attempt (EX4). |
| L8 over/under-correction swings | partly | stronger | **better** | Delta review lists delta files no finding names; "both directions" question; the late-finding rule damps reviewer-side swings. |
| L9 fakes hide durable-state bugs | not handled | partly | **better** | Durable-surface risk signal (EX4 backlog) plus a reviewer obligation line (T10). Still judgment-based. |
| L10 tests that can never fail | partly | stronger | **better** | Survivors become findings to dispose of. |
| L11 worker stops mid-task | partly | same | equal | EX4's 402/context-overflow classification is orthogonal; add it in the backlog. |
| L12 inherits half-done edits | handled | same | equal | Fresh worktree per attempt unchanged. |
| L13 false evidence claims | partly | stronger | **better** | Tree fingerprint in every command evidence record (needed anyway for reuse and ReviewKey). |
| L14 task too large | partly | stronger | **better** | A thinner contract makes size visible; `task_size` plan-risk reason (EX4 backlog) triggers the critic. |
| L15 leftovers | partly | same or better | equal | Fewer repo files (no diary); EX4 tmpdir snapshot is orthogonal. |
| L16 stale environment | not handled | partly | **better** | The reuse fingerprint forces the runner to know the child environment; EX4's PATH/npm scrub belongs with V1. |
| L17 out-of-scope edits | partly (HIGH) | stronger | **better** | Claims shown to worker and reviewer; submission scope check (EX4 2) as a blocking finding; harness-diary-looking new files flagged there. |
| L18 duplicate expensive runs | partly | handled for exact identity | **better** | Exact-identity reuse and review dedupe; semantic reuse waits for data (OD-4). |
| N1 worker weakens the suite | not handled (HIGH) | handled | **better** | EX4 1. |
| N2 worker commits a secret | not handled (HIGH) | handled | **better** | EX4 2(b) refusal. |
| N3 reviewer rubber-stamps | partly | stronger | **better** | Section 7.4. Prefilled Architect verdicts (OD-3) could invite an Architect rubber stamp; that is acceptable because the independent reviewer is the real check, and overrides are logged. |
| N4 prompt injection via repo files | partly | stronger | **better** | The kernel owns the AGENTS.md section; worker edits to instruction files need a claim (EX4 2a). |
| N5 self-review through failover | not handled (HIGH) | handled | **better** | EX4 3(a). |
| D1 forgetting to document | gate catches it; costs a loop | cannot happen | **better** | The kernel renders the snapshot. |
| D2 stale or false status in docs | possible (model-written) | exact for its revision, self-describing | **better** | Rendered from records; stamped with the revision. |
| D3 journal bloat in the repo | encouraged (evidence/, plans/) | one file | **better** | Diary stays in AIBoard. |
| D4 another tool cannot find the info | handled by D6 | handled | equal | AGENTS.md entry + snapshot + spec copy. |
| D5 loss of free-form Architect narrative | Architect writes anything | handoff summary + planning decisions only | **slightly worse** | Mitigation: `write_project_doc` stays available for genuinely useful docs. |

Nothing in the target is worse on a safety row. The one "worse" row is narrative richness, by design.

---

## 9. How other harnesses handle durable state (question 6)

| Tool | Durable state and continuity | Copy | Do not copy |
|---|---|---|---|
| Claude Code | Human-curated `CLAUDE.md` in the repo, with `@path` imports; auto-memory kept **outside** the repo (per user/project); resumable sessions. Recent releases reportedly read `AGENTS.md` when no `CLAUDE.md` exists (sources disagree). | `@AGENTS.md` import; memory outside the repo, like AIBoard's project memory | — |
| Codex, Cursor, Jules, Amp (AGENTS.md) | `AGENTS.md` as the open, tool-neutral entry point; nearest file wins | A short, static AGENTS.md section as the entry point | Long, frequently edited AGENTS.md content |
| Aider | Git history is the journal (auto-commit per change); conventions file passed read-only; chat history in `.aider*` files it suggests git-ignoring (general knowledge) | Commit trailers as the journal: put task id and requirement ids in task commit trailers, so any tool can `git log` what was done and why, with zero extra files | — |
| OpenHands | Append-only event log per conversation, persisted outside the repo; state derived from events; repo instructions in `.openhands/…` files | Exactly AIBoard's kernel model | — |
| Devin-style planners | Plans and knowledge live in the platform, suggested by the agent and approved by a human; output is a PR (general knowledge) | Human-approved knowledge = AIBoard's proposed→promoted project memory | — |
| spec-kit / Kiro | Specs, plans and `tasks.md` committed under `specs/<feature>/`, plus a constitution file; the agent ticks tasks | Specs in the repo; a plan committed when a plan is the deliverable (plan-only runs) | Agent-maintained task checklists as the state of record in a harness that has a kernel |
| Cline "memory bank" pattern | Several model-maintained Markdown context files in the repo (general knowledge) | — | This is the diary pattern the audit warns about; known to drift and bloat |

The pattern: tools **without** a kernel must keep state in repo files, because the repo is their only durable store. Tools **with** an event store keep state outside and put only instructions in the repo. AIBoard has a kernel, so it should follow the second pattern — plus one generated snapshot, because the owner wants tool-neutral continuation.

---

## 10. Owner decisions needed (at most four)

### OD-1 — What form does cross-harness continuity take? (Revises capability D6.)

- **Option A (recommended): kernel-generated handoff.** Docs policy v2 for new runs: the runner writes the static AGENTS.md section, the `@AGENTS.md` line and a generated `docs/project/STATE.md` snapshot at handoff and plan-only completion; nothing for answered runs. The spec copy is written by default when the spec is not already in the repo, with a per-run opt-out. The completion check stays and the kernel satisfies it. The Architect keeps `write_project_doc` for docs it genuinely judges useful, but not for status or evidence.
- **Option B: keep D6.** The Architect keeps maintaining `docs/project/**` and STATE.md; trim the prompts only (the audit's "approach A").
- **Trade-off.** A cannot forget and cannot state a false status. It removes ~1-1.5k tokens from every Architect turn, four writes from every answered question (F6), and the mid-run document-tip logic (F9). It loses free-form narrative beyond the handoff summary and planning decisions. B keeps narrative and keeps the journaling cost and the risk of an unverified "tests passed" in a repo file.
- **Recommendation: A.** It meets the owner's continuity goal more reliably than D6 does. It is a reversal of D6's rejected alternative, so it needs the owner's explicit word and a D6 revision note.

### OD-2 — When to make the model changes?

- **Option A (recommended): insert four small correction packets before T7** (section 11, phase C).
- **Option B: start T7 now** and fold changes into T10, T8 and P7.
- **Trade-off.** No production run uses the new policy yet (F1). Changes before T7 only update test fixtures, as T9 already did for unshipped logs (`progress.md:10`). After T7 ships the policy, each change needs a new planning-policy or docs-policy version, replay fixtures and T7 views built twice. A costs roughly one packet-phase of delay.
- **Recommendation: A.**

### OD-3 — What is the Architect's role in task review under the new policy?

- **Option A (recommended): disposition.** The independent deliverable review is the review. The Architect gets verdicts prefilled from the reviewer and runner evidence, confirms or overrides with a reason, and opens the diff only when it overrides, rejects a finding, or wants to.
- **Option B: full second review.** Keep today's flow: the Architect re-reads the diff and writes every criterion verdict.
- **Trade-off.** A removes one full diff read per task by the most expensive model and gives one clear semantic judge. B keeps a second opinion from the planner, who knows its own intent, at that cost; the planner is also not independent of the plan.
- **Recommendation: A.**

### OD-4 — How far should evidence reuse go before T8?

- **Option A (recommended): exact-identity reuse now.** Reuse a test result within a run only for an identical tree, command and environment. Amend T8's "unrelated-change reuse" scenario (plan `:298`) to exact reuse. Semantic reuse (T5's `decideApplicability`) waits for P7 data.
- **Option B: wire T5 semantic applicability now**, so T8 runs as written.
- **Trade-off.** A removes most duplicate runs (fast-forward integrations; final verification on the last boundary's tree) with no judgment and no false-green risk. B also saves runs after unrelated changes, but relies on impact judgments that can be wrong, and it is a larger packet on code that already took 12 review rounds.
- **Recommendation: A.**

---

## 11. Migration outline (question 7)

Packets are small: one mechanism each, wired into production, with the tests that prove it. At most four per phase.

### Phase C — "P6.6 correction", before T7 (needs OD-1 and OD-2)

| Packet | One sentence | Risk |
|---|---|---|
| **C1** Handoff renderer | A pure, deterministic function renders the snapshot (and the plan-only plan view) from the projection and the handoff summary; T7's export will call the same function. | Low. Watch scope creep: cap the output size. |
| **C2** Docs policy v2 | The reducer accepts `project_docs.policy_configured` version 2; new runs stamp v2; v2 completion requires the kernel-committed snapshot for the handed-off revision (none for answered runs); the runner writes the AGENTS/CLAUDE lines, the snapshot and the optional spec copy through the existing commit path at handoff; the Architect gets no docs templates under v2; `write_project_doc` becomes optional with kernel-owned paths and `evidence/` refused. | Medium: completion readiness and handoff order. Mitigate with v1 replay fixtures. |
| **C3** Planning bookkeeping cut | Remove `record_planning_checkpoint` from the tool surface and prompt, derive the resume index from the read index and plan/review state, and accept a new plan revision as the only "planning turn after folded guidance" proof. | Low. Keep the event type and reducer for replay. |
| **C4** Contract envelope and delivery | The kernel stamps run/manifest/policy/time/base fields, derives the mirrored links from one side, makes the unused fields optional, and renders the semantic contract (outcome, scope, steps, writable files, criteria, definition of done) into the worker's and deliverable reviewer's context. | Medium: T3a/T3b fixtures and the coverage reviewer's input shape change. |

### T7 (as planned, adjusted)

Production source provisioning and the new-policy stamp (fixes P0/F1); UI and authenticated APIs; exports through C1's renderer. The `docs/project/generated/` branch in T7 (plan `:284`) is replaced by the v2 snapshot. **Definition of done adds EX4's ask:** one unseeded factory test from production run creation to `delivery.review_started` → boundary → `task.acceptance_recorded`.

### Phase R1 — safety, before T8 (EX4's four HIGH packets, unchanged in substance)

| Packet | One sentence | Risk |
|---|---|---|
| **E1** Test integrity | Pin the test command and fail a boundary whose executed count shrank or whose test script changed without a plan-revision reason (N1, L4a). | Medium. |
| **E2** Submission scope and secrets | At submission, out-of-claim paths and harness-diary-looking new files become blocking findings the Architect must resolve; secrets and key files are refused; instruction files need a claim (L17, N2, N4). | Medium. Note: make the scope part a finding, not a refusal, to respect the "no rigid worker file whitelist" non-goal (plan `:62`); EX4's draft refuses. |
| **E3** Review independence and depth floor | Record every runtime that touched an attempt as an author; flag unreferenced new source files; require an inspection call at every tier (N5, N3, L3). | Low-medium. |
| **E4** Encoding safety | Keep an existing BOM in `fs.patch`/`fs.write`, and flag BOM, line-ending, mojibake and invalid-UTF-8 changes at submission (L6). | Low. |

### Phase R2 — evidence and review economics, before T8 (needs OD-3, OD-4)

| Packet | One sentence | Risk |
|---|---|---|
| **V1** Fingerprints and exact reuse | Record a working-tree fingerprint and child-environment fingerprint in every command evidence record, and reuse a test result within a run for an identical tree, command and environment (L13, L16, L18). | Medium: an incomplete fingerprint causes false reuse; keep it within one run. |
| **V2** ReviewKey, stage resume, delta re-review | Refuse a review with an already-reviewed key, resume an interrupted review at its missing stage, and give fix re-reviews the fix delta plus the list of delta files no finding names (OA-6, L7, L8). | Medium: touches the T6a flow that took eight rounds; keep it additive. |
| **V3** Architect disposition | Prefill `review_task` verdicts from the reviewer and runner evidence; overrides need a reason and read evidence (OD-3). | Low-medium. Skip if OD-3 = B. |
| **V4** Language-neutral execution profile | Detect build/test commands and machine-readable reports for non-`package.json` projects (for example `dotnet test` TRX, `ctest --output-junit`, `pytest --junitxml`, Maven/Gradle JUnit XML, `cargo`/`go` where a reader exists), falling to `unknown` only when nothing applies (F5). | Medium. **T8 depends on it** (plan `:300`). |

### T10 — prompt hygiene (prompt text only, as planned)

v2 texts (no docs templates; `write_project_doc` description with the anti-journaling rule; `@AGENTS.md`); the fix re-review "both directions" line (EX4 L8); the worker's compact task view formatting (C4 supplies the data); untrusted-content labelling (M12); token counts before and after.

### T8 — final gate, add these scenarios

A v2 build that plans, restarts, executes, reviews, integrates and completes with **no repository files except product files, the snapshot and the two entry-point lines**; an answered run that adds **no** file; a plan-only run whose snapshot contains the plan; a v1-stamped docs log that replays unchanged; non-JS fixtures through the boundary (needs V4); reuse per OD-4.

### P7 — real-world qualification

A real continuation test: after an AIBoard run, a fresh Claude Code or Codex session with **no AIBoard access** continues the project correctly from the repository alone. Measure tokens per gate and tune tiers. Decide semantic reuse with data. Consider delta plan revisions, a diff-on-demand verdict pass, and a prior-run digest (from AIBoard's own records plus `git log` since the snapshot revision) at triage.

**Minimum path if time is short:** C1, C2, C3 before T7; E1-E4 and V4 before T8; everything else to P7.

### Compatibility notes

- Never delete an event type or reducer branch. Old logs must replay byte-for-byte.
- Docs policy v1 stays exactly as it is for every run stamped v1. **Production runs on `main` are already stamped v1** since the capability program merged (`build-runtime.ts:1885-1896`), so v1 replay is a hard requirement. Old runner code refuses v2 (`scheduler-store.ts:2865-2867`), which is the desired fail-closed behavior.
- The new planning policy (planning v1) is unshipped (F1). Its tool inputs and contract shapes can change before T7 with fixture updates only, following the T9 precedent (`progress.md:10`). After T7, any change needs a policy version bump.
- `planning.checkpoint_recorded` stays reducer-accepted; only the tool and prompt go.
- Contract fields become optional in the validator, not removed from the type, so stored revisions and their digests stay valid.
- The document-tip logic stays for v1 runs; v2 runs never create a mid-run document tip.
- AC-25 (the STATE.md gate) is an accepted requirement of the capability program. OD-1 = A needs a D6 revision note and a matching P6.6 amendment line, so traceability stays intact.

---

## 12. Risks and open questions

1. **The snapshot may be too thin for some owners.** It carries status, decisions and the handoff summary, not a design narrative. Mitigation: `write_project_doc` remains; a source that needs architecture docs gets them as reviewed tasks.
2. **Spec copy and privacy.** Copying the approved source into the repo may expose content the user did not want committed. Default on with a per-run opt-out is my proposal; the owner may prefer default off (OD-1).
3. **Other tools may edit the snapshot.** AIBoard reads it as untrusted context at its next triage and regenerates it at its next handoff; git keeps the edited version. Open question: should AIBoard show the owner a diff of hand edits before overwriting?
4. **T7 carries more risk than planned.** It is the first time the new policy runs in production (F1). Every phase-C packet should come with a seeded test now and gain an unseeded one in T7.
5. **F5 is a P7 blocker on its own.** Until V4 lands, a new-policy run cannot finish on a non-Node project, and final verification on such a project may mark tests not applicable because nothing was detected.
6. **Fingerprint completeness (V1).** Exact reuse is only as safe as the environment fingerprint. Keep reuse inside one run, include runtime version, lockfile digest and relevant variables, and fall back to re-running when unsure.
7. **Content-based evidence digests change the approach-decision rule.** A genuinely new diagnostic with the same command but a different output must still count as new. Test both directions.
8. **EX4 packet E2 versus the owner's "no hard write fences" position.** I recommend a blocking finding for scope, and a refusal only for secrets. The controller should confirm this reading with the owner.
9. **Two dead models in the schema (F4).** Decide explicitly whether T5's observations ever become the acceptance record, or whether `delivery.*` stays the only one. I recommend the latter, with T2's unused types frozen.
10. **Claude Code AGENTS.md behavior is contested in public reports.** Keep the `@AGENTS.md` line and verify at T10 on the owner's own version.

---

## Sources (web, used for section 9)

- [DevOps.com — Claude Code adds AGENTS.md fallback](https://devops.com/claude-code-adds-agents-md-fallback-cutting-instruction-file-sprawl/)
- [DEV Community — Claude Code now supports AGENTS.md natively](https://dev.to/valyuai/claude-code-now-supports-agentsmd-natively-heres-how-it-actually-works-5nl)
- [Gist disputing the fallback claim; documents the `@AGENTS.md` import](https://gist.github.com/yurukusa/d36197848911f025add142abefcde685)
- [anthropics/claude-code — mods/agents-md README](https://github.com/anthropics/claude-code/blob/main/mods/agents-md/README.md)
- [github/spec-kit](https://github.com/github/spec-kit) and [spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)
- [OpenHands docs — conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence)
- [OpenHands skills README](https://github.com/OpenHands/OpenHands/blob/main/skills/README.md)
- Aider, Devin and the Cline memory-bank pattern: general knowledge, not re-verified for this report.
