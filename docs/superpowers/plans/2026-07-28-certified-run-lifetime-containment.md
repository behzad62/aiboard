# Certified Run Lifetime Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one certified benchmark alive but exclusive across same-tab navigation, make explicit cancellation stop every active and queued descendant, and prevent Copilot SDK sends after cancellation wins.

**Architecture:** A module-scoped coordinator owns synchronous per-tab admission, one parent `AbortController`, lifecycle subscriptions, and release-after-settlement. Advanced and preset execution link their local controllers to that parent; preset worker admission checks it before every paid boundary. Copilot SDK setup checks cancellation before and after each awaited setup stage and never calls `sendAndWait` after abort.

**Tech Stack:** Next.js 16 App Router, React 19 `useSyncExternalStore`, strict TypeScript, browser `AbortController`, GitHub Copilot SDK, Node/TSX local integration tests, JSZip publication artifacts.

## Global Constraints

- Same-tab navigation and user inactivity do not cancel an active benchmark.
- Returning to Benchmark in the same tab must discover the active owner, block both launch families, and expose Cancel for the original run.
- The tab admission owner is released only after the active executor and awaited descendant teardown settle.
- A full reload, tab close, browser termination, or network loss remains best-effort transport teardown; live browser execution is not recoverable across a new JavaScript realm.
- Separate browser tabs remain independent.
- Explicit cancellation preserves its original reason, aborts every active descendant, and prevents queued model/leg/provider/persistence admission.
- A model provider failure remains isolated and does not cancel independent sibling models.
- ModelIQ remains capped at two model runs with four GameIQ scenarios per model.
- Tool Reliability remains capped at four model runs.
- Do not change benchmark cases, scoring, schemas, persistence formats, the 120-second production model-call timeout, the one-hour GameIQ budget, or retry delays/counts.
- Account-provider runner version remains exactly `19`.
- Tests use local/fake transports only; do not make paid or live model calls.
- Regenerated account-provider artifacts must remain byte-identical to their source entries. Do not stage the WorkBench ZIP when its content is unchanged.
- Google cancellation remains client-transport-only; provider-side billing cessation cannot be guaranteed.
- Preserve existing user changes and remain on `codex/fix-modeliq-account-concurrency` until final reviewed local merge.

---

### Task 1: Build the tab-lifetime certified-run coordinator

**Files:**
- Create: `lib/benchmark/certified/run-session.ts`
- Modify: `scripts/test-certified-run-lock.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export type CertifiedRunOwner = "advanced" | "preset";
export type CertifiedTabRunPhase = "idle" | "running" | "cancelling";

export interface CertifiedTabRunSnapshot {
  owner: CertifiedRunOwner | null;
  phase: CertifiedTabRunPhase;
  presetId?: BenchmarkPreset["id"];
  startedAt?: number;
  error?: string;
}

export interface CertifiedTabRunCoordinator {
  getSnapshot(): CertifiedTabRunSnapshot;
  subscribe(listener: () => void): () => void;
  tryStart(
    owner: CertifiedRunOwner,
    metadata: { presetId?: BenchmarkPreset["id"] },
    execute: (signal: AbortSignal) => Promise<void>
  ): boolean;
  cancel(reason: unknown): boolean;
}

export function createCertifiedTabRunCoordinator(): CertifiedTabRunCoordinator;
export const certifiedTabRunCoordinator: CertifiedTabRunCoordinator;
```

- Task 2 consumes the module-scoped `certifiedTabRunCoordinator` and the factory-backed behavior pinned here.
- The coordinator stores only lifecycle metadata and a controller; it never stores credentials, prompts, model output, or durable result records.

- [ ] **Step 1: Replace the lock test with a failing tab-lifetime lifecycle regression**

Retain the existing `PresetCards` busy-button assertions. Replace the pure lock block in `scripts/test-certified-run-lock.tsx` with a deferred executor test:

