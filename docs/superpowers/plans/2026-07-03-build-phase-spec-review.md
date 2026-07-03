# Build Phase Spec Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Build mode create a current-phase spec and require both spec-compliance and code-quality approval before task completion.

**Architecture:** Extend the existing Build action protocol instead of adding separate reviewer calls. `lib/orchestrator/build.ts` owns phase-spec types, parser normalization, review gate helpers, and prompt copy; `lib/client/build-engine.ts` owns active phase spec persistence, task association, and state transitions. Plain `tsx` scripts cover parser/prompt helpers and review gate rules before production code changes.

**Tech Stack:** TypeScript strict, Next.js client-side app, existing plain `tsx` test scripts, ESLint flat config.

---

### Task 1: Protocol Tests

**Files:**
- Modify: `scripts/test-parse-action.mts`
- Modify after red test: `lib/orchestrator/build.ts`

- [ ] **Step 1: Write failing parser and helper tests**

Add cases to `scripts/test-parse-action.mts` that expect:

```ts
const phasePlan = parseArchitectAction(
  '{"action":"plan","phaseSpec":{"id":"P1","objective":"Ship review gates","acceptanceCriteria":["Both gates are parsed"],"qualityCriteria":["Legacy verdicts still work"],"verification":["npm run lint"]},"tasks":[{"id":"T1","title":"Parser","instructions":"Update parser"}]}'
);
console.log(
  `${phasePlan?.action === "plan" && phasePlan.phaseSpec?.acceptanceCriteria[0] === "Both gates are parsed" ? "PASS" : "FAIL"} - plan parses phaseSpec`
);
```

Add review-result checks for:

```ts
{"action":"review","results":[{"taskId":"T1","specVerdict":"approve","qualityVerdict":"fix","qualityIssues":"Missing test","fixInstructions":"Add parser test"}],"done":false}
{"action":"review","results":[{"taskId":"T1","verdict":"approve"}],"done":true}
{"action":"review","results":[{"taskId":"T1","verdict":"fix","specVerdict":"approve","qualityIssues":"Needs cleanup"}],"done":false}
```

The first must preserve the explicit gate verdicts. The second must normalize legacy `verdict: "approve"` to both gates approving. The third must leave `specVerdict` approved and map the missing `qualityVerdict` to fix.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: FAIL lines for phase spec and/or gate verdict parsing because the current parser only preserves the legacy single `verdict` contract.

- [ ] **Step 3: Add protocol types and parser normalization**

In `lib/orchestrator/build.ts`, add `BuildPhaseSpec`, `ReviewGateVerdict`, `ReviewResult`, and helpers:

```ts
export type ReviewGateVerdict = "approve" | "fix";

export interface BuildPhaseSpec {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  qualityCriteria: string[];
  verification: string[];
  constraints?: string[];
}

export interface ReviewResult {
  taskId: string;
  specVerdict: ReviewGateVerdict;
  qualityVerdict: ReviewGateVerdict;
  verdict?: ReviewGateVerdict;
  specIssues?: string;
  qualityIssues?: string;
  fixInstructions?: string;
}
```

Normalize `PlanAction.phaseSpec` and `ReviewAction.results` inside `parseActionCandidate`.

- [ ] **Step 4: Run protocol tests to verify they pass**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: all cases print PASS and the process exits 0.

### Task 2: Review Gate State Helpers

**Files:**
- Modify: `scripts/test-parse-action.mts`
- Modify after red test: `lib/orchestrator/build.ts`

- [ ] **Step 1: Write failing review gate helper tests**

Import and test:

```ts
isReviewResultApproved
buildReviewGateFixInstructions
```

Assertions:

```ts
isReviewResultApproved({ taskId: "T1", specVerdict: "approve", qualityVerdict: "approve" }) === true
isReviewResultApproved({ taskId: "T1", specVerdict: "fix", qualityVerdict: "approve" }) === false
isReviewResultApproved({ taskId: "T1", specVerdict: "approve", qualityVerdict: "fix" }) === false
buildReviewGateFixInstructions({ taskId: "T1", specVerdict: "fix", qualityVerdict: "fix", specIssues: "Missing setting", qualityIssues: "No test", fixInstructions: "Update files" }).includes("Spec-compliance issues")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: TypeScript import failure because the helpers do not exist yet.

- [ ] **Step 3: Implement helpers**

Add pure helpers in `lib/orchestrator/build.ts`:

```ts
export function isReviewResultApproved(result: Pick<ReviewResult, "specVerdict" | "qualityVerdict">): boolean {
  return result.specVerdict === "approve" && result.qualityVerdict === "approve";
}

