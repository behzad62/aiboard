# WorkBench Managed Runner V2 Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute every certified WorkBench case through an automatically launched per-attempt Runner V2 child and expose readiness, evidence, retention, and failures in the Benchmark UI.

**Architecture:** The Bench Runner owns fixture/oracle lifecycle and launches a one-project Runner V2 child on an ephemeral port. A benchmark-only browser adapter drives the existing `/v2` API, automatically applies handoff, records native usage/tool evidence, stops the child, and then allows deterministic verification.

**Tech Stack:** Node.js 24.18.0, TypeScript, standalone Node `.mjs` Bench Runner, React 19, Next.js static export, Runner V2 HTTP control plane, `node:test`/assert script tests.

## Global Constraints

- Runner V2 remains bound to one absolute project path per process.
- Runner V2 state stays outside the attempt workspace.
- Hidden oracle files are physically absent while Runner V2 is alive.
- WorkBench allowed commands are enforced in native process and evidence tools.
- MCP is disabled for managed benchmark children.
- Successful attempts are cleaned; failed and invalid attempts are retained without secrets.
- Product Build mode must not import `legacy-build-engine.benchmark.ts`.
- Development is Windows/PowerShell; Runner V2 uses Node.js exactly 24.18.0.

---

### Task 1: Bench Runner managed-child and oracle lifecycle

**Files:**
- Modify: `scripts/bench-runner.mjs`
- Modify: `lib/client/bench-runner.ts`
- Modify: `scripts/test-bench-runner-contract.mts`

**Interfaces:**
- Produces `ManagedAttemptRunnerResult { attemptId, url, token, projectPath, statePath, pid, nodeVersion }`.
- Produces `startManagedAttemptRunner`, `getManagedAttemptRunner`, and `stopManagedAttemptRunner` browser client functions.
- Extends `BenchRunnerHealth` with `runnerV2: { ready, source?, nodeVersion?, error? }`.

- [ ] **Step 1: Write failing contract tests**

Add tests that start Bench Runner with a fake Runner V2 launcher and assert:

```ts
const started = await post("/bench/attempt-runner/start", { attemptId });
assert.equal(started.attemptId, attemptId);
assert.match(started.url, /^http:\/\/127\.0\.0\.1:/);
assert.ok(started.token.length >= 16);
assert.equal((await post("/bench/attempt-runner/status", { attemptId })).running, true);
assert.equal((await post("/bench/attempt-runner/stop", { attemptId })).running, false);
```

