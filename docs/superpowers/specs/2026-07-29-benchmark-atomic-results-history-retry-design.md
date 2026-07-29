# Atomic Benchmark Results, History, and Provider Recovery Design

**Status:** Design choices approved; written specification pending user review

**Date:** 2026-07-29

**Scope:** Certified ModelIQ, TeamIQ, WorkBench, Full Certified, Results,
profiles, reports, storage, deletion, and certified provider-call recovery

## Objective

Make certified benchmark results represent complete benchmark executions rather
than a lifetime aggregate of every persisted attempt.

The Results experience must:

- publish each independently evaluated model or team only after that subject's
  promised benchmark work finishes;
- keep completed peers visible when another model or team fails;
- exclude provider, runner, harness, budget, cancellation, interruption, and
  other incomplete executions from every Results decision surface;
- preserve incomplete evidence in Data/audit storage for diagnosis;
- show the latest completed result for an exact configuration;
- expose older completed results inline so behavior drift remains visible;
- never average separate executions together; and
- retry temporary provider failures with bounded, cancelable backoff before
  abandoning already-funded progress.

The final implementation is merged into local `main` only after automated
verification, independent review, and a live Chrome benchmark using the
user-supplied local account-provider connection and GPT-5.6 models.

## Confirmed Problems

### Incremental evidence is mistaken for a publishable result

Certified runs correctly persist attempts as work completes so crashes do not
erase evidence. The certified dashboard currently reads scored attempts without
requiring their enclosing run or preset subject to have completed. A model that
finishes GameIQ but loses its Tool Reliability leg to a provider outage can
therefore appear as a partial ModelIQ result.

Incremental persistence is valuable for audit and token accounting. It is not a
valid publication boundary.

### Separate executions are aggregated

Current scoring groups attempts by semantic model or team identity. Repeating a
benchmark adds new attempts to the old row and changes its lifetime average.
That hides provider or model drift, makes the displayed timestamp ambiguous,
and prevents a user from comparing the latest behavior with earlier behavior.

### Existing retries are too short for temporary outages

The certified model-call layer currently allows the original call plus two
short retries. A rate limit, overload, short network outage, or temporary 5xx
can outlast that window. The remainder of an otherwise useful benchmark is then
discarded even though waiting consumes no model tokens.

### Existing deletion targets an attempt

The current Results deletion metadata identifies a newest attempt. Once
executions become immutable snapshots, deleting one attempt would corrupt the
snapshot and could make history or deltas misleading.

## Core Concepts

### Execution

An execution is one user launch of Advanced, ModelIQ, Team benchmark, WorkBench,
or Full Certified. It has a stable `executionId` used to link independently
published sibling snapshots and to prevent cross-execution comparisons.

An execution may finish with a mixture of completed, failed, and cancelled
subjects. There is no global all-or-nothing Results transaction.

### Result set

A `BenchmarkResultSet` is the durable publication manifest for one scoreable
subject and its promised track bundle. It is created as `pending` before that
subject's first paid provider call.

Conceptually it contains:

```ts
interface BenchmarkResultSet {
  id: string;
  schemaVersion: 1;
  executionId: string;
  subjectKind: "model" | "team";
  configurationKey: string;
  configuration: BenchmarkResultConfiguration;
  expectedTracks: BenchmarkExpectedTrack[];
  status: "pending" | "completed" | "failed" | "cancelled" | "deleting";
  createdAt: string;
  completedAt?: string;
  terminalAt?: string;
  failure?: SanitizedBenchmarkFailure;
  metrics?: CertifiedResultSnapshotMetrics;
}
```

The concrete storage representation may follow existing JSON-string conventions,
but it must preserve these semantics. Every owned run, attempt, verifier result,
trace, tool call, artifact, and failure record carries `resultSetId`.

The result set is not a replacement for `BenchmarkRun`. Runs continue to record
track-level execution and recovery details. The result set sits above one or
more runs and decides whether their evidence may enter Results.

### Completed snapshot

A completed result set is an immutable result snapshot. Completion freezes:

- the exact configuration identity;
- expected track and case manifests;
- completion time;
- scoring and suite versions;
- owned evidence references;
- tokens, cost, latency, pass rate, coverage, reliability, and overall metrics;
  and
