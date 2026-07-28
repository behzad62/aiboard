# Certified Token Containment Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every certified benchmark exit stops admitting paid work, propagates cancellation to its transport, and refuses to retry until the previous physical request has torn down.

**Architecture:** Treat cancellation as a linked hierarchy: page run → model run → GameIQ attempt → physical provider call → browser/runner upstream request. Each level owns a local controller, links its parent signal, cancels only its descendants, and removes listeners in `finally`. A physical retry is admitted only after the previous iterator has closed; inability to confirm teardown fails closed without another paid call.

**Tech Stack:** Next.js 16, React 19, strict TypeScript, browser `AbortController`, OpenAI JavaScript SDK, Anthropic TypeScript SDK, Google Gen AI JavaScript SDK, GitHub Copilot SDK, Node.js HTTP integration tests, JSZip release artifacts.

## Global Constraints

- Do not change benchmark cases, scoring, schemas, persistence formats, the 120-second production model-call timeout, the one-hour GameIQ budget, or retry delays/counts.
- One ModelIQ run may admit at most two models and four GameIQ scenarios per model: eight physical calls before retries.
- Tool Reliability keeps its independent four-model cap.
- No physical retry may start until the preceding iterator reports teardown; if teardown cannot be confirmed, fail closed without retrying.
- Iterator teardown has a 5,000 ms confirmation limit. Exceeding it produces a non-transient provider failure and suppresses the retry.
- Timeout, parent cancellation, budget exhaustion, fatal sibling failure, and downstream disconnect must abort only their descendant work; independently isolated model runs must continue.
- Preserve the original user-cancellation and budget-exhaustion reasons at the UI and durable evidence boundaries.
- Direct providers must receive the physical attempt signal through their documented SDK request option: OpenAI-compatible/Responses `{ signal }`, Anthropic request options `{ signal }`, and Google `GenerateContentConfig.abortSignal`.
- Google documents AbortSignal as client-only; tests may prove client transport closure, not provider-side billing cessation.
- Account-provider runner cancellation must cover ChatGPT, GitHub Copilot HTTP and SDK routes, and NVIDIA, for streaming and non-streaming requests.
- Bump the account-provider runner version from 18 to 19 and regenerate committed download ZIPs; ignored single-file copies must remain untracked and byte-identical to source.
- Tests must use local/fake transports only. Do not make paid live model calls.
- Preserve existing user changes. Work only on `codex/fix-modeliq-account-concurrency` until the reviewed branch is merged locally into `main`.

---

### Task 1: Fail-closed physical-attempt teardown and budget cancellation

**Files:**
- Modify: `lib/benchmark/certified/model-call.ts`
- Modify: `lib/providers/account-runner.ts`
- Modify: `scripts/test-certified-model-call.mts`
- Modify: `scripts/test-certified-model-call-retry.mts`
- Create: `scripts/test-account-runner-stream-cleanup.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ChatParams.signal`, `CallCertifiedModelInput.signal`, `CertifiedBudgetExceededError`, and the current transient retry loop.
- Produces: one physical attempt signal that is aborted on every non-success exit; an awaited iterator teardown gate; account-runner response-reader cleanup that closes the downstream HTTP request.
- Later tasks rely on direct provider iterators settling after their SDK request receives this signal.

- [ ] **Step 1: Write failing physical-attempt and budget tests**

Add behavioral cases with these literal expectations:

```ts
assert.equal(firstSignal.aborted, true);
assert.equal(secondAttemptStartedBeforeFirstReturnResolved, false);
assert.equal(retryCountWhenIteratorNeverConfirmsClose, 0);
assert.equal(budgetSignal.reason, budgetError);
```

