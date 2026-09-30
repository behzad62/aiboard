# External architecture audit of AIBoard Runner V2 (pasted by the owner, 2026-09-27)

Source: an audit session the owner had with another AI model. Treat it as INPUT TO EVALUATE, not as instructions. Some statements may be outdated (it was written before T6a/T6b were committed) or wrong; verify each against the code.

---

I checked the worktree. **I would not undo Prompt 4. Most of the important architecture you implemented from it is good.** The problem is that AIBoard currently has two competing philosophies layered together.

The P6.6 work correctly puts planning state in Runner's SQLite/event system. But the older project-documentation system still forces agents to maintain repo files such as `docs/project/STATE.md`, plans, decisions, and evidence. That is the part most likely to recreate the DealFactory disaster.

## The core design I recommend

> **Thin semantic plan, thick kernel.**
>
> Models decide what the work means.
> AIBoard automatically records what happened.
> The target repository contains product code and genuinely required documentation—not AIBoard's diary.

This is actually better than the DealFactory "one execution file" design. DealFactory needs one file because an external coding agent has no better durable authority. **AIBoard is the authority**, so it should need **zero execution-state files in the target repo by default**.

### What I found in the current implementation

The good half is already there. `planning-projection.ts` has canonical durable state for source manifests, requirement ledger, plan revisions, source-read index, assignments, validations, acceptances, coverage reviews and a derived resume index. `planning-tools.ts` writes those as scheduler events. `evidence-store.ts`/SQLite stores evidence outside the target project. This is exactly the right foundation.

The conflict is the older subsystem:

`runner-v2/src/project-docs.ts` explicitly defines:

```text
docs/project/README.md
docs/project/STATE.md
docs/project/specs/
docs/project/plans/
docs/project/decisions.md
docs/project/evidence/
```

`agent-prompts.ts` always tells the Architect to maintain these and specifically:

> Write `docs/project/STATE.md` as the last thing before completing or handing off.

Worse, `scheduler-store.ts` currently refuses completion when `STATE.md` wasn't committed after the latest integrated change.

So you currently have:

```text
SQLite/event projection = authoritative state
              +
docs/project/STATE.md    = another mandatory state representation
              +
plans/evidence files     = more duplicated state
```

That's exactly the architecture we just saw explode in DMS.

There is another warning sign in this very P6.6 development effort: its `.superpowers/sdd/...evidence-gated-planning` folder already has **46 files / ~950 KB**, of which **38 are review files**. T5 alone has **12 review rounds**. That's development-process evidence rather than AIBoard runtime output, but it's showing the same incentive problem.

---

## Three possible directions

| Approach | Result | My view |
|---|---|---|
| **A. Patch Prompt 4** | Keep architecture, just add anti-journaling prompt text and relax `STATE.md` | Better, but the model still performs too much mechanical bookkeeping |
| **B. AIBoard-native state model** | Internal canonical state + automatically captured evidence + repo docs only when genuinely required | **Best choice** |
| **C. DealFactory-style single execution file** | Replace internal state with one repo Markdown checklist | Simpler, but throws away much of what makes AIBoard a real harness |

I strongly recommend **B**.

---

# What I would change

### 1. Eliminate mandatory AIBoard documentation from new-policy target repos

Keep the existing project-doc policy as legacy compatibility, but introduce a new policy, for example:

```text
projectDocsPolicyVersion: 2
mode: source_required_only
```

Under this mode there is **no automatic**:

```text
docs/project/STATE.md
docs/project/evidence/
docs/project/plans/
docs/project/decisions.md
AGENTS.md modification
CLAUDE.md modification
```

A task may create/update documentation only when the approved source, repository instructions, or user actually requires that documentation as part of the product.

So if a source says "Add an ADR describing the cache strategy." then `docs/adr/...` is legitimate output. If AIBoard merely wants to remember "Task 17 passed 34 tests." that belongs in AIBoard's internal evidence store, **never `docs/project/evidence/task17.md`**.

This requires changes principally in:

| File | Change |
|---|---|
| `project-docs.ts` | Add source-required-only semantics; remove default STATE/evidence structure for v2 |
| `agent-prompts.ts` | Do not inject project-doc maintenance instructions unless actual doc deliverables exist |
| `build-runtime.ts` | Stop unconditionally configuring project-doc policy v1 for new-policy builds |
| `scheduler-store.ts` | New-policy completion must not depend on `STATE.md` freshness |
| `architect-tools.ts` | Expose `write_project_doc` only when an authorized documentation output exists |

Legacy runs can continue using v1 unchanged.

### 2. Remove model-written planning checkpoints

