# Certified Run Lifetime Containment Design

**Status:** Approved direction; written specification pending user review
**Branch:** `codex/fix-modeliq-account-concurrency`
**Applies to:** final-review remediation after `51729575`

## Objective

Close the remaining token-waste races without cancelling a benchmark merely
because the user is inactive or navigates to another route in the same browser
tab.

One active certified run may continue across same-tab SPA navigation. A
remounted Benchmark panel must discover that run, remain unable to start a
second run, and retain an explicit Cancel action. The active run owns one
stable parent cancellation signal whose descendants include every model,
scenario, provider request, and runner request admitted by that run.

Explicit cancellation stops future admission and aborts every active
descendant. It does not release the tab-level admission lock until descendant
teardown has settled.

## Confirmed Problems

### Preset Tool Reliability cancellation

A preset can run four Tool Reliability models concurrently. Each model
currently replaces the same `runAbortRef`, so Cancel reaches only whichever
controller was assigned last. The concurrency mapper can then claim a fifth
model after cancellation.

The same preset flow checks cancellation before the asynchronous WorkBench
health gate, but not after it. Cancellation during the health request can
therefore admit the WorkBench leg after the gate resolves.

### Copilot SDK late admission

If cancellation wins while the Copilot client or session is being created,
the adapter calls `session.abort()` after creation and then still invokes
`sendAndWait()`. Copilot defines `abort()` as cancelling a message that is
already processing; it is not permission to start a new message afterward.

### Mounted-component-only locking

The current `useRef` lock belongs to one `CertifiedRunPanel` mount. SPA
navigation destroys that component instance, while its asynchronous run may
continue. Returning to the page creates a fresh lock that can admit an
overlapping run in the same tab.

## User Decision

Same-tab navigation does **not** cancel an active benchmark. Inactivity does
not cancel it either.

The run continues in the current JavaScript tab lifetime. Returning to the
Benchmark page reconnects to its active owner and cancellation control. A new
run remains blocked until the old run has fully settled.

A full page reload, tab close, browser termination, or machine/network loss
cannot preserve browser-owned asynchronous execution. Those events use the
existing best-effort transport teardown; already consumed provider tokens
cannot be recovered.

Separate browser tabs remain independent.

## Architecture

### Tab-lifetime run coordinator

Replace component-owned admission with one module-scoped coordinator per
browser JavaScript realm. Module scope survives Next.js client-side route
unmount/remount while remaining naturally isolated between tabs.

The coordinator exposes:

```ts
type CertifiedRunOwner = "advanced" | "preset";

interface CertifiedTabRunSnapshot {
  owner: CertifiedRunOwner | null;
  phase: "idle" | "running" | "cancelling";
  presetId?: BenchmarkPreset["id"];
  startedAt?: number;
  error?: string;
}

interface CertifiedTabRunCoordinator {
  getSnapshot(): CertifiedTabRunSnapshot;
  subscribe(listener: () => void): () => void;
  tryStart(
    owner: CertifiedRunOwner,
    metadata: { presetId?: BenchmarkPreset["id"] },
    execute: (signal: AbortSignal) => Promise<void>
  ): boolean;
  cancel(reason: unknown): boolean;
}
```

`tryStart` performs admission synchronously. When idle, it creates and stores
one parent `AbortController`, publishes a running snapshot, and invokes the
executor. A second call in the same tick or after a route remount returns
`false`.

The coordinator owns the executor promise, catches its rejection so an
unmounted caller cannot create an unhandled rejection, records a safe
lifecycle error for subscribers, and finalizes through one `finally`. Export a
factory for isolated tests and one module-scoped production instance.

`cancel` aborts the stored parent once and publishes `cancelling`. It does not
clear ownership. Ownership returns to idle only in the executor's `finally`
after the run promise and all awaited descendant cleanup have settled.

The coordinator stores lifecycle metadata, not provider credentials, prompts,
model output, or durable benchmark results.

`CertifiedRunPanel` subscribes with `useSyncExternalStore`. On remount it
renders the active owner, disables both launch families, and exposes the
coordinator Cancel action. Detailed state produced by an unmounted panel need
not be reconstructed; durable results remain in benchmark storage and the
active lifecycle status remains visible.

### Stable parent cancellation hierarchy

Advanced and preset entry points receive the coordinator's parent
`AbortSignal`.

Execution helpers may retain local child controllers for isolation, but every
child must link to the parent once and remove its listener in `finally`.
Component refs are no longer cancellation authority.

For preset execution:

- `RunPresetContext` receives the parent signal.
- GameIQ's batch controller links to that signal.
- Each Tool Reliability model owns a distinct local controller linked to that
  signal; concurrent models never share or overwrite one ref.
- TeamIQ and WorkBench child runs link to the same parent.
- A model's provider failure remains isolated and does not abort sibling
  models. Only the preset parent signal represents explicit whole-run
  cancellation.