- the physical retry usage included in efficiency metrics.

Historical snapshots are not silently rescored by future scoring code. A
scoring-version change creates a separate history series.

Snapshot metrics contain only intrinsic measurements of that subject. Deltas,
team lift, and other cross-snapshot or cross-subject comparisons are derived
relationship fields, not frozen intrinsic metrics. They may therefore become
unavailable or change their comparison neighbor when a linked snapshot is
deleted, without rewriting the underlying snapshot.

## Publication Units

Publication follows independently scoreable subjects, not the number of models
selected in the UI and not the entire preset launch.

### ModelIQ

Each selected model has one result set promising:

- the complete current GameIQ bundle; and
- the complete current Tool Reliability suite.

GameIQ evidence alone cannot publish that ModelIQ snapshot. If GPT-5.6 Sol
finishes GameIQ but its Tool Reliability leg suffers an exhausted provider
failure, the Sol result set is failed and hidden. Fully completed GPT-5.6 Luna
and Terra result sets from the same launch publish normally.

### Team benchmark

Each solo baseline and each exact team strategy/composition has its own result
set promising the complete TeamIQ case manifest assigned to it.

Completed subjects publish independently. Team lift is a comparison, not part
of base publication: it is calculated only when the team and required solo
baseline result sets are all completed siblings with the same `executionId`,
suite version, and scoring version. Otherwise lift is unavailable rather than
borrowed from another execution.

### WorkBench

Each exact solo model or team composition/strategy evaluated against a WorkBench
pack has its own result set promising that complete pack. The native runner and
browser evidence remain attached to that result set.

### Full Certified and Advanced

These launchers reuse the same subject-level rule. A result set promises only
the track bundle scheduled for that subject. Failures do not hide unrelated
completed subjects from the same Full Certified execution.

The launcher or preset name is not itself part of history identity. Two
snapshots launched through different UI paths share a history series only when
their exact subject configuration and promised versioned track bundle are the
same.

## Completion Contract

### Scoreable completion

A result set may transition from `pending` to `completed` only when:

1. every expected track run completed;
2. every expected logical case has exactly one terminal scoreable outcome;
3. no expected work remains queued, running, skipped by infrastructure, or
   represented only by a synthetic infrastructure failure;
4. all owned provider calls and tool activity have physically settled;
5. immutable snapshot metrics have been calculated from this result set only;
   and
6. the metrics and `completed` marker are durably written together.

A scoreable terminal outcome may be a pass or an honest model failure. Examples
that still publish as low or zero scores include:

- a verifier rejecting a completed answer;
- a model refusal returned as a usable answer;
- invalid model-generated JSON or an invalid tool action;
- a wrong game move or failed coding solution; and
- a model exhausting allowed semantic turns after the provider calls succeeded.

These outcomes measure model behavior and must not be reclassified as
infrastructure merely to hide a weak score.

### Unpublishable termination

The result set must become `failed` or `cancelled`, and remain absent from
Results, when expected work is incomplete because of:

- provider transport failure before a usable response;
- exhausted transient-provider retries;
- a runner disconnect or runner process failure;
- harness, persistence, or verifier infrastructure failure;
- certified wall-clock, call, token, or cost budget exhaustion;
- explicit user cancellation;
- tab reload, tab close, browser termination, or unrecoverable interruption;
  or
- any missing expected track or case.

Infrastructure failures must not be converted into synthetic scored zeroes to
make the manifest appear complete.

### Independent failure containment

Execution orchestration captures errors per result set and awaits all admitted
siblings. One model or team failure never rejects the whole preset early or
cancels another subject. Only the execution's explicit parent cancellation
signal may cancel all unfinished siblings.

As soon as one subject satisfies its full completion contract, its snapshot may
publish. A later sibling failure or user cancellation does not retract that
already completed snapshot.

### Crash and stale-pending reconciliation

Same-tab navigation and inactivity do not interrupt execution. The existing
tab-lifetime coordinator remains the live owner across route unmount/remount.

After a genuine JavaScript-realm loss, orphaned `pending` result sets are
reconciled to a non-publishable interrupted failure. Reconciliation must not
mark result sets owned by the live tab coordinator as stale. Audit evidence
stays available even when a snapshot never publishes.

## Durable Publication

Before the first paid call for a subject:

