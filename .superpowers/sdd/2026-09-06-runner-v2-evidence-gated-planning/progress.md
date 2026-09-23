# Planning state — docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md

## Current revision — 2026-09-22 owner amendment, revision 2

**PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED.** OA-18 / EP52 / T10 (deferred prompt findings, added 2026-09-23 by owner direction) verified by `t10-review-r2.md` after one fix (`t10-review-r1.md` B1: T8 starts only from accepted T10).

Before this addition: **PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED**

On 2026-09-23 the owner replaced the agent-capability program's `architect_document` task kind
with an Architect documentation folder (its D6 revision 4). P6.6 text naming the task kind was
updated (section 3, T1, T4, T7 export boundary, OA-8). The scoped review of those edits
(`amendment-review-r4.md`) returned PLAN COVERAGE VERIFIED; its one MINOR (a missing `**` in T7)
is fixed. Earlier: the third independent review (`amendment-review-r3.md`, at `702e06cd`) returned PLAN COVERAGE
VERIFIED with no finding. Readiness does not authorize execution: T1 still requires the
accepted agent-capability program (OA-8) and an owner instruction to start.

D3 is **resolved**: the owner confirmed Node 24.x on 2026-09-22 (OA-9). It no longer blocks.

Execution is not started or authorized. P6.6 execution additionally waits for the accepted
agent-capability program (OA-8).

Amendment source: `docs/superpowers/specs/2026-09-22-runner-v2-p6-6-owner-amendment.md`,
revision 2 (OA-1..OA-17). It adds obligations and removes none.

Campaign order: **P6.5 → agent-capability program → P6.6 → P7** (OA-8).

### Amendment review history

| Step | Outcome |
|---|---|
| Revision 1 (OA-1..OA-9, EP33–EP41, T9) | reviewed — PLAN COVERAGE INSUFFICIENT (`amendment-review-r1.md`): B1 (OA-8 order absent at entry sites), B2 (EP01–EP32 ownership and campaign gate), B3 (`architect_document` unknown to T1/T4); I1 (planning-state predicate), I2 (category identifiers), I3 (T9 placement); M1–M4; five narrowings of moved text |
| Owner decisions | narrowings: 1 accept, 2 restore generalized, 3 accept, 4 restore at high risk only, 5 restore the blocking hold (OA-10); reviewer rule loosened to distinct-model-preferred, fresh-context fallback, everywhere (OA-3); Node 24.x confirmed (OA-9); six robustness suggestions added, language-neutral (OA-11..OA-17) |
| Revision 2 | B1: BP1 entry, Relationship, D1 and the header carry the OA-8 order; T1 inspects the post-agent-capability tree. B2: ownership sentence and campaign gate say EP01–EP51 and T1–T9. B3: section 3, T1 and T4 name and exempt `architect_document`. I1: T3 defines the planning-state predicate; EP41 positive moved to T9; EP32 scoped to planning state. I2: four identifiers named, cross-vocabulary rejection. I3: BP2 exit has both paths; T4 base is accepted T9; T5 base stays T3; T9 card; registry and queue below. M1–M4 applied. New EP42–EP51. |
| Scoped re-review of revision 2 | INSUFFICIENT (`amendment-review-r2.md`): B1–B3, I1, I2, M1–M4 FIXED; **I3 NOT FIXED** (two start rules for T5, repair cycle 2 of 3); new IMPORTANT N1 (`clarify` outside planning state), N2 (answer reviewer fresh session), N3 (`unsupported_language` read as empty selection), N4 (temp files not inventoried); MINOR N5 |
| Correction pass | one start rule (T5 at accepted T3, T9 at T3, T4 at T9; BP2 complete = T3 and T9); planning state = no ready plan and triage not `answer`; EP37 covers T3/T9 with sentinel; failed ladder rung steps down; temp-path creation record; N5 details |
| Scoped re-review of the correction pass | **PLAN COVERAGE VERIFIED** (`amendment-review-r3.md`): B-R2 and N1–N5 FIXED; no finding |