### Fail-closed preset admission

Preset execution checks its parent signal:

- before claiming every leg;
- immediately after every awaited admission gate, including WorkBench health;
- immediately before every concurrency-worker cursor claim;
- before any model team, run, case, attempt, or provider persistence/admission.

When Cancel wins:

- all four active Tool Reliability model signals abort;
- queued models receive a visible cancelled status;
- queued models make no provider calls and create no team/run/attempt records;
- the next preset leg is marked cancelled/skipped without work;
- the preset parent remains owned until active children settle.

The existing concurrency caps remain unchanged: Tool Reliability admits at
most four models, and ModelIQ GameIQ admits at most two models with four
scenarios per model.

### Copilot SDK admission barrier

Treat every asynchronous Copilot setup boundary as paid-work admission:

- reject an already-aborted signal before `client.start()`;
- after `client.start()`, recheck before `createSession()`;
- after `createSession()`, install cancellation cleanup and recheck before
  `sendAndWait()`.

If cancellation already won:

- invoke `session.abort()` when available;
- throw the original signal reason before any send;
- await abort cleanup;
- unsubscribe, disconnect, and stop in the existing order.

Cancellation that arrives after `sendAndWait()` starts continues to abort that
in-flight message. No retry, fallback, or new SDK send is admitted after the
signal is aborted.

## UI Behavior

- Walking away while leaving the page mounted: the run continues.
- Navigating to another route in the same tab: the run continues.
- Returning to Benchmark: both run families remain disabled, the active owner
  is shown, and Cancel targets the original parent controller.
- Clicking Cancel: the UI shows cancelling until the run and teardown settle;
  it does not immediately unlock.
- Completing or failing naturally: ownership clears only after final cleanup.
- Refreshing or closing the tab: live browser execution is not recoverable;
  existing transport-disconnect cancellation applies.

## Error and Reason Semantics

- Preserve the original user cancellation reason.
- Preserve existing budget, provider, timeout, and fatal-error classification.
- A child cancellation derived from the preset parent must not replace an
  independently winning model failure.
- Explicit cancellation marks queued work as cancelled, not failed.
- The Copilot SDK pre-send barrier surfaces the original abort reason and
  never reports a successful empty response.

## Tests

### Tab coordinator and remount

Add a behavioral coordinator/component regression:

1. mount/subscribe panel A;
2. start a deferred run;
3. unsubscribe/unmount panel A;
4. subscribe/remount panel B;
5. assert panel B sees the same active owner;
6. assert a second Advanced or preset start is rejected;
7. cancel from panel B and assert the original parent signal aborts;
8. keep teardown deferred and assert ownership remains locked;
9. settle teardown and assert ownership becomes idle;
10. assert a new run can then start.

### Preset cancellation

Use five fake Tool Reliability models with concurrency four:

- assert models 1-4 start;
- cancel the preset parent;
- assert all four active signals abort;
- assert model 5 never reaches provider execution or persistence;
- assert model 5 is reported cancelled;
- assert one model failure without parent cancellation does not abort its
  siblings.

Delay WorkBench health, cancel while it is pending, then resolve it healthy.
Assert the WorkBench leg never reaches team/run/provider persistence.

### Copilot SDK

Cover:

- signal already aborted before `runCopilotSdkChat`;
- signal aborts while `client.start()` is pending;
- signal aborts while `createSession()` is pending;
- signal aborts after `sendAndWait()` begins.

The first three cases assert zero sends. Cleanup is `stop` when no session was
admitted and ordered `abort -> disconnect -> stop` when a session exists. The
fourth keeps the existing in-flight abort behavior.

### Aggregate registration

Register the tab-lifetime and preset-cancellation regressions in the
repository's benchmark aggregate suite. Retain the standalone convenience
commands and include them in final acceptance.

## Preserved Constraints

- No benchmark case, scoring, schema, persistence format, model timeout,
  one-hour GameIQ budget, retry delay/count, provider payload, credential, or
  runner-routing change.
- No live or paid provider tests.
- Account-provider runner remains version 19.
- Existing v19 artifact source/ZIP byte-identity guarantees remain required.
- Google cancellation remains client-transport-only; provider-side billing
  cessation cannot be guaranteed.
- Same-tab SPA navigation is coordinated; cross-tab coordination is outside
  scope.

## Acceptance

The remediation is complete only when:

- all new RED cases pass;
- task-level review finds no unresolved Critical or Important issue;
- fix-only re-review confirms any findings;
- independent final correctness and specification reviews both pass;
- full focused, aggregate, lint, TypeScript, build, artifact, and diff checks
  pass on the feature branch and again after local merge into `main`;
- the standalone account-provider runner is updated to the merged v19 source
  and `/health` confirms version 19 without exposing credentials.
