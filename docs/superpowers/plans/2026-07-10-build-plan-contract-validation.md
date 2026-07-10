# Build Plan Contract Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Build mode from dispatching structurally invalid Architect plans or accepting task approvals that contradict current objective verification evidence.

**Architecture:** Add a pure compiler-like plan validator and a pure approval-evidence validator under `lib/orchestrator/`. The browser Build engine will use bounded Architect revision loops around both validators, persist validation state in checkpoints, and dispatch only validated tasks. The engine reports contradictions but never repairs dependencies, invents test paths, or changes Architect verdicts.

**Tech Stack:** TypeScript strict mode, browser-side Next.js 15/React 19 client engine, plain `npx tsx` regression scripts, existing runner/tool evidence ledger.

## Global Constraints

- Work only in `C:\Users\b_a_s\source\repos\ai-discussion-board`; do not edit or coach AIPaintball.
- The engine validates machine-verifiable contracts; the Architect remains the semantic decision-maker.
- Do not silently add/remove dependencies, test paths, verification policy, or verdicts.
- Semantic plan concerns remain warnings and never block dispatch.
- Allow at most two Architect contract revisions after an original plan/review action.
- Invalid plans stop before worker calls; invalid approvals return to the Architect before task status changes.
- Preserve legacy checkpoint readability with optional schema fields and explicit resume revalidation.
- Use the repository's plain `tsx` scripts and observe RED before production edits.
- Preserve unrelated working-tree changes.

---

### Task 1: Pure Build plan contract compiler

**Files:**
- Create: `lib/orchestrator/build-plan-contract.ts`
- Create: `scripts/test-build-plan-contract.mts`
- Modify: `lib/orchestrator/build.ts:77-115, 405-454, 2850-2880`

**Interfaces:**
- Consumes: structural `BuildTask` fields (`id`, `kind`, `verificationPolicy`, `requiredEvidence`, `requiredToolActions`, `outputPaths`, `testOutputPaths`, `dependsOn`).
- Produces: `BuildPlanContractIssue`, `BuildPlanContractValidation`, `validateBuildPlanContract()`, `renderBuildPlanContractErrors()`, and `isBuildTaskRunnable()`.

- [ ] **Step 1: Write the failing contract-validator script**

Create `scripts/test-build-plan-contract.mts` with a local `task()` factory and checks for duplicate IDs, unknown/self/cyclic dependencies, unordered overlapping source/test paths, accepted transitive ordering, explicit strict-TDD contracts, tool-verification contracts, warnings not blocking, and repo terminal barriers. Representative assertions:

```ts
import {
  isBuildTaskRunnable,
  validateBuildPlanContract,
} from "../lib/orchestrator/build-plan-contract";
import type { BuildTask } from "../lib/orchestrator/build";

const task = (input: Partial<BuildTask> & Pick<BuildTask, "id">): BuildTask => ({
  id: input.id,
  title: input.title ?? input.id,
  instructions: input.instructions ?? "Complete the declared contract.",
  contextFiles: input.contextFiles ?? [],
  status: input.status ?? "planned",
  ...input,
});

const overlap = validateBuildPlanContract([
  task({ id: "T1", kind: "modify", outputPaths: ["src/game.ts"] }),
  task({ id: "T2", kind: "modify", outputPaths: ["src/game.ts"] }),
]);
check(
  "unordered output owners are rejected",
  overlap.errors.some((issue) => issue.code === "unordered_output_overlap"),
  overlap
);

const ordered = validateBuildPlanContract([
  task({ id: "T1", kind: "modify", outputPaths: ["src/game.ts"] }),
  task({
    id: "T2",
    kind: "modify",
    outputPaths: ["src/game.ts"],
    dependsOn: ["T1"],
  }),
]);
check("transitively ordered output owners are valid", ordered.valid, ordered);
```

- [ ] **Step 2: Run the new script and verify RED**

Run: `npx tsx scripts/test-build-plan-contract.mts`

Expected: FAIL during import because `lib/orchestrator/build-plan-contract.ts` does not exist.

- [ ] **Step 3: Implement the pure validator without mutating tasks**