export function buildReviewGateFixInstructions(result: ReviewResult): string {
  const sections = [
    result.specVerdict === "fix" ? `Spec-compliance issues: ${result.specIssues?.trim() || "Review did not approve the implementation against the phase spec."}` : "",
    result.qualityVerdict === "fix" ? `Code-quality issues: ${result.qualityIssues?.trim() || "Review did not approve the code-quality gate."}` : "",
    result.fixInstructions?.trim() ? `Fix instructions: ${result.fixInstructions.trim()}` : "",
  ].filter(Boolean);
  return sections.join("\n");
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: all cases print PASS and the process exits 0.

### Task 3: Prompts And Schema

**Files:**
- Modify: `scripts/test-parse-action.mts`
- Modify after red test: `lib/orchestrator/build.ts`

- [ ] **Step 1: Write failing prompt tests**

Add checks that:

```ts
buildArchitectPlanPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 0,
}).includes('"phaseSpec"')
buildWorkerTaskPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  task: parsedTaskWithPhaseSpec,
  contextFileText: "",
  architectNotes: "",
}).includes("Current phase spec")
buildArchitectReviewPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  executedText: "T1 changed lib/orchestrator/build.ts",
  maxNewTasks: 3,
  cyclesLeft: 1,
  phaseSpec: parsedPhaseSpec,
}).includes("specVerdict")
buildArchitectReviewPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  executedText: "T1 changed lib/orchestrator/build.ts",
  maxNewTasks: 3,
  cyclesLeft: 1,
  phaseSpec: parsedPhaseSpec,
}).includes("qualityVerdict")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: FAIL for prompt-copy checks because current prompts only mention the legacy `verdict`.

- [ ] **Step 3: Update schema and prompt copy**

Update `buildArchitectActionResponseFormat` to include `phaseSpec`, `specVerdict`, `qualityVerdict`, `specIssues`, and `qualityIssues`. Update plan, worker, and review prompts to require a current-phase spec and the two-gate review JSON.

- [ ] **Step 4: Run prompt tests to verify they pass**

Run: `npx tsx scripts/test-parse-action.mts`

Expected: all cases print PASS and the process exits 0.

### Task 4: Engine Wiring

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/orchestrator/build.ts`

- [ ] **Step 1: Write failing type/state checks in the existing parser script where possible**

Use exported helpers to prove both-gate approval logic before wiring the engine. The engine itself is not currently unit-testable without browser storage and provider setup, so keep direct tests on pure helpers and use TypeScript/lint for integration wiring.

- [ ] **Step 2: Persist and assign phase specs**

Add optional `phaseSpec?: BuildPhaseSpec` to `BuildTask` and `BuildCheckpointTask`; add optional `phaseSpec?: BuildPhaseSpec` to `BuildCheckpoint`. In `runBuildDiscussion`, keep `activePhaseSpec`, restore it from checkpoints, assign it when creating tasks, pass it into worker and review context, and save it in checkpoints.

- [ ] **Step 3: Update review state transitions**

Replace `result.verdict === "approve"` with `isReviewResultApproved(result)`. For any fix gate, call `buildReviewGateFixInstructions(result)` and send the task back to fixing. Forced or omitted review results must stay fixing and ask for explicit spec and quality verdicts.

- [ ] **Step 4: Run TypeScript and parser checks**

Run:

```bash
npx tsx scripts/test-parse-action.mts
npm run lint
```

Expected: parser script exits 0 and ESLint exits 0.

### Task 5: Final Verification And Commit

**Files:**
- All modified implementation, test, and plan files.

- [ ] **Step 1: Run focused and broad verification**

Run:

```bash
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-extract.ts
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 2: Review git diff**

Run: `git diff --stat` and `git diff --check`

Expected: intended files only and no whitespace errors.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-07-03-build-phase-spec-review.md scripts/test-parse-action.mts lib/orchestrator/build.ts lib/client/build-engine.ts lib/db/schema.ts
git commit -m "feat: add build phase review gates"
```

Expected: commit succeeds on `codex/build-phase-review-gates`.