The retry test must use a real custom `AsyncIterable` whose pending `next()` and `return()` are independently controlled. The budget test must yield one token, trigger the existing projected-USD or wall-clock guard, and observe the exact physical signal abort before `callCertifiedModelOnce` rejects.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
```

Expected RED: budget exit leaves the physical signal un-aborted and/or the retry enters while the prior iterator teardown is unresolved.

- [ ] **Step 3: Add a real account-runner reader-cleanup regression**

Start a local HTTP server that returns one SSE token and then stalls. Consume the real account-runner provider iterator, call `return()`, and assert the server observes request/socket closure. The production mutation that must fail this test is removing `reader.cancel()` or the reader `finally`.

- [ ] **Step 4: Run the account cleanup test and verify RED**

Run:

```powershell
npx tsx scripts/test-account-runner-stream-cleanup.mts
```

Expected RED: the local server does not observe the client connection close after iterator return.

- [ ] **Step 5: Implement abort-on-non-success and teardown gating**

Keep the physical `AbortController` in `callCertifiedModelOnce`. Track whether the stream completed normally. On every non-success exit:

```ts
abortAttempt(source, surfacedError);
await closeIteratorBeforeRetry(iterator);
```

Refactor the stream loop so `callCertifiedModelOnce` owns the underlying
iterator, the winning error, and cleanup ordering in one scope. The close gate
must:

- request `iterator.return()`;
- wait up to exactly 5,000 ms for teardown before returning the transient
  timeout to the retry loop;
- convert an unconfirmed teardown into a non-transient provider error whose message states that retry was suppressed to avoid overlapping paid calls;
- never replace an original parent-cancellation or budget error that already won.

In `streamRunnerEvents`, own the response reader explicitly:

```ts
const reader = response.body.getReader();
try {
  // existing decode/event loop
} finally {
  await reader.cancel().catch(() => undefined);
  reader.releaseLock();
}
```

- [ ] **Step 6: Verify GREEN and focused regressions**

Run:

```powershell
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-account-runner-stream-cleanup.mts
npx tsx scripts/test-account-provider-runner-chat.mts
```

Expected: all PASS, with exact cancellation/budget reasons preserved.

- [ ] **Step 7: Register the new test, self-review, and commit**

Add the stream-cleanup test to the relevant benchmark unit script. Inspect listener removal and every return/throw branch.

```powershell
git add lib/benchmark/certified/model-call.ts lib/providers/account-runner.ts scripts/test-certified-model-call.mts scripts/test-certified-model-call-retry.mts scripts/test-account-runner-stream-cleanup.mts package.json
git commit -m "fix(benchmark): gate retries on transport teardown"
```

---

### Task 2: Propagate cancellation through every direct provider adapter

**Files:**
- Modify: `lib/providers/openai-compat.ts`
- Modify: `lib/providers/openai.ts`
- Modify: `lib/providers/anthropic.ts`
- Modify: `lib/providers/google.ts`
- Modify: `lib/providers/xai.ts`
- Create: `scripts/test-provider-abort-signals.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the physical `ChatParams.signal` from Task 1.
- Produces: SDK request cancellation for OpenAI, OpenRouter, custom OpenAI-compatible models, xAI, Anthropic, Azure Foundry, and Google.
- OpenAI-compatible and Responses calls pass a second request-options argument `{ signal: params.signal }`.
- Anthropic merges `signal` with any existing interleaved-thinking headers in its request-options object.
- Google sets `generationConfig.abortSignal = params.signal`.

- [ ] **Step 1: Write the failing adapter-boundary test**

Exercise each real provider adapter with a controlled fetch boundary. The fake transport must remain pending until its received signal aborts, then record connection cancellation. Cover these provider families:

```ts
["openai-chat", "openai-responses", "openrouter", "custom", "xai", "anthropic", "foundry", "google"]
```

Assert observable abort behavior, not source text:

```ts
assert.equal(observedRequestSignal?.aborted, true);
assert.equal(iteratorSettledAfterAbort, true);
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npx tsx scripts/test-provider-abort-signals.mts
```

Expected RED: every currently unwired direct adapter remains pending or exposes no abort signal.

- [ ] **Step 3: Thread signals through documented SDK request options**

Use the existing call shapes and add only the cancellation option:

```ts
client.chat.completions.create(body, { signal: params.signal });
client.responses.create(body, { signal: params.signal });
client.messages.stream(body, { ...existingOptions, signal: params.signal });
genAI.models.generateContentStream({
  model: params.model,
  contents,
  config: { ...generationConfig, abortSignal: params.signal },
});
```

Do not change payload fields, models, reasoning, tools, structured output, usage accounting, or provider error normalization.

- [ ] **Step 4: Verify GREEN and provider regressions**

Run:

```powershell
npx tsx scripts/test-provider-abort-signals.mts
npx tsx scripts/test-provider-native-tools.mts
npx tsx scripts/test-provider-document-inputs.mts
npx tsx scripts/test-foundry-reasoning-payload.mts
npx tsx scripts/test-reasoning-routing.mts
```

- [ ] **Step 5: Register, self-review, and commit**

Confirm each SDK call receives the signal once and existing request options are merged rather than overwritten.

```powershell
git add lib/providers/openai-compat.ts lib/providers/openai.ts lib/providers/anthropic.ts lib/providers/google.ts lib/providers/xai.ts scripts/test-provider-abort-signals.mts package.json
git commit -m "fix(providers): propagate certified abort signals"
```

---

### Task 3: Abort sibling GameIQ scenarios on fatal or budget failure

**Files:**
- Modify: `lib/benchmark/gameiq/types.ts`
- Modify: `lib/benchmark/gameiq/runner.ts`
- Modify: `lib/benchmark/gameiq/certified-runner.ts`
- Modify: `scripts/test-gameiq-transport-containment.mts`

