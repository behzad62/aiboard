# WorkBench Lifecycle Recovery Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent worker lifecycle recovery attempts from exhausting the Architect's independent recovery allowance during certified WorkBench runs.

**Architecture:** Derive the bounded continuation key from the lifecycle owner: one Architect key and one worker key per task. Keep all existing continuation limits and certified failure mappings unchanged.

**Tech Stack:** TypeScript, Node.js 24.18.0, Runner V2, Next.js.

## Global Constraints

- Keep lifecycle recovery bounded at two adapter continuations per owner/task scope.
- Do not change provider, budget, protocol, or verifier classification behavior.
- Preserve benchmark audit recording on both success and failure.

---

### Task 1: Reproduce the shared-counter failure

**Files:**
- Modify: `scripts/test-workbench-native-runner-adapter.mts`

**Interfaces:**
- Consumes: `runNativeWorkBenchBuild` and mocked native build projections.
- Produces: a regression sequence with independent Architect and worker pauses followed by project handoff.

- [x] Extend the success-path projection sequence with Architect, worker `T1`, then Architect lifecycle pauses.

Use projections equivalent to:

```ts
{ status: "paused", pauseReason: { reason: "model_ended_without_lifecycle:" } }
{ status: "paused", pauseReason: { reason: "worker_model_ended_without_lifecycle", taskId: "T1" } }
{ status: "paused", pauseReason: { reason: "model_ended_without_lifecycle:" } }
{ status: "paused", projectHandoff: { status: "requested", options: ["apply_to_project"] } }
```

Assert that three `continue-build` calls occur before `apply-handoff`.

- [x] Run `npx tsx scripts/test-workbench-native-runner-adapter.mts` and confirm it fails before project handoff because the shared recovery key is exhausted.

### Task 2: Scope lifecycle recovery keys

**Files:**
- Modify: `lib/benchmark/workbench/native-runner-adapter.ts`

**Interfaces:**
- Consumes: pause reason and optional paused task identifier.
- Produces: `architect-model-lifecycle-repair` or `worker-model-lifecycle-repair:<taskId>` continuation keys.

- [x] Pass `projection.pauseReason?.taskId` into `nativePauseDisposition`.
- [x] Return owner/task-scoped keys for no-lifecycle pauses while keeping limit `2`.

Implement the key split as:

```ts
if (normalized.startsWith("model_ended_without_lifecycle:")) {
  return lifecycleRepair("architect-model-lifecycle-repair", normalized);
}
if (normalized.startsWith("worker_model_ended_without_lifecycle")) {
  return lifecycleRepair(
    `worker-model-lifecycle-repair:${taskId?.trim() || "unknown-task"}`,
    normalized
  );
}
```

- [x] Run the focused regression and confirm it passes.

### Task 3: Verify, publish, and restart

**Files:**
- Verify: WorkBench adapter and Runner V2 suites.
- Publish: `public/aiboard-runner-v2.zip`.

**Interfaces:**
- Consumes: repository verification and publish scripts.
- Produces: a rebuilt app and Runner V2 package ready for the certified rerun.

- [x] Run the focused test, WorkBench benchmark tests, Runner V2 tests, lint, and typecheck.

Run:

```powershell
npx tsx scripts/test-workbench-native-runner-adapter.mts
npm run test:benchmark:workbench
npm run test:runner-v2
npm run lint
npx tsc --noEmit
```

- [x] Build the app with the dev server stopped, then restore it.
- [x] Confirm the rebuilt Runner V2 bundle is unchanged and keep the healthy `WorkBenchTest` runner running.
- [x] Commit the fix and restart the 19-case GPT-5.4 Mini WorkBench run in Chrome.