Create the module with these exact public shapes:

```ts
import type { BuildTask } from "./build";

export type BuildPlanContractIssueSeverity = "error" | "warning";
export type BuildPlanContractIssueCode =
  | "duplicate_task_id"
  | "unknown_dependency"
  | "self_dependency"
  | "dependency_cycle"
  | "unordered_output_overlap"
  | "missing_strict_tdd_contract"
  | "missing_tool_verification_contract"
  | "repo_task_not_terminal";

export interface BuildPlanContractIssue {
  code: BuildPlanContractIssueCode;
  severity: BuildPlanContractIssueSeverity;
  taskIds: string[];
  message: string;
}

export interface BuildPlanContractValidation {
  valid: boolean;
  errors: BuildPlanContractIssue[];
  warnings: BuildPlanContractIssue[];
}

export interface BuildPlanContractOptions {
  strictTdd?: boolean;
  verifyCommand?: string;
  phaseVerification?: string[];
}

export function validateBuildPlanContract(
  tasks: ReadonlyArray<BuildTask>,
  options: BuildPlanContractOptions = {}
): BuildPlanContractValidation;

export function renderBuildPlanContractErrors(
  validation: BuildPlanContractValidation
): string;

export function isBuildTaskRunnable(
  task: BuildTask,
  tasks: ReadonlyArray<BuildTask>
): boolean;
```

Use case-insensitive slash-normalized path ownership, DFS cycle detection, and transitive dependency reachability. Add `requiredToolActions?: string[]` to `BuildTask`, Architect task JSON, and `BuildCheckpointTask`; accepted identifiers are typed action names such as `run`, `playwright.browser_navigate`, `playwright.browser_console_messages`, and `playwright.browser_take_screenshot`. A strict-TDD source task is valid only when it explicitly owns a recognized test path, `requiredEvidence` contains both RED and GREEN terms, and `requiredToolActions` includes `run`. A tool-policy task is valid when it declares `requiredToolActions` or is covered by an accepted project verifier/phase verification. `isBuildTaskRunnable` requires known dependencies to be `done` and holds `kind: "repo"` until every non-repo task is `done`.

- [ ] **Step 4: Remove semantic auto-repair from dispatch validation**

Change `validateBuildPlanForDispatch()` in `lib/orchestrator/build.ts` to normalize representational task-contract defaults only, call `validateBuildPlanContract()`, and return the validation without adding test paths or stripping audit dependencies:

```ts
export interface BuildPlanDispatchValidation extends BuildPlanContractValidation {
  tasks: BuildTask[];
}

export function validateBuildPlanForDispatch(
  tasks: BuildTask[],
  options: BuildPlanContractOptions = {}
): BuildPlanDispatchValidation {
  const normalized = tasks.map((task) => normalizeBuildTaskContract({ ...task }));
  return {
    tasks: normalized,
    ...validateBuildPlanContract(normalized, options),
  };
}
```

Export or relocate the existing recognized-test/source-path helpers so the validator reuses the established path rules without duplicating heuristics.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npx tsx scripts/test-build-plan-contract.mts
npx tsx scripts/test-build-task-contracts.mts
```

Expected: the new validator script passes; existing task-contract assertions are updated to expect explicit errors rather than auto-added tests or removed dependencies.

- [ ] **Step 6: Commit the contract compiler**

```powershell
git add lib/orchestrator/build-plan-contract.ts lib/orchestrator/build.ts scripts/test-build-plan-contract.mts scripts/test-build-task-contracts.mts
git commit -m "feat: validate build plan contracts"
```

---

### Task 2: Bounded Architect plan revision gate

**Files:**
- Modify: `lib/orchestrator/build.ts:5390-5590`
- Modify: `lib/client/build-engine.ts:1440-1595, 5660-6310`
- Modify: `lib/db/schema.ts:190-265`
- Modify: `scripts/test-build-checkpoint.mts`
- Create: `scripts/test-build-plan-revision.mts`

**Interfaces:**
- Consumes: `BuildPlanContractValidation` from Task 1 and existing Architect structured-action parsing.
- Produces: `buildPlanContractRevisionPrompt()`, `resolveBuildPlanContract()`, checkpointed validation state, and blocked-before-dispatch behavior.

- [ ] **Step 1: Write RED tests for bounded revision behavior**

Create `scripts/test-build-plan-revision.mts` around a generic resolver with injected `validate` and `revise` functions:

```ts
const corrected = await resolveBuildPlanContract({
  initialPlan: invalidPlan,
  validate: (plan) => validateBuildPlanContract(plan.tasks),
  revise: async () => validPlan,
  maxRevisions: 2,
});
check("one corrected revision proceeds", corrected.status === "valid", corrected);

