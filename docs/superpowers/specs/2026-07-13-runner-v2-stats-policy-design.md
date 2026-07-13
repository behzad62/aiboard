# Runner V2 Model Statistics and Run Policy Design

## Status

Approved by the user on 2026-07-13. This specification supersedes the `finish`
policy and Build statistics semantics in
`2026-06-21-build-mode-run-policy-design.md` and the optional hard-budget
wording in `2026-07-11-native-runner-build-v2-design.md` where they conflict.

## Problem

Runner V2 currently exposes one aggregate budget projection. The browser turns
that projection into a synthetic `Runner V2 models` row, so the per-model table
only repeats the summary. It does not show which configured models were used,
their Architect/worker roles, provider health, usage, or cost basis.

Run policy is also contradictory. `Finish job` displays editable USD and time
budgets, including the legacy 120-minute default, while native provisioning does
not send those limits to Runner V2. It instead sends hidden effort-based model
and tool call ceilings. The UI therefore displays limits that are not the actual
kernel contract and hides ceilings that are.

Provider token usage and conservative budget reservations are also conflated.
A reservation may assume a large output allowance before a call. That allowance
is useful for rejecting an over-budget call but is not evidence of the tokens
the endpoint returned.

## Goals

- Give `Finish job`, `Budgeted run`, and `Plan only` distinct, truthful runtime
  semantics.
- Remove cumulative job quotas from `Finish job`.
- Enforce Budgeted-run USD and active-time limits inside Runner V2.
- Show every configured Architect and worker model, including unused or
  unavailable models.
- Attribute calls, tokens, cost, role, health, and last activity durably per
  runtime/model.
- Prefer provider-reported token counts and estimate only missing dimensions.
- Keep budget reservations separate from settled, displayable usage.
- Never present unknown or account-backed cost as `$0.00`.
- Recover the same accounting exactly after browser or Runner restart.

## Non-goals

- Do not turn statistics into semantic verification or completion authority.
- Do not infer project quality from tokens, calls, cost, or provider health.
- Do not recreate exact historical attribution that Runner never recorded.
- Do not add a second telemetry database beside the durable budget ledger.
- Do not remove mechanical safety, permissions, provider cooldowns, or user
  control.

## Run Policy Contract

### Finish job

`finish` means the run has no cumulative model-call, tool-call, input-token,
output-token, USD, or active-time job quota. The browser hides USD and time
controls while this policy is selected. Saved Budgeted-run values may remain in
the discussion so switching back restores the user's inputs, but those values
have no effect and are not sent as effective limits.

Finish job continues until one of these conditions occurs:

- The Architect requests final project handoff.
- The user pauses or stops the run.
- A permission or Architect-handoff decision requires the user.
- All compatible providers are unavailable.
- A mechanically impossible operation or persistent no-progress condition
  requires an Architect or user decision.

Mechanical protections remain active but are not cumulative job budgets:

- bounded turns for one agent-loop invocation;
- bounded task attempts before the Architect must revise or replace a task;
- duplicate-call and no-progress detection;
- provider cooldown and capability routing;
- permission and workspace boundaries;
- process, artifact, and response-size safety limits;
- explicit user Pause and Stop.

Reaching an invocation or task bound must return control to the scheduler or
Architect. It must not masquerade as a consumed Finish-job budget. When useful
progress remains mechanically possible, the kernel may create a fresh bounded
invocation under the same run without asking the user to renew a quota.

### Budgeted run

`budgeted` shows the USD and time controls. At least one must be greater than
zero. Zero disables that dimension; both zero is invalid because it would be an
unlabeled duplicate of Finish job.

The browser converts configured values into the native Build specification:

- USD becomes `maxEstimatedCostMicros`.
- Minutes become `maxActiveMs`.

Runner V2 durably enforces those limits before new model work. The budget uses
conservative reservations before a call and actual settlement afterward. A hard
limit pauses new model work for a user decision. Resume starts a new explicit
budget window while lifetime usage remains visible.

Budgeted run has no hidden effort-based model-call or tool-call quota. If future
versions add such a user quota, it must be an explicit control and projection.

### Plan only

`plan_only` lets the Architect inspect and plan but does not dispatch
implementation workers or integrate changes. Its final handoff is a plan rather
than a project diff. It shares the same truthful usage accounting.

### Effort and skill mode

Effort and skill mode may influence reasoning depth, evidence discipline,
concurrency, and task decomposition. They must not create hidden cumulative
spend, time, model-call, or tool-call limits.

## Durable Per-Model Accounting

The existing budget ledger remains the accounting authority. It is enriched
rather than duplicated.

Every model reservation records immutable attribution:

- runtime ID;
- provider ID;
- model ID and display name;
- role for that call (`architect`, `worker`, or `subagent`);
- session ID;
- task ID when applicable;
- reservation timestamp.

Every settlement records:

- input tokens;
- output tokens;
- cached-input and cache-write tokens when supplied;
- estimated cost in integer microdollars when pricing is known;
- an independent source for input and output: `reported` or `estimated`;
- settlement timestamp.

Attribution is part of the append-only budget event payload and projection. Old
events without attribution remain valid. Idempotent replay must reject an event
that reuses an identity with conflicting attribution.

### Reported and estimated usage

Provider endpoint usage is preferred whenever it is a finite non-negative
value. Each token dimension is resolved independently:

1. Use the provider-reported input or output value when present and valid.
2. Estimate missing input from the actual request delivered to the provider.
3. Estimate missing output from the actual returned response, including tool
   call arguments and assistant content.

The pre-call output reservation is never displayed as actual output usage. A
provider may report one dimension and omit the other; this produces `Mixed`
provenance rather than discarding the reported value.