1. determine its exact configuration;
2. freeze its expected versioned track and case manifests;
3. create its `pending` result set; and
4. attach subsequent owned records through `resultSetId`.

Attempts, traces, verifier results, failures, token usage, and artifacts continue
to persist incrementally. This preserves diagnostic evidence and consumed-token
accounting without exposing partial Results.

At completion, the application validates the manifest, builds metrics using
only owned evidence, and performs one durable publication update containing the
metrics, `completedAt`, and `status: "completed"`. Results selectors require both
the completed marker and valid referenced evidence.

Folder-backed storage must preserve the same visible atomicity even though it
cannot rely on one IndexedDB transaction. It writes all snapshot content before
the completed marker. A crash can therefore leave a hidden pending snapshot,
never a visible partial one.

## Configuration and History Identity

The canonical configuration key includes:

- subject kind;
- provider identity;
- exact model ID;
- normalized reasoning effort;
- effective maximum-output-token configuration;
- the complete promised benchmark track bundle;
- benchmark suite and case-manifest versions;
- scoring version; and
- for teams, exact strategy identity/configuration plus ordered roles, where
  every role includes its label, provider, model ID, effort, and max-token
  configuration.

Temperature is deliberately ignored.

The canonical object is serialized with stable key and array ordering and stored
with a deterministic key/hash. Selectors confirm canonical configuration
equality rather than trusting a hash match alone. Human-readable configuration
metadata remains available for audit and display.

Configuration keys do not include:

- execution ID;
- launch timestamp;
- launcher/preset name;
- generated team/run/attempt IDs; or
- temperature.

A changed provider, model ID, effort, max-token configuration, ordered role,
strategy, track bundle, suite version, case manifest, or scoring version starts
a separate history series. This prevents misleading deltas between
non-comparable results.

## No Cross-Execution Aggregation

Certified dashboard construction changes from attempt-first lifetime grouping
to result-set-first selection:

1. read and validate completed result sets;
2. group them by canonical configuration key;
3. order each group by `completedAt` descending with result-set ID as a stable
   tie-breaker;
4. select the first snapshot as the current row;
5. build that row and profile only from the selected result set's owned
   evidence; and
6. retain the remaining completed result sets as history.

Decision cards, charts, Pareto analysis, leaderboard ordering, head-to-head
views, and reports use latest snapshots only. They must not receive hidden
attempts or older snapshots in their scoring input.

Aggregation still occurs inside one snapshot where a suite defines multiple
cases or tracks. It never crosses `resultSetId`.

Profiles and evidence links are snapshot-scoped. Opening an older profile shows
the evidence and metrics that belonged to that historical execution.

## Results History UI

The approved UI is inline expansion.

### Latest row

Each configuration renders one primary row containing:

- model or team identity;
- benchmark bundle and version when needed to distinguish otherwise similar
  rows;
- completion date/time in the user's locale;
- the latest full metric set already supported by that Results view;
- a compact Overall Index delta against the immediately previous completed
  snapshot; and
- a compact pass-rate delta, expressed in percentage points, against that same
  snapshot.

Higher score deltas are visually positive and lower deltas negative, but color
is never the only indicator. Accessible labels state the metric, direction, and
comparison target. When there is no previous completed comparable snapshot,
the UI shows no delta rather than comparing against zero.

### Inline history

A labeled caret/action such as `3 runs` expands older snapshots directly below
the latest row. History is newest-first and exposes the same core metrics,
completion time, profile action, and evidence access for each snapshot.

The first five older snapshots render initially. `Show more` reveals the next
five until all retained history is visible. There is no automatic retention
cap; all completed snapshots remain until the user deletes or clears them.

Expansion state is presentation-only. Search and filters operate on the latest
configuration row and do not change which snapshot is considered latest.

## Snapshot Deletion

Deletion targets one entire result snapshot, never an attempt.

The UI identifies the snapshot by configuration and completion time and asks
for confirmation. Deletion removes or tombstones:

- the result-set manifest;
- its owned runs and attempts;
- verifier results;
- traces and physical retry records;
- tool calls;
- artifacts;
- failure evidence; and
- stored immutable metrics.

Records owned by sibling result sets are not deleted. Shared experiment
metadata may be removed only after no result set references it.