let revisions = 0;
const blocked = await resolveBuildPlanContract({
  initialPlan: invalidPlan,
  validate: (plan) => validateBuildPlanContract(plan.tasks),
  revise: async () => {
    revisions += 1;
    return invalidPlan;
  },
  maxRevisions: 2,
});
check(
  "persistent invalidity blocks after two revisions",
  blocked.status === "blocked" && revisions === 2,
  blocked
);
```

Run: `npx tsx scripts/test-build-plan-revision.mts`

Expected: FAIL because the resolver and prompt do not exist.

- [ ] **Step 2: Add the revision prompt and generic resolver**

Add `buildPlanContractRevisionPrompt()` to `lib/orchestrator/build.ts`. It must include the original request/spec, complete current plan JSON, exact issue codes/messages, and require one complete `build_plan` response without telling the Architect how to repair semantics.

Add this public resolver to `lib/orchestrator/build-plan-contract.ts`:

```ts
export async function resolveBuildPlanContract<T>(input: {
  initialPlan: T;
  validate: (plan: T) => BuildPlanContractValidation;
  revise: (
    plan: T,
    validation: BuildPlanContractValidation,
    revision: number
  ) => Promise<T | null>;
  maxRevisions?: number;
}): Promise<
  | { status: "valid"; plan: T; validation: BuildPlanContractValidation; revisions: number }
  | { status: "blocked"; plan: T; validation: BuildPlanContractValidation; revisions: number }
>;
```

The resolver validates the original and every revision, never mutates a plan, and performs exactly `maxRevisions` calls when invalidity persists.

- [ ] **Step 3: Persist validation state in checkpoints**

Extend `BuildCheckpoint` with optional backward-compatible fields:

```ts
planContractValidation?: BuildPlanContractValidation;
planContractRevisionCount?: number;
```

Thread both through the Build engine's checkpoint snapshot/save functions. Bump the Build engine marker from live-checkpoint v5/contract 3 to v6/contract 4. Update `scripts/test-build-checkpoint.mts` to round-trip the fields.

- [ ] **Step 4: Gate original, critic-revised, review-created, and resumed plans**

In `lib/client/build-engine.ts`:

1. Validate the original Architect plan before the independent critic.
2. Use `resolveBuildPlanContract()` to request up to two Architect contract revisions.
3. Run the independent critic only after structural validity.
4. Revalidate a critic-driven revision before consuming tasks.
5. Validate review-created task graphs before adding them to scheduler state.
6. Revalidate resumed checkpoint tasks before dispatch.
7. If blocked, record each issue as a structured Build problem, save a blocked checkpoint with zero worker executions, emit an explanatory diagnostic, and call the existing blocked-stop path.

Do not call `allocateIncrementalTaskIds()` until the raw Architect graph has passed ID/dependency validation; after allocation, validate the remapped graph once more.

- [ ] **Step 5: Run revision/checkpoint regressions**

```powershell
npx tsx scripts/test-build-plan-contract.mts
npx tsx scripts/test-build-plan-revision.mts
npx tsx scripts/test-build-checkpoint.mts
npx tsx scripts/test-plan-critique.mts
```

Expected: all pass; the exhaustion case reports two revisions and no dispatch-ready plan.

- [ ] **Step 6: Commit the plan gate**

```powershell
git add lib/orchestrator/build-plan-contract.ts lib/orchestrator/build.ts lib/client/build-engine.ts lib/db/schema.ts scripts/test-build-plan-revision.mts scripts/test-build-checkpoint.mts scripts/test-plan-critique.mts
git commit -m "feat: gate workers on valid architect plans"
```

---

### Task 3: Scheduler invariants for dependencies and repo barriers

**Files:**
- Modify: `lib/orchestrator/build.ts:3160-3175`
- Modify: `lib/client/build-engine.ts:8080-8225`
- Modify: `scripts/test-parse-action.mts:520-545`
- Modify: `scripts/test-build-task-scheduling.mts`

**Interfaces:**
- Consumes: `isBuildTaskRunnable()` from Task 1.
- Produces: dispatch filtering that cannot bypass unknown dependencies, Architect approval, overlapping-owner ordering, or the repo terminal barrier.

- [ ] **Step 1: Change dependency tests to the desired RED behavior**

Update the missing-dependency case in `scripts/test-parse-action.mts` from satisfied to unsatisfied. Add scheduling assertions:

```ts
check(
  "unknown dependency is never runnable",
  !isBuildTaskRunnable(task({ id: "T2", dependsOn: ["missing"] }), [
    task({ id: "T2", dependsOn: ["missing"] }),
  ])
);

