# Task cohesion and independent reviewability

Rechecked against the product Runner V2 implementation on 2026-10-26.

## Audit result

The pasted audit's central finding was correct: a task is already a unit of
delivery, rather than an individual tool action. A worker can inspect, edit,
test and correct multiple files before submitting one immutable changeset.
The existing acceptance, review, integration and dependency machinery should
be retained.

Before this change, both the plan critic and the evidence-gated coverage
reviewer checked for oversized or independently unverifiable tasks, but
neither explicitly checked for unnecessary fragmentation or unrelated
outcomes bundled into one task. Structural validation cannot determine
semantic cohesion; the Architect and independent reviewer remain responsible
for that judgment.

Two qualifications to the original audit matter:

- The one-model-response planning instruction is in
  `lib/orchestrator/build.ts`, used by the legacy benchmark path. Product
  Build uses `lib/client/native-build-engine.ts` and `runner-v2/src/`.
  Changing the benchmark planner would not fix product planning.
- A database migration, foundation, test, small fix or investigation can be
  independently reviewable. Judge its actual deliverable and acceptance
  boundary; its position in a dependency chain or its file count does not
  make it too small. There is no reliable deterministic PR-size threshold.

This is an implementation audit, not a measurement of completed live-model
changesets or proof that every future model will choose good boundaries.

## Planning rule

Each implementation task should deliver one coherent change whose outcome
can be accepted when its declared dependencies are available. Keep its
necessary implementation, exports/wiring and targeted tests together. Put
individual coding actions in the contract's `steps` field.

Merge fragments that have no distinct useful outcome or acceptance boundary.
Split unrelated outcomes and changes too broad for one focused review.
Do not size tasks by one response, one file, one method, line counts or the
number of available workers. A bounded investigation, verification or repair
may deliver evidence or a decision instead of code.

The current Architect prompt and both planning tool contracts carry the shared
rule from `runner-v2/src/task-cohesion.ts`. Frozen legacy prompt text stays
compatible. The plan critic and coverage verdict/re-review prompts share the
same cohesion review instructions; blind source-obligation derivation still
receives no task plan.

The shared finding vocabulary now includes `undersized_task` and
`incoherent_task`, alongside `oversized_task`. Reviewers must name the affected
tasks, cite concrete outcomes/criteria/dependencies, and propose a specific
merge or split with a reason. Blocking findings flow through the existing
resolution/readiness gates. Sound small changes and evidence-only tasks do
not require artificial code or additional tasks.

New planning reviews also require [structured evidence for every blocking
finding](./planning-finding-evidence.md). In particular, a dependency finding
must name the actual consumed output, cite the consumer's existing criterion
and explain a concrete failure if the producer has not run. Related features
and optional enhancements alone do not justify serializing tasks.

Planning without evidence gating retains its existing risk-based/always/off
critique policy. This change does not introduce a mandatory model call for
each low-risk plan or change the owner's selected review policy.

## Decomposition diagnostics

The existing authenticated
`GET /v2/runs/:runId/build/observability` response exposes optional
`taskDecomposition` data, also typed in the browser client. Live and terminal
historical readers derive it from the full durable event history, before the
displayed event list is truncated. No new scheduler authority or migration is
introduced.

- Task totals include cancelled work so discarded decomposition remains
  visible; kernel-owned final verification tasks are excluded.
- Per-task rows retain attempts, submitted attempts, file inventory coverage,
  unique changed-file counts across submissions, independent review starts,
  review reuse, Architect decisions, corrections and integration conflicts.
- A correction cycle is a rejected Architect review decision. A fresh attempt
  after a timeout or budget stop is not automatically a quality defect.
- File counts use the recorded submission inventory bound to the exact run,
  task, attempt and changeset. A missing or stale inventory makes the count
  `null`; an observed evidence-only submission may have zero changed files.
  Older/unscoped submissions can therefore have unknown file counts.
- Review usage includes all attributed verifier-role calls, including plan
  and final reviews, across usage windows. Settled API cost estimates,
  account-backed calls, unknown pricing, pending calls and model calls with
  missing historical role attribution remain distinguishable. These are
  recorded usage/estimates, not billing data or per-task reviewer cost.
- Missing scheduler history omits the whole field; missing budget history
  gives `reviewUsage: null`. Neither becomes an invented zero measurement.

These measurements support comparisons across runs. They do not assign a
cohesion score, infer that fewer tasks are better, or decide acceptance.

## Verification coverage

Regression tests exercise both new finding categories through the real
plan-critique and coverage-review gates, including an otherwise fully covered
plan whose blocking cohesion finding must still hold readiness. Diagnostics
tests cover multiple attempts, duplicate submission receipts, cancelled work,
stale/missing inventories, evidence-only submissions, review reuse, old events
beyond the display limit, usage windows and missing pricing. Factory tests
check the live submission path and read-only historical availability. These
scripted reviewer tests verify runner behavior, not live-model planning quality.

Validation on 2026-10-26: 243 distinct targeted tests passed (plus a six-test
rerun after final edits), including both native delivery scenarios. App and
Runner TypeScript checks passed. Scoped ESLint reported only the existing
`prefer-const` finding for `subprocessResidue` in `native-build-factory.ts`;
linting that file's HEAD version independently confirms the same finding.