Visibility is removed first by transitioning the result set to `deleting`.
Child cleanup then runs, and the manifest is removed last. A crash during
cleanup can leave hidden recoverable garbage but cannot leave a partially
deleted Results row. Startup cleanup resumes any `deleting` tombstone.

Deleting the latest snapshot promotes the next newest completed snapshot and
recomputes its delta against its new predecessor. Deleting an older snapshot
updates the adjacent comparison. Deleting a solo TeamIQ baseline can make a
linked team's comparison lift unavailable, but it does not delete the team
snapshot or alter its base score.

Clear-all behavior includes result-set manifests and all owned evidence.

## Legacy Data, Import, Export, and Reports

There is no legacy Results compatibility requirement.

- Existing attempts without a valid completed result-set manifest remain in
  storage but are hidden from all Results and decision surfaces.
- No migration may infer completion from old attempts or old run status.
- Raw Data/audit views and raw exports may expose legacy, pending, failed,
  cancelled, interrupted, and deleting records with explicit status.
- Certified Results reports include completed snapshots only.
- Export/import schemas add result sets and ownership identifiers.
- Import accepts older bundles without result sets for audit purposes, but they
  do not score.
- A purported imported completed result set is validated against its expected
  manifests and referenced evidence. Missing or inconsistent evidence keeps it
  out of Results.
- Redaction rules continue to remove secrets, credentials, and unsafe local
  paths from every export.

## Transient Provider Recovery

### Retry owner and scope

The central certified model-call layer is the only explicit application retry
owner. A retry repeats the exact failed logical provider call, not its enclosing
case, track, result set, or preset.

The logical request keeps a stable logical-call ID and identical benchmark
state. Each physical request receives its own attempt ID, timing, outcome,
usage, and failure metadata.

Certified transports must not introduce an unobserved nested retry loop. SDK
automatic retries reachable from certified mode are disabled where possible or
otherwise surfaced as physical attempts so retry counts, timing, tokens, and
cost cannot be multiplied invisibly. Non-benchmark discussion behavior is
unchanged.

A call may retry only before any response has been admitted as usable and
before any returned tool action or other side effect has been applied. A
failure after side effects is an infrastructure failure for the result set and
is not replayed.

### Backoff schedule

Each logical call permits the original physical request plus at most five
retries:

| Physical request | Base delay before request |
| --- | ---: |
| Original | 0 seconds |
| Retry 1 | 2 seconds |
| Retry 2 | 5 seconds |
| Retry 3 | 15 seconds |
| Retry 4 | 30 seconds |
| Retry 5 | 60 seconds |

Each non-zero base delay receives bounded jitter of plus or minus 20 percent.
Tests use an injected deterministic random source and fake clock.

When a typed provider failure supplies `Retry-After`, the wait is the larger of
the jittered base delay and the provider delay. A wait is admitted only when it
fits inside the result set's remaining certified wall-clock budget. Otherwise
the call terminates without sleeping past its budget.

Backoff waiting:

- consumes no provider call or model-token budget;
- does consume elapsed wall-clock budget;
- is immediately abortable through the stable parent signal;
- retains the subject's concurrency slot to avoid a retry surge;
- does not stop already running sibling subjects; and
- rechecks cancellation and remaining budget before and after sleeping.

Jitter prevents simultaneously selected models from retrying in lockstep.

### Retryable failures

Retry only typed transient failures that occur before usable output:

- rate limiting, including HTTP 429;
- provider overload or temporary unavailability;
- retryable HTTP 5xx responses;
- network connection, fetch, DNS, socket, or connection-reset failures;
- transport timeouts;
- prematurely ended streams with no usable response; and
- empty provider responses.

Structured status codes and typed provider metadata take precedence over
message matching. `Retry-After` is carried as structured milliseconds where
the transport exposes it.

### Non-retryable failures

Never retry:

- authentication or invalid-key failures;
- authorization failures;
- billing, depleted-credit, hard quota, or account-suspension failures;
- unsupported, unavailable, or missing model identifiers;
- invalid request or payload failures;
- certified wall-clock, token, call, or cost budget exhaustion;
- explicit cancellation;
- verifier rejection;
- model refusal or safety response returned as usable output;
- malformed or incorrect model output;
- invalid model-selected tools or tool arguments; or
- harness and persistence defects.