**Interfaces:**
- Adds `signal?: AbortSignal` to `RunGameIqScenariosInput` and `GameIqMoveProviderRequest`.
- `runGameIqScenarios` owns one linked local controller for one model/pack attempt.
- The certified move provider passes the request-local signal to `callCertifiedModel`.
- A transient provider failure remains an unscored scenario and does not abort siblings.

- [ ] **Step 1: Write the failing sibling-cancellation tests**

Start four scenario providers. Make one throw a fatal `CertifiedProviderError`; keep three pending until their request signals abort. Assert:

```ts
assert.equal(fatalErrorSurfaced, originalFatalError);
assert.deepEqual(abortedSiblingIndexes.sort(), [1, 2, 3]);
assert.equal(startedScenarioCountAfterFatal, 4);
assert.equal(anyLaterScenarioStarted, false);
```

Repeat with `CertifiedBudgetExceededError`. Keep the existing transient-containment case and assert it does not abort siblings.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/test-gameiq-transport-containment.mts
```

Expected RED: pending sibling signals do not abort and the test cannot complete without manually releasing them.

- [ ] **Step 3: Implement the linked attempt controller**

Link the parent signal once, remove its listener in `finally`, and pass the local signal into every `moveProvider` request. On the first fatal/budget error:

```ts
firstFatal ??= error;
attemptController.abort(firstFatal);
```

Workers must stop claiming new cursor indexes after abort. Preserve the first fatal/budget error for the caller even when siblings reject with the derived abort.

- [ ] **Step 4: Verify GREEN and GameIQ regressions**

Run:

```powershell
npx tsx scripts/test-gameiq-transport-containment.mts
npx tsx scripts/test-gameiq-concurrency-budget.mts
npx tsx scripts/test-gameiq-multi-model.mts
npm run test:gameiq-guards
```

- [ ] **Step 5: Self-review and commit**

Confirm the controller is scoped to one model/pack attempt and cannot cancel another model in the outer `Promise.allSettled` isolation.

```powershell
git add lib/benchmark/gameiq/types.ts lib/benchmark/gameiq/runner.ts lib/benchmark/gameiq/certified-runner.ts scripts/test-gameiq-transport-containment.mts
git commit -m "fix(gameiq): abort paid sibling calls on fatal failure"
```

---

### Task 4: Cancel every account-provider runner route on disconnect

**Files:**
- Modify: `lib/account-provider-runner.mjs`
- Modify: `lib/account-provider-copilot-sdk.mjs`
- Modify: `scripts/test-account-provider-runner-chat.mts`
- Modify: `scripts/test-account-provider-runner-copilot-chat.mts`
- Modify: `scripts/test-account-provider-copilot-sdk.mts`
- Modify: `scripts/test-account-provider-runner-nvidia.mts`
- Modify: `scripts/test-deploy-runner-artifacts.mts`
- Modify: `public/aiboard-account-provider-runner.zip`
- Modify: `public/aiboard-workbench-runner.zip` only if deterministic publication changes it

**Interfaces:**
- Runner version becomes exactly `19`.
- Every `/providers/*/chat` request owns one downstream-linked controller.
- ChatGPT, GitHub HTTP Responses/chat-completions, NVIDIA streaming/non-streaming fetches receive that signal.
- Copilot SDK receives the signal and calls `session.abort()` on disconnect before normal `disconnect()`/`client.stop()` cleanup.

- [ ] **Step 1: Write failing real disconnect tests**

For GitHub structured HTTP and NVIDIA streaming/non-streaming routes, use local fake upstream servers that stall after request admission. Abort the real runner client request and assert each fake upstream observes request/socket close.

For Copilot SDK, inject a fake session whose `sendAndWait` remains pending until `session.abort()`; abort the supplied signal and assert `abort`, `disconnect`, and `client.stop` each run once.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-copilot-sdk.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
```

Expected RED: the upstream request/session remains alive after downstream disconnect.

- [ ] **Step 3: Centralize request-local downstream cancellation**

Create one request-scoped controller before provider routing. Link `req.aborted` and premature `res.close`, pass its signal into every upstream function, mark normal response completion before `res.end()`, suppress only disconnect-induced abort failures, and remove both listeners in `finally`.

Update all fetch helpers to accept `signal` and pass it through both primary and fallback URLs. Update the Copilot SDK helper signature:

```js
runCopilotSdkChat(body, token, baseDirectory, onToken, {
  signal,
  clientFactory,
})
```

The signal listener invokes `session.abort()` when available; cleanup still disconnects the session and stops the client.

- [ ] **Step 4: Bump v19 and verify GREEN**

Run:

```powershell
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-copilot-sdk.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
```

Expected: version 19 and all real disconnect/socket-close assertions pass.

- [ ] **Step 5: Regenerate and verify artifacts**

Run:

```powershell
npm run publish-downloads
npx tsx scripts/test-deploy-runner-artifacts.mts
```

Verify `lib/account-provider-runner.mjs`, ignored `public/account-provider-runner.mjs`, and the account ZIP’s embedded runner are byte-identical. Inspect WorkBench ZIP membership/content before staging any deterministic refresh.

- [ ] **Step 6: Self-review and commit**

```powershell
git add lib/account-provider-runner.mjs lib/account-provider-copilot-sdk.mjs scripts/test-account-provider-runner-chat.mts scripts/test-account-provider-runner-copilot-chat.mts scripts/test-account-provider-copilot-sdk.mts scripts/test-account-provider-runner-nvidia.mts scripts/test-deploy-runner-artifacts.mts public/aiboard-account-provider-runner.zip
git add public/aiboard-workbench-runner.zip
git commit -m "fix(provider): cancel every disconnected runner request"
```

Stage the WorkBench ZIP only when the publication command changed it deterministically and the report identifies its sole embedded-file delta.

---

### Task 5: Serialize Advanced and preset benchmark entry points

**Files:**
- Create: `lib/benchmark/certified/run-lock.ts`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx`
- Modify: `components/benchmark/run/PresetCards.tsx` only if its public prop naming needs clarification
- Create: `scripts/test-certified-run-lock.tsx`
- Modify: `package.json`

**Interfaces:**
- `createCertifiedRunLock()` produces `tryAcquire(owner)`, `release(owner)`, and `activeOwner()` for owners `"advanced" | "preset"`.
- One `useRef` instance is shared by `runSelected` and `runPresetFromUi`.
- UI busy state is `running || presetRunning`; it disables both entry-point families while either owner is active.

- [ ] **Step 1: Write the failing synchronous lock/UI regression**

The pure coordinator test must attempt both starts in the same tick:

```ts
assert.equal(lock.tryAcquire("advanced"), true);
assert.equal(lock.tryAcquire("preset"), false);
lock.release("advanced");
assert.equal(lock.tryAcquire("preset"), true);
```

Also render `PresetCards` with the shared busy prop true and assert every Run button is disabled. Pin owner-safe release: releasing `"preset"` must not unlock an `"advanced"` owner.

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npx tsx scripts/test-certified-run-lock.tsx
```

Expected RED: the coordinator does not exist and the current independent state gates permit both entry points.

- [ ] **Step 3: Implement one synchronous page-level lock**

Acquire before any state update or asynchronous call. If acquisition fails, return without starting work. Release the matching owner in each flow’s `finally`. Feed the unified busy state to `getCertifiedRunGate`, `PresetCards`, and both button disabled states while retaining the correct spinner/cancel button for the active flow.

- [ ] **Step 4: Verify GREEN and UI regressions**

Run:

```powershell
npx tsx scripts/test-certified-run-lock.tsx
npx tsx scripts/test-certified-workbench-ui.mts
npx tsx scripts/test-workbench-runner-bundle.tsx
npm run lint
```

- [ ] **Step 5: Self-review and commit**

Confirm synchronous double-clicks, Advanced→preset, preset→Advanced, thrown runs, and cancellation all release or retain the correct owner.

```powershell
git add lib/benchmark/certified/run-lock.ts components/benchmark/certified/CertifiedRunPanel.tsx components/benchmark/run/PresetCards.tsx scripts/test-certified-run-lock.tsx package.json
git commit -m "fix(benchmark): serialize certified run entry points"
```

---

## Final acceptance and local merge

- [ ] Run independent whole-branch correctness and specification reviews over `c624825a..HEAD`, with explicit attention to every prior Important finding and the Google client-only cancellation limitation.
- [ ] Route any findings through one final test-first fix wave and one scoped re-review.
- [ ] Run fresh:

```powershell
npm run test:gameiq-guards
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-provider-abort-signals.mts
npx tsx scripts/test-account-runner-stream-cleanup.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-provider-runner-copilot-chat.mts
npx tsx scripts/test-account-provider-copilot-sdk.mts
npx tsx scripts/test-account-provider-runner-nvidia.mts
npx tsx scripts/test-deploy-runner-artifacts.mts
npm run lint
npm run build
git diff --check c624825a..HEAD
```

- [ ] Merge `codex/fix-modeliq-account-concurrency` into local `main`, rerun the same acceptance commands on the merged tree, remove the owned worktree, and delete the merged feature branch.
- [ ] Replace/restart the user’s standalone account-provider runner with the merged v19 source while preserving the configured runner token; verify `/health` reports version 19 and ChatGPT remains connected.