check(
  "repo task waits for every non-repo task",
  !isBuildTaskRunnable(
    task({ id: "T3", kind: "repo" }),
    [task({ id: "T1", kind: "modify", status: "review" }), task({ id: "T3", kind: "repo" })]
  )
);
```

Run:

```powershell
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-build-task-scheduling.mts
```

Expected: FAIL because unknown dependencies currently count as satisfied and the scheduler has no repo barrier.

- [ ] **Step 2: Make unknown dependencies unsatisfied**

Change `isBuildTaskDependencySatisfied()` so a missing dependency returns `false`. The plan validator now prevents typos from reaching dispatch, so deadlock avoidance is handled by bounded plan rejection rather than unsafe scheduling.

- [ ] **Step 3: Use the unified runnable predicate in the scheduler**

Replace the scheduler's inline dependency filter with:

```ts
const ready = tasks.filter(
  (task) =>
    (task.status === "planned" || task.status === "fixing") &&
    isBuildTaskRunnable(task, tasks)
);
```

Keep concurrent output-path collision deferral as defense in depth, but emit an engine error if an unordered overlap somehow reaches it instead of running the deferred owner in a later batch.

- [ ] **Step 4: Verify scheduler regressions**

```powershell
npx tsx scripts/test-parse-action.mts
npx tsx scripts/test-build-task-scheduling.mts
npx tsx scripts/test-build-plan-contract.mts
```

Expected: all pass; a repo task becomes runnable only after every non-repo task is `done`.

- [ ] **Step 5: Commit scheduler safety**

```powershell
git add lib/orchestrator/build.ts lib/client/build-engine.ts scripts/test-parse-action.mts scripts/test-build-task-scheduling.mts
git commit -m "fix: enforce build scheduler contract barriers"
```

---

### Task 4: Task-scoped verification facts and approval gate

**Files:**
- Create: `lib/orchestrator/build-review-evidence.ts`
- Create: `scripts/test-build-review-evidence.mts`
- Modify: `lib/orchestrator/build-progress.ts:87-135`
- Modify: `lib/client/build-engine.ts:3210-3505, 7240-7330, 7920-8010, 8225-8620`
- Modify: `lib/orchestrator/build.ts:1460-1635, 5800-5885`
- Modify: `lib/db/schema.ts:190-265`
- Modify: `scripts/test-build-progress.mts`
- Modify: `scripts/test-build-checkpoint.mts`

**Interfaces:**
- Consumes: normalized task contracts, `ReviewAction.results`, worker/engine evidence ledger entries, and wave verification results.
- Produces: `BuildTaskVerificationFact`, `BuildReviewContractIssue`, `validateBuildReviewApprovals()`, `resolveBuildReviewContract()`, and checkpointed task verification facts.

- [ ] **Step 1: Write failing approval-evidence tests**

Create `scripts/test-build-review-evidence.mts` with these cases:

```ts
const approved: ReviewResult = {
  taskId: "T1",
  specVerdict: "approve",
  qualityVerdict: "approve",
  specIssues: "",
  qualityIssues: "",
  fixInstructions: "",
};