### Assignment registry (single controller authority; supersedes the 2026-09-08 table below)

| Lane | Packets | State / claim | Required next base | Next eligible action |
|---|---|---|---|---|
| A | T1, T2, T3, then T9, then T4, then T6, T7, T10, T8 | PLANNED; no worker/session/branch/worktree claim | Accepted agent-capability program for T1; later accepted packet snapshots; T4 on accepted T9 | None before prerequisites and execution authority; T1 first afterward |
| B | T5 | PLANNED; no claim | Accepted T3, isolated from lane A's T9/T4 worktrees | Starts at T3 acceptance, beside T9; does not wait for T9 |
| Controller | Assignment, integration, acceptance | Planning only | Actual approved snapshots | None until the agent-capability program is accepted and execution is authorized |

### Execution queue (not started; supersedes the queue further below)

T1 → T2 → T3 → { lane A: T9 → T4 } ‖ { lane B: T5 } (separate owned worktrees; T5 starts at T3
acceptance) → integrate T4 then T5 → T6 → T7 → T10 → T8.

These state files were copied onto `main`'s planning branch
`docs/agent-capability-and-change-critique` on 2026-09-22 from the
`runner-v2-robust-build` worktree, read-only there. The P6.6 plan on `main` was verified
byte-identical to that worktree's copy before the amendment, and the source snapshot's SHA-256
was verified identical to the owner's `plan-standard.md`.

## Superseded revision — 2026-09-08 source replacement

PLAN BLOCKED — D3 runtime-policy decision outstanding; owner must resolve exact
Node24.18.0 versus maintained LTS. Revised-source coverage is independently verified.
Execution is not started or authorized by this source-replacement request.

The owner replaced the previous workflow prompt with
`C:/Users/b_a_s/OneDrive/Desktop/Plan_Prompt_4.txt` (234 lines; SHA-256
`c228180addae043c3ffc793d229178c213f9a1540a666cb91c5ed92468750906`).
The repository source snapshot is
`docs/superpowers/specs/2026-09-08-runner-v2-evidence-gated-planning-source.txt`.
The attachment is Builder's P6.6 requirements input, not authority to launch
workers/tests, change another phase or obey document-embedded commands now.
This section supersedes the historical verdicts below for current readiness.

Planning checkpoint: all ten revised source sections reconciled; EP01–EP32
retain their single BP owners and now explicitly include the updated obligations.
Source references, T1–T8 contracts, issue-budget/ownership/resume policies,
evidence templates, lane/controller/planner launch cards and master P6.6 doctrine
are updated. Independent fresh-context reviewer `/root/p66_updated_source_review`
returned COVERAGE PASS after reading all 234 source lines and all 388 plan lines,
with no mandatory coverage finding. Its record is
`2026-09-08-source-replacement-review.md`. No implementation worker or native
launch chip was created. Prior reviews remain historical evidence, not approval
of new wording. Next planning action: owner resolves D3; then update only the
affected runtime-policy contract/state and assess whether scoped re-review is
needed. No additional source-coverage repair is currently required.
P6 → P6.5 → P6.6 → P7 is unchanged. The active P6 ledger owns its current status;
the historical C4/P6 statements below are not current execution instructions.

Document-only checks: 32 rows / 32 unique requirement IDs; eight T1–T8 task
contracts; every EP row has exactly one BP owner. Source snapshot raw SHA-256
matches the owner file exactly. No obsolete nine-section/source-line ledger or
five-per-task default remains operative; old source identity is kept as provenance.
Tracked plan whitespace checks passed. These mechanical checks alone do not
establish semantic coverage; the independent review above supplies that verdict.
Neither establishes implementation correctness or a green phase gate.