Also assert hidden oracle files return absent during the child lifetime, are restored before verifier execution, `.git` is excluded from snapshots/diffs, duplicate stop is harmless, and Bench Runner shutdown terminates the fake child.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npx tsx scripts/test-bench-runner-contract.mts`

Expected: FAIL because `/bench/attempt-runner/start` is unknown and health has no managed Runner V2 capability.

- [ ] **Step 3: Implement lifecycle and external metadata**

Add authenticated routes:

```js
case "/bench/attempt-runner/start": return startAttemptRunner(body);
case "/bench/attempt-runner/status": return statusAttemptRunner(body);
case "/bench/attempt-runner/stop": return stopAttemptRunner(body);
```

Store metadata under `<root>/.attempt-meta/<attemptId>.json`, state under `<root>/.runner-v2-state/<attemptId>`, and live child handles only in memory. Discover Runner V2 from `--runner-v2-dir`, sibling distribution, or repository source. Launch with port `0`, parse the first JSON stdout record, health-check it, and return the ephemeral connection. Remove model-hidden files after snapshot and restore canonical copies only after confirmed stop. Exclude `.git`, metadata roots, and runner-state roots from `walk()`.

- [ ] **Step 4: Add typed browser client methods**

Implement:

```ts
export function startManagedAttemptRunner(config, input): Promise<ManagedAttemptRunnerResult>;
export function getManagedAttemptRunner(config, input): Promise<ManagedAttemptRunnerStatus>;
export function stopManagedAttemptRunner(config, input): Promise<ManagedAttemptRunnerStatus>;
```

Use the existing authenticated `requestJson` transport.

- [ ] **Step 5: Verify GREEN**

Run: `npx tsx scripts/test-bench-runner-contract.mts`

Expected: PASS, including hidden-oracle and child-termination assertions.

- [ ] **Step 6: Commit**

```powershell
git add scripts/bench-runner.mjs lib/client/bench-runner.ts scripts/test-bench-runner-contract.mts
git commit -m "feat(workbench): manage per-attempt Runner V2 children"
```

### Task 2: Native benchmark command policy

**Files:**
- Modify: `runner-v2/src/build-spec.ts`
- Modify: `runner-v2/src/control-server.ts`
- Modify: `runner-v2/src/native-build-factory.ts`
- Modify: `runner-v2/src/process-tools.ts`
- Modify: `runner-v2/src/evidence-tools.ts`
- Modify: `runner-v2/src/worker-runtime.ts`
- Modify: `runner-v2/src/subagent-tools.ts`
- Modify: `runner-v2/src/native-architect-runtime.ts`
- Modify: `runner-v2/src/native-worker-driver.ts`
- Modify: `lib/client/runner-v2.ts`
- Test: `runner-v2/test/process-tools.test.ts`
- Test: `runner-v2/test/evidence-tools.test.ts`
- Test: `runner-v2/test/control-server.test.ts`

**Interfaces:**
- Adds optional `benchmark?: { attemptId: string; allowedCommands: string[] }` to native Build creation/specification.
- Adds `allowedCommands?: readonly string[]` to process/evidence tool construction.

- [ ] **Step 1: Write failing policy tests**

Assert an exact rendered invocation is permitted and all other commands are blocked:

```ts
const tools = createProcessTools({ allowedCommands: ["npm test"] });
assert.equal((await execute(tools, { command: "npm", args: ["test"] })).isError, false);
assert.equal((await execute(tools, { command: "npm", args: ["install"] })).error?.code, "benchmark_command_denied");
```

Repeat for `run_evidence_command`, shell scripts, and control-server Build-body validation.

- [ ] **Step 2: Run focused Runner V2 tests and verify RED**

Run: `npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test runner-v2/test/process-tools.test.ts runner-v2/test/evidence-tools.test.ts runner-v2/test/control-server.test.ts`

Expected: FAIL because the options and Build field do not exist.

- [ ] **Step 3: Implement exact command rendering and enforcement**

Add a shared renderer that compares either `command + args` or the exact shell script against trimmed allowlist entries. Return a tool error with code `benchmark_command_denied` before spawning. Thread the optional policy from `NativeBuildSpec` through factory, Architect, workers, and subagents into both tool constructors.

- [ ] **Step 4: Validate and persist benchmark policy**

Reject empty attempt IDs, empty commands, duplicate commands, and non-string values in `assertBuildBody`; clone the policy in spec persistence and client types.

- [ ] **Step 5: Verify GREEN and regression suite**

Run the focused command from Step 2, then `npm run test:runner-v2` and `npm run typecheck:runner-v2`.

Expected: all PASS.

- [ ] **Step 6: Commit**

```powershell
git add runner-v2/src runner-v2/test lib/client/runner-v2.ts
git commit -m "feat(runner-v2): enforce WorkBench command policy"
```

### Task 3: Native WorkBench adapter and evidence mapping

**Files:**
- Create: `lib/benchmark/workbench/native-runner-adapter.ts`
- Create: `scripts/test-workbench-native-runner-adapter.mts`
- Modify: `lib/client/native-build-engine.ts`
- Create: `lib/client/native-provider-config.ts`
- Modify: `lib/benchmark/workbench/types.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `runNativeWorkBenchBuild(input: NativeWorkBenchBuildInput): Promise<WorkBenchBuildExecutionResult>`.
- Produces pure `mapNativeUsageToBenchmarkTraces` and `mapNativeToolsToBenchmarkTraces` helpers.
- Extracts reusable `createNativeProviderConfig(runtimeId, options)` without product-discussion persistence.

- [ ] **Step 1: Write failing adapter tests**

Use injected Bench and Runner V2 clients to assert start → configure → create → start → poll → automatic eligible Architect handoff → `apply_to_project` → audit → stop ordering. Assert settled model reservations map to unique certified traces and completed tool observations map to valid/failed tool traces.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/test-workbench-native-runner-adapter.mts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Extract provider configuration**

Move provider transport, pricing, capability, and credential mapping from `native-build-engine.ts` into `native-provider-config.ts`. Keep the product engine behavior unchanged and add a parameterized API suitable for selected benchmark models.

- [ ] **Step 4: Implement native benchmark orchestration**

Create the managed child, verify health/project path, configure selected providers, create a Build with `permissionProfile: "full"`, `runPolicy: "finish"`, case budget limits, and benchmark command policy. Poll native run/build state with abort support. Resolve only an offered Architect runtime present in the selected team. Apply project handoff, fetch audit/usage/observability, record traces/tool calls/events/artifact, and stop in `finally`.

- [ ] **Step 5: Implement evidence mapping**

Create one model trace per settled attributed reservation. Use `settledAt` for timestamps, actual usage for token/cost values, and reservation ID for stable identity. Create one tool trace per completed observation and count validity from `isError`.

- [ ] **Step 6: Verify GREEN**

Run: `npx tsx scripts/test-workbench-native-runner-adapter.mts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add lib/benchmark/workbench lib/client/native-build-engine.ts lib/client/native-provider-config.ts scripts/test-workbench-native-runner-adapter.mts package.json
git commit -m "feat(workbench): execute builds through native Runner V2"
```

### Task 4: Certified execution, retention, and artifacts

**Files:**
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `lib/benchmark/workbench/certified-runner.ts`
- Modify: `lib/benchmark/workbench/executor.ts`
- Modify: `lib/benchmark/workbench/artifacts.ts`
- Modify: `scripts/test-workbench-executor.mts`
- Modify: `scripts/test-certified-workbench-runner.mts`