These failures either produce an honest scoreable model outcome or terminate
the result set as unpublishable according to the completion contract.

### Physical teardown before retry

Before retrying, the failed provider request must confirm physical teardown:

- the stream iterator has returned or been closed;
- abort cleanup has settled;
- SDK/session cleanup required for that request has completed; and
- no late response can be admitted into the logical call.

If teardown cannot be confirmed, the retry fails closed. This prevents
overlapping paid requests and late-response races. Provider-side billing
cessation cannot be guaranteed after a network failure, but the application
must never knowingly overlap physical attempts.

### Accounting and progress

All physical attempts remain attached to the logical call and result set.
Reported tokens, cost, latency, and calls include any usage returned for failed
physical attempts. Successful retry does not erase its earlier cost.

Live progress identifies:

- the affected model or team;
- a sanitized transient reason;
- retry number out of five;
- planned wait; and
- final exhaustion when recovery fails.

No credentials, raw provider payloads, or secret-bearing error text appear in
progress or persisted failure messages.

After all retries are exhausted, only that result set fails and remains hidden.
Other subjects continue and publish independently.

## Data and Audit UI

Data/audit distinguishes:

- pending;
- completed and published;
- failed infrastructure;
- cancelled;
- interrupted/stale;
- deleting; and
- legacy/unmanifested evidence.

It shows consumed tokens and physical retry attempts even for unpublished
result sets. This provides a truthful operational record without presenting
partial work as a benchmark score.

The Results empty state explains when stored evidence exists but no fully
completed snapshots qualify.

## Testing Strategy

Implementation follows test-driven development. Focused regressions must fail
before production changes and then pass.

### Publication and containment

Tests cover:

- a pending, failed, cancelled, interrupted, or deleting result set is absent
  from every Results selector;
- a valid completed set is visible;
- a verifier/model failure with every expected case completed publishes a low
  score;
- a provider/harness/budget failure never becomes a synthetic scored zero;
- ModelIQ GameIQ completion without Tool Reliability completion does not
  publish that model;
- one failed ModelIQ model does not hide completed peers;
- one subject failure does not cancel or prevent sibling finalization;
- a completed subject remains published when a later sibling fails or the user
  cancels;
- stale pending reconciliation never targets a live same-tab owner; and
- old evidence without a result-set manifest is hidden.

### Snapshot selection and history

Tests cover:

- separate executions are never averaged;
- configuration identity includes provider, model, effort, max tokens, ordered
  roles, strategy, promised track bundle, suite/case version, and scoring
  version;
- configuration identity ignores temperature, execution ID, time, and launcher;
- latest ordering is deterministic by completion time and ID;
- Overall Index and pass-rate deltas use only the immediately previous
  completed comparable snapshot;
- no predecessor means no delta;
- charts, verdicts, Pareto, head-to-head, reports, and profiles consume latest
  snapshots only;
- profiles and evidence remain scoped to their selected historical snapshot;
- TeamIQ lift uses completed siblings from the same execution only;
- five older snapshots render initially and `Show more` preserves ordering; and
- inline controls are keyboard accessible and expose meaningful labels.

### Storage, import, and deletion

Tests cover both IndexedDB-style and folder-backed ordering:

- the completed marker is the last publication write;
- a crash before publication leaves no visible result;
- imported incomplete or inconsistent manifests do not score;
- legacy imports remain audit-only;
- raw and certified reports apply their different inclusion rules;
- redaction remains effective;
- snapshot deletion removes only owned evidence;
- deleting latest promotes the next snapshot and recomputes deltas;
- deleting history updates comparisons;
- deleting a linked solo baseline does not delete its team snapshot;
- interrupted `deleting` cleanup resumes safely; and
- clear-all removes manifests and owned records.

### Provider recovery

Fake-clock and fake-provider tests cover:

- exact 2, 5, 15, 30, and 60 second base delays;
- deterministic plus/minus 20 percent jitter bounds;
- longer typed `Retry-After` precedence;
- refusal to sleep past remaining wall-clock budget;
- immediate cancellation during every backoff;
- cancellation and budget checks on both sides of sleep;
- all supported transient classifications;
- every fatal and model-behavior non-retry classification;
- exact logical request replay without enclosing-case replay;
- no retry after a tool action or other side effect;
- confirmed iterator/session teardown before the next request;
- fail-closed behavior when teardown does not settle;
- no overlapping physical provider requests;
- no multiplicative hidden SDK retry loop;
- retained token/cost/call accounting for failed physical attempts;
- sanitized progress messages; and
- exhausted retries fail only their owning result set.

