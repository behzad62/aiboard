# Runner Observability UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present Runner V2 activity as user-facing progress, verification, and active problems while retaining raw records in collapsed advanced diagnostics.

**Architecture:** Add a pure presentation projection in `RunnerV2ObservabilityPanel.tsx` that translates existing `NativeBuildObservability` and `NativeBuildProjection` data into friendly sections. Render that projection by default and move the existing diagnostic UI, search, and audit download into a native collapsed disclosure.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, lucide-react, Node/tsx contract tests.

## Global Constraints

- Product Build mode continues to use only `lib/client/native-build-engine.ts` and Runner V2.
- No Runner protocol, durable event, or AIPaintball project changes.
- Raw audit data remains available and downloadable.
- The default UI contains no worker IDs, raw tool names, raw event names, sequence numbers, process commands, or skill inventories.
- Advanced diagnostics is collapsed by default and keyboard accessible.
- Node.js 24.18.0 or newer remains supported.

---

### Task 1: User-facing Runner activity panel

**Files:**
- Modify: `components/RunnerV2ObservabilityPanel.tsx`
- Modify: `scripts/test-runner-v2-observability.mts`
- Test: `scripts/test-runner-v2-observability.mts`

**Interfaces:**
- Consumes: `NativeBuildObservability`, `NativeBuildProjection`, and the existing optional `onDownloadAudit` callback.
- Produces: exported pure helper `runnerUserFacingObservability(snapshot, projection)` returning `{ lifecycle, progress, verification, problems }` for contract testing.

- [ ] **Step 1: Write failing contract tests**

Add assertions that require `runnerUserFacingObservability` to:

```ts
const view = runnerUserFacingObservability(observability, projection);
assert.equal(view.lifecycle, "Ready for your decision");
assert.equal(view.progress.completed, 1);
assert.equal(view.verification.find((item) => item.category === "Tests")?.status, "passed");
assert.deepEqual(view.problems, []);
```

Also read `RunnerV2ObservabilityPanel.tsx` as text and assert that it contains `Build activity`, `Progress`, `Verification`, `Problems requiring attention`, and `<details`, while `Search durable runner records`, `Agent sessions`, and `Recent tools` occur after the Advanced diagnostics disclosure.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx scripts/test-runner-v2-observability.mts`

Expected: failure because `runnerUserFacingObservability` and the new section copy do not exist.

- [ ] **Step 3: Implement the pure user-facing projection**

In `RunnerV2ObservabilityPanel.tsx`, add focused helpers that:

```ts
export function runnerUserFacingObservability(
  snapshot: NativeBuildObservability,
  projection: NativeBuildProjection | null
): {
  lifecycle: string;
  progress: { completed: number; total: number; items: Array<{ key: string; title: string; detail: string }> };
  verification: Array<{ key: string; category: string; title: string; detail: string; status: "passed" | "failed" | "recorded" }>;
  problems: Array<{ key: string; title: string; detail: string }>;
}
```

Group evidence by `taskId` plus a friendly category (`Tests`, `Browser checks`, `Source control`, or `Other checks`) and retain only the newest `createdAt` record in each group. Derive problems only from current projection/agent/provider state, not historical tool errors.

- [ ] **Step 4: Render the three default sections and collapsed diagnostics**

Replace the diagnostic-first layout with:

```tsx
<h2>Build activity</h2>
<UserSection title="Progress" />
<UserSection title="Verification" />
<UserSection title="Problems requiring attention" />
<details>
  <summary>Advanced diagnostics</summary>
  {/* existing counters, search, lists, processes, and audit download */}
</details>
```

Use plain-language copy, semantic success/warning/error accents, visible focus states, responsive single-column stacking, and no additional animation.

- [ ] **Step 5: Verify focused and project contracts**

Run:

```powershell
npx tsx scripts/test-runner-v2-observability.mts
npm run lint
npx tsc --noEmit
npm run test:runner-v2
git diff --check
```

Expected: all commands pass with zero errors.

- [ ] **Step 6: Commit**

```powershell
git add components/RunnerV2ObservabilityPanel.tsx scripts/test-runner-v2-observability.mts docs/superpowers/specs/2026-07-13-runner-observability-ux-design.md docs/superpowers/plans/2026-07-13-runner-observability-ux.md
git commit -m "feat(build): simplify runner activity for users"
```