**Interfaces:**
- Production WorkBench passes the native adapter as `runBuild`.
- Adds retained-state and Runner V2 audit artifacts without secrets.
- Cleanup policy is based on final certified attempt status.

- [ ] **Step 1: Write failing certified-flow tests**

Assert passed attempts call cleanup, failed/invalid attempts do not, retained failures include workspace/state artifacts, and production `runSelected` supplies the native adapter instead of reaching the missing legacy callback error.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/test-workbench-executor.mts && npx tsx scripts/test-certified-workbench-runner.mts`

Expected: FAIL because cleanup is unconditional and production has no native executor.

- [ ] **Step 3: Implement outcome-aware cleanup**

Track the final attempt status in `executeWorkBenchVerifierOnly`. Call `cleanupBenchRun` only for `passed`; preserve failed and invalid attempts and attach sanitized retained paths returned by the adapter.

- [ ] **Step 4: Wire production certified execution**

Pass selected models, team composition, context, and signal to `runNativeWorkBenchBuild` from `run-execution.ts`. Remove the unreachable legacy discussion branch from the production path while retaining injection seams for tests.

- [ ] **Step 5: Verify GREEN**

Run the two commands from Step 2 and `npm run test:benchmark:workbench`.

Expected: all PASS.

- [ ] **Step 6: Commit**

```powershell
git add lib/benchmark scripts/test-workbench-executor.mts scripts/test-certified-workbench-runner.mts
git commit -m "feat(benchmark): certify native WorkBench execution"
```

### Task 5: Benchmark UI readiness and progress

**Files:**
- Modify: `components/benchmark/workbench/WorkBenchRunnerStatus.tsx`
- Modify: `components/benchmark/workbench/WorkBenchRunPanel.tsx`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx`
- Modify: `scripts/test-certified-workbench-ui.mts`

**Interfaces:**
- WorkBench readiness requires `health.ok && health.runnerV2.ready`.
- UI displays managed Runner V2 source/version or actionable `--runner-v2-dir` setup text.

- [ ] **Step 1: Write failing UI source tests**

Assert the panel renders separate `Bench Runner` and `Managed Runner V2` states, blocks Run when managed capability is unavailable, and contains no second persistent Runner V2 token field.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/test-certified-workbench-ui.mts`

Expected: FAIL because UI readiness checks only `health.ok`.

- [ ] **Step 3: Implement UI changes**

Render managed readiness/version under the existing Bench connection form. Update preset gates and notes to require the managed capability. Surface native execution phases through existing certified progress messages and link retained/audit artifacts in results using existing artifact rendering.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx scripts/test-certified-workbench-ui.mts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add components/benchmark scripts/test-certified-workbench-ui.mts
git commit -m "feat(benchmark-ui): show managed Runner V2 readiness"
```

### Task 6: End-to-end verification and distribution guidance

**Files:**
- Modify: `scripts/test-certified-e2e-workbench-fixture.mts`
- Modify: `scripts/publish-downloads.mjs`
- Modify: `components/benchmark/workbench/WorkBenchRunnerStatus.tsx`
- Modify: `README.md` if it contains WorkBench startup guidance

**Interfaces:**
- Published Bench Runner documentation describes `--runner-v2-dir` and sibling auto-discovery.
- End-to-end test proves prepare → managed native Build → applied handoff → verifier → cleanup.

- [ ] **Step 1: Write the failing end-to-end fixture**

Use a deterministic local account-runner/fake provider transport and a minimal fixture. Assert at least one native model trace, at least one native tool trace, applied file changes, verifier pass, child exit, and successful cleanup.

- [ ] **Step 2: Run and verify RED**

Run: `npx tsx scripts/test-certified-e2e-workbench-fixture.mts`

Expected: FAIL until distribution discovery and the full bridge are connected.

- [ ] **Step 3: Update publishing and guidance**

Ensure the downloadable Bench Runner prints discovery status and exact startup guidance:

```powershell
node .\bench-runner.mjs --runner-v2-dir C:\tools\aiboard-runner-v2
```

Document sibling auto-discovery and retained-failure paths.

- [ ] **Step 4: Run complete verification**

Run:

```powershell
npm run test:benchmark:workbench
npm run test:runner-v2
npm run typecheck:runner-v2
npm run lint
npm run build
```

Expected: all commands exit `0`. Stop the development server before `npm run build`, then restart it afterward if manual browser verification is needed.

- [ ] **Step 5: Manually verify the Benchmark tab**

Start the app, Account Provider Runner, and Bench Runner with Runner V2 discovery. Confirm healthy readiness, execute one WorkBench fixture, inspect audit/trace artifacts, and confirm no child remains after success.

- [ ] **Step 6: Commit**

```powershell
git add scripts/publish-downloads.mjs scripts/test-certified-e2e-workbench-fixture.mts components/benchmark/workbench/WorkBenchRunnerStatus.tsx README.md
git commit -m "test(workbench): verify managed Runner V2 bridge end to end"
```