```tsx
const coordinator = createCertifiedTabRunCoordinator();
const teardown = deferred<void>();
const cancellation = new Error("cancel from remounted panel");
let activeSignal: AbortSignal | undefined;
let firstSubscriberCalls = 0;
let remountedSubscriberCalls = 0;

const unsubscribeFirst = coordinator.subscribe(() => firstSubscriberCalls++);
assert.equal(
  coordinator.tryStart("preset", { presetId: "model-iq" }, async (signal) => {
    activeSignal = signal;
    await teardown.promise;
  }),
  true
);
assert.deepEqual(coordinator.getSnapshot(), {
  owner: "preset",
  phase: "running",
  presetId: "model-iq",
  startedAt: coordinator.getSnapshot().startedAt,
});

unsubscribeFirst();
const unsubscribeRemounted = coordinator.subscribe(
  () => remountedSubscriberCalls++
);
assert.equal(coordinator.getSnapshot().owner, "preset");
assert.equal(
  coordinator.tryStart("advanced", {}, async () => undefined),
  false
);
assert.equal(coordinator.cancel(cancellation), true);
assert.equal(activeSignal?.aborted, true);
assert.equal(activeSignal?.reason, cancellation);
assert.equal(coordinator.getSnapshot().phase, "cancelling");
assert.equal(coordinator.tryStart("advanced", {}, async () => undefined), false);

teardown.resolve();
await waitFor(() => coordinator.getSnapshot().owner === null);
assert.equal(coordinator.getSnapshot().phase, "idle");
assert.equal(coordinator.tryStart("advanced", {}, async () => undefined), true);
unsubscribeRemounted();
assert.ok(firstSubscriberCalls >= 1);
assert.ok(remountedSubscriberCalls >= 2);
```

Add a second executor that throws and assert the coordinator catches it,
publishes a sanitized `error`, returns to idle, and produces no
`unhandledRejection`.

- [ ] **Step 2: Run the coordinator test and verify RED**

Run:

```powershell
npx tsx scripts/test-certified-run-lock.tsx
```

Expected RED: `../lib/benchmark/certified/run-session` does not exist.

- [ ] **Step 3: Implement stable snapshots, synchronous admission, and settlement-owned release**

Implement `createCertifiedTabRunCoordinator` with one immutable snapshot
reference between updates:

```ts
const IDLE: CertifiedTabRunSnapshot = { owner: null, phase: "idle" };

export function createCertifiedTabRunCoordinator(): CertifiedTabRunCoordinator {
  let snapshot = IDLE;
  let controller: AbortController | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  const publish = (next: CertifiedTabRunSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tryStart(owner, metadata, execute) {
      if (snapshot.owner !== null) return false;
      const runGeneration = ++generation;
      const runController = new AbortController();
      controller = runController;
      publish({
        owner,
        phase: "running",
        ...metadata,
        startedAt: Date.now(),
      });
      void Promise.resolve()
        .then(() => execute(runController.signal))
        .catch((error: unknown) => {
          if (runGeneration !== generation) return;
          publish({
            ...snapshot,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (runGeneration !== generation) return;
          controller = null;
          publish({ owner: null, phase: "idle", error: snapshot.error });
        });
      return true;
    },
    cancel(reason) {
      if (!controller || snapshot.owner === null) return false;
      if (!controller.signal.aborted) controller.abort(reason);
      if (snapshot.phase !== "cancelling") {
        publish({ ...snapshot, phase: "cancelling" });
      }
      return true;
    },
  };
}
```

Export exactly one production instance from the module. Do not attach it to
`window`, `localStorage`, IndexedDB, or a cross-tab channel.

- [ ] **Step 4: Verify GREEN and mutation strength**

Run:

```powershell
npx tsx scripts/test-certified-run-lock.tsx
npx eslint lib/benchmark/certified/run-session.ts scripts/test-certified-run-lock.tsx
npx tsc --noEmit --pretty false
```

