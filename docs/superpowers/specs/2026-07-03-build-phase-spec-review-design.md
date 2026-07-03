# Build Phase Spec Review Design

## Status

Approved design direction from the user on 2026-07-03. This spec describes the Build mode workflow change before implementation planning.

## Problem

Build mode currently has one combined Architect or Reviewer verdict per worker task. That review can consider requirements and code quality, but the engine only sees one `approve` or `fix` outcome. A task can therefore be marked done without a structured record that the implementation both followed the intended phase spec and met a code-quality bar.

The desired workflow is:

```text
Architect phase spec -> worker implementation -> spec-compliance review + code-quality review -> fixes until both approve
```

The "spec" here is not a whole-build requirements document. It is the current phase or wave contract: what this slice of work must accomplish, which files it owns, what acceptance criteria matter, and what verification evidence should exist.

## Goals

- Make each Build wave start from an explicit current-phase spec.
- Give workers that phase spec as part of their task context.
- Make review return separate spec-compliance and code-quality verdicts.
- Mark a task done only when both gates approve.
- Send tasks back to fixing with targeted instructions when either gate fails.
- Preserve the existing single reviewer call per wave to avoid doubling review cost and latency.
- Keep deterministic Build quality gates as final backstops, not replacements for phase-level review.

## Non-goals

- Do not add two separate model review calls in this iteration.
- Do not require a whole-project formal spec before Build mode can start.
- Do not redesign the Build UI beyond showing useful phase/gate status where the existing task/status surfaces already fit.
- Do not make benchmark scoring depend on subjective reviewer prose beyond the existing approve/fix class of outcome.

## Architecture

Build mode keeps the current orchestration shape:

```text
plan -> worker wave -> automated verification -> reviewer inspection loop -> task state updates -> repeat
```

The review protocol becomes more structured:

- The Architect creates or updates a compact `phaseSpec` for the current wave.
- Each planned task is associated with the current `phaseSpec`.
- Workers receive the phase spec plus the specific task.
- The Reviewer returns two verdict dimensions for each reviewed task:
  - `specVerdict`: whether the landed work satisfies the phase spec and task contract.
  - `qualityVerdict`: whether the landed work is maintainable, scoped, integrated, and verified well enough.
- The engine treats the task as complete only when both verdicts are `approve`.

The optional `reviewerModelId` remains useful: if configured, that model performs the combined two-gate review. If not, the Architect performs it.

## Phase Spec

Add a small `BuildPhaseSpec` shape in `lib/orchestrator/build.ts`:

```ts
export interface BuildPhaseSpec {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  qualityCriteria: string[];
  verification: string[];
  constraints?: string[];
}
```

The spec should be short enough to fit worker and reviewer context. It should describe the current phase, not all remaining project work.

Examples of acceptance criteria:

- The requested setting appears in the Settings page and persists through reload.
- Existing provider custom model flows continue to work.
- Invalid input shows a visible validation error.

Examples of quality criteria:

- Keep provider-specific behavior in the provider registry layer.
- Do not add server APIs; the app remains fully client-side.
- Cover parsing or state-transition changes with focused tests.

## Protocol Changes

`PlanAction` should gain `phaseSpec: BuildPhaseSpec`. The planning prompt should require it before tasks:

```json
{
  "action": "plan",
  "phaseSpec": {
    "id": "P1",
    "objective": "Add the phase-gated review protocol.",
    "acceptanceCriteria": [
      "Review results expose independent spec and quality verdicts.",
      "A task is marked done only when both verdicts approve."
    ],
    "qualityCriteria": [
      "Keep review parsing tolerant of existing outputs.",
      "Cover parser and state-transition behavior with focused tests."
    ],
    "verification": ["npm run lint", "npx tsx scripts/test-parse-action.mts"]
  },
  "tasks": []
}
```

`ReviewAction.results` should replace the single `verdict` with two gate verdicts:

```json
{
  "taskId": "T1",
  "specVerdict": "approve",
  "qualityVerdict": "fix",
  "specIssues": "",
  "qualityIssues": "The parser change lacks compatibility coverage.",
  "fixInstructions": "Add tests for legacy review verdict parsing and rerun the parser script."
}
```

For compatibility, the parser must accept the legacy `verdict` field during migration:

- `verdict: "approve"` maps to both `specVerdict` and `qualityVerdict` as `approve`.
- `verdict: "fix"` maps to both gates as `fix` unless one explicit new gate is present.

This keeps older checkpoint text and tolerant parsing from breaking existing runs.

## Engine Behavior

Task state update rules:

- `specVerdict === "approve"` and `qualityVerdict === "approve"` marks the task `done`, subject to existing deterministic blockers such as missing skill evidence.
- Any `fix` verdict sends the task to `fixing`.
- Fix instructions include both spec and quality issues, clearly labeled.
- Omitted explicit verdicts still send the task back for fixing, as today.
- Forced or malformed review fallback must not silently approve. It should produce a fixing instruction that asks for explicit two-gate review evidence.

Phase spec persistence:

- Store the active phase spec in the Build checkpoint.
- Store the phase spec or its id on each `BuildTask` so delayed tasks are reviewed against the spec they were assigned under.
- When review creates `newTasks`, it may also provide a next `phaseSpec`. If it omits one, the engine reuses the current spec and tells the reviewer to be explicit on the next cycle.

Automated verification:

- The existing per-wave `verifyCommand` still runs before review.
- Final Build quality gates still run after all tasks are done.
- Failed verification should normally drive `qualityVerdict: "fix"` or a verification fix task.

Scoreboard:

- Keep one worker outcome per reviewed task attempt.
- Count a task as approved only when both gates approve.
- Count a task as a fix when either gate requires fixing.
- Optionally record spec-vs-quality failure counts later, but do not expand benchmark scoring in this change.

## Prompting

Planning prompt:

- Ask the Architect to create a current-phase spec first.
- Tell it that workers and reviewers will be bound to this spec.
- Keep tasks self-contained and make their instructions reference relevant phase criteria.

Worker prompt:

- Show the current phase spec before the task.
- Tell workers to satisfy acceptance criteria and quality criteria for their owned files only.
- Keep the existing file ownership and patch/append rules.

Review prompt:

- Review against the phase spec, task instructions, landed change digest, targeted reads/searches, automated verification, and skill evidence.
- Return both verdicts for every reviewed task.
- Approve only when the spec is satisfied and the code-quality bar is met.
- Separate spec issues from quality issues so fix rounds are actionable.

## Testing

Focused tests should cover:

- Parsing a plan with `phaseSpec`.
- Parsing review results with separate `specVerdict` and `qualityVerdict`.
- Legacy `verdict` compatibility mapping.
- Engine task update rules for:
  - both approve -> `done`
  - spec fix only -> `fixing`
  - quality fix only -> `fixing`
  - omitted verdict -> `fixing`
- Checkpoint serialization and resume with active phase spec.

Existing scripts to run after implementation:

```bash
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-extract.ts
npm run lint
```

Add or extend a plain `tsx` script if current parser tests do not reach the new task-state behavior cleanly.

## Rollout

Implement in small steps:

1. Add the phase spec and two-gate review types/parser support.
2. Update prompts and schemas.
3. Persist active phase spec and associate tasks with it.
4. Update review state transitions.
5. Add focused tests.
6. Update Build mode copy or diagnostics where task review status is shown.

This can ship without a storage migration because existing checkpoints can default to a synthetic phase spec derived from Architect notes, task instructions, and the original user request.