### Mechanical verification

The final branch runs:

- focused new result-set, history, deletion, and retry tests;
- `npm run test:benchmark`;
- any affected Runner V2 and account-provider artifact tests;
- `npm run lint`;
- the relevant TypeScript checks;
- `npm run build`; and
- final diff/status inspection.

Because an active development server can corrupt `.next` during build, the dev
server is stopped for the build and restarted before browser acceptance.

If Runner V2 or the standalone account-provider runner is changed, its
published WorkBench/download artifact is regenerated and verified against the
source before browser testing. The existing version-19 account-provider
contract remains in force unless a separately approved protocol change is
required.

## Live Chrome Acceptance

After implementation and automated verification:

1. start the merged local application and required local runner processes;
2. use the real Chrome browser, not only unit tests or the in-app browser;
3. enter the user-supplied local account-provider URL and token through
   Settings;
4. do not write or echo that token into source files, test fixtures, logs,
   screenshots, reports, commits, or final prose;
5. select the GPT-5.6 Luna, GPT-5.6 Terra, and GPT-5.6 Sol ChatGPT models at
   Medium effort;
6. run the real ModelIQ preset and allow all subjects to settle;
7. verify live progress, absence of unexpected cancellation while unattended,
   independent subject completion, and completed-snapshot publication;
8. verify Results shows one latest row per completed exact configuration and no
   partial row;
9. verify inline history, five-item pagination, deltas, profile scoping, and
   whole-snapshot deletion against deterministic local test snapshots, without
   spending a second full paid ModelIQ run solely to manufacture history;
10. verify the Data/audit view distinguishes unpublished evidence;
11. inspect Chrome console output for errors; and
12. remove the credential from UI storage after the live acceptance run unless
    the user asks to retain it.

Transient outage and exhausted-retry behavior use deterministic fake providers,
not an intentionally sabotaged paid run. The live provider check validates the
real happy path without deliberately wasting tokens.

## Security and Privacy

- Account-provider credentials are runtime-only acceptance inputs and are never
  committed.
- No design, plan, task brief, report, test fixture, screenshot, or exported
  benchmark bundle contains the supplied token.
- Persisted failure messages and retry progress use sanitized typed metadata.
- Existing optional encrypted browser storage remains the only supported
  credential persistence mechanism.
- Raw response content is not added to the result-set manifest.

## Non-Goals

- Reconstructing completed snapshots from legacy attempts.
- Averaging or smoothing model performance across executions.
- Treating temperature as configuration history identity.
- Automatically deleting failed or incomplete audit evidence.
- Retrying model mistakes, verifier failures, invalid tool choices, or hard
  account failures.
- Resuming browser-owned provider calls after full reload, tab close, browser
  termination, or machine loss.
- Guaranteeing that an upstream provider did not bill a request after the local
  transport lost contact.
- Changing benchmark case content, verifier semantics, Certified Index formula,
  provider model IDs, or reasoning-effort semantics.
- Pushing local commits or opening a pull request unless separately requested.

## Acceptance Criteria

The work is complete only when:

- Results contains exclusively validated completed result sets;
- independently completed peers remain visible after another subject fails;
- ModelIQ publishes a model only after both GameIQ and Tool Reliability finish;
- separate executions render as latest plus history and are never aggregated;
- exact configuration history and deterministic deltas behave as specified;
- whole-snapshot deletion and promotion are correct;
- transient failures receive bounded cancelable recovery without overlapping
  physical requests or hidden retry multiplication;
- retry usage remains visible in cost and token accounting;
- legacy and incomplete evidence is audit-only;
- focused and full mechanical verification pass;
- Tier 3 task, final correctness, and specification reviews have no unresolved
  important findings;
- the live GPT-5.6 Chrome acceptance run passes without console errors or
  unexpected cancellation;
- the supplied credential has not entered repository history or reports; and
- the verified feature branch is merged into local `main`, with local `main`
  clean and passing final verification.