Mutations that must fail the test: clearing ownership inside `cancel`, creating
a new controller for each subscriber, releasing before `teardown.resolve()`,
or accepting the remounted Advanced start.

- [ ] **Step 5: Register the lifecycle regression in the aggregate suite**

Keep `test:certified-run-lock`. In the current `test:benchmark:unit` command,
insert `npm run test:certified-run-lock && ` immediately before its first
clause, `tsx scripts/test-benchmark-model-effort.mts`, while preserving every
later clause:

```json
"test:certified-run-lock": "tsx scripts/test-certified-run-lock.tsx"
```

Run:

```powershell
npm run test:certified-run-lock
git diff --check
```

- [ ] **Step 6: Self-review and commit**

Review snapshot reference stability for `useSyncExternalStore`, repeated
Cancel idempotency, executor rejection handling, subscription removal, and
generation ownership.

```powershell
git add lib/benchmark/certified/run-session.ts scripts/test-certified-run-lock.tsx package.json
git commit -m "fix(benchmark): coordinate runs across route remounts"
```

---

### Task 2: Link every certified descendant to the tab session

**Files:**
- Modify: `lib/benchmark/certified/run-execution.ts`
- Delete: `lib/benchmark/certified/run-lock.ts`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx`
- Modify: `components/benchmark/run/RunProgressList.tsx`
- Modify: `scripts/test-certified-run-lock.tsx`
- Create: `scripts/test-certified-preset-cancellation.mts`
- Modify: `scripts/test-gameiq-concurrency-budget.mts`
- Modify: `scripts/test-certified-workbench-ui.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `certifiedTabRunCoordinator` and its executor `AbortSignal` from Task 1.
- Changes:

```ts
export interface CertifiedRunActions {
  signal?: AbortSignal;
  setRunning: (running: boolean) => void;
  setRunPhase: (phase: CertifiedRunPhase) => void;
  setSummary: (summary: CertifiedRunSummary | null) => void;
  setMessage: (message: string | null) => void;
  runAbortRef: MutableRefObject<AbortController | null>;
  onComplete: () => Promise<void>;
}

export interface RunPresetContext {
  models: SelectedModel[];
  soloModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
  teamModelIds: string[];
  teamIqStrategy: TeamIqUiStrategy;
  workBenchRoleMode: WorkBenchRoleMode;
  workBenchRunnerUrl: string;
  workBenchRunnerToken: string;
  fireworksPlayerCount: 2 | 3;
  signal: AbortSignal;
  onComplete: () => Promise<void>;
  // remove cancelledRef and the shared preset runAbortRef
}

export type GameIqModelRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "partial"
  | "failed"
  | "cancelled";
```

- Every `runSelected` and `runGameIqMultiModel` invocation owns its existing
local controller and links it to `CertifiedRunActions.signal`. Each listener
is removed in `finally`.
- Preset Tool Reliability creates a fresh `runAbortRef` object per model. It
is never shared between concurrent model jobs and is not UI cancellation
authority.

- [ ] **Step 1: Write the failing five-model preset cancellation regression**

Create `scripts/test-certified-preset-cancellation.mts` using the existing
in-memory benchmark store helpers and the real `openaiProvider.streamChat`
override pattern from `scripts/test-gameiq-concurrency-budget.mts`.

Start five Tool Reliability models with four provider generators blocked on
deferred promises. Each generator must listen to `params.signal` and record
its model when aborted:

```ts
const parent = new AbortController();
const pending = runPreset(
  toolReliabilityPreset,
  {
    models,
    soloModelIds: models.map((model) => model.modelId),
    effortByModelId: {},
    teamModelIds: [],
    teamIqStrategy: "panel",
    workBenchRoleMode: "solo",
    workBenchRunnerUrl: "",
    workBenchRunnerToken: "",
    fireworksPlayerCount: 2,
    signal: parent.signal,
    onComplete: async () => {},
  },
  (event) => progress.push(event)
);

await waitFor(() => startedModels.size === 4);
parent.abort(cancellation);
await pending;

assert.deepEqual([...abortedModels].sort(), [
  "toolrel-1",
  "toolrel-2",
  "toolrel-3",
  "toolrel-4",
]);
assert.equal(startedModels.has("toolrel-5"), false);
assert.equal(persistedTeamIdsFor("toolrel-5").length, 0);
assert.equal(persistedRunIdsFor("toolrel-5").length, 0);
assert.equal(persistedAttemptIdsFor("toolrel-5").length, 0);
assert.equal(
  progress.some(
    (event) =>
      event.type === "model" &&
      event.modelId.endsWith("toolrel-5") &&
      event.status === "cancelled"
  ),
  true
);
```

Add a separate five-model case where model 1 fails without aborting the parent.
Assert models 2-5 still complete and none of their signals abort.

- [ ] **Step 2: Add a failing delayed WorkBench health admission regression**

In the same script, start a local fake bench-runner health endpoint whose
response is deferred. Start a WorkBench-only preset, abort its parent while
health is pending, then release a healthy response:

```ts
await waitFor(() => healthRequests === 1);
parent.abort(new Error("cancel during runner health"));
healthGate.resolve(healthyRunnerV2Response);
await pending;

assert.equal(workBenchPostRequests, 0);
assert.equal(persistedWorkBenchTeams, 0);
assert.equal(persistedWorkBenchRuns, 0);
assert.equal(
  progress.some(
    (event) =>
      event.type === "leg" &&
      event.leg.track === "workbench" &&
      event.status === "skipped" &&
      event.detail === "Cancelled."
  ),
  true
);
```

The local server must fail the test if any route other than health is called.

- [ ] **Step 3: Run the preset tests and verify RED**

Run:

```powershell
npx tsx scripts/test-certified-preset-cancellation.mts
npx tsx scripts/test-gameiq-concurrency-budget.mts
```

Expected RED:

- only one of four Tool Reliability model signals aborts;
- model five reaches provider/persistence after cancellation;
- a healthy WorkBench response admits its leg after cancellation;
- existing `RunPresetContext` still requires `cancelledRef`/`runAbortRef`
  rather than one parent signal.

- [ ] **Step 4: Implement parent linking and fail-closed preset admission**

Add a private linked-controller helper in `run-execution.ts`:

```ts
function linkRunController(parent?: AbortSignal): {
  controller: AbortController;
  unlink: () => void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, unlink: () => {} };
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    unlink: () => parent.removeEventListener("abort", abort),
  };
}
```

Use it in `runSelected` and `runGameIqMultiModel`, remove the listener in each
outer `finally`, and never clear another call's `runAbortRef`:

```ts
if (runAbortRef.current === abortController) {
  runAbortRef.current = null;
}
unlink();
```

Replace preset refs with `ctx.signal`. Before and after the WorkBench health
await, and before every leg/model claim:

```ts
if (ctx.signal.aborted) {
  onProgress({
    type: "leg",
    legIndex,
    leg,
    status: "skipped",
    detail: "Cancelled.",
  });
  continue;
}
```

Use a preset-specific four-worker loop for Tool Reliability. Check
`ctx.signal.aborted` immediately before incrementing the cursor and again
before invoking `runSelected`. After workers settle, emit `"cancelled"` for
every unclaimed model. Pass a fresh `{ current: null }` ref and
`signal: ctx.signal` to every model-local `runSelected`.

After an active child returns, if the parent is aborted, report that model as
`"cancelled"` rather than `"failed"`. Keep provider failures isolated when the
parent is not aborted.

Pass the same parent signal to preset GameIQ and team/WorkBench helpers.

- [ ] **Step 5: Integrate the module-scoped coordinator into the panel**

