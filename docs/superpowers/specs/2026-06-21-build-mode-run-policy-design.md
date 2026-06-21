# Build Mode Run Policy, Recovery, and Activity Design

## Status

Approved design direction from the user on 2026-06-21. This spec is for planning implementation; it does not prescribe a final code order.

## Problem

Build mode currently inherits controls that were designed for discussion modes. `Low`, `Medium`, and `High` express rounds, task waves, and worker-call ceilings, but a user asking Build mode to implement a feature expects the workflow to finish unless it reaches a clear budget, time, user stop, or real blocker.

The current Build page also behaves like a long discussion transcript. It can show full model responses across many rounds, and the activity log repeats per-call token details such as `estimated 18,734 tokens`. That is noisy for Build mode. Build users need an operational view: progress, task state, branch/PR state, spend/time, and aggregate model usage.

Tool usage is also too constrained. The engine asks models to emit only one tool action per turn. That keeps execution simple and observable, but it slows obvious inspection batches such as reading several files or searching several patterns.

## Goals

- Make Build mode default to finishing the requested job.
- Let users cap spend with understandable money and time guardrails.
- Remove worker-call count as a stopping rule.
- Stop runaway loops without creating frequent false "build failed" states.
- Let the model request small batches of safe tool actions.
- Replace the Build-mode default transcript view with a compact workflow view.
- Show token and cost usage as aggregate stats, using compact notation such as `18.7k`.
- Preserve a useful resumable checkpoint when stopped by budget, time, user stop, or blocker.

## Non-goals

- Do not redesign panel, debate, or specialist discussion modes.
- Do not merge Build branches automatically.
- Do not make GitHub PR review or merge automatic; human review remains the gate.
- Do not create a full general-purpose agent runtime in this iteration.

## Build Run Policy

Build mode gets a Build-specific run policy instead of treating effort as the workflow budget.

Policies:

- `finish`: default. Continue until the job completes, the user stops it, a configured guardrail is reached, or the engine detects a repeated blocker.
- `budgeted`: run until the configured USD or time budget window is consumed, then stop cleanly with a resumable checkpoint.
- `plan_only`: optional policy for creating a plan, GitHub milestones, and GitHub issues without implementing code.

Spend guardrails:

- `buildBudgetUsd`: number. `0` means unlimited.
- `buildTimeLimitMinutes`: number. Default `120`. `0` means unlimited.
- The two limits are independent. Either one can stop a budgeted run; either can be disabled.
- If both are unlimited, Build mode runs until completion, user stop, or blocker.

Resume behavior:

- Resume keeps branch, files, task graph, GitHub refs, failures, and Architect notes.
- Resume starts a fresh budget window with USD spent reset to `0` and time elapsed reset to `0`.
- The user can change Build settings before resuming.

Worker-call count:

- Worker calls are telemetry only.
- Worker calls never stop Build mode.

Token ceilings:

- Per-response `maxTokens` values stay as safety ceilings so a single response cannot grow without bound.
- They are not workflow budgets and should not be presented as the user's budget.
- Workers should keep a high enough output ceiling for real implementation output.
- Architect/summary calls should keep a high enough ceiling for plans, reviews, and handoff summaries.

## Failure Recovery

Build mode should recover automatically before it stops as blocked. The engine should distinguish failed attempts from no-progress loops.

Progress signals:

- Files changed successfully.
- A build/test failure changed shape after a fix.
- The Architect added a more specific fix task.
- An oversized or ambiguous task was split.
- A different worker produced usable output.
- Branch, issue, milestone, push, or PR state advanced.

No-progress guards:

- Same task fails with the same error shape after several repair attempts.
- Same command fails with the same key error after fixes were attempted.
- Architect repeats the same action several times.
- Worker repeats malformed, duplicate, or no-op output several times.
- Review cycles keep adding duplicate tasks without resolving anything.

Recovery behavior:

- Retry a failed task with exact error/output context.
- Reassign the task to another worker when available.
- Split large tasks into smaller tasks.
- Ask the Architect for a targeted repair plan after repeated failure.
- Run focused test/build-fix loops.
- Stop as blocked only after repeated no-progress recovery attempts.

Stopped state:

- A blocked or budget-stopped run must be resumable.
- The summary must say what was completed, what remains, what failed, what recovery was attempted, and what user action may be needed.

## Tool Scheduler

The model may request multiple tool actions in one response. The engine classifies and schedules them instead of rejecting the whole response.

Batch-safe reads:

- `read`
- `read_range`
- `search`
- `repo_status`
- `repo_diff`
- `repo_issue_list`
- `repo_issue_read`

Queued mutations:

- `patch`
- `append`
- `repo_branch_create`
- `repo_commit`
- `repo_push`
- `repo_pr_create`
- `repo_milestone_create`
- `repo_issue_create`

Conditionally safe shell queue:

- In full-access mode, the engine may run a small queue of commands classified as read-only or normal verification.
- Examples: `git status`, `git diff`, `rg`, `npm test`, `npm run build`.
- Unknown, risky, or state-mutating commands remain single-step and approval-gated.

Execution rules:

- Safe reads may run together.
- Mutations run in order.
- Writes to the same path cannot overlap.
- Git and GitHub state mutations serialize.
- Approval UI shows the full batch when approval is needed.
- The engine reports which requested actions were served, partially served, skipped, denied, or deferred.

Tool result packing:

- The engine returns one combined tool-result message to the model.
- Results are capped conservatively so the combined response fits common model contexts.
- Large results are truncated or summarized with explicit omitted ranges.
- A skipped request is never silent. The model sees why it was skipped.

Example shape:

```text
TOOL BATCH RESULT

Served:
- read package.json
- read app/page.tsx
- search "BUILD_LIMITS"

Skipped:
- read .next/cache/...: output cap reached
- run "npm install": unsafe command, requires separate approval

Results:
...
```

## Build Discussion View

Build mode should not default to a full round-by-round transcript. It needs a Build run dashboard.

Top stats segment:

- status
- current branch
- PR URL when available
- budget policy
- current budget-window USD spent and time elapsed
- total estimated tokens by model
- estimated USD by model when pricing is known
- unknown-priced model count or warning when applicable

Token notation:

- Use compact notation everywhere in Build stats and activity: `18.7k`, `1.2M`.
- Avoid long integers in normal UI unless the user opens a detailed diagnostics view.
- Aggregate by model with input, output, and total tokens.

Default Build content:

- Build overview
- Task board
- Repo/GitHub workflow panel
- Generated/modified files
- Compact activity log
- Final handoff summary

Transcript handling:

- Full model responses are collapsed by default in Build mode.
- A separate "Transcript" or "Diagnostics" view can expose raw model turns for debugging.
- The raw transcript remains exportable or downloadable.
- Worker implementation outputs should be represented through task status, file changes, diagnostics, and artifacts rather than full prose dumps.

Activity log behavior:

- Do not show token usage on every activity row.
- A model completion row should show model, provider, phase/turn, and short status.
- Token usage belongs in the top stats segment and optional diagnostics.
- Tool batch rows show served/skipped counts and enough detail to audit actions.

## Data Model

Optional fields on `Discussion`:

- `buildRunPolicy?: "finish" | "budgeted" | "plan_only"`
- `buildBudgetUsd?: number`
- `buildTimeLimitMinutes?: number`
- `buildStopReason?: "budget" | "time" | "blocked" | "user" | "completed"`
- `buildStoppedAt?: string | null`

Structured checkpoint:

- Add a `BuildCheckpoint` record keyed by `discussionId`.
- Store task graph and statuses.
- Store branch, PR, milestone, and issue refs.
- Store completed and remaining tasks.
- Store failure fingerprints and recovery attempts.
- Store last Architect notes.
- Store current budget-window estimated spend and elapsed time.

Cost tracking:

- Build mode already emits estimated token usage per model call.
- Convert token usage to estimated USD using pricing data and user overrides.
- Dollar guardrails are strict only for models with known pricing.
- If selected models have unknown pricing, label spend as partial and surface a warning. The user can add pricing overrides to make the budget stricter.

## Settings And Labels

Dashboard Build mode:

- Replace `Effort level` with `Run policy`.
- Show `Budget guardrails` with USD and time fields.
- Keep `Reasoning effort`.
- Rename Build-mode `Answer detail` label to `Handoff detail`; keep the existing persisted `verbosity` field unless a new field becomes necessary.
- Keep support for one or more worker models plus Architect.

Settings defaults:

- Default Build run policy.
- Default Build USD budget.
- Default Build time budget.
- Default Build handoff detail.
- Reuse or optionally separate default Build reasoning effort.

## Testing

Tests should cover:

- USD budget `0` means unlimited.
- Time budget `0` means unlimited.
- Budgeted run stops with a resumable checkpoint.
- Resume resets the active budget window but preserves task state.
- Worker-call count does not stop Build mode.
- Repeated no-progress failure fingerprints eventually stop as blocked.
- Progress signals prevent premature blocked states.
- Batched reads return served/skipped lists.
- Unsafe tool batches are split, deferred, or rejected safely.
- Build UI hides legacy effort-budget language.
- Build activity rows do not show per-call token usage by default.
- Top stats aggregate token usage per model using compact notation.
- Unknown-priced models show partial spend warnings.

## Implementation Notes

Keep this iterative:

1. Add Build-specific settings and remove worker-call stopping.
2. Add budget/time guardrails and resumable stop state.
3. Add aggregate Build stats UI and compact Build activity display.
4. Add checkpoint persistence for reliable resume.
5. Add safe tool batching.
6. Strengthen failure recovery and blocked-state fingerprints.

The order can change if code dependencies make a different sequence safer, but each step should leave Build mode usable.