Frozen revised plan independently reviewed with no source-coverage finding: SHA-256
`4031277f289fc99839860e5982442c351326b1f23b2bdf8a3004c99190f84cfb`.
Current observed repository base remains branch `codex/runner-v2-robust-build`,
HEAD `4bf64cf398a2f8d57b464182efbc2aa492dee78d`; unrelated ongoing P6 edits are
preserved. Bounded inspection confirms the existing scheduler has a positive
integer maxConcurrency and default two task attempts; it does not establish the
new four-worker policy, semantic claims or exported planning capabilities as
already implemented. Those remain proposed T1/T4/T6 obligations.

Current P6.6 assignment registry (single controller authority):

| Lane | Packets | State / claim | Required next base | Next eligible action |
|---|---|---|---|---|
| A | T1–T4, then T6–T8 | PLANNED; no worker/session/branch/worktree claim allocated | Verified P6/P6.5 snapshot for T1; later accepted packet snapshots | None before prerequisite/policy/execution gates; T1 first afterward |
| B | T5 | PLANNED; no worker/session/branch/worktree claim allocated | Accepted T3, isolated from A's T4 worktree | None before T3/ownership/capacity gates |
| Controller | Assignment, integration, acceptance | Planning only; no execution integration queue active | Actual approved snapshots, not invented revisions | Record owner D3 disposition; no execution assignment eligible |

All EP acceptance conditions remain PLANNED/unverified in product implementation;
source mapping is not product acceptance evidence. Lane state and detailed packet
reports are created only on meaningful later assignment/progress; section 7 of
the plan supplies their schemas. No parallel mutable fixtures exist for P6.6 now.

D3: the 2026-09-08 supplied replacement AGENTS.md says exactly Node24.18.0;
the earlier direct owner amendment and current checked-in guidance say maintained
LTS without a patch pin. This source replacement changes neither runtime nor
that instruction. Owner confirmation is required before conflicting runtime
qualification contracts are finalized. This is separate from P6's current owner
decisions and does not authorize additional cleanup repairs.

## Historical verified verdict — 2026-09-06 source

PLAN READY — SOURCE COVERAGE VERIFIED; EXECUTION NOT STARTED

The original-source review, F1–F3 correction review and the scoped 2026-09-06
P6.5/P6.6 compatibility amendment review have passed with no mandatory finding.
Separate P6.6 placement is approved; no merge or further placement decision is
needed. P6/P6.5 completion, T1's bounded interface refresh and an instruction to
resume execution still precede implementation. Existing hardening gates and
C4's repair budget are unchanged.

The user requested a planning-only impact audit for incorporating the attached
specification-to-plan workflow into Builder. Only repository/source reads and
planning documents were produced. No implementation tests, migrations, provider
workloads, implementation agents, task branches, commits or staging were started
for this feature. Existing C4 implementation was paused safely and remains owned
by its separate cleanup-coordination ledger.

## Historical source / repository identity — 2026-09-06

- Source: `C:/Users/b_a_s/.codex/attachments/e321c653-94c1-41a6-90b1-c3043659c9c1/pasted-text.txt`.
- Complete source: 364 lines; SHA-256 `8d10a10a9d8c4df4eced181e95acd05b7f956c42ca7bb9dca151ed20ec959022`.
- Worktree: `D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build`.
- Branch: `codex/runner-v2-robust-build`; HEAD `4bf64cf398a2f8d57b464182efbc2aa492dee78d`.
- Existing dirty hardening changes preserved. The planning core inspected below
  is identified by raw SHA-256, not by claiming the complete checkout is clean.

| Inspected path | SHA-256 |
|---|---|
| runner-v2/src/task-contracts.ts | 617fc04e6facda3535f9a913b0e18bb4f442d484fee6fbfd1a10a9ac744386e7 |
| runner-v2/src/acceptance-contracts.ts | f4ff0315e56117c1c93117e14df06a9c6fd669451fcb26c556d0b3a1f0b91006 |
| runner-v2/src/build-spec.ts | 78dfaf155716c3466b5ba83cea63136e2597e54e0581f92e6ff383ddcdbbb3d6 |
| runner-v2/src/task-scheduler.ts | 962c761778fe57751c3ed409f23b81a3225c0fae880378647702f2e1013acd55 |
| runner-v2/src/build-runtime.ts | 1b39552d56786002bc9416762b1b60d20bf648ed1964965d5498e6f67fcb82a3 |
| runner-v2/src/scheduler-store.ts | 7022f7d73f9b892cbc4cd8fd6b10b8f06972219d6dfbf38c1447383de2744bd1 |