Replace `runLockRef`, `presetCancelledRef`, and `presetAbortRef` with:

```tsx
const tabRun = useSyncExternalStore(
  certifiedTabRunCoordinator.subscribe,
  certifiedTabRunCoordinator.getSnapshot,
  certifiedTabRunCoordinator.getSnapshot
);
const busy = tabRun.owner !== null;
```

Both entry points use synchronous coordinator admission:

```tsx
function runPresetFromUi(preset: BenchmarkPreset) {
  certifiedTabRunCoordinator.tryStart(
    "preset",
    { presetId: preset.id },
    async (signal) => {
      setFocusedPresetId(preset.id);
      setRunningPresetId(preset.id);
      setPresetRunning(true);
      try {
        await runPreset(
          preset,
          {
            models,
            soloModelIds,
            effortByModelId,
            teamModelIds: sharedTeamModelIds,
            teamIqStrategy: sharedTeamIqStrategy,
            workBenchRoleMode: workBenchRoleModeFromCount(
              sharedTeamModelIds.length
            ),
            workBenchRunnerUrl,
            workBenchRunnerToken,
            fireworksPlayerCount: 2,
            signal,
            onComplete,
          },
          handlePresetProgress
        );
      } finally {
        setPresetRunning(false);
        setRunningPresetId(null);
      }
    }
  );
}
```

Use the same pattern for Advanced and pass `signal` to
`runSelectedTrack`/`runGameIqMultiModelExec`.

The preset Cancel action calls `certifiedTabRunCoordinator.cancel` with
`"Cancelled from preset run."`. The Advanced Cancel action uses
`"Cancelled from certified benchmark panel."`. Use `tabRun.owner` rather than
component-local booleans for launch disabling, active spinner/cancel
visibility, and the preset id shown after remount.

Add a remounted-run notice when `tabRun.owner !== null` but both local running
booleans are false:

```tsx
<div role="status">
  A certified {tabRun.owner} run continues in this tab.
  <Button onClick={cancelActiveTabRun}>Cancel</Button>
</div>
```

Do not cancel in an unmount effect.

When `tabRun.error` is present, mirror it into the panel's existing message
surface:

```tsx
useEffect(() => {
  if (tabRun.error) setMessage(tabRun.error);
}, [setMessage, tabRun.error]);
```

Update `RunProgressList` so `running && rows.length === 0` still renders the
continuation message and Cancel button. Render `"cancelled"` as `Cancelled`
with the muted/skipped tone.

- [ ] **Step 6: Strengthen UI/remount and source-wiring checks**

Extend `scripts/test-certified-run-lock.tsx` to simulate subscriber A
unmounting and subscriber B observing/cancelling the same signal, then render
the empty-running progress component and assert its Cancel button exists.

Extend `scripts/test-certified-workbench-ui.mts` with exact guards:

```ts
check(
  "certified panel uses the tab-lifetime coordinator",
  certifiedRunPanelSource.includes("useSyncExternalStore") &&
    certifiedRunPanelSource.includes("certifiedTabRunCoordinator.tryStart") &&
    certifiedRunPanelSource.includes("certifiedTabRunCoordinator.cancel") &&
    !certifiedRunPanelSource.includes("useRef(createCertifiedRunLock())") &&
    !certifiedRunPanelSource.includes("presetCancelledRef"),
  certifiedRunPanelSource
);
```

Delete `lib/benchmark/certified/run-lock.ts` and assert no production or test
import remains.

- [ ] **Step 7: Verify GREEN and focused regressions**

Run:

```powershell
npx tsx scripts/test-certified-run-lock.tsx
npx tsx scripts/test-certified-preset-cancellation.mts
npx tsx scripts/test-gameiq-concurrency-budget.mts
npx tsx scripts/test-gameiq-multi-model.mts
npx tsx scripts/test-certified-workbench-ui.mts
npx tsx scripts/test-workbench-runner-bundle.tsx
npx tsc --noEmit --pretty false
npm run lint
```