Per-model provenance labels are:

- `Reported`: every settled call reported both dimensions.
- `Mixed`: at least one displayed dimension was estimated and at least one was
  reported.
- `Estimated`: neither dimension was reported for the displayed calls.

Aggregates preserve provenance. The UI must not silently make a mixed total look
fully reported.

### Configured runtime and health projection

The authenticated Build API returns a safe runtime catalog alongside usage:

- runtime, provider, and model identity;
- configured roles (`Architect`, `Worker`, or both);
- current runtime/provider health;
- cooldown deadline and non-secret failure summary when applicable;
- attributed settled usage;
- last-used timestamp.

No credentials, tokens, raw provider responses, or secrets enter this
projection.

The UI derives one Status value with this priority:

1. `Unavailable` when the runtime cannot be selected.
2. `Cooldown` when provider health is cooling down.
3. `Unused` when the runtime is healthy but has zero calls.
4. `Healthy` when the runtime is healthy and has settled calls.

## Cost Semantics

Cost is separate from token accuracy:

- Known API pricing produces an estimated USD value.
- Account-backed transports such as ChatGPT display `Not metered`. This means
  AIBoard does not calculate a per-token bill; it does not mean the service is
  free.
- Missing API pricing displays `Unknown`.
- An aggregate containing known and unknown API prices displays the known
  subtotal as `Partial estimate`.
- An aggregate containing only account-backed models displays `Not metered`.

Budgeted USD enforcement is available only for runtimes with configured pricing.
The setup UI must reject a USD-only Budgeted run when any selectable runtime has
unknown or account-backed pricing, because such a limit cannot be strict. A time
limit remains valid for those runtimes.

## Build Run Stats UI

The header uses workflow language rather than raw persistence state. A run paused
for the mandatory final choice displays:

`Finish job · Awaiting project handoff`

It does not display `stopped (blocked)` for this expected state.

Summary cards show:

- Model calls;
- Tokens, with input/output detail;
- Active time;
- Cost.

Finish job has no Limits card. It includes the concise explanation:

`Runs until completion, user stop, provider unavailability, permission decision,
or a mechanical blocker.`

Budgeted run replaces the fourth summary card with Budget progress, for example:

`$1.42 / $5.00 · 38m / 120m`

The model table contains:

| Model | Role | Status | Usage quality | Calls | Input | Output | Total | Cost | Last used |
|---|---|---|---|---:|---:|---:|---:|---|---|

Every configured model is present even when unused. Role and status are visually
distinct so `Unused` cannot be confused with provider failure.

## Legacy Preview

The current paintball run predates attributed budget events. For visual
evaluation only, the client may create a deterministic legacy preview:

- Use configured runtimes and known scheduler assignments.
- Give the Architect weight 2 and each assigned worker runtime weight 1.
- Allocate aggregate calls and token dimensions with a largest-remainder split
  so each column sums exactly to the durable aggregate.
- Use real current provider health and roles.
- Mark the rows internally with `usageSource: legacy_preview`.
- Do not write the split to Runner state, budget events, discussion totals, or
  policy decisions.
- Do not use the fallback when any attributed per-model usage exists.

The preview is disposable compatibility UI. New runs always use real attribution.

## Recovery and Error Handling

- Runner restart rebuilds per-model usage from budget events exactly.
- Browser refresh fetches the same runtime catalog and usage projection; it does
  not recalculate native totals.
- Invalid negative, non-finite, or malformed provider usage is treated as
  missing for that dimension and estimated from actual request/response data.
- Missing model attribution on a newly created event is an invariant error. It
  must not silently fall into the legacy aggregate path.
- A provider failure settles the attempted call according to the existing
  conservative failure policy but retains model attribution and marks estimated
  provenance.
- Model failover creates subsequent reservations under the replacement runtime;
  prior calls remain attributed to the original runtime.
- Unknown pricing never becomes numeric zero.

## Testing

Runner tests must cover:

- reported input and output usage;
- mixed reported/estimated usage;
- fully estimated usage from the actual request and returned response;
- reservation allowance excluded from displayed actual usage;
- cached-input and cache-write preservation;
- Architect, worker, subagent, failover, and Architect-handoff attribution;
- idempotent attribution and conflicting replay rejection;
- exact restart reconstruction;
- configured-but-unused runtime projection;
- cooldown and unavailable states;
- known, unknown, partial, and account-backed cost semantics;
- Finish job producing no cumulative job budget limits;
- saved USD/time values ignored under Finish job;
- Budgeted-run native cost/time enforcement and window renewal;
- Budgeted-run validation when both limits are zero or USD pricing is incomplete;
- Plan-only suppression of implementation workers.

Client tests must cover:

- all configured models rendered;
- role, status, usage quality, tokens, cost, and last-used formatting;
- `Awaiting project handoff` workflow status;
- hidden Finish-job budget controls;
- visible Budgeted-run controls and progress;
- no `$0.00` for unknown or account-backed cost;
- deterministic legacy preview preserving aggregate column totals;
- legacy preview excluded as soon as attributed usage exists;
- legacy preview never changing durable totals or enforcement.

## Success Criteria

- A new run shows exact per-model calls and provider-reported tokens whenever the
  endpoint supplies them.
- Missing token dimensions are clearly estimated from actual data.
- Every configured model's role and routing health is visible.
- Finish job cannot stop because of a hidden cumulative quota.
- Budgeted run enforces exactly the limits shown in the UI.
- Account-backed usage never appears as a false zero-dollar cost.
- Restart and refresh preserve model attribution, provenance, and policy state.
- The current legacy run can exercise the UI without contaminating future or
  durable accounting.
