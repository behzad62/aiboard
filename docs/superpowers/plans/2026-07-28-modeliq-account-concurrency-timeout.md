# ModelIQ Account Concurrency and Timeout Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a three-model ModelIQ run complete reliably by keeping GameIQ below the empirically safe account-provider pressure ceiling and by cancelling timed-out ChatGPT transports instead of leaving them alive during retries.

**Architecture:** GameIQ retains four parallel scenario calls inside one model, but its model scheduler admits at most two model runs at once, bounding the aggregate at eight calls—the last observed clean stored run—while non-GameIQ preset legs retain their existing four-model cap. Each certified physical call owns an abort controller that links user cancellation and timeout cancellation to `ChatParams.signal`; the standalone account runner then links a closed downstream client to the upstream ChatGPT fetch.

**Tech Stack:** Next.js 16 static export, React 19, strict TypeScript, Node.js ESM account-provider runner, `tsx` script tests.

## Global Constraints

- Do not modify, migrate, delete, or rewrite any persisted data under `C:\Users\b_a_s\OneDrive\Documents\AIBoard`.
- Do not change benchmark scoring, case content, retry counts/backoff, the 120000 ms certified call timeout, or the one-hour GameIQ wall-clock budget.
- Keep GameIQ scenario concurrency at exactly 4 per active model and cap active GameIQ models at exactly 2, so the aggregate bound is exactly 8 physical calls.
- Keep non-GameIQ solo preset concurrency at exactly 4; Tool Reliability already completed cleanly for all three selected models and must not be slowed by the GameIQ safety cap.
- A timed-out certified physical attempt must abort the exact signal passed to its provider stream before a retry begins.
- Existing user cancellation must still reject as user cancellation, not be relabeled as a provider timeout.
- A downstream disconnect from `/providers/chatgpt/chat` must abort the corresponding upstream ChatGPT Codex fetch.
- Update both `lib/account-provider-runner.mjs` and its generated `public/account-provider-runner.mjs` copy, and bump the standalone account-runner version from 17 to 18.
- Follow strict TDD: add the behavioral test, run it and capture the expected failure, then implement the minimum production change and rerun to green.
- Preserve all unrelated user changes and avoid unrelated refactors.

---

### Task 1: Bound GameIQ Aggregate Provider Pressure

**Files:**
- Create: `scripts/test-gameiq-concurrency-budget.mts`
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `mapWithConcurrency<T, R>(items, limit, mapper)` from `lib/benchmark/certified/run-execution.ts`.
- Produces: exported numeric constants `MAX_PARALLEL_GAMEIQ_MODELS = 2`, `MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL = 4`, and an independent internal `MAX_PARALLEL_PRESET_LEG_MODELS = 4`.

- [ ] **Step 1: Write the failing aggregate-concurrency test**

Create `scripts/test-gameiq-concurrency-budget.mts`. Import the two exported GameIQ constants and `mapWithConcurrency`. Schedule three synthetic model jobs through the real mapper; each job starts `MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL` deferred scenario promises while counters record active and peak physical calls. Release the first admitted batch, then the queued job. Assert these observable behaviors:

```ts
assert.equal(MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL, 4);
assert.ok(peakPhysicalCalls <= 8);
assert.equal(startedModelJobsBeforeFirstRelease, 2);
assert.equal(completedModelJobs, 3);
```

The test name/output must state that three ModelIQ models never exceed eight simultaneous GameIQ calls. Do not assert only the value of `MAX_PARALLEL_GAMEIQ_MODELS`; the worker-pool behavior must drive the peak counter.

- [ ] **Step 2: Run the new test to verify RED**

Run:

```powershell
npx tsx scripts/test-gameiq-concurrency-budget.mts
```

Expected: FAIL because the current scheduler admits all three model jobs, producing a peak of 12 and `startedModelJobsBeforeFirstRelease === 3`.

- [ ] **Step 3: Implement the minimal scheduler split**

In `run-execution.ts`:

```ts
export const MAX_PARALLEL_GAMEIQ_MODELS = 2;
export const MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL = 4;
```

Use `MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL` instead of the literal `4` in the `runCertifiedGameIq` call. Replace the reused preset constant with:

```ts
const MAX_PARALLEL_PRESET_LEG_MODELS = 4;
```

Update the nearby comments to document the eight-call aggregate and the deliberate independent cap for Tool Reliability. Add the new test to `test:gameiq-guards` in `package.json`.

- [ ] **Step 4: Verify GREEN and focused regressions**

Run:

```powershell
npx tsx scripts/test-gameiq-concurrency-budget.mts
npx tsx scripts/test-gameiq-multi-model.mts
```

Expected: both scripts print only PASS lines and exit 0.

- [ ] **Step 5: Commit**

```powershell
git add scripts/test-gameiq-concurrency-budget.mts lib/benchmark/certified/run-execution.ts package.json
git commit -m "fix(benchmark): bound GameIQ account concurrency"
```

### Task 2: Abort the Provider Stream on Certified Attempt Timeout

**Files:**
- Modify: `scripts/test-certified-model-call.mts`
- Modify: `lib/benchmark/certified/model-call.ts`