Expected: all PASS. The cancellation tests must use fake/local providers only.

- [ ] **Step 8: Register, self-review, and commit**

Add `test:certified-preset-cancellation` and invoke it from
`test:benchmark:unit` immediately after `test:certified-run-lock`:

```json
"test:certified-preset-cancellation": "tsx scripts/test-certified-preset-cancellation.mts"
```

The aggregate command prefix becomes exactly:

```text
npm run test:certified-run-lock && npm run test:certified-preset-cancellation && tsx scripts/test-benchmark-model-effort.mts
```

Preserve every aggregate clause after `test-benchmark-model-effort.mts`.

Review all signal listeners, every early return, model-failure isolation,
queued status emission, WorkBench post-health checking, remount UI state, and
release-after-settlement.

```powershell
git add lib/benchmark/certified/run-execution.ts components/benchmark/certified/CertifiedRunPanel.tsx components/benchmark/run/RunProgressList.tsx scripts/test-certified-run-lock.tsx scripts/test-certified-preset-cancellation.mts scripts/test-gameiq-concurrency-budget.mts scripts/test-certified-workbench-ui.mts package.json
git add -u lib/benchmark/certified/run-lock.ts
git commit -m "fix(benchmark): cancel complete preset run trees"
```

---

### Task 3: Block Copilot SDK sends after cancellation

**Files:**
- Modify: `lib/account-provider-copilot-sdk.mjs`
- Modify: `scripts/test-account-provider-copilot-sdk.mts`
- Modify: `public/aiboard-account-provider-runner.zip`

**Interfaces:**
- Consumes: the runner request-local `AbortSignal` already passed to
  `runCopilotSdkChat`.
- Preserves:

```js
runCopilotSdkChat(body, githubToken, baseDirectory, onToken, {
  signal,
  clientFactory,
})
```

- Produces: a fail-closed admission barrier before `client.start`,
  `client.createSession`, and `session.sendAndWait`.
- Runner version remains exactly `19`.

- [ ] **Step 1: Write failing pre-send cancellation tests**

Extend `scripts/test-account-provider-copilot-sdk.mts` with controlled
`client.start` and `createSession` gates.

Pin four races:

```ts
// Pre-aborted before entry.
controller.abort(preStartReason);
await assert.rejects(run(), (error) => error === preStartReason);
assert.equal(counts.start, 0);
assert.equal(counts.create, 0);
assert.equal(counts.send, 0);

// Abort while client.start is pending.
const duringStart = run();
await startEntered.promise;
controller.abort(startReason);
startGate.resolve();
await assert.rejects(duringStart, (error) => error === startReason);
assert.equal(counts.create, 0);
assert.equal(counts.send, 0);
assert.deepEqual(cleanup, ["stop"]);

// Abort while createSession is pending.
const duringCreate = run();
await createEntered.promise;
controller.abort(createReason);
createGate.resolve(fakeSession);
await assert.rejects(duringCreate, (error) => error === createReason);
assert.equal(counts.send, 0);
assert.deepEqual(cleanup, ["abort", "disconnect", "stop"]);

// Existing in-flight send.
await sendEntered.promise;
controller.abort(inFlightReason);
assert.deepEqual(cleanup, ["abort", "disconnect", "stop"]);
```