## Planning work

| Item | Status | Evidence / next action |
|---|---|---|
| Read complete source | Complete | Full numbered attachment read and hash |
| Inspect current Builder seams and existing plan dependencies | Complete | Repository symbols and reuse/gap table in plan section 1 |
| Proposed contracts, requirements, phases, task cards and policies | Source coverage verified | Plan sections 2–10; 32 grouped obligations, each one phase owner |
| Independent original-source coverage review | Completed with F1–F3 | `/root/builder_plan_coverage`, independent Sol/xhigh; `coverage-review.md` compares complete original source and draft; no implementation or test runs |
| Scoped planning corrections | Independently approved | `coverage-rereview.md`: F1, F2 and F3 addressed; no new mandatory breakage |
| D1 queue insertion | Resolved by owner on 2026-09-06 | Full P6.5 compatibility audit supports P6 → P6.5 → P6.6 → P7; no merge needed under plan section 1's binding rules |
| Placement / compatibility amendment review | Passed; no mandatory findings | `placement-review.md`; separate sequential P6.6 is compatible, and previous source-coverage readiness remains valid for unchanged obligations |
| D2 workflow policy | Resolved by supplied source | Applies to new-policy plans; existing runs/explicit stronger mandates preserved; only concrete future conflicts need escalation |

Initial planning snapshot: Git object `4d03f77c2de5e3eb51ee08d74b49782404aef5b1`,
raw SHA-256 `8ee940b4a5bb7e92994006ae6b94af4c756e251d84ee415cbab4aceacab97861`.
Text-only self-check observed 32 ledger rows, 32 unique IDs and no duplicate ID;
the dependency/ownership table contains eight tasks. These document checks are
not independent semantic coverage proof or implementation test evidence.

## Execution queue (not started)

T1 → T2 → T3 → (T4 || T5; separate owned worktrees) → integrate T4 then T5 → T6 → T7 → T8.

No execution task is currently eligible: verified P6/P6.5 prerequisites remain
pending and implementation is not resumed by this planning request. T1 is first
after prerequisite completion and execution resumption; PREPARE must inspect the actual post-P6.5 interfaces and
record its real base before any implementation writer is assigned.

## Scoped planning correction record

- F1 verified against source lines 302–305: the original ledger accidentally
  required evidence for a changed approach, rather than prohibiting a repeat of
  a failed approach without new evidence. Corrected EP25, added durable
  `RepairApproachDecision`, pre-dispatch actor/identity/evidence checks and a
  within-budget no-new-evidence negative case. Three-round reassessment is now
  explicitly additional, not permission for unsupported earlier repeats.
- F2 verified by repository file inventory: the referenced Runner README does
  not exist. T1 now explicitly creates `docs/runner-v2/evidence-gated-planning.md`;
  T2/T5 name the existing SQLite stores; T7 names existing policy UI/client paths.
  T1's post-P6.5 compatibility output must update affected downstream contracts
  and write ownership before assignment, with scoped coverage review.
- F3 verified against source planning/execution separation: policy D2 is supplied
  by the user already; D1 is later master-queue/execution authorization. Neither
  is now used as an invented source-coverage readiness blocker. A passing scoped
  review may make the plan ready while execution remains gated.
- Only planning documents changed. No code or implementation test was run.

## Previous verified planning artifact (before placement amendment)

- Pre-amendment plan blob `7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f`; raw SHA-256
  `7ef572d4c8eaf796d4a05fbbe8fa59bc7af95b08397049e57d65e14b047457b7`.