**Interfaces:**
- Consumes: `ChatParams.signal?: AbortSignal` and the existing `withCertifiedModelCallTimeout` timeout boundary.
- Produces: one physical-attempt `AbortController`; its signal is passed as `params.signal`, linked to `input.signal`, and aborted when that physical attempt times out.

- [ ] **Step 1: Extend the stalled-stream test to observe cancellation**

In the existing timeout case in `scripts/test-certified-model-call.mts`, capture the `params.signal` supplied to the injected `streamChat`. Make the stalled generator wait for that signal’s `abort` event, record that the event fired, and return. After `expectReject`, assert:

```ts
timeoutProviderReceivedSignal === true
timeoutProviderSignalAborted === true
timeoutProviderSignalReason includes "timed out" or "timeout"
```

Also add a focused parent-abort case whose injected stream observes its signal aborting after the caller aborts an `AbortController`; assert the surfaced error still matches the caller’s user-cancellation reason.

- [ ] **Step 2: Run the model-call test to verify RED**

Run:

```powershell
npx tsx scripts/test-certified-model-call.mts
```

Expected: FAIL because the current certified params carry no signal and the timeout wrapper only rejects its local race.

- [ ] **Step 3: Implement physical-attempt signal ownership**

In `callCertifiedModelOnce`, create one `AbortController` before constructing `ChatParams`. Link `input.signal` into it with a removable listener and preserve `input.signal.reason`. Set:

```ts
signal: attemptController.signal
```

on `params`. Extend `withCertifiedModelCallTimeout`/`withTimeout` with a timeout callback. When the timeout timer wins, reject with the existing exact timeout message and abort the attempt controller with that timeout error. Remove the parent listener in a `finally` that covers the provider attempt. Do not change retry policy, trace messages, error classification, or timeout duration.

- [ ] **Step 4: Verify GREEN and retry regression**

Run:

```powershell
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
```

Expected: both scripts print only PASS lines and exit 0.

- [ ] **Step 5: Commit**

```powershell
git add scripts/test-certified-model-call.mts lib/benchmark/certified/model-call.ts
git commit -m "fix(benchmark): abort timed-out provider calls"
```

### Task 3: Abort ChatGPT Upstream Work When the Runner Client Disconnects

**Files:**
- Modify: `scripts/test-account-provider-runner-chat.mts`
- Modify: `lib/account-provider-runner.mjs`
- Regenerate: `public/account-provider-runner.mjs`

**Interfaces:**
- Consumes: the browser-side fetch cancellation produced by Task 2, observed by the Node runner as an aborted/closed downstream request.
- Produces: an upstream `AbortController` used as the `signal` for the ChatGPT Codex `fetch` inside `streamChatGptChat`.

- [ ] **Step 1: Add a downstream-disconnect integration test**

Extend the fake ChatGPT backend in `scripts/test-account-provider-runner-chat.mts` with a request branch that starts a valid SSE response and deliberately never completes. Record the backend request’s `aborted`/socket-close event. Start a streaming request to the local account runner with an `AbortController`, wait until the fake backend has received it, abort the downstream fetch, then wait with a short bounded condition loop and assert the fake backend observed its upstream connection close. Keep the existing request-capture assertions unchanged.

Update the health assertion to expect runner version 18.

- [ ] **Step 2: Run the account-runner integration test to verify RED**

Run:

```powershell
npx tsx scripts/test-account-provider-runner-chat.mts
```

Expected: FAIL because closing the local runner response does not currently abort the upstream ChatGPT fetch, and health still reports version 17.

- [ ] **Step 3: Link downstream close to upstream abort**

In `lib/account-provider-runner.mjs`, bump:

```js
const VERSION = 18;
```

Inside `streamChatGptChat`, create an `AbortController`, register bounded one-shot listeners for downstream `req` abort and `res` close, pass `signal: controller.signal` to the ChatGPT Codex `fetch`, and remove listeners in `finally`. Abort only when the downstream connection closes before normal completion. Avoid writing an SSE error to an already destroyed response.

- [ ] **Step 4: Regenerate and verify both runner copies**

Run:

```powershell
node scripts/build-runner.mjs
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-deploy-runner-artifacts.mts
```

Expected: all commands exit 0; `lib/account-provider-runner.mjs` and `public/account-provider-runner.mjs` are byte-identical; the integration test proves the fake upstream connection closes after downstream cancellation.

- [ ] **Step 5: Commit**

```powershell
git add scripts/test-account-provider-runner-chat.mts lib/account-provider-runner.mjs public/account-provider-runner.mjs
git commit -m "fix(provider): cancel disconnected ChatGPT streams"
```

## Final Mechanical Verification

Run from the isolated worktree after all three reviewed tasks:

```powershell
npx tsx scripts/test-gameiq-concurrency-budget.mts
npx tsx scripts/test-gameiq-multi-model.mts
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-deploy-runner-artifacts.mts
npm run lint
npm run build
```

Inspect `git diff --check`, `git status --short`, and the complete branch diff against `main`. Do not run a live paid benchmark as automated verification.