Use distinct `Error` instances and assert exact identity. No test may call the
real Copilot SDK or account.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/test-account-provider-copilot-sdk.mts
```

Expected RED: pre-aborted/delayed-setup cases invoke `sendAndWait` or fail to
surface the original abort reason.

- [ ] **Step 3: Add admission checks at every asynchronous setup boundary**

Add:

```js
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new Error("Copilot SDK request aborted.");
}
```

Use it before and after setup awaits:

```js
try {
  throwIfAborted(signal);
  await client.start();
  throwIfAborted(signal);
  session = await client.createSession(buildCopilotSdkSessionConfig(body));
  if (signal?.aborted) abortSession();
  else signal?.addEventListener("abort", abortSession, { once: true });
  throwIfAborted(signal);
  unsubscribe = session.on("assistant.message_delta", onDelta);
  throwIfAborted(signal);
  const result = await session.sendAndWait(
    { prompt: copilotSdkPromptFromMessages(body?.messages) },
    120_000
  );
  const content =
    typeof result?.data?.content === "string" ? result.data.content : "";
  if (!emittedText && content) onToken?.(content);
  return content;
} finally {
  signal?.removeEventListener("abort", abortSession);
  if (signal?.aborted) abortSession();
  await abortPromise;
  try { unsubscribe?.(); } catch {}
  try { await session?.disconnect?.(); } catch {}
  try { await client.stop?.(); } catch {}
}
```

Do not normalize or replace an existing `signal.reason`. Do not change prompt,
permission, model-capability, timeout, or token-stream behavior.

- [ ] **Step 4: Verify GREEN and runner regressions**

Run:

```powershell
npx tsx scripts/test-account-provider-copilot-sdk.mts
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
node --check lib/account-provider-copilot-sdk.mjs
node --check lib/account-provider-runner.mjs
```

- [ ] **Step 5: Regenerate and verify v19 artifacts**

Run:

```powershell
npm run publish-downloads
npm run build
npx tsx scripts/test-deploy-runner-artifacts.mts
```

Verify:

- `lib/account-provider-runner.mjs` still reports version `19`;
- ignored `public/account-provider-runner.mjs` equals source;
- the account ZIP's runner and Copilot SDK equal their source files;
- the WorkBench ZIP hash is unchanged and remains unstaged.

- [ ] **Step 6: Self-review and commit**

Inspect the fix-only diff for zero sends after pre-start/start/session
cancellation, exact reason identity, listener removal, cleanup order, version,
and archive membership.

```powershell
git add lib/account-provider-copilot-sdk.mjs scripts/test-account-provider-copilot-sdk.mts public/aiboard-account-provider-runner.zip
git commit -m "fix(provider): block cancelled Copilot SDK sends"
```

---

## Final acceptance and local merge

- [ ] Send every task commit to an independent task reviewer. Route any finding
  to the original implementer and require a fix-only re-review.
- [ ] Run independent final correctness and specification reviews over
  `c624825a..HEAD`, explicitly revisiting the original five findings, iterator
  closure, OAuth refresh, preset cancellation, Copilot setup admission, and
  same-tab remount behavior.
- [ ] Route final findings through one test-first fix wave and scoped re-review.
- [ ] Run fresh on the feature branch:

```powershell
npm run test:certified-run-lock
npm run test:certified-preset-cancellation
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-provider-abort-signals.mts
npx tsx scripts/test-account-runner-stream-cleanup.mts
npx tsx scripts/test-gameiq-transport-containment.mts
npx tsx scripts/test-gameiq-concurrency-budget.mts
npx tsx scripts/test-gameiq-multi-model.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-copilot-sdk.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
npx tsx scripts/test-deploy-runner-artifacts.mts
npm run test:gameiq-guards
npm run test:certified
npm run lint
npx tsc --noEmit --pretty false
npm run build
git diff --check c624825a..HEAD
git status --short
```

- [ ] Confirm the feature worktree is clean and local `main` remains at the
  expected reviewed baseline before merge.
- [ ] Fast-forward or merge `codex/fix-modeliq-account-concurrency` into local
  `main`, then rerun the same acceptance commands on the merged tree.
- [ ] Remove the owned feature worktree and delete the merged feature branch
  only after merged-tree verification succeeds.
- [ ] Replace/restart the standalone account-provider runner with the merged
  v19 source while preserving its configured token without printing it.
- [ ] Verify `/health` reports version `19` and ChatGPT remains connected.