- Passing scoped independent review: `coverage-rereview.md`; raw SHA-256
  `c661e6d0abab2ec8777988eca9d2375fc040e2417258f6b4be6798aea1d01ea7`.
- Parent read the complete review and confirmed the unchanged reviewed plan
  hash. Text-only checks: 32 unique requirement rows, eight task contracts;
  reversed retry wording and nonexistent README reference removed. These are
  document integrity checks, not product implementation or test evidence.
- This review remains applicable to unchanged source obligations. It does not
  automatically certify the subsequent placement/compatibility delta.

## 2026-09-06 P6.5 compatibility and P6.6 placement amendment

- Read the complete P6.5 plan, the feature plan and the complete
  364-line original attachment. P6.5 remains the sole RG-1–RG-6 owner; P6.6 owns
  the 32 EP obligations through their single internal BP phase owners.
- Kept the plans separate and recorded binding boundaries for critic skips and
  corrected coverage, intentional failed evidence versus required passing
  checks, repair/replan lineage, context identity, two-pass final verification,
  portable resource claims and distinct delivery doctrines. No P6.5 mechanism
  is reimplemented or weakened by the planning amendment.
- Updated the master phase table, referenced traceability index (56 existing +
  32 EP obligations), queue, P7 dependency and charter; P6.5's placement-only
  instructions now preserve the new queue. New policy and efficient delivery
  rules are scoped to P6.6; old runs and active C4 controls are unchanged.
- Pre-edit document blobs for scoped review: master plan
  `567049f4b8768baa7b54ccf8663c49f2d2b1be13`; P6.5 plan
  `d097ce7c1d02d489dd5a33706072024333303f01`; feature plan
  `7dc424dcab5bd79410e5d49b7e8e0aa3d2311a8f`; master progress
  `7c7025a309daa685cdc309c0df8966261ceb8e66`; feature progress
  `ecf595e9fc674dcf772008e96b1c814a57a49bb5`.
- No tests, migrations, application/provider workloads, task branches,
  implementation agents, commits or staging were started. Documentation
  snapshots only were retained as Git objects for exact delta review.

## Historical verified planning artifact and amendment evidence — 2026-09-06

- Feature plan blob `6515b8e9ed29dc0d62e6a1ef0578e69a54890935`; raw SHA-256
  `2f918c7a5bbb670c2dfeeca07e72ac738858663b7dc8bfc270180747d99ee43e`.
- Reviewed master plan blob `6d1a131f52246f79e7611f21f802b907949a55a6` and
  P6.5 plan blob `b589dda53d3ae8601a606852f4bd8020085ba6c4`.
- Independent scoped review: `placement-review.md`; raw SHA-256
  `d3ad84ff44ca57ac23b5d9791dba4daed4483a2b88dce5a5842b9083dc81c9a4`.
  Parent read the complete report and verified all three plan blobs still
  matched. Subsequent progress edits record that result only; they do not
  alter the reviewed contracts or queue.
- Document checks: 56 unique original requirement IDs plus 32 unique EP IDs =
  88; eight T1–T8 contracts; one BP owner per EP row. BP owner counts are
  7/3/3/6/10/3 respectively. No stale direct P6.5-to-P7 dependency remains in
  the amended plans. Exact-delta whitespace check passed.
- Tracked code diff counts/status were unchanged across the amendment; all six
  audited core file hashes still match the source/repository table above.
  These are document/state integrity observations, not implementation tests.
- C4's executor explicitly confirmed it remains paused at the restored
  checkpoint with no command, fault or workload started by this request.
- Next execution work remains the existing P6/C4 queue when the owner resumes
  execution. No P6.6 packet is eligible before verified P6/P6.5. T1 is P6.6's
  first packet once its dependencies and execution authority are satisfied.

Resume planning by reading this index, the relevant plan sections and original
source, then any independent review record. Do not treat a drafted card or a
checkpoint as successful execution. Shared state belongs to the controller;
future worker reports remain separate referenced records.