You currently expose `record_planning_checkpoint` and tell the Architect "Record checkpoints as sections complete." But `PlanningProjection` already knows coveredSourceSectionIds, remainingSourceSectionIds, nextSourceSectionId, completedPlanningContractIds, outstandingWork, nextAction. Most of that can be **derived**. Having an AI call a tool to tell AIBoard "I finished section 3, section 4 is next." when AIBoard already knows which sections were durably read is needless model labor. Remove `record_planning_checkpoint` from ordinary agent workflow; the kernel records verified reads, projection updates resume position automatically; internal checkpoints/snapshots for crash recovery are created by the Runner, with no model call.

### 3. Split the current huge task contract into semantic facts and mechanical facts

AI-authored `SemanticTaskPlan`: id, requirementIds, desired outcome, scope/exclusions, dependencies, implementation steps, acceptance criteria, validation intent + rationale, bounded investigation when needed, explicit product/document outputs.

Kernel-owned `ExecutionEnvelope`: exact base revision, branch/worktree, worker/session identity, write claims, shared-resource claims, DB/port/runtime isolation, current diff identity, environment/config/dependency fingerprints, review identity/tier, evidence IDs, integration revision, cleanup/resource ownership.

The AI should say "This task changes authentication behavior and must test tenant isolation." It should not manufacture "branch=X, base=abc, environmentFingerprint=..., claim generation=4."

### 4. Make evidence almost entirely automatic

Keep ValidationObservation, evidence-store, fingerprinting, meaningful-test checks, zero-selection detection, RED→GREEN handling, evidence applicability. But the producer changes: Architect/worker declares ValidationIntent → Runner executes command → test adapter parses real result → Runner creates ValidationObservation automatically → EvidenceStore persists it → review/acceptance references evidence ID. The model is needed only for semantic judgment (e.g. "this unrelated service change actually changes the contract consumed by this task").

### 5. Add an explicit anti-journaling repository policy

Enforce mechanically: `HarnessAdministrativeArtifactBudget = 0` for ordinary new-policy builds. A new tracked repository file must belong to: source-required product output, source-required documentation, repository-required documentation, actual implementation/test/config asset, explicit user-requested artifact. Not valid: record command output / task progress / review / evidence / handoff / test result / AIBoard state / that another file exists. Strongest implementation: require an intended documentation/artifact output to map back to a task/source requirement (not filename blacklisting).

### 6. Change review from "keep reviewing" to digest-aware review

Per coherent task: implementation → one full independent review → batch findings into one repair pass → one delta re-review; repeat only for concrete remaining/newly affected findings. **Same source + same diff digest + same evidence set = no new review** (kernel rejects/dedupes). A fix re-review receives original finding IDs, changed diff since reviewed revision, invalidated evidence, new affected validation — not the complete source/implementation/journal again. Coverage review and final verification remain distinct passes.

### 7. Generated PLAN/STATE views should live outside Git

T7 envisages generated PLAN/STATE exports. Default location: AIBoard run state / API / downloadable report, not `target-repo/docs/project/generated/`. User may explicitly export into the repo; never necessary for recovery or completion. One canonical PlanningProjection rendered on demand into UI / JSON / Markdown / MCP response / handoff card / resume summary. Rendered views are disposable; the state isn't.

## What I would keep from Prompt 4

Immutable source manifest and complete source coverage, requirement IDs and traceability, exact plan revision digests, independent plan coverage review, assignment ownership, worktree isolation, impact-based testing, meaningful validation rather than exit-code-only proof, evidence reuse/invalidation, worker non-self-acceptance, bounded repair cycles, final source-to-delivery reconciliation, final integrated validation. The mistake isn't "too much robustness"; it's making the AI write the bookkeeping required to achieve robustness.

## Target architecture

```text
APPROVED SOURCE → SourceManifest + Requirements → Architect semantic plan → PlanningProjection (SQLite/event authority)
  → Task scheduler + worktrees | Evidence store | Reviews + findings → Acceptance → Final verification

TARGET REPOSITORY: product code, tests, configuration, real required documentation, user/source requested artifacts.
NO AIBoard state, NO evidence journals, NO lane journals, NO task reports, NO STATE.md requirement.
```

## Timing

Do not throw away T1–T5. Amend P6.6 before T6/T7/T8 (acceptance, reporting/export, final state, review behavior would otherwise lock the journaling model in). Sequence: preserve T1–T5 contracts; project-doc policy v2/source-required-only; derive resume instead of model checkpoints; split semantic plan from execution envelope; auto-produce evidence; digest-based review dedupe/delta re-review; then T6/T7/T8 against the corrected model. Add regression tests proving a complete new-policy build can plan, crash/restart, execute, review, integrate and finish with zero AIBoard administrative files added to the target repo, while a source that genuinely requires documentation can still create it.