check(
  "tool approval without current evidence is rejected",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [],
    wave: 2,
  }).errors[0]?.code === "missing_task_verification"
);

check(
  "failed current verifier contradicts approval",
  validateBuildReviewApprovals({
    tasks: [toolTask],
    results: [approved],
    facts: [fact({ taskId: "T1", wave: 2, status: "failed" })],
    wave: 2,
  }).errors[0]?.code === "failed_task_verification"
);

check(
  "architect policy does not require tool evidence",
  validateBuildReviewApprovals({
    tasks: [{ ...toolTask, verificationPolicy: "architect" }],
    results: [approved],
    facts: [],
    wave: 2,
  }).valid
);
```

Also test stale-wave evidence, current passing evidence, non-approved results, mixed task results, and two-attempt review revision exhaustion.

Run: `npx tsx scripts/test-build-review-evidence.mts`

Expected: FAIL because the evidence module does not exist.

- [ ] **Step 2: Implement the pure evidence validator**

Create these public interfaces:

```ts
export interface BuildTaskVerificationFact {
  taskId: string;
  wave: number;
  at: string;
  action: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  coveredPaths: string[];
}

export interface BuildReviewContractIssue {
  code: "missing_task_verification" | "stale_task_verification" | "failed_task_verification";
  taskId: string;
  message: string;
}

export function validateBuildReviewApprovals(input: {
  tasks: ReadonlyArray<BuildTask>;
  results: ReadonlyArray<ReviewResult>;
  facts: ReadonlyArray<BuildTaskVerificationFact>;
  wave: number;
}): { valid: boolean; errors: BuildReviewContractIssue[] };

export async function resolveBuildReviewContract<T>(input: {
  initialAction: T;
  validate: (action: T) => { valid: boolean; errors: BuildReviewContractIssue[] };
  revise: (action: T, errors: BuildReviewContractIssue[], revision: number) => Promise<T | null>;
  maxRevisions?: number;
}): Promise<
  | { status: "valid"; action: T; revisions: number }
  | { status: "blocked"; action: T; revisions: number; errors: BuildReviewContractIssue[] }
>;
```

Only results that approve both gates are checked. Tool-policy approval requires a current-wave passing fact for every declared `requiredToolActions` item and no later current-wave failed fact for the same action. A task covered by the accepted project verifier requires its current-wave `run` fact. Other verification policies pass through unchanged.

- [ ] **Step 3: Produce task-scoped facts from actual tools**

Add optional `wave` to `BuildEvidenceLedgerEntry` and preserve it in `appendBuildEvidenceLedgerEntry()`. Pass the active wave when recording worker tool facts.

After every wave verifier, append one `BuildTaskVerificationFact` for each executed tool-policy task:

- `passed` when the accepted verifier exits successfully;
- `failed` when it fails or is rejected;
- covered paths from that task's landed files/output ownership;
- exact command and bounded feedback.

Convert current-wave worker facts only for the explicit verification allowlist: `run` and declared `server.tool` identifiers such as `playwright.browser_navigate`, `playwright.browser_console_messages`, and `playwright.browser_take_screenshot`. Reads, searches, code-intelligence calls, patches, appends, and context retrieval never count as verification facts.

- [ ] **Step 4: Persist verification facts**

Extend `BuildCheckpoint` with:

```ts
taskVerificationFacts?: BuildTaskVerificationFact[];
```

Cap persisted facts, restore them on Resume, and discard stale facts for a task after that task writes files in a later wave. Add checkpoint/progress tests for wave and cap preservation.

- [ ] **Step 5: Reject contradictory approvals through the Architect**

After parsing the Architect review but before applying any result or updating model scores:

1. Call `validateBuildReviewApprovals()`.
2. When invalid, call the Architect with a new `buildReviewContractRevisionPrompt()` containing the unchanged review action, exact objective facts, and issue codes.
3. Allow two corrected review actions.
4. Revalidate each response.
5. Apply statuses only after validation succeeds.
6. If exhausted, save a blocked checkpoint and stop; do not convert approvals to fixes, requeue workers, or score the worker.

If the review changes `verifyCommand`, do not accept tool-policy approvals in that same response; run the replacement verifier in the next wave and review with fresh facts.

- [ ] **Step 6: Run focused evidence tests**

```powershell
npx tsx scripts/test-build-review-evidence.mts
npx tsx scripts/test-build-progress.mts
npx tsx scripts/test-build-checkpoint.mts
npx tsx scripts/test-build-task-contracts.mts
```

Expected: all pass; missing/failing evidence blocks only contradictory approvals, while Architect/evidence/external policies remain valid.

- [ ] **Step 7: Commit the approval gate**

```powershell
git add lib/orchestrator/build-review-evidence.ts lib/orchestrator/build-progress.ts lib/orchestrator/build.ts lib/client/build-engine.ts lib/db/schema.ts scripts/test-build-review-evidence.mts scripts/test-build-progress.mts scripts/test-build-checkpoint.mts scripts/test-build-task-contracts.mts
git commit -m "feat: require verified evidence for build approvals"
```

---

### Task 5: Full regression, production build, and live Build-mode acceptance

**Files:**
- Modify only if verification exposes a defect: files from Tasks 1-4
- Test: all focused Build scripts plus lint/build

**Interfaces:**
- Consumes: completed contract/revision/scheduler/evidence gates.
- Produces: verified AIBoard Build mode and a resumed paintball validation run without manual coaching or AIPaintball edits.

- [ ] **Step 1: Run the focused Build regression suite**

```powershell
$tests = @(
  'scripts/test-build-plan-contract.mts',
  'scripts/test-build-plan-revision.mts',
  'scripts/test-build-review-evidence.mts',
  'scripts/test-build-task-contracts.mts',
  'scripts/test-build-task-scheduling.mts',
  'scripts/test-parse-action.mts',
  'scripts/test-plan-critique.mts',
  'scripts/test-build-progress.mts',
  'scripts/test-build-checkpoint.mts',
  'scripts/test-build-live-checkpoint.mts',
  'scripts/test-build-quality-gates.mts'
)
foreach ($test in $tests) {
  npx tsx $test
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every script ends with PASS and exit code 0.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Run production build and restart the dev server**

Run: `npm run build`

Expected: static export succeeds. Because production build invalidates the active `.next`, restart the localhost development server afterward with logs outside the repository and confirm `http://localhost:3000/` responds.

- [ ] **Step 4: Verify invalid-plan acceptance without worker spend**

Use a controlled local test fixture or the integration script from Task 2 to supply an invalid overlapping-output plan. Confirm:

- exact contract errors appear;
- the Architect receives a revision request;
- worker call count remains zero before a valid revision;
- two invalid revisions stop blocked with a durable checkpoint.

- [ ] **Step 5: Resume the stopped paintball Build solely as system acceptance**

Refresh the visible Chrome AIBoard page after the dev server restart and click Resume. Do not edit AIPaintball or send notes to the Architect. Observe that:

- the saved invalid checkpoint graph is revalidated before dispatch;
- the Architect, not the engine or Codex, supplies any corrected plan;
- overlapping file owners do not dispatch unordered;
- tool-policy approvals cannot pass with a failing verifier;
- Activity and checkpoint diagnostics record contract decisions.

Stop the acceptance run after these safeguards are demonstrated unless the corrected Build is progressing cleanly toward the user's requested gameplay result.

- [ ] **Step 6: Verify repository scope and commit remaining AIBoard changes**

```powershell
git status --short
git diff --check
git log -5 --oneline
```

Confirm no AIPaintball files are staged in the AIBoard repository. Commit any remaining AIBoard-only fixes in a focused commit, preserving unrelated changes.

- [ ] **Step 7: Push the completed AIBoard commits**

```powershell
git push origin main
```

Expected: `main` is synchronized with `origin/main` and the intended AIBoard working tree is clean.
