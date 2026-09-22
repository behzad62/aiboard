# Runner V2 P6.5 Review-Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan packet by packet and `superpowers:test-driven-development` for every implementation packet. Steps use checkbox (`- [ ]`) syntax for tracking. This phase inherits every execution control of the master plan (`docs/superpowers/plans/2026-08-26-runner-v2-robust-build-improvements.md`, section "Execution controls applying to every phase").

**Goal:** Close the six real gaps found by the 2026-09-02 external design review of Runner V2 Build mode without transferring any lifecycle authority out of the kernel: a risk-gated plan critique before workers start, a kernel exit-code gate on approvals, a durable repair-cycle cap, a live worker `request_replan` signal, durable context manifests per model call, and a two-pass adversarial independent verifier.

**Architecture:** Extend the existing scheduler event log, reducer, Architect/worker/verifier runtimes, and observability seams. Every new decision is a typed scheduler event with an actor-role check in the reducer; every new pause is runner-owned and resolvable only by the user; every new model role reuses the independent-verifier selection, session, budget, and workspace machinery. No new model authority: the critic and the verifier report findings, the Architect resolves them, the kernel enforces coverage and order.

**Tech stack:** Strict TypeScript, Node.js maintained LTS lines (22.x / 24.x), Node built-in SQLite (`node:sqlite`), `node:test` via `tsx --test`, Git worktrees, React 19 client surfaces.

**Spec:** This plan implements the "Real gaps worth adding" list from the 2026-09-02 review verdict (recorded below in "Origin"), against the approved design `docs/superpowers/specs/2026-07-11-native-runner-build-v2-design.md`. The design's non-goals stay in force: no rigid file whitelist for workers, no kernel semantic verdicts, no bypass flags.

## Origin: the six gaps this phase closes

| Gap | What exists today | What P6.5 adds |
|---|---|---|
| RG-1 Plan critique | `build-runtime.ts` goes `plan_required` → workers with no second-model critique. Risk is assessed only after final verification. | Deterministic plan-time risk, one read-only independent critic pass over the task graph at the baseline revision, typed findings, exactly one Architect resolution before any worker starts. |
| RG-2 Exit-code gate | `review.decided` enforces criterion coverage and evidence existence, but never checks that a cited command exited 0. | A `satisfied` verdict citing failing command evidence is rejected unless it carries an explicit `acceptedFailures` entry with rationale. Same rule for verifier verdicts. |
| RG-3 Repair-cycle cap | Only per-task `attemptLimit` and `runUntilBlocked(maxSteps = 100)`. `repair_budget_exhausted` is prompt-only. | Durable `repairPlanLimit` (default 3). The reducer blocks a fourth repair plan; the runner pauses; only the user can extend. |
| RG-4 Worker replan | `request_replan` lifecycle signal exists in `agent-contracts.ts` and `agent-loop.ts` but no tool emits it. | A typed `request_replan` worker tool that becomes a blocking `replan` guidance request; the Architect reconciles the plan or refuses with evidence. |
| RG-5 Context manifests | `ContextAssembler` computes section digests; nothing persists them. | A per-model-call manifest (sections, digests, omissions, limits, revision) in a SQLite side ledger, exported in audit; optional full pack text artifact. |
| RG-6 Two-pass verifier | One pass, neutral prompt, thin verdict schema, verifier sees Architect verdict rationale before forming its own view. | Pass 1 records expectations from the baseline revision with no diff visible; pass 2 verifies against them with an adversarial stance; the kernel refuses a verdict without recorded expectations; unsatisfied verdicts carry location and reproduction. |

Line numbers are deliberately omitted below. The B2 work in flight moves lines; anchor every edit by the named symbol.

## Global Constraints

- Work in the isolated worktree `D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build` on branch `codex/runner-v2-robust-build`. Record the P6.5 starting revision in the SDD ledger before the first edit.
- Node.js: any maintained LTS line (`>=22.13.0 <23 || >=24.0.0 <25`). Never pin a patch release.
- Runner state stays outside the project. Preserve the unrelated user changes in `lib/account-provider-runner.mjs` and `scripts/test-account-provider-runner-chat.mts`.
- One packet active at a time. Each packet ends with an independently testable behavior and its own commit.
- Prove-red protocol on every new guard: pre-fix red with recorded signature, implement, reinject the fault, second red, revert the fault only, final green, all tied to exact revisions.
- Automatic repair budget: three cycles per failed check and root cause, one reclassification, at most five total. Exhaustion escalates; it never weakens a requirement.
- No runtime bypass flags. Rollback of any packet is a whole-packet revert.
- No kernel semantic verdicts: findings, expectations, and risk declarations are model output; the kernel validates shape, references, order, actor, and revision binding only.
- Only two allowed phase outputs: `PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN` or `PHASE BLOCKED — GENUINE USER DECISION REQUIRED`.
- Static gates for every packet (**amended 2026-09-21, owner decision**): `npm run typecheck:runner-v2`, targeted ESLint over changed files, and **targeted tests over the packet's affected graph** — the packet's own test files plus any test file that exercises a symbol the packet changed. Packets that change client or UI contracts additionally run `npm run build` (stop the dev server first).
- **The full `npm run test:runner-v2` gate runs twice per phase, not per packet**: once as the phase-entry baseline, and once at the phase exit gate to detect regressions outside every packet's affected graph. The original constraint required the full suite on every packet; at roughly 35 minutes per run that is about six hours of re-proving untouched code across ten packets, with no added signal that the affected-graph selection plus the exit-gate regression run does not already provide. The owner amended it on 2026-09-21.
- **Accepted trade-off of that amendment**: a defect that escapes a packet's affected graph is detected at the phase exit gate rather than at the packet boundary, so the offending packet must be identified by bisecting the phase's packet commits. Each packet therefore ends with its own commit specifically so that bisection stays cheap. If a packet touches a shared kernel surface (`scheduler-store.ts`, `subprocess-runtime.ts`, `acceptance-contracts.ts`, `execution-host.ts`) the affected graph must be widened to every test importing that surface, not merely the packet's own files.

## Placement in the master plan

- P6.5 sits after the P6 gate and before P6.6. Under the 2026-09-06 owner-approved placement, the chain is P6 → P6.5 → P6.6 → P7; P7's hard dependency is "P6.6 verified and OD-1".
- Requirement prefix `RG-` (review gap). Sole owning phase for RG-1 through RG-6 is P6.5.
- Entry condition: the P6 phase produced the exact success output and its base revision is recorded in `.superpowers/sdd/2026-08-26-runner-v2-robust-build-improvements/progress.md`.
- P6.6 reuses these six mechanisms and adds only its EP requirements. Its binding compatibility table is in `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md`, section 1. P6.5's packet requirements, old-policy behaviors, validation/negative-proof controls and exit gate remain unchanged. Do not pull P6.6 work into this phase or restore the superseded direct P6.5 → P7 dependency while executing Task P6.5.0.

### Requirements assigned

| Requirement | Canonical requirement | Packet | Verification anchor |
|---|---|---|---|
| RG-2.1 | A `satisfied` criterion verdict that cites failing command evidence is rejected unless explicitly accepted with rationale | P6.5.1 | `acceptance-contracts` + `scheduler-store` gate tests |
| RG-2.2 | The rule applies to Architect task reviews and independent verifier verdicts alike | P6.5.1 | `validateSchedulerEvidenceEvent` tests for both event types |
| RG-2.3 | Accepted failures are visible in audit and UI | P6.5.1 | Client type + task-board render test |
| RG-4.1 | Workers have a typed `request_replan` lifecycle tool | P6.5.2 | Worker lifecycle tool test |
| RG-4.2 | The Architect resolves a replan request by reconciling the plan or by an evidence-based refusal | P6.5.2 | Reducer auto-answer + reason-matching tests |
| RG-4.3 | Replan requests are visible in the observability UI | P6.5.2 | Observability summary test |
| RG-3.1 | A durable per-run repair-plan limit exists (default 3) | P6.5.3 | `repair.policy_configured` reducer test |
| RG-3.2 | The reducer rejects a repair plan beyond the limit | P6.5.3 | Reducer block test (both repair sources) |
| RG-3.3 | The runner pauses at the limit; only the user can extend it | P6.5.3 | Build-runtime pause + actor-role tests |
| RG-3.4 | The cap survives restart and duplicate events | P6.5.3 | Replay/idempotency tests |
| RG-5.1 | Every Architect, worker, and verifier model-call context pack records a manifest | P6.5.4 | Runtime tests for all three roles |
| RG-5.2 | Manifests are durable, run-scoped, and audit-exported | P6.5.4 | SQLite store + audit export tests |
| RG-5.3 | Full pack text is optionally stored as a content-addressed artifact | P6.5.4 | Spec flag + artifact test |
| RG-5.4 | Historical runs open manifests read-only | P6.5.4 | Read-only store test |
| RG-1.1 | Plan-time risk is deterministic, durable, and raise-only | P6.5.5a | `assessPlanRisk` + reducer tests |
| RG-1.2 | The critic is an independent model with read-only tools over the baseline revision | P6.5.5b | Critic runtime tests |
| RG-1.3 | Findings are typed and bound to the plan revision | P6.5.5a | Contract parser + reducer tests |
| RG-1.4 | Blocking findings force exactly one Architect resolution before any worker starts | P6.5.5c | Build-runtime ordering test |
| RG-1.5 | An unavailable or failed critic never silently blocks or waives: typed pause or durable skip | P6.5.5c | Pause/skip tests |
| RG-1.6 | Plan critique state is visible in UI and audit | P6.5.5d | Client/UI tests |
| RG-6.1 | The verifier records expectations from the baseline revision before it can see the implementation | P6.5.6 | Pass-1 context/tool tests |
| RG-6.2 | The kernel refuses a verdict without recorded expectations under two-pass policy | P6.5.6 | Reducer test |
| RG-6.3 | The verifier prompt is adversarial and unsatisfied verdicts carry location and reproduction | P6.5.6 | Prompt + parser tests |
| RG-6.4 | Two-pass verification is restart-safe and cleans up its baseline workspace | P6.5.6 | Resume + cleanup tests |

### Packet order and dependencies

| Packet | Owns | Depends on | Why this order |
|---|---|---|---|
| P6.5.0 | Master-plan amendment + ledger row | P6 gate | Agents must find the phase |
| P6.5.1 | RG-2 exit-code gate | none | Smallest kernel change; warms up the prove-red loop |
| P6.5.2 | RG-4 worker replan | none | Wires a dead lifecycle signal; reuses guidance machinery |
| P6.5.3 | RG-3 repair-cycle cap | none | Adds the first runner-owned user pause after P4's verifier pause |
| P6.5.4 | RG-5 context manifests | none | Side ledger; needed by P7 to compare models fairly |
| P6.5.5a-d | RG-1 plan critique | P6.5.3 (shares the pause pattern), P6.5.4 (manifests for the critic) | Largest packet; reuses the verifier selection path |
| P6.5.6 | RG-6 two-pass verifier | P6.5.1 (`acceptedFailures` on verifier verdicts), P6.5.4 | Touches the verifier last, after its contracts are stable |

Full queue:

```text
P6.5.0 → P6.5.1 → P6.5.2 → P6.5.3 → P6.5.4 → P6.5.5a → P6.5.5b → P6.5.5c → P6.5.5d → P6.5.6 → P6.5 gate
```

### Owner decisions resolved by default

These defaults were chosen so the phase needs no owner question. Change them only through a recorded owner amendment.

- `planCritique` mode default `risk_based`; plan-time risk is high when the Architect declares high, when `alwaysRequireIndependentVerifier` is set, when the plan has 4 or more tasks, or when any task has 2 or more dependencies.
- `repairPlanLimit` default 3 repair plans per run (final-verification repairs and verifier repairs counted together).
- Two-pass verifier default on for new runs; runs created before P6.5 keep single-pass replay semantics.
- `contextRecording` default `manifest` (digests only); `full` stores the rendered pack text as an artifact.
- The critic reuses the verifier candidate list, the verifier selection pause, and the `verifier` budget role. No new model role is introduced.

---

# Detailed packet specifications

### Task P6.5.0: Master-plan amendment and ledger row

**Files:**
- Modify: `docs/superpowers/plans/2026-08-26-runner-v2-robust-build-improvements.md` (phase table, P7 dependencies, execution queue, traceability, doctrine matrix)
- Modify: `.superpowers/sdd/2026-08-26-runner-v2-robust-build-improvements/progress.md` (task status table)

The plan author applied Steps 1–4 on 2026-09-02. Verify each edit is present at the P6.5 starting revision; re-apply only what is missing, then record the starting revision (Git revision, dirty files, Node version, Git version, state-directory location, baseline validation results) in the ledger before Step 5.

- [ ] **Step 1: Add the P6.5 row to the master phase table**

Insert after the P6 row:

```markdown
| P6.5 | Review-gap closure: plan critique, exit-code gate, repair-cycle cap, worker replan, context manifests, two-pass verifier | P1 High | RG-1–RG-6 | P6 verified | P6.6 |
```

Preserve the subsequently inserted P6.6 row. P7's hard dependency is `P6.6 verified and OD-1` under the 2026-09-06 amendment.

- [ ] **Step 2: Preserve P6.5 → P6.6 → P7**

In `### Task 7: P7 — Real-world Build-mode qualification`, verify `**Dependencies:** P6.6 verified and OD-1`. Preserve the entry condition requiring verified P6.5/P6.6 and a charter enabling source-traceable planning/evidence policy, plan critique, two-pass verification and context manifests. This step verifies the current master amendment; it must not replace it with the original direct P6.5 dependency.

- [ ] **Step 3: Extend the execution queue and traceability**

Under `# 4. Execution queue` verify the line `P6.5.0 → P6.5.1 → P6.5.2 → P6.5.3 → P6.5.4 → P6.5.5a → P6.5.5b → P6.5.5c → P6.5.5d → P6.5.6 → P6.5 gate` sits between P6 and P6.6, preserving the later P6.6 → P7 sequence. Retain the statement that this plan starts only after the exact P6 success output. Under `# 3. Requirement-to-phase traceability` verify one row per RG requirement from this plan's "Requirements assigned" table with `Sole owning phase` = `P6.5`; reapply missing rows only. Preserve the current total, including the 32 referenced P6.6 EP obligations, and the doctrine matrix's scoped P6.6 column. P6.5 retains `✓` for each original control.

- [ ] **Step 4: Add the ledger row**

In `progress.md` task status table insert between rows 6 and 7:

```markdown
| 6.5 | P6.5 review-gap closure (plan critique, exit-code gate, repair cap, worker replan, context manifests, two-pass verifier) | pending: blocked on P6 gate | pending | `docs/superpowers/plans/2026-09-02-runner-v2-p6-5-review-gap-closure.md` | pending |
```

- [ ] **Step 5: Commit**

`docs/superpowers/` and `.superpowers/` are listed in `.gitignore`; most existing plans and SDD files are tracked only because they were force-added. Use `-f` so the new plan and the ledger are committed too:

```bash
git add -f docs/superpowers/plans/2026-08-26-runner-v2-robust-build-improvements.md .superpowers/sdd/2026-08-26-runner-v2-robust-build-improvements/progress.md docs/superpowers/plans/2026-09-02-runner-v2-p6-5-review-gap-closure.md
git commit -m "docs(runner-v2): insert P6.5 review-gap closure before P7"
```

---

### Task P6.5.1: RG-2 — Exit-code evidence gate on approvals

**Purpose:** The kernel already proves a cited evidence record exists, belongs to the attempt, and was produced by the assigned worker. It never checks that a cited command actually succeeded. This packet adds that mechanical check for every `satisfied` verdict, with an explicit typed acceptance for intentionally failing commands (for example a pre-fix red test).

**Files:**
- Modify: `runner-v2/src/acceptance-contracts.ts` (new types + two pure functions)
- Modify: `runner-v2/src/verifier-contracts.ts` (`VerifierCriterionVerdict.acceptedFailures`, parser)
- Modify: `runner-v2/src/scheduler-store.ts` (`validateSchedulerEvidenceEvent` branches for `review.decided` and `verifier.verdict_submitted`)
- Modify: `runner-v2/src/architect-tools.ts` (`reviewTaskTool` schema + pre-check; `criterionReviewVerdictSchema`)
- Modify: `runner-v2/src/verifier-tools.ts` (schema)
- Modify: `runner-v2/src/native-architect-runtime.ts` (one system-prompt line)
- Modify: `lib/client/runner-v2.ts` (`NativeCriterionReviewVerdict.acceptedFailures`)
- Modify: `components/BuildTaskBoard.tsx` (render accepted failures)
- Test: `runner-v2/test/acceptance-contracts.test.ts`, `runner-v2/test/scheduler-store.test.ts`, `runner-v2/test/verifier-contracts.test.ts`, `scripts/test-build-task-board-ui.tsx`

**Interfaces:**
- Produces: `AcceptedEvidenceFailure`, `GreenEvidenceVerdict`, `failingCommandEvidenceIds(records)`, `assertSatisfiedVerdictsCiteGreenEvidence(verdicts, records, label)` in `acceptance-contracts.ts`. P6.5.6 reuses `acceptedFailures` on verifier verdicts.

- [ ] **Step 1: Write the failing unit tests for the pure functions**

Append to `runner-v2/test/acceptance-contracts.test.ts`:

```ts
import {
  assertSatisfiedVerdictsCiteGreenEvidence,
  failingCommandEvidenceIds,
} from "../src/acceptance-contracts.js";
import type { EvidenceRecord } from "../src/evidence-store.js";

function commandEvidence(
  id: string,
  overrides: Partial<Extract<EvidenceRecord["fact"], { kind: "command" }>> = {},
): EvidenceRecord {
  return {
    id,
    runId: "run_gate",
    taskId: "T1",
    actor: { role: "worker", id: "worker:T1:1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "tests",
      command: "npm",
      args: ["test"],
      cwd: ".",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "a".repeat(64),
      stderrArtifactHash: "b".repeat(64),
      ...overrides,
    },
    createdAt: "2026-09-02T00:00:01.000Z",
    idempotencyKey: `evidence:${id}`,
    attempt: 1,
  };
}

test("failingCommandEvidenceIds flags non-zero exit, signal, timeout, and cancellation only", () => {
  const records: EvidenceRecord[] = [
    commandEvidence("green"),
    commandEvidence("exit1", { exitCode: 1 }),
    commandEvidence("killed", { exitCode: null, signal: "SIGKILL" }),
    commandEvidence("slow", { timedOut: true }),
    commandEvidence("stopped", { cancelled: true }),
    {
      ...commandEvidence("shot"),
      fact: {
        kind: "browser_screenshot",
        label: "ui",
        capturedAt: "2026-09-02T00:00:00.000Z",
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
    },
  ];
  assert.deepEqual(failingCommandEvidenceIds(records), ["exit1", "killed", "slow", "stopped"]);
});

test("a satisfied verdict may cite failing command evidence only with an explicit accepted failure", () => {
  const records = [commandEvidence("green"), commandEvidence("red", { exitCode: 1 })];
  assert.throws(
    () => assertSatisfiedVerdictsCiteGreenEvidence(
      [{ verdict: "satisfied", evidenceIds: ["red"] }],
      records,
      "Review decision",
    ),
    /Review decision cites failing command evidence red for a satisfied verdict/,
  );
  assert.doesNotThrow(() => assertSatisfiedVerdictsCiteGreenEvidence(
    [{
      verdict: "satisfied",
      evidenceIds: ["red"],
      acceptedFailures: [{ evidenceId: "red", rationale: "RED phase of the TDD cycle before the fix." }],
    }],
    records,
    "Review decision",
  ));
  assert.doesNotThrow(() => assertSatisfiedVerdictsCiteGreenEvidence(
    [{ verdict: "unsatisfied", evidenceIds: ["red"] }],
    records,
    "Review decision",
  ));
  assert.throws(
    () => assertSatisfiedVerdictsCiteGreenEvidence(
      [{
        verdict: "satisfied",
        evidenceIds: ["green"],
        acceptedFailures: [{ evidenceId: "green", rationale: "not actually failing" }],
      }],
      records,
      "Review decision",
    ),
    /accepted failure green is not failing command evidence cited by that verdict/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test runner-v2/test/acceptance-contracts.test.ts`
Expected: FAIL with an import error naming `failingCommandEvidenceIds`. Record the signature in the SDD ledger.

- [ ] **Step 3: Implement the contract additions**

In `runner-v2/src/acceptance-contracts.ts`, next to `CriterionReviewVerdict`:

```ts
export interface AcceptedEvidenceFailure {
  evidenceId: string;
  rationale: string;
}

export interface CriterionReviewVerdict {
  criterionId: string;
  verdict: CriterionReviewVerdictValue;
  rationale: string;
  evidenceIds: string[];
  artifactHashes?: string[];
  /** Explicit, audited acceptance of cited command evidence that did not succeed. */
  acceptedFailures?: AcceptedEvidenceFailure[];
}

export interface GreenEvidenceVerdict {
  verdict: string;
  evidenceIds: readonly string[];
  acceptedFailures?: readonly AcceptedEvidenceFailure[];
}

export function failingCommandEvidenceIds(
  records: readonly EvidenceRecord[],
): string[] {
  return records
    .filter((record) =>
      record.fact.kind === "command" &&
      (
        record.fact.exitCode !== 0 ||
        record.fact.signal !== null ||
        record.fact.timedOut ||
        record.fact.cancelled
      ),
    )
    .map((record) => record.id);
}

export function assertSatisfiedVerdictsCiteGreenEvidence(
  verdicts: readonly GreenEvidenceVerdict[],
  records: readonly EvidenceRecord[],
  label: string,
): void {
  const failing = new Set(failingCommandEvidenceIds(records));
  for (const verdict of verdicts) {
    const accepted = new Map(
      (verdict.acceptedFailures ?? []).map((failure) => [failure.evidenceId, failure]),
    );
    for (const failure of accepted.values()) {
      if (!failure.rationale.trim()) {
        throw new Error(`${label} accepted failure ${failure.evidenceId} requires a rationale.`);
      }
      if (!failing.has(failure.evidenceId) || !verdict.evidenceIds.includes(failure.evidenceId)) {
        throw new Error(
          `${label} accepted failure ${failure.evidenceId} is not failing command evidence cited by that verdict.`,
        );
      }
    }
    if (verdict.verdict !== "satisfied") continue;
    for (const evidenceId of verdict.evidenceIds) {
      if (failing.has(evidenceId) && !accepted.has(evidenceId)) {
        throw new Error(
          `${label} cites failing command evidence ${evidenceId} for a satisfied verdict without an accepted failure.`,
        );
      }
    }
  }
}
```

Also extend `validateCriterionReviewVerdicts` (same file) so `acceptedFailures`, when present, must be an array of `{ evidenceId, rationale }` with unique non-empty strings; push the issue `criterion <id> acceptedFailures is malformed` otherwise.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx tsx --test runner-v2/test/acceptance-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing durable-gate tests**

Append to `runner-v2/test/scheduler-store.test.ts`. Build a `SchedulerProjection` literal with helper `reviewProjectionWith(task)`: `runId: "run_gate"`, `status: "running"`, `planRevision: 1`, one task `T1` (`status: "architect_review"`, `attempt: 1`, `assignedWorkerId: "worker:T1:1"`, `requiredCapabilities: ["code"]`, `dependencies: []`, `objective: "Gate"`, plus the given `acceptanceCriteria` and `criterionEvidenceLinks`), empty `guidance`, `userGuidance`, `architectQuestions`, `reviews`, `userGuidanceVersion: 0`, `architectQuestionVersion: 0`, `runtime: { providerHealth: {}, workerAssignments: {}, architect: {} }`, `lastSequence: 8`. Build `inMemoryEvidenceStore(records)` implementing `EvidenceStore` (`record` throws, `list` returns all, `getByIds` filters by id and optional taskId, `close` no-op). Reuse `commandEvidence` from Step 1 (move it to `runner-v2/test/support/evidence-fixtures.ts` and import it in both test files).

```ts
test("review.decided rejects a satisfied verdict that cites a failing command without an accepted failure", () => {
  const evidenceStore = inMemoryEvidenceStore([commandEvidence("red", { exitCode: 1 })]);
  const projection = reviewProjectionWith({
    acceptanceCriteria: [{ id: "AC-1", text: "Tests pass." }],
    criterionEvidenceLinks: [{
      criterionId: "AC-1", evidenceId: "red", artifactHashes: ["a".repeat(64)], taskId: "T1", attempt: 1,
    }],
  });
  const decided = (criterionVerdicts: unknown): SchedulerEvent => ({
    eventId: "e1", runId: "run_gate", sequence: 9, type: "review.decided",
    occurredAt: "2026-09-02T00:00:02.000Z", actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "review:T1",
    payload: {
      taskId: "T1", decision: "approved", summary: "ok",
      evidenceArtifactHashes: ["a".repeat(64), "b".repeat(64)], criterionVerdicts,
    },
  });
  assert.throws(
    () => validateSchedulerEvidenceEvent(projection, decided([
      { criterionId: "AC-1", verdict: "satisfied", rationale: "looks fine", evidenceIds: ["red"] },
    ]), evidenceStore),
    /cites failing command evidence red/,
  );
  assert.doesNotThrow(() => validateSchedulerEvidenceEvent(projection, decided([{
    criterionId: "AC-1", verdict: "satisfied", rationale: "RED before fix", evidenceIds: ["red"],
    acceptedFailures: [{ evidenceId: "red", rationale: "Intentional pre-fix failure." }],
  }]), evidenceStore));
});

test("verifier.verdict_submitted rejects a satisfied verdict that cites failing command evidence", () => {
  const evidenceStore = inMemoryEvidenceStore([commandEvidence("red", { exitCode: 2 })]);
  const projection = reviewProjectionWith({});
  assert.throws(
    () => validateSchedulerEvidenceEvent(projection, {
      eventId: "e2", runId: "run_gate", sequence: 10, type: "verifier.verdict_submitted",
      occurredAt: "2026-09-02T00:00:03.000Z", actor: { role: "verifier", id: "google:verifier" },
      idempotencyKey: "verifier:verdict:r1",
      payload: {
        reviewId: "r1", targetRevision: "a".repeat(40), sessionId: "verifier:s1",
        criterionVerdicts: [{
          taskId: "T1", criterionId: "AC-1", verdict: "satisfied", rationale: "ok", evidenceIds: ["red"],
        }],
      },
    }, evidenceStore),
    /Verifier verdict cites failing command evidence red/,
  );
});
```

- [ ] **Step 6: Run the gate tests to verify they fail**

Run: `npx tsx --test runner-v2/test/scheduler-store.test.ts`
Expected: FAIL on both new tests with `Missing expected exception`.

- [ ] **Step 7: Wire the gate into the durable boundary**

In `runner-v2/src/scheduler-store.ts`, function `validateSchedulerEvidenceEvent`:

1. In the `verifier.verdict_submitted` branch, after the `records.length !== uniqueEvidenceIds.length` check, add:

```ts
    assertSatisfiedVerdictsCiteGreenEvidence(
      event.payload.criterionVerdicts as GreenEvidenceVerdict[],
      records,
      "Verifier verdict",
    );
```

2. In the trailing `review.decided` section, after `assertReviewArtifactHashes(...)`, add:

```ts
  assertSatisfiedVerdictsCiteGreenEvidence(verdicts, records, "Review decision");
```

Import both symbols from `./acceptance-contracts.js`. In `runner-v2/src/verifier-contracts.ts`: add `acceptedFailures?: AcceptedEvidenceFailure[]` to `VerifierCriterionVerdict` (import the type from `./acceptance-contracts.js`); in `parseCriterionVerdict` accept an optional `acceptedFailures` array of `{ evidenceId, rationale }` (non-empty strings, unique evidence ids, else throw `Verifier criterion verdict ${index} acceptedFailures is invalid.`); clone it in `cloneCriterionVerdict`.

- [ ] **Step 8: Run the gate tests to verify they pass**

Run: `npx tsx --test runner-v2/test/scheduler-store.test.ts runner-v2/test/verifier-contracts.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 9: Make the tools fail fast with the same rule**

In `runner-v2/src/architect-tools.ts`:
- `criterionReviewVerdictSchema()` gains:

```ts
      acceptedFailures: {
        type: "array",
        items: objectSchema({
          evidenceId: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        }, ["evidenceId", "rationale"]),
      },
```

- In `reviewTaskTool.execute`, after `validateCriterionReviewVerdicts` succeeds and before the decision checks:

```ts
        try {
          assertSatisfiedVerdictsCiteGreenEvidence(
            input.criterionVerdicts,
            evidenceRecords,
            "Task review",
          );
        } catch (error) {
          return errorOutput(
            "failing_evidence_cited",
            error instanceof Error ? error.message : String(error),
          );
        }
```

- `validateReview` must pass `acceptedFailures` through unchanged.

In `runner-v2/src/verifier-tools.ts`, add the same `acceptedFailures` schema fragment to the verdict item schema (object with `evidenceId` and `rationale`, `additionalProperties: false`).

In `runner-v2/src/native-architect-runtime.ts`, add to the system message array:

```ts
          "A satisfied criterion verdict may cite a command that did not exit 0 only with an explicit acceptedFailures entry naming that evidence ID and a rationale, for example an intentionally failing pre-fix test. Otherwise mark the criterion unsatisfied.",
```

- [ ] **Step 10: Client type and task-board rendering**

In `lib/client/runner-v2.ts`, add to `NativeCriterionReviewVerdict`:

```ts
  acceptedFailures?: Array<{ evidenceId: string; rationale: string }>;
```

In `components/BuildTaskBoard.tsx`, where a criterion verdict row is rendered (grep `criterionVerdicts`), append a muted line per accepted failure: `Accepted failure {evidenceId}: {rationale}`. Add one assertion to `scripts/test-build-task-board-ui.tsx` that a verdict with `acceptedFailures` renders the text `Accepted failure`.

- [ ] **Step 11: Prove red, revert, prove green**

Temporarily comment out the `assertSatisfiedVerdictsCiteGreenEvidence` call in the `review.decided` section; run `npx tsx --test runner-v2/test/scheduler-store.test.ts` and record the red signature (`Missing expected exception`). Restore the call. Run the full gates:

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

- [ ] **Step 12: Commit**

```bash
git add runner-v2/src/acceptance-contracts.ts runner-v2/src/verifier-contracts.ts runner-v2/src/scheduler-store.ts runner-v2/src/architect-tools.ts runner-v2/src/verifier-tools.ts runner-v2/src/native-architect-runtime.ts lib/client/runner-v2.ts components/BuildTaskBoard.tsx runner-v2/test/acceptance-contracts.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/verifier-contracts.test.ts runner-v2/test/support/evidence-fixtures.ts scripts/test-build-task-board-ui.tsx
git commit -m "feat(runner-v2): gate satisfied verdicts on green command evidence (RG-2)"
```

**Acceptance criteria (P6.5.1):**
- An approved review or a satisfied verifier verdict cannot cite a command evidence record with non-zero exit, signal, timeout, or cancellation unless the verdict carries an `acceptedFailures` entry for that exact evidence id with a non-empty rationale.
- An `acceptedFailures` entry that names green evidence, uncited evidence, or a non-command record is rejected.
- Unsatisfied verdicts are unaffected.
- The rule is enforced at the durable append boundary, not only in the tool.
- Historical events replay unchanged: `validateSchedulerEvidenceEvent` runs only on append, never on replay, so existing runs stay readable.

**Prove-red injections:** remove the review-decision call (red), remove the verifier-verdict call (red), accept a failure without rationale (red), then restore and prove green.

**Cleanup and rollback:** whole-packet revert; no stored data changes shape except the optional `acceptedFailures` field.

---

### Task P6.5.2: RG-4 — Worker `request_replan` lifecycle tool

**Purpose:** `agent-contracts.ts` declares the `request_replan` lifecycle signal and `agent-loop.ts` already maps it to `replan_requested`, but no tool emits it. A worker that discovers its task cannot be completed as scoped has only free-text `ask_architect`. This packet makes the signal live as a typed, blocking guidance request of kind `replan`, so the Architect must either reconcile the plan or refuse with evidence. It reuses the existing guidance projection, `waiting_guidance` task state, and `guidance_required` Architect action.

**Files:**
- Modify: `runner-v2/src/task-contracts.ts` (`ReplanReason`, `ReplanRequest`)
- Modify: `runner-v2/src/worker-lifecycle-tools.ts` (`requestReplanTool`)
- Modify: `runner-v2/src/scheduler-store.ts` (`GuidanceProjection.kind/replan`, `guidance.requested` reducer, `applyPlanReconciliation` auto-answer, `architectLifecycleEventMatchesReason`)
- Modify: `runner-v2/src/native-worker-driver.ts` (`guidanceOutcomeFromProjection`, `replan_requested` branch, continuation message)
- Modify: `runner-v2/src/native-architect-runtime.ts` (system-prompt line)
- Modify: `lib/client/runner-v2.ts` (`NativeGuidanceProjection.kind/replan`)
- Modify: `components/RunnerV2ObservabilityPanel.tsx` (attention item)
- Test: new `runner-v2/test/request-replan.test.ts`; `runner-v2/test/native-worker-driver.test.ts`; `scripts/test-runner-v2-observability.mts`

**Interfaces:**
- Produces: `ReplanReason`, `ReplanRequest` (task-contracts), `GuidanceProjection.kind?: "question" | "replan"`, `GuidanceProjection.replan?: ReplanRequest`, `guidanceOutcomeFromProjection(projection, requestId): WorkerOutcome` (native-worker-driver).

- [ ] **Step 1: Add the contract types**

In `runner-v2/src/task-contracts.ts`:

```ts
export type ReplanReason =
  | "scope_exceeded"
  | "requirement_conflict"
  | "architecture_contradiction"
  | "dependency_missing";

export const REPLAN_REASONS: readonly ReplanReason[] = [
  "scope_exceeded",
  "requirement_conflict",
  "architecture_contradiction",
  "dependency_missing",
];

export interface ReplanRequest {
  reason: ReplanReason;
  summary: string;
  proposedChange: string;
}
```

- [ ] **Step 2: Write the failing reducer and tool tests**

Create `runner-v2/test/request-replan.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  architectLifecycleEventMatchesReason,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { createWorkerLifecycleTools } from "../src/worker-lifecycle-tools.js";

const RUN_ID = "run_replan";
const AT = "2026-09-02T00:00:00.000Z";

function event(
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
  actor: NewSchedulerEvent["actor"] = { role: "runner", id: "test" },
): NewSchedulerEvent {
  return { runId: RUN_ID, type, occurredAt: AT, actor, idempotencyKey, payload };
}

function seededStore(root: string): SqliteSchedulerStore {
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  store.append(event("run.initialized", "init", { runId: RUN_ID }));
  store.append(event("plan.created", "plan:1", {
    revision: 1,
    tasks: [{
      id: "T1", objective: "Add caching", dependencies: [], status: "planned",
      requiredCapabilities: ["code"], attempt: 0,
      acceptanceCriteria: [{ id: "AC-1", text: "Cache invalidates on membership change." }],
      acceptanceCriteriaVersion: 1,
    }],
  }, { role: "architect", id: "architect_1" }));
  store.append(event("task.transitioned", "T1:assigned", {
    taskId: "T1", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker:T1:1" },
  }, { role: "runner", id: "scheduler" }));
  store.append(event("task.transitioned", "T1:running", { taskId: "T1", status: "running" },
    { role: "runner", id: "scheduler" }));
  return store;
}

test("request_replan appends a blocking replan guidance request and ends the worker turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    const tool = createWorkerLifecycleTools({ store, taskId: "T1", clock: () => AT })
      .find((candidate) => candidate.definition.name === "request_replan");
    assert.ok(tool, "request_replan tool is registered");
    assert.equal(tool.definition.lifecycle, true);
    const validated = tool.validate({
      requestId: "replan-1",
      reason: "scope_exceeded",
      summary: "The cache key factory lives outside this task and must change.",
      proposedChange: "Split into T1a (key factory) and T1b (invalidation) with T1b depending on T1a.",
      evidenceSequence: 4,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, {
      runId: RUN_ID, sessionId: "worker:T1:1", actor: { role: "worker", id: "worker:T1:1" },
    });
    assert.equal(output.isError, false);
    assert.deepEqual(output.lifecycle, { type: "request_replan", requestId: "replan-1" });

    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks.T1.status, "waiting_guidance");
    assert.equal(projection.guidance["replan-1"].kind, "replan");
    assert.equal(projection.guidance["replan-1"].blocking, true);
    assert.equal(projection.guidance["replan-1"].replan?.reason, "scope_exceeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replan guidance request must be blocking and carry a known reason", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    assert.throws(() => store.append(event("guidance.requested", "g:bad-blocking", {
      requestId: "bad-blocking", taskId: "T1", question: "x", blocking: false, evidenceSequence: 1,
      kind: "replan", replan: { reason: "scope_exceeded", summary: "s", proposedChange: "p" },
    }, { role: "worker", id: "worker:T1:1" })), /replan guidance must be blocking/);
    assert.throws(() => store.append(event("guidance.requested", "g:bad-reason", {
      requestId: "bad-reason", taskId: "T1", question: "x", blocking: true, evidenceSequence: 1,
      kind: "replan", replan: { reason: "bored", summary: "s", proposedChange: "p" },
    }, { role: "worker", id: "worker:T1:1" })), /replan reason bored is invalid/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciling the plan answers the open replan request and satisfies guidance_required", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-replan-"));
  const store = seededStore(root);
  try {
    store.append(event("guidance.requested", "g:replan-2", {
      requestId: "replan-2", taskId: "T1", question: "Replan requested.", blocking: true,
      evidenceSequence: 4, kind: "replan",
      replan: { reason: "scope_exceeded", summary: "s", proposedChange: "split" },
    }, { role: "worker", id: "worker:T1:1" }));
    const reconciled = store.append(event("plan.reconciled", "plan:2", {
      revision: 2,
      summary: "Split T1 per worker replan request.",
      taskUpdates: [{ taskId: "T1", action: "cancel" }],
      newTasks: [
        { id: "T1a", objective: "Key factory", dependencies: [], requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "AC-1", text: "Factory builds org-scoped keys." }] },
        { id: "T1b", objective: "Invalidation", dependencies: ["T1a"], requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "AC-1", text: "Membership change invalidates the key." }] },
      ],
    }, { role: "architect", id: "architect_1" }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.equal(projection.tasks.T1.status, "cancelled");
    assert.equal(projection.guidance["replan-2"].status, "answered");
    assert.equal(projection.guidance["replan-2"].answer, "plan_reconciled:2");
    assert.equal(
      architectLifecycleEventMatchesReason(reconciled, {
        type: "guidance_required", requestId: "replan-2", taskId: "T1",
      }),
      true,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test runner-v2/test/request-replan.test.ts`
Expected: FAIL: `request_replan tool is registered` assertion, then `Missing expected exception`, then `answered !== open`.

- [ ] **Step 4: Implement the worker tool**

In `runner-v2/src/worker-lifecycle-tools.ts`, register a third tool in `createWorkerLifecycleTools` and add:

```ts
import { REPLAN_REASONS, type ReplanReason } from "./task-contracts.js";

interface RequestReplanInput {
  requestId: string;
  reason: ReplanReason;
  summary: string;
  proposedChange: string;
  evidenceSequence: number;
}

function requestReplanTool(
  store: SchedulerStore,
  taskId: string,
  clock: () => string
): NativeTool<RequestReplanInput> {
  return {
    definition: {
      name: "request_replan",
      description:
        "End this attempt because the task cannot be completed within its objective: the scope is exceeded, a requirement conflicts with the repository, an architectural contradiction was found, or a dependency is missing. The Architect reconciles the plan or refuses with evidence; the task stays owned by this workspace.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", minLength: 1 },
          reason: { type: "string", enum: [...REPLAN_REASONS] },
          summary: { type: "string", minLength: 1, maxLength: 4_000 },
          proposedChange: { type: "string", minLength: 1, maxLength: 4_000 },
          evidenceSequence: { type: "integer", minimum: 0 },
        },
        required: ["requestId", "reason", "summary", "proposedChange", "evidenceSequence"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: validateReplan,
    execute: async (input, context) => {
      const denied = workerOnly(context);
      if (denied) return denied;
      const requestId = allocateGuidanceRequestId(store, context.runId, input.requestId);
      const result = append(store, {
        runId: context.runId,
        type: "guidance.requested",
        occurredAt: clock(),
        actor: { role: "worker", id: context.actor.id },
        idempotencyKey: `guidance:${requestId}`,
        payload: {
          requestId,
          taskId,
          question: `Replan requested (${input.reason}): ${input.summary}\nProposed change: ${input.proposedChange}`,
          blocking: true,
          evidenceSequence: input.evidenceSequence,
          kind: "replan",
          replan: {
            reason: input.reason,
            summary: input.summary,
            proposedChange: input.proposedChange,
          },
        },
      });
      if (result.isError) return result;
      return { ...result, lifecycle: { type: "request_replan", requestId } };
    },
  };
}

function validateReplan(input: unknown): ValidationResult<RequestReplanInput> {
  if (!isRecord(input)) return invalid("Replan arguments must be an object.");
  if (
    !nonEmpty(input.requestId) ||
    !REPLAN_REASONS.includes(input.reason as ReplanReason) ||
    !nonEmpty(input.summary) ||
    !nonEmpty(input.proposedChange) ||
    !nonNegativeInteger(input.evidenceSequence)
  ) return invalid("requestId, reason, summary, proposedChange, and evidenceSequence are required.");
  return { ok: true, value: input as unknown as RequestReplanInput };
}
```

- [ ] **Step 5: Implement the reducer changes**

In `runner-v2/src/scheduler-store.ts`:

1. `GuidanceProjection` gains `kind?: "question" | "replan";` and `replan?: ReplanRequest;` (import `REPLAN_REASONS`, `ReplanRequest`, `ReplanReason` from `./task-contracts.js`).

2. In the `guidance.requested` reducer, before `next.guidance[requestId] = {...}`:

```ts
      const kind = event.payload.kind === undefined ? "question" : event.payload.kind;
      if (kind !== "question" && kind !== "replan") {
        throw new Error(`Guidance kind ${String(kind)} is invalid.`);
      }
      let replan: ReplanRequest | undefined;
      if (kind === "replan") {
        if (!blocking) throw new Error("A replan guidance must be blocking.");
        if (!isRecord(event.payload.replan)) throw new Error("A replan guidance requires a replan record.");
        const reason = requiredString(event.payload.replan, "reason");
        if (!REPLAN_REASONS.includes(reason as ReplanReason)) {
          throw new Error(`A replan reason ${reason} is invalid.`);
        }
        replan = {
          reason: reason as ReplanReason,
          summary: requiredString(event.payload.replan, "summary"),
          proposedChange: requiredString(event.payload.replan, "proposedChange"),
        };
      }
```

and include `kind` and `...(replan ? { replan } : {})` in the stored projection entry. (The `blocking` constant already exists above this point; move the `const blocking = ...` line up if necessary.)

3. In `applyPlanReconciliation`, after a task update with `action: "cancel"` or `action: "revise"` is applied to task `taskId`, auto-answer its open replan guidance:

```ts
  for (const guidance of Object.values(projection.guidance)) {
    if (
      guidance.kind === "replan" &&
      guidance.status === "open" &&
      touchedTaskIds.has(guidance.taskId)
    ) {
      projection.guidance[guidance.requestId] = {
        ...guidance,
        status: "answered",
        answer: `plan_reconciled:${reconciliation.revision}`,
      };
    }
  }
```

where `touchedTaskIds` is the set of `taskUpdates[].taskId`. A cancelled task keeps `cancelled`; a revised task that was `waiting_guidance` transitions to `planned` (add `waiting_guidance: ["running", "planned", "cancelled"]` is already allowed in `task-graph.ts` `TRANSITIONS`; the revise branch must use `applyTaskTransition(task, "planned", { guidanceRequestId: undefined, ... })` for a `waiting_guidance` task instead of throwing).

4. In `architectLifecycleEventMatchesReason`, extend the `guidance_required` case:

```ts
    case "guidance_required":
      return event.actor.role === "architect" && (
        (event.type === "guidance.answered" && event.payload.requestId === reason.requestId) ||
        (event.type === "plan.reconciled" &&
          Array.isArray(event.payload.taskUpdates) &&
          event.payload.taskUpdates.some((update) =>
            isRecord(update) && update.taskId === reason.taskId))
      );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test runner-v2/test/request-replan.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/guidance-review.test.ts runner-v2/test/task-graph.test.ts`
Expected: PASS.

- [ ] **Step 7: Map the loop result in the worker driver (test first)**

In `runner-v2/test/native-worker-driver.test.ts` add:

```ts
test("guidanceOutcomeFromProjection maps an open replan request to a blocking guidance outcome", () => {
  const outcome = guidanceOutcomeFromProjection({
    ...emptyProjectionForTest("run_replan"),
    guidance: {
      "replan-1": {
        requestId: "replan-1", taskId: "T1", blocking: true, question: "Replan requested.",
        evidenceSequence: 3, version: 1, status: "open", kind: "replan",
        replan: { reason: "scope_exceeded", summary: "s", proposedChange: "p" },
      },
    },
  }, "replan-1");
  assert.deepEqual(outcome, {
    type: "guidance", requestId: "replan-1", blocking: true, question: "Replan requested.", evidenceSequence: 3,
  });
  assert.deepEqual(guidanceOutcomeFromProjection(emptyProjectionForTest("run_replan"), "missing"), {
    type: "failed", reason: "missing_guidance:missing",
  });
});
```

(`emptyProjectionForTest` is a local helper returning the same literal shape used in `scheduler-store.test.ts`; extract it to `runner-v2/test/support/projection-fixtures.ts` and import it from both files.)

Run: `npx tsx --test runner-v2/test/native-worker-driver.test.ts` — Expected: FAIL (`guidanceOutcomeFromProjection` is not exported).

Then in `runner-v2/src/native-worker-driver.ts` extract and export:

```ts
export function guidanceOutcomeFromProjection(
  projection: SchedulerProjection,
  requestId: string,
): WorkerOutcome {
  const guidance = projection.guidance[requestId];
  if (!guidance) return { type: "failed", reason: `missing_guidance:${requestId}` };
  return {
    type: "guidance",
    requestId: guidance.requestId,
    blocking: guidance.blocking,
    question: guidance.question,
    evidenceSequence: guidance.evidenceSequence,
  };
}
```

and replace the body of the `waiting_for_architect` branch with a call to it; add the sibling branch:

```ts
      if (result.loop.status === "replan_requested") {
        return guidanceOutcomeFromProjection(
          rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
          result.loop.requestId,
        );
      }
```

In `workerContinuationMessages`, change the third line to: `"Finish with submit_task when the task is ready; use ask_architect when an Architect decision is genuinely required; use request_replan when the task cannot be completed within its objective."`

Run the driver test again. Expected: PASS.

- [ ] **Step 8: Architect prompt and UI**

In `runner-v2/src/native-architect-runtime.ts` system message array add:

```ts
          "A guidance request of kind replan means the worker cannot complete the task within its objective. Either reconcile the plan with reconcile_plan (cancel or revise that task, add replacement tasks) or refuse with answer_guidance citing evidence; never leave a replan request open.",
```

In `lib/client/runner-v2.ts`, add to `NativeGuidanceProjection`: `kind?: "question" | "replan"; replan?: { reason: string; summary: string; proposedChange: string };`. In `components/RunnerV2ObservabilityPanel.tsx`, in the attention-item builder next to the `verifier:selection` item, add for every open guidance with `kind === "replan"`: `{ key: "replan:" + requestId, title: "Worker requested a replan", detail: replan.summary }`. Add an assertion in `scripts/test-runner-v2-observability.mts` that such a projection yields the title `Worker requested a replan`.

- [ ] **Step 9: Prove red, gates, commit**

Injection: temporarily skip the auto-answer loop in `applyPlanReconciliation`; run `npx tsx --test runner-v2/test/request-replan.test.ts` and record the red signature; restore. Then:

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

```bash
git add runner-v2/src/task-contracts.ts runner-v2/src/worker-lifecycle-tools.ts runner-v2/src/scheduler-store.ts runner-v2/src/native-worker-driver.ts runner-v2/src/native-architect-runtime.ts lib/client/runner-v2.ts components/RunnerV2ObservabilityPanel.tsx runner-v2/test/request-replan.test.ts runner-v2/test/native-worker-driver.test.ts runner-v2/test/support/projection-fixtures.ts scripts/test-runner-v2-observability.mts
git commit -m "feat(runner-v2): wire the worker request_replan lifecycle signal (RG-4)"
```

**Acceptance criteria (P6.5.2):**
- `request_replan` is a lifecycle tool; its call ends the worker turn and moves the task to `waiting_guidance` with a durable `replan` guidance record.
- A replan guidance that is not blocking, or whose reason is unknown, is rejected by the reducer.
- The Architect resolves it either by `answer_guidance` (task resumes with the refusal in context) or by `reconcile_plan` touching that task (the reducer auto-answers the request with `plan_reconciled:<revision>`).
- `guidance_required` is satisfied by either resolution; the runner never loops on a resolved replan.
- Restart with an open replan request resumes at `guidance_required` (existing durable behavior; add one replay assertion).

**Prove-red injections:** skip the auto-answer (red: request stays open after reconciliation); allow `blocking: false` (red); drop the `replan_requested` branch (worker outcome becomes `unexpected_worker_lifecycle:replan_requested`, red).

---

### Task P6.5.3: RG-3 — Durable repair-cycle cap

**Purpose:** Today a verifier-unsatisfied or final-verification-failed build can loop repair → integrate → re-verify without any durable count; the only stops are the per-task attempt limit and `runUntilBlocked(maxSteps = 100)`. The `repair_budget_exhausted` question kind is prompt-only. This packet adds a kernel-counted limit on repair plans per run, a runner-owned pause when it is reached, and a user-only extension. It mirrors the P4 verifier-selection pause exactly.

**Files:**
- Modify: `runner-v2/src/build-spec.ts` (`repairPlanLimit?: number`, validation, clone)
- Modify: `runner-v2/src/scheduler-store.ts` (three events, `RepairCyclesProjection`, `consumeRepairCycle`, `repairCyclesExhausted`, counting in both repair-task creators)
- Modify: `runner-v2/src/build-runtime.ts` (`configureRepairPolicy`, `pauseIfRepairCyclesExhausted`, `extendRepairCycles`, resume guard)
- Modify: `runner-v2/src/native-build-factory.ts` (pass `repairPlanLimit`)
- Modify: `runner-v2/src/native-build-manager.ts` (`extendRepairCycles`)
- Modify: `runner-v2/src/control-server.ts` (`POST /v2/runs/{runId}/build/repair-cycles`)
- Modify: `lib/client/runner-v2.ts` (`extendNativeRepairCycles`, `NativeBuildProjection.repairCycles`)
- Modify: `components/RunnerV2ObservabilityPanel.tsx` (attention item + extend control + control summary)
- Test: new `runner-v2/test/repair-cycles.test.ts`; `runner-v2/test/build-spec-store.test.ts`; `runner-v2/test/control-server.test.ts`; `scripts/test-runner-v2-client.mts`; `scripts/test-runner-v2-observability.mts`
- Test support: extract `createFixture`, `createRuntime`, `appendVerifierRequest`, `verifierRequestPayload` from `runner-v2/test/verifier-contracts.test.ts` into `runner-v2/test/support/verifier-run-fixture.ts` (exported, behavior unchanged) so this packet and P6.5.5 can reuse the seeded unsatisfied-verdict run.

**Interfaces:**
- Produces: `DEFAULT_REPAIR_PLAN_LIMIT = 3`, `RepairCyclesProjection`, `consumeRepairCycle(projection)`, `repairCyclesExhausted(projection)` in `scheduler-store.ts`; `BuildRuntime.extendRepairCycles(additionalRepairPlans, idempotencyKey)`; event types `repair.policy_configured`, `repair.cycle_limit_reached`, `repair.cycle_limit_extended`.
- Consumes: the verifier run fixture (unsatisfied verdict at `REVISION`).

- [ ] **Step 1: Extract the shared verifier run fixture**

Move the four helpers into `runner-v2/test/support/verifier-run-fixture.ts` with `export` keywords and re-import them in `runner-v2/test/verifier-contracts.test.ts`. Run `npx tsx --test runner-v2/test/verifier-contracts.test.ts` and confirm every existing test still passes before continuing.

- [ ] **Step 2: Write the failing reducer tests**

Create `runner-v2/test/repair-cycles.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeRepairCycle,
  DEFAULT_REPAIR_PLAN_LIMIT,
  rebuildSchedulerProjection,
  repairCyclesExhausted,
} from "../src/scheduler-store.js";
import { emptyProjectionForTest } from "./support/projection-fixtures.js";
import {
  appendVerifierRequest,
  createFixture,
  event,
  RUN_ID,
  REVISION,
} from "./support/verifier-run-fixture.js";

test("consumeRepairCycle counts repair plans and blocks at the limit", () => {
  const projection = {
    ...emptyProjectionForTest(RUN_ID),
    repairCycles: { limit: 1, used: 0, extensions: 0 },
  };
  consumeRepairCycle(projection);
  assert.deepEqual(projection.repairCycles, { limit: 1, used: 1, extensions: 0 });
  assert.equal(repairCyclesExhausted(projection), true);
  assert.throws(
    () => consumeRepairCycle(projection),
    /Repair plan limit reached: 1 of 1 repair plans used; the user must extend the repair-cycle budget/,
  );
  const legacy = emptyProjectionForTest(RUN_ID);
  consumeRepairCycle(legacy);
  assert.equal(legacy.repairCycles, undefined, "runs without a policy stay uncapped");
  assert.equal(repairCyclesExhausted(legacy), false);
});

test("repair policy is runner-only, idempotent, and conflict-checked", () => {
  const fixture = createFixture({});
  try {
    assert.throws(() => fixture.store.append(event("repair.policy_configured", "repair-policy:user", {
      repairPlanLimit: 2,
    }, { role: "user", id: "local-user" })), /Only the runner may configure repair policy/);
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 2 }));
    assert.throws(() => fixture.store.append(event("repair.policy_configured", "repair-policy:again", {
      repairPlanLimit: 5,
    })), /Repair policy is already configured differently/);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.deepEqual(projection.repairCycles, { limit: 2, used: 0, extensions: 0 });
    assert.equal(DEFAULT_REPAIR_PLAN_LIMIT, 3);
  } finally {
    fixture.close();
  }
});

test("a verifier repair plan consumes a cycle and the limit pauses only for the user to extend", () => {
  const fixture = createFixture({});
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 1 }));
    appendVerifierRequest(fixture.store);
    fixture.store.append(event("verifier.verdict_submitted", "verifier:verdict", {
      reviewId: "verifier-review-1",
      targetRevision: REVISION,
      sessionId: "verifier:session-1",
      criterionVerdicts: [{
        taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied",
        rationale: "The UI criterion is not met.", evidenceIds: [fixture.evidenceIds[0]],
      }],
    }, { role: "verifier", id: "google:verifier" }));
    fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:1", {
      reviewId: "verifier-review-1",
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [{
        id: "repair_ui", objective: "Repair the UI criterion",
        criteria: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
        evidenceIds: [fixture.evidenceIds[0]], dependencies: [], requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "AC-1", text: "UI criterion satisfied." }],
      }],
    }, { role: "architect", id: "openai:architect" }));
    let projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 1);
    assert.equal(repairCyclesExhausted(projection), true);

    assert.throws(() => fixture.store.append(event("repair.cycle_limit_reached", "limit:early", {
      source: "verifier", targetRevision: REVISION, used: 0, limit: 1,
    })), /does not match the kernel repair-cycle count/);
    fixture.store.append(event("repair.cycle_limit_reached", "limit:1", {
      source: "verifier", targetRevision: REVISION, used: 1, limit: 1,
    }));
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.status, "paused");
    assert.deepEqual(projection.pauseReason, { reason: "repair_cycle_limit" });
    assert.deepEqual(projection.repairCycles?.pause, {
      source: "verifier", targetRevision: REVISION, used: 1, limit: 1,
    });

    assert.throws(() => fixture.store.append(event("repair.cycle_limit_extended", "extend:runner", {
      additionalRepairPlans: 1,
    })), /Repair-cycle extension requires the user/);
    assert.throws(() => fixture.store.append(event("repair.cycle_limit_extended", "extend:zero", {
      additionalRepairPlans: 0,
    }, { role: "user", id: "local-user" })), /additionalRepairPlans must be an integer between 1 and 10/);
    fixture.store.append(event("repair.cycle_limit_extended", "extend:1", {
      additionalRepairPlans: 2,
    }, { role: "user", id: "local-user" }));
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.status, "running");
    assert.equal(projection.pauseReason, undefined);
    assert.deepEqual(projection.repairCycles, { limit: 3, used: 1, extensions: 1 });
    assert.equal(repairCyclesExhausted(projection), false);
  } finally {
    fixture.close();
  }
});
```

`event`, `RUN_ID`, and `REVISION` are the fixture file's existing helpers/constants; export them from the support module.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test runner-v2/test/repair-cycles.test.ts`
Expected: FAIL with an import error naming `consumeRepairCycle`.

- [ ] **Step 4: Implement the reducer**

In `runner-v2/src/scheduler-store.ts`:

1. Add the three event names to `SchedulerEventType`: `"repair.policy_configured" | "repair.cycle_limit_reached" | "repair.cycle_limit_extended"`.

2. Add the projection type and field:

```ts
export const DEFAULT_REPAIR_PLAN_LIMIT = 3;
export const MAX_REPAIR_CYCLE_EXTENSION = 10;

export interface RepairCyclesProjection {
  limit: number;
  used: number;
  extensions: number;
  pause?: {
    source: "final_verification" | "verifier";
    targetRevision: string;
    used: number;
    limit: number;
  };
}
```

and `repairCycles?: RepairCyclesProjection;` on `SchedulerProjection` (clone it wherever the projection is cloned; grep `cloneVerifierProjection(` for the pattern).

3. Pure helpers:

```ts
export function repairCyclesExhausted(projection: SchedulerProjection): boolean {
  const cycles = projection.repairCycles;
  return cycles !== undefined && cycles.used >= cycles.limit;
}

export function consumeRepairCycle(projection: SchedulerProjection): void {
  const cycles = projection.repairCycles;
  if (!cycles) return;
  if (cycles.used >= cycles.limit) {
    throw new Error(
      `Repair plan limit reached: ${cycles.used} of ${cycles.limit} repair plans used; the user must extend the repair-cycle budget.`,
    );
  }
  projection.repairCycles = { ...cycles, used: cycles.used + 1 };
}
```

4. Call `consumeRepairCycle(projection)` as the first statement of both `createFinalVerificationRepairTasks` and `createVerifierRepairTasks` (before any mutation, so a rejected plan mutates nothing).

5. Reducer cases:

```ts
    case "repair.policy_configured": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may configure repair policy.");
      }
      const limit = event.payload.repairPlanLimit;
      if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
        throw new Error("repairPlanLimit must be a non-negative integer.");
      }
      if (current.repairCycles && current.repairCycles.limit !== limit) {
        throw new Error("Repair policy is already configured differently.");
      }
      next.repairCycles = current.repairCycles ?? { limit: limit as number, used: 0, extensions: 0 };
      break;
    }
    case "repair.cycle_limit_reached": {
      if (event.actor.role !== "runner") {
        throw new Error("Only the runner may report a repair-cycle limit.");
      }
      const cycles = current.repairCycles;
      if (!cycles) throw new Error("Repair-cycle limit requires configured repair policy.");
      const source = event.payload.source;
      if (source !== "final_verification" && source !== "verifier") {
        throw new Error("Repair-cycle limit source is invalid.");
      }
      const used = requiredNumber(event.payload, "used");
      const limit = requiredNumber(event.payload, "limit");
      if (used !== cycles.used || limit !== cycles.limit || used < limit) {
        throw new Error("Repair-cycle limit event does not match the kernel repair-cycle count.");
      }
      next.repairCycles = {
        ...cycles,
        pause: { source, targetRevision: requiredString(event.payload, "targetRevision"), used, limit },
      };
      next.status = "paused";
      next.pauseReason = { reason: "repair_cycle_limit" };
      break;
    }
    case "repair.cycle_limit_extended": {
      if (event.actor.role !== "user") {
        throw new Error("Repair-cycle extension requires the user.");
      }
      const cycles = current.repairCycles;
      if (!cycles?.pause) throw new Error("There is no repair-cycle pause to extend.");
      const additional = event.payload.additionalRepairPlans;
      if (
        !Number.isSafeInteger(additional) ||
        (additional as number) < 1 ||
        (additional as number) > MAX_REPAIR_CYCLE_EXTENSION
      ) {
        throw new Error(`additionalRepairPlans must be an integer between 1 and ${MAX_REPAIR_CYCLE_EXTENSION}.`);
      }
      next.repairCycles = {
        limit: cycles.limit + (additional as number),
        used: cycles.used,
        extensions: cycles.extensions + 1,
      };
      next.status = "running";
      delete next.pauseReason;
      break;
    }
```

- [ ] **Step 5: Run the reducer tests to verify they pass**

Run: `npx tsx --test runner-v2/test/repair-cycles.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/verifier-contracts.test.ts runner-v2/test/final-verification-repair.test.ts`
Expected: PASS. (Existing repair tests have no policy event, so they stay uncapped.)

- [ ] **Step 6: Build spec field (test first)**

In `runner-v2/test/build-spec-store.test.ts` add: a spec with `repairPlanLimit: 0` saves and reloads; `repairPlanLimit: -1` and `repairPlanLimit: 1.5` throw `Build spec repairPlanLimit must be a non-negative integer.`; a legacy version-1 spec recovers with `repairPlanLimit` undefined. Run to see it fail, then in `runner-v2/src/build-spec.ts` add `repairPlanLimit?: number;` to `NativeBuildSpec` with that validation inside `validateBuildSpecCore` and a copy in `cloneBuildSpec`. Run again: PASS.

- [ ] **Step 7: Runtime guard (test first)**

Append to `runner-v2/test/repair-cycles.test.ts`:

```ts
test("the runtime pauses at the repair limit instead of asking the Architect, and resumes after a user extension", async () => {
  const fixture = createFixture({});
  try {
    appendVerifierRequest(fixture.store);
    fixture.store.append(event("verifier.verdict_submitted", "verifier:verdict", {
      reviewId: "verifier-review-1", targetRevision: REVISION, sessionId: "verifier:session-1",
      criterionVerdicts: [{
        taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied",
        rationale: "Not met.", evidenceIds: [fixture.evidenceIds[0]],
      }],
    }, { role: "verifier", id: "google:verifier" }));
    let architectCalls = 0;
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("risk already assessed"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async () => { architectCalls += 1; },
      { repairPlanLimit: 0 },
    );
    const paused = await runtime.step();
    assert.deepEqual(paused, { status: "paused", action: "repair_cycle_limit_reached" });
    assert.equal(architectCalls, 0);
    const projection = runtime.projection();
    assert.deepEqual(projection.repairCycles, {
      limit: 0, used: 0, extensions: 0,
      pause: { source: "verifier", targetRevision: REVISION, used: 0, limit: 0 },
    });
    assert.throws(() => runtime.resume("resume:1"), /awaiting the user's repair-cycle decision/);

    runtime.extendRepairCycles(1, "extend:1");
    assert.equal(runtime.projection().status, "running");
    await runtime.step();
    assert.equal(architectCalls, 1);
  } finally {
    fixture.close();
  }
});
```

`createRuntime` gains a fourth optional parameter `options: { repairPlanLimit?: number }` spread into `BuildRuntimeOptions`. Run: FAIL (`repairPlanLimit` unknown; `extendRepairCycles` missing).

Then in `runner-v2/src/build-runtime.ts`:
- `BuildRuntimeOptions.repairPlanLimit?: number;` stored as `this.repairPlanLimit = options.repairPlanLimit ?? DEFAULT_REPAIR_PLAN_LIMIT`.
- In the constructor after `this.configureVerifierPolicy();` call `this.configureRepairPolicy();`:

```ts
  private configureRepairPolicy(): void {
    const events = this.store.readRun(this.runId);
    if (events.some((event) => event.type === "repair.policy_configured")) return;
    if (events.some((event) => event.type === "plan.created")) return; // in-flight pre-P6.5 runs stay uncapped
    this.store.append({
      runId: this.runId,
      type: "repair.policy_configured",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "repair-policy",
      payload: { repairPlanLimit: this.repairPlanLimit },
    });
  }
```

- Guard helper:

```ts
  private pauseIfRepairCyclesExhausted(
    projection: SchedulerProjection,
    source: "final_verification" | "verifier",
    targetRevision: string,
  ): BuildStepResult | undefined {
    if (!repairCyclesExhausted(projection)) return undefined;
    const cycles = projection.repairCycles!;
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_reached",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `repair-cycle-limit:${targetRevision}:${cycles.used}:${cycles.extensions}`,
      payload: { source, targetRevision, used: cycles.used, limit: cycles.limit },
    });
    return { status: "paused", action: "repair_cycle_limit_reached" };
  }
```

Call it immediately before every `runArchitect({ type: "final_verification_repair_plan_required", ... })` (both the semantic-review and mechanical-failure sites in `advanceFinalVerification`; grep the reason string) with `source: "final_verification"`, and before `runArchitect({ type: "verifier_repair_plan_required", ... })` in `advanceIndependentVerification` with `source: "verifier"`; return the pause result when defined.

- `extendRepairCycles`:

```ts
  extendRepairCycles(additionalRepairPlans: number, idempotencyKey: string): SchedulerProjection {
    this.store.append({
      runId: this.runId,
      type: "repair.cycle_limit_extended",
      occurredAt: this.clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey,
      payload: { additionalRepairPlans },
    });
    return this.projection();
  }
```

- In `resumeInternal`, after the verifier-selection guard:

```ts
    if (projection.repairCycles?.pause) {
      throw new Error("This Build is awaiting the user's repair-cycle decision.");
    }
```

Run the runtime test: PASS.

- [ ] **Step 8: Manager, control plane, client, UI**

- `native-build-factory.ts`: pass `repairPlanLimit: spec.repairPlanLimit` where `BuildRuntime` options are assembled (next to `independentVerifier`).
- `native-build-manager.ts`: add `async extendRepairCycles(runId, additionalRepairPlans, idempotencyKey)` mirroring `selectVerifierRuntime` (same `withRuntimeActivity` wrapper and lifecycle sync).
- `control-server.ts`: after the `verifier-handoff` route add `segments[4] === "repair-cycles"` POST with body `{ additionalRepairPlans, idempotencyKey }` validated as a safe integer 1–10 and a non-empty key; respond with the projection. Add a control-server test that posts to `/v2/runs/<id>/build/repair-cycles` and asserts a 400 on `additionalRepairPlans: 0` and a 200 projection otherwise.
- `lib/client/runner-v2.ts`: `repairCycles?: { limit: number; used: number; extensions: number; pause?: { source: "final_verification" | "verifier"; targetRevision: string; used: number; limit: number } }` on `NativeBuildProjection`; `export async function extendNativeRepairCycles(connection, runId, input: { additionalRepairPlans: number; idempotencyKey: string })` mirroring `selectNativeVerifierRuntime`. Add the client test in `scripts/test-runner-v2-client.mts` next to the verifier-runtime test.
- `components/RunnerV2ObservabilityPanel.tsx`: attention item `{ key: "repair-cycles:limit", title: "Repair budget exhausted", detail: "Runner used <used> of <limit> repair plans. Extend the budget or stop the build." }` when `projection.repairCycles?.pause` exists; `runnerBuildControlSummary` returns `"Repair budget exhausted"` in that state; a numeric input (1–10, default 1) plus an "Extend repair budget" button calling `extendNativeRepairCycles` next to the verifier-selection control. Assert the title and the summary in `scripts/test-runner-v2-observability.mts`.

- [ ] **Step 9: Prove red, gates, commit**

Injections: (a) remove the `consumeRepairCycle` call from `createVerifierRepairTasks` (red: `used` stays 0); (b) change the guard to skip when `source === "verifier"` (red: `architectCalls` is 1); (c) allow a runner actor in `repair.cycle_limit_extended` (red). Restore each. Then:

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

```bash
git add runner-v2/src/build-spec.ts runner-v2/src/scheduler-store.ts runner-v2/src/build-runtime.ts runner-v2/src/native-build-factory.ts runner-v2/src/native-build-manager.ts runner-v2/src/control-server.ts lib/client/runner-v2.ts components/RunnerV2ObservabilityPanel.tsx runner-v2/test/repair-cycles.test.ts runner-v2/test/support/verifier-run-fixture.ts runner-v2/test/verifier-contracts.test.ts runner-v2/test/build-spec-store.test.ts runner-v2/test/control-server.test.ts scripts/test-runner-v2-client.mts scripts/test-runner-v2-observability.mts
git commit -m "feat(runner-v2): cap repair plans per run with a user-only extension (RG-3)"
```

**Acceptance criteria (P6.5.3):**
- New runs record `repair.policy_configured` with the spec limit or the default 3; runs that already planned before P6.5 stay uncapped.
- The reducer rejects a repair plan (either source) once `used >= limit`; the rejection mutates nothing.
- The runtime appends `repair.cycle_limit_reached` and pauses instead of calling the Architect; resume is refused while the pause stands; only a user `repair.cycle_limit_extended` (1–10) lifts it.
- Replaying the event log reproduces `repairCycles` exactly; duplicate limit/extension events are idempotent by key.
- UI shows the pause, the counts, and the extension control; the client helper is covered.

**Prove-red injections:** as in Step 9 plus a restart replay: terminate after `repair.cycle_limit_reached`, rebuild the projection, assert the pause persists.

**Cleanup and rollback:** whole-packet revert. Runs created under P6.5 that carry a `repair.policy_configured` event cannot be resumed by an older runner (the reducer will not know the event); document this in the packet report.

---

### Task P6.5.4: RG-5 — Durable context manifests per model call

**Purpose:** `ContextAssembler` computes a SHA-256 digest per section and per pack, but nothing persists them; a failed run cannot show what a model was actually given, and P7 cannot compare models fairly. This packet records one manifest per assembled context pack for the Architect, workers, and the verifier in a SQLite side ledger (same pattern as the tool ledger), exports it in audit, and can optionally store the rendered pack text as a content-addressed artifact.

**Files:**
- Create: `runner-v2/src/context-manifest-store.ts`
- Create: `runner-v2/src/sqlite-context-manifest-store.ts`
- Modify: `runner-v2/src/context-assembler.ts` (`IncludedContextSection.sourceDigest?/artifactHash?`)
- Modify: `runner-v2/src/build-spec.ts` (`contextRecording?: "manifest" | "full"`)
- Modify: `runner-v2/src/native-architect-runtime.ts`, `runner-v2/src/native-worker-driver.ts`, `runner-v2/src/native-verifier-runtime.ts` (options + record call)
- Modify: `runner-v2/src/native-build-factory.ts` (live store, historical read-only store, close, wiring)
- Modify: `runner-v2/src/native-build-manager.ts` and `runner-v2/src/control-server.ts` (audit export), `runner-v2/src/build-observability.ts` (`contextManifestCount`)
- Modify: `lib/client/runner-v2.ts` (`NativeBuildAuditExport.contextManifests`, `NativeBuildObservability.contextManifestCount`), `components/RunnerV2ObservabilityPanel.tsx` (one summary line)
- Test: new `runner-v2/test/context-manifest-store.test.ts`; `runner-v2/test/context-assembler.test.ts`; `runner-v2/test/native-verifier-runtime.test.ts`; `runner-v2/test/native-worker-driver.test.ts`; `runner-v2/test/native-architect-runtime.test.ts`; `runner-v2/test/build-spec-store.test.ts`; `scripts/test-runner-v2-observability.mts`

**Interfaces:**
- Produces: `ContextManifest`, `ContextManifestInput`, `ContextManifestStore`, `contextManifestId(input)`, `recordContextPack(input)` (context-manifest-store.ts); `SqliteContextManifestStore` (sqlite-context-manifest-store.ts). P6.5.5 records critic manifests through the same `recordContextPack`.

- [ ] **Step 1: Write the failing store test**

Create `runner-v2/test/context-manifest-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContextAssembler } from "../src/context-assembler.js";
import { contextManifestId, type ContextManifestInput } from "../src/context-manifest-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";

function manifestInput(overrides: Partial<ContextManifestInput> = {}): ContextManifestInput {
  const pack = new ContextAssembler({ maxBytes: 4_096, maxEstimatedTokens: 1_024 }).assemble([
    { id: "kernel-invariants", kind: "system", required: true, priority: 1000, content: "Use native tools." },
    { id: "instruction:AGENTS.md", kind: "instructions", required: false, priority: 900, content: "Keep it small.", sourceDigest: "d".repeat(64) },
    { id: "evidence:e1", kind: "evidence", required: false, priority: 500, content: "npm test exited 0", artifactHash: "e".repeat(64) },
  ]);
  return {
    runId: "run_manifest",
    sessionId: "worker:T1:1",
    actor: { role: "worker", id: "worker:T1:1" },
    role: "worker",
    purpose: "worker:task",
    taskId: "T1",
    attempt: 1,
    repositoryRevision: "a".repeat(40),
    limits: { maxBytes: 4_096, maxEstimatedTokens: 1_024 },
    pack,
    recordedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

test("manifests are recorded once per identity, listed per run, and readable read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-"));
  const path = join(root, "context-manifests.sqlite");
  const store = new SqliteContextManifestStore(path);
  try {
    const first = store.record(manifestInput());
    const again = store.record(manifestInput({ recordedAt: "2026-09-02T00:00:09.000Z" }));
    assert.equal(again.manifestId, first.manifestId);
    assert.equal(again.recordedAt, first.recordedAt, "a duplicate identity keeps the first record");
    assert.equal(first.manifestId, contextManifestId(manifestInput()));
    assert.equal(first.packDigest, manifestInput().pack.digest);
    assert.deepEqual(first.sections.map((section) => section.id), [
      "kernel-invariants", "instruction:AGENTS.md", "evidence:e1",
    ]);
    assert.equal(first.sections[1]?.sourceDigest, "d".repeat(64));
    assert.equal(first.sections[2]?.artifactHash, "e".repeat(64));
    assert.deepEqual(first.omissions, []);
    store.record(manifestInput({ runId: "run_other", sessionId: "architect:run_other" }));
    assert.equal(store.listRun("run_manifest").length, 1);
    assert.equal(store.get(first.manifestId)?.taskId, "T1");
  } finally {
    store.close();
  }
  const readOnly = new SqliteContextManifestStore(path, { readOnly: true });
  try {
    assert.equal(readOnly.listRun("run_manifest").length, 1);
    assert.throws(() => readOnly.record(manifestInput({ sessionId: "worker:T2:1" })), /read-only/);
  } finally {
    readOnly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test runner-v2/test/context-manifest-store.test.ts`
Expected: FAIL: cannot find module `../src/context-manifest-store.js`.

- [ ] **Step 3: Carry provenance through the assembler (test first)**

In `runner-v2/test/context-assembler.test.ts` add an assertion that an included section with `sourceDigest`/`artifactHash` surfaces both fields on `pack.sections[i]`. Run: FAIL. Then in `runner-v2/src/context-assembler.ts` add `sourceDigest?: string; artifactHash?: string;` to `IncludedContextSection` and spread them in `assemble()`'s `sections` mapping (`...(section.sourceDigest ? { sourceDigest: section.sourceDigest } : {})`, same for `artifactHash`). Run: PASS.

- [ ] **Step 4: Implement the store contract and helper**

Create `runner-v2/src/context-manifest-store.ts`:

```ts
import { createHash } from "node:crypto";

import type { AgentActor } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ModelCallRole } from "./budget-ledger.js";
import type {
  ContextLimits,
  ContextOmission,
  ContextPack,
  IncludedContextSection,
} from "./context-assembler.js";

export type ContextManifestSection = IncludedContextSection;

export interface ContextManifestInput {
  runId: string;
  sessionId: string;
  actor: AgentActor;
  role: ModelCallRole;
  /** Stable purpose label, e.g. "architect:review_required", "worker:task", "verifier:verdict". */
  purpose: string;
  taskId?: string;
  attempt?: number;
  repositoryRevision?: string;
  limits: ContextLimits;
  pack: ContextPack;
  packArtifactHash?: string;
  recordedAt: string;
}

export interface ContextManifest {
  manifestId: string;
  runId: string;
  sessionId: string;
  actor: AgentActor;
  role: ModelCallRole;
  purpose: string;
  taskId?: string;
  attempt?: number;
  repositoryRevision?: string;
  limits: ContextLimits;
  packDigest: string;
  byteLength: number;
  estimatedTokens: number;
  sections: ContextManifestSection[];
  omissions: ContextOmission[];
  packArtifactHash?: string;
  recordedAt: string;
}

export interface ContextManifestStore {
  record(input: ContextManifestInput): ContextManifest;
  get(manifestId: string): ContextManifest | undefined;
  listRun(runId: string): ContextManifest[];
  close(): void;
}

export function contextManifestId(
  input: Pick<ContextManifestInput, "runId" | "sessionId" | "purpose" | "taskId" | "attempt" | "repositoryRevision"> & {
    pack: Pick<ContextPack, "digest">;
  },
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.runId,
      input.sessionId,
      input.purpose,
      input.taskId ?? null,
      input.attempt ?? null,
      input.repositoryRevision ?? null,
      input.pack.digest,
    ]))
    .digest("hex");
}

export function toContextManifest(input: ContextManifestInput): ContextManifest {
  return {
    manifestId: contextManifestId(input),
    runId: input.runId,
    sessionId: input.sessionId,
    actor: { ...input.actor },
    role: input.role,
    purpose: input.purpose,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.repositoryRevision !== undefined ? { repositoryRevision: input.repositoryRevision } : {}),
    limits: { ...input.limits },
    packDigest: input.pack.digest,
    byteLength: input.pack.byteLength,
    estimatedTokens: input.pack.estimatedTokens,
    sections: input.pack.sections.map((section) => ({ ...section })),
    omissions: input.pack.omissions.map((omission) => ({ ...omission })),
    ...(input.packArtifactHash ? { packArtifactHash: input.packArtifactHash } : {}),
    recordedAt: input.recordedAt,
  };
}

export interface RecordContextPackInput extends Omit<ContextManifestInput, "packArtifactHash"> {
  store?: ContextManifestStore;
  artifacts?: ArtifactStore;
  recordPackText?: boolean;
}

/** No-op without a store; stores the rendered text as an artifact only when asked. */
export async function recordContextPack(
  input: RecordContextPackInput,
): Promise<ContextManifest | undefined> {
  const { store, artifacts, recordPackText, ...manifest } = input;
  if (!store) return undefined;
  const packArtifactHash = recordPackText && artifacts
    ? (await artifacts.put(Buffer.from(manifest.pack.text, "utf8"), "text/markdown", "context-pack")).hash
    : undefined;
  return store.record({
    ...manifest,
    ...(packArtifactHash ? { packArtifactHash } : {}),
  });
}
```

Create `runner-v2/src/sqlite-context-manifest-store.ts` following `SqliteToolLedger` exactly (WAL, `mkdirSync` unless read-only, `readOnly` option):

```ts
CREATE TABLE IF NOT EXISTS context_manifests (
  manifest_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_manifests_run ON context_manifests(run_id, recorded_at, manifest_id);
```

`record` builds the manifest with `toContextManifest`, runs `INSERT OR IGNORE`, then returns the row read back by id (so a duplicate identity returns the first record). `get` and `listRun` parse `payload_json`. In read-only mode `record` throws `Error("Context manifest store is read-only.")`.

- [ ] **Step 5: Run the store test to verify it passes**

Run: `npx tsx --test runner-v2/test/context-manifest-store.test.ts runner-v2/test/context-assembler.test.ts`
Expected: PASS.

- [ ] **Step 6: Record manifests in the three runtimes (verifier test first)**

In `runner-v2/test/native-verifier-runtime.test.ts` extend `createFixture` with a `SqliteContextManifestStore` at `join(root, "context-manifests.sqlite")` passed as `contextManifests`, exposed on the fixture, closed in `close()`. Add:

```ts
test("every verifier inspection records one context manifest bound to the exact revision", async () => {
  const fixture = createFixture("manifest", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_manifest"));
    assert.equal(result.status, "inspected");
    const manifests = fixture.contextManifests.listRun("run_manifest");
    assert.equal(manifests.length, 1);
    const manifest = manifests[0]!;
    assert.equal(manifest.role, "verifier");
    assert.equal(manifest.purpose, "verifier:inspection");
    assert.equal(manifest.sessionId, result.sessionId);
    assert.equal(manifest.repositoryRevision, TARGET_REVISION);
    assert.equal(manifest.sections.some((section) => section.id === "build-criteria"), true);
    assert.equal(manifest.packArtifactHash, undefined);
  } finally {
    fixture.close();
  }
});
```

Run: FAIL (`contextManifests` is not a known option). Then add to `NativeVerifierRuntimeOptions`: `contextManifests?: ContextManifestStore; recordContextPackText?: boolean;` and, right after `const context = buildVerifierContext({...})` and the `sessionId` computation in `inspect`, add:

```ts
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: this.options.verdictAuthority ? "verifier:verdict" : "verifier:inspection",
      repositoryRevision: request.targetRevision,
      limits: this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 },
      pack: context,
      recordedAt: this.clock(),
    });
```

Do the same in `native-architect-runtime.ts` (after `const context = await this.context(request, projection)`; `role: "architect"`, `purpose: \`architect:${request.reason.type}\``, `repositoryRevision: projection.integrationRevision`, `taskId` when the reason carries one, `limits` = the same limits object used by `context()`; move that default into a private getter so both sites share it) and in `native-worker-driver.ts` (after `workerContext(...)`; `role: "worker"`, `purpose: "worker:task"`, `taskId: assignment.task.id`, `attempt: assignment.attempt`, `repositoryRevision` parsed from the first line of `repositorySnapshot` via `/^HEAD ([0-9a-f]{40,64})/`; store the snapshot on the context-building result so the driver can read it). Add one assertion in each of `native-architect-runtime.test.ts` and `native-worker-driver.test.ts` mirroring the verifier test (role, purpose, and taskId/attempt for the worker). Run all three: PASS.

- [ ] **Step 7: Spec flag, factory wiring, audit, observability**

- `build-spec.ts`: `contextRecording?: "manifest" | "full";` validated against those two values when present; copied in `cloneBuildSpec`; test in `build-spec-store.test.ts`.
- `native-build-factory.ts`: next to `const ledger = new SqliteToolLedger(...)` create `const contextManifests = new SqliteContextManifestStore(join(runRoot, "context-manifests.sqlite"));`; pass `contextManifests` and `recordContextPackText: spec.contextRecording === "full"` into the Architect runtime, worker driver, and `NativeVerifierRuntime`; close it wherever `ledger.close()` is called (grep). In the historical/read-only path (grep `new SqliteToolLedger(await snapshotStorePath(ledgerPath), { readOnly: true })`), open the manifest store the same way when its file exists.
- Audit export: grep `auditExport` / `NativeBuildAuditExport` producers in `native-build-manager.ts` and `control-server.ts`; add `contextManifests: contextManifests.listRun(runId)` to the exported object and `contextManifests: NativeContextManifest[]` to `NativeBuildAuditExport` in `lib/client/runner-v2.ts` (define `NativeContextManifest` mirroring `ContextManifest`).
- `build-observability.ts`: add `contextManifestCount: number` to `BuildObservabilitySnapshot`, filled from `listRun(runId).length`; client `NativeBuildObservability.contextManifestCount?: number`; panel renders `Context manifests: <n>` in the build control summary; assert it in `scripts/test-runner-v2-observability.mts`.

- [ ] **Step 8: Full-text recording test**

In `runner-v2/test/native-verifier-runtime.test.ts` add a variant with `recordContextPackText: true`: the manifest's `packArtifactHash` is a 64-hex string and `artifacts.get(hash)` returns bytes equal to the pack text sent to the model (`fixture.model.requests[0].messages` user content joined). Run: PASS.

- [ ] **Step 9: Prove red, gates, commit**

Injections: (a) return early from `recordContextPack` before `store.record` (red: manifest count 0 in all three runtime tests); (b) drop `INSERT OR IGNORE` for plain `INSERT` (red: duplicate identity throws). Restore each. Then:

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

```bash
git add runner-v2/src/context-manifest-store.ts runner-v2/src/sqlite-context-manifest-store.ts runner-v2/src/context-assembler.ts runner-v2/src/build-spec.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/native-worker-driver.ts runner-v2/src/native-verifier-runtime.ts runner-v2/src/native-build-factory.ts runner-v2/src/native-build-manager.ts runner-v2/src/control-server.ts runner-v2/src/build-observability.ts lib/client/runner-v2.ts components/RunnerV2ObservabilityPanel.tsx runner-v2/test/context-manifest-store.test.ts runner-v2/test/context-assembler.test.ts runner-v2/test/native-verifier-runtime.test.ts runner-v2/test/native-worker-driver.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/build-spec-store.test.ts scripts/test-runner-v2-observability.mts
git commit -m "feat(runner-v2): record a durable context manifest per model call (RG-5)"
```

**Acceptance criteria (P6.5.4):**
- Every Architect action, worker attempt, and verifier inspection records exactly one manifest per distinct pack digest, with section ids, digests, provenance, omissions, limits, and revision.
- Recording is idempotent by identity and survives restart (SQLite WAL, read-only reopen for historical runs).
- `contextRecording: "full"` stores the rendered pack text as an artifact whose hash is on the manifest; the default stores digests only.
- Audit export includes the run's manifests; observability shows the count.
- A missing store is a no-op (tests and legacy fixtures without the store keep passing).

**Prove-red injections:** as in Step 9 plus: corrupt `payload_json` of one row and prove `listRun` throws a typed parse error rather than returning a partial list.

**Cleanup and rollback:** the manifest database lives under the run's state root and follows the run's existing cleanup/compaction rules; whole-packet revert leaves orphan files that older runners ignore.

---

### Task P6.5.5a: RG-1 — Plan critique contracts, events, and reducer

**Purpose:** Establish the durable vocabulary of the plan critique before any model touches it: a deterministic plan-time risk, a typed finding, a typed resolution, and reducer rules that bind all of it to one plan revision and one critic identity. Nothing in this packet calls a model.

**Files:**
- Create: `runner-v2/src/plan-critique-contracts.ts`
- Modify: `runner-v2/src/build-spec.ts` (`planCritique?: PlanCritiqueMode`)
- Modify: `runner-v2/src/verifier-contracts.ts` (export `parseExcludedModels` and `parseRuntimeBinding`)
- Modify: `runner-v2/src/scheduler-store.ts` (six events, `planRiskDeclaration`, `planCritique` state, `planCritiquePending`)
- Modify: `runner-v2/src/task-scheduler.ts` (`tick()` waits while a critique is pending)
- Modify: `runner-v2/src/architect-tools.ts` (`plan_tasks` optional `riskDeclaration`)
- Test: new `runner-v2/test/plan-critique-contracts.test.ts`, new `runner-v2/test/plan-critique.test.ts`; `runner-v2/test/build-spec-store.test.ts`; `runner-v2/test/task-scheduler.test.ts`

**Interfaces:**
- Produces: everything exported from `plan-critique-contracts.ts` (below), `SchedulerProjection.planRiskDeclaration`, `SchedulerProjection.planCritique`, `planCritiquePending(projection)`, event types `plan_critique.policy_configured | plan_critique.risk_assessed | plan_critique.requested | plan_critique.submitted | plan_critique.resolved | plan_critique.skipped`.
- Consumes: `VerifierRuntimeBinding`, `VerifierExcludedModel`, `parseExcludedModels`, `parseRuntimeBinding`, `canonicalModelIdentity` (verifier-contracts), `applyPlanReconciliation`, `parsePlanReconciliation` (scheduler-store).

- [ ] **Step 1: Write the failing contract tests**

Create `runner-v2/test/plan-critique-contracts.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPlanRisk,
  parsePlanCritiqueFindings,
  planCritiqueRequired,
  PLAN_CRITIQUE_TASK_COUNT_THRESHOLD,
} from "../src/plan-critique-contracts.js";
import type { BuildTask } from "../src/task-contracts.js";

function task(id: string, dependencies: string[] = []): BuildTask {
  return {
    id, objective: `Do ${id}`, dependencies, status: "planned", requiredCapabilities: ["code"], attempt: 0,
    acceptanceCriteria: [{ id: "AC-1", text: `${id} works.` }], acceptanceCriteriaVersion: 1,
  };
}

test("plan risk is high on Architect declaration, strict qualification, task count, or dependency fan-in", () => {
  const low = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false, tasks: [task("A"), task("B"), task("C", ["A"])],
  });
  assert.deepEqual(low, { risk: "low", reasons: [] });
  assert.equal(PLAN_CRITIQUE_TASK_COUNT_THRESHOLD, 4);
  const count = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false,
    tasks: [task("A"), task("B"), task("C"), task("D")],
  });
  assert.deepEqual(count.reasons, [{ code: "task_count", evidence: ["tasks:4"] }]);
  const fanIn = assessPlanRisk({
    architectDeclaration: "low", stricterQualification: false,
    tasks: [task("A"), task("B"), task("C", ["A", "B"])],
  });
  assert.deepEqual(fanIn.reasons, [{ code: "dependency_fan_in", evidence: ["C:2"] }]);
  const declared = assessPlanRisk({ architectDeclaration: "high", stricterQualification: true, tasks: [task("A")] });
  assert.deepEqual(declared.reasons.map((reason) => reason.code), ["architect_declared_high", "stricter_qualification"]);
  assert.equal(planCritiqueRequired("risk_based", low), false);
  assert.equal(planCritiqueRequired("risk_based", count), true);
  assert.equal(planCritiqueRequired("always", low), true);
  assert.equal(planCritiqueRequired("off", declared), false);
});

test("findings are validated against the current plan", () => {
  const tasks = { A: task("A"), B: task("B") };
  const valid = parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "untestable_criterion",
    taskIds: ["A"], criterionIds: [{ taskId: "A", criterionId: "AC-1" }],
    claim: "AC-1 has no observable behavior to test.", evidence: ["A/AC-1: 'A works.'"],
  }, {
    findingId: "F-2", severity: "advisory", category: "missing_integration_task", taskIds: [],
    claim: "No task integrates A and B.", evidence: ["task graph has no task depending on both A and B"],
  }], tasks);
  assert.equal(valid.length, 2);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["Z"], claim: "x", evidence: ["y"],
  }], tasks), /references unknown task Z/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: [],
  }], tasks), /requires at least one evidence string/);
  assert.throws(() => parsePlanCritiqueFindings([
    { findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: ["y"] },
    { findingId: "F-1", severity: "advisory", category: "oversized_task", taskIds: ["B"], claim: "x", evidence: ["y"] },
  ], tasks), /duplicate finding F-1/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "fatal", category: "overlapping_scope", taskIds: ["A"], claim: "x", evidence: ["y"],
  }], tasks), /severity fatal is invalid/);
  assert.throws(() => parsePlanCritiqueFindings([{
    findingId: "F-1", severity: "blocking", category: "style", taskIds: ["A"], claim: "x", evidence: ["y"],
  }], tasks), /category style is invalid/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test runner-v2/test/plan-critique-contracts.test.ts`
Expected: FAIL: cannot find module `../src/plan-critique-contracts.js`.

- [ ] **Step 3: Implement the contracts**

Create `runner-v2/src/plan-critique-contracts.ts`:

```ts
import type { BuildTask } from "./task-contracts.js";
import { isFinalVerificationTask } from "./task-contracts.js";
import type {
  VerifierExcludedModel,
  VerifierRuntimeBinding,
} from "./verifier-contracts.js";

export type PlanCritiqueMode = "risk_based" | "always" | "off";
export const PLAN_CRITIQUE_MODES: readonly PlanCritiqueMode[] = ["risk_based", "always", "off"];
export const PLAN_CRITIQUE_TASK_COUNT_THRESHOLD = 4;
export const PLAN_CRITIQUE_FAN_IN_THRESHOLD = 2;
export const PLAN_CRITIQUE_MAX_FINDINGS = 50;

export type PlanRiskLevel = "low" | "high";
export type PlanRiskReasonCode =
  | "architect_declared_high"
  | "stricter_qualification"
  | "task_count"
  | "dependency_fan_in";

export interface PlanRiskReason {
  code: PlanRiskReasonCode;
  evidence: string[];
}

export interface PlanRiskAssessment {
  risk: PlanRiskLevel;
  reasons: PlanRiskReason[];
}

export interface PlanRiskInput {
  architectDeclaration: PlanRiskLevel;
  stricterQualification: boolean;
  tasks: readonly Pick<BuildTask, "id" | "dependencies" | "status" | "kind">[];
}

export function assessPlanRisk(input: PlanRiskInput): PlanRiskAssessment {
  const reasons: PlanRiskReason[] = [];
  if (input.architectDeclaration === "high") {
    reasons.push({ code: "architect_declared_high", evidence: ["architect:high"] });
  }
  if (input.stricterQualification) {
    reasons.push({ code: "stricter_qualification", evidence: ["qualification:strict"] });
  }
  const live = input.tasks.filter(
    (task) => task.status !== "cancelled" && task.kind !== "final_verification",
  );
  if (live.length >= PLAN_CRITIQUE_TASK_COUNT_THRESHOLD) {
    reasons.push({ code: "task_count", evidence: [`tasks:${live.length}`] });
  }
  const fanIn = live
    .filter((task) => new Set(task.dependencies).size >= PLAN_CRITIQUE_FAN_IN_THRESHOLD)
    .map((task) => `${task.id}:${new Set(task.dependencies).size}`)
    .sort();
  if (fanIn.length > 0) reasons.push({ code: "dependency_fan_in", evidence: fanIn });
  return { risk: reasons.length > 0 ? "high" : "low", reasons };
}

export function planCritiqueRequired(
  mode: PlanCritiqueMode,
  assessment: PlanRiskAssessment,
): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return assessment.risk === "high";
}

export type PlanCritiqueSeverity = "blocking" | "advisory";
export const PLAN_CRITIQUE_CATEGORIES = [
  "ambiguous_criterion",
  "untestable_criterion",
  "missing_dependency",
  "overlapping_scope",
  "missing_failure_mode",
  "unproven_assumption",
  "oversized_task",
  "missing_integration_task",
] as const;
export type PlanCritiqueCategory = (typeof PLAN_CRITIQUE_CATEGORIES)[number];

export interface PlanCritiqueFinding {
  findingId: string;
  severity: PlanCritiqueSeverity;
  category: PlanCritiqueCategory;
  taskIds: string[];
  criterionIds?: Array<{ taskId: string; criterionId: string }>;
  claim: string;
  evidence: string[];
}

export interface PlanCritiqueResolutionItem {
  findingId: string;
  resolution: "plan_reconciled" | "rejected";
  rationale: string;
}

export interface PlanCritiqueProjection {
  critiqueId: string;
  planRevision: number;
  runtime: VerifierRuntimeBinding;
  excludedModels: VerifierExcludedModel[];
  status: "requested" | "submitted" | "resolved";
  requestedAt: string;
  submittedAt?: string;
  resolvedAt?: string;
  findings?: PlanCritiqueFinding[];
  blockingFindingIds?: string[];
  resolution?: {
    planRevisionAfter: number;
    resolvedBy: "architect" | "runner";
    resolutions: PlanCritiqueResolutionItem[];
  };
  supersededByCritiqueId?: string;
}

export interface PlanCritiqueState {
  policy?: { mode: PlanCritiqueMode };
  risk?: {
    planRevision: number;
    architectDeclaration: PlanRiskLevel;
    stricterQualification: boolean;
    assessment: PlanRiskAssessment;
    assessedAt: string;
  };
  current?: PlanCritiqueProjection;
  history: PlanCritiqueProjection[];
  skipped?: { planRevision: number; reason: PlanCritiqueSkipReason; skippedAt: string };
}

export type PlanCritiqueSkipReason = "policy_off" | "low_plan_risk" | "critic_failed" | "plan_only";

export function parsePlanCritiqueFindings(
  value: unknown,
  tasks: Readonly<Record<string, BuildTask>>,
): PlanCritiqueFinding[] {
  if (!Array.isArray(value)) throw new Error("Plan critique findings must be an array.");
  if (value.length > PLAN_CRITIQUE_MAX_FINDINGS) {
    throw new Error(`Plan critique allows at most ${PLAN_CRITIQUE_MAX_FINDINGS} findings.`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Plan critique finding ${index} is invalid.`);
    }
    const record = candidate as Record<string, unknown>;
    const findingId = requiredText(record, "findingId");
    if (seen.has(findingId)) throw new Error(`Plan critique has a duplicate finding ${findingId}.`);
    seen.add(findingId);
    const severity = requiredText(record, "severity");
    if (severity !== "blocking" && severity !== "advisory") {
      throw new Error(`Plan critique finding ${findingId} severity ${severity} is invalid.`);
    }
    const category = requiredText(record, "category");
    if (!(PLAN_CRITIQUE_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Plan critique finding ${findingId} category ${category} is invalid.`);
    }
    const taskIds = textArray(record, "taskIds", findingId, 0);
    for (const taskId of taskIds) {
      const task = tasks[taskId];
      if (!task || task.status === "cancelled" || isFinalVerificationTask(task)) {
        throw new Error(`Plan critique finding ${findingId} references unknown task ${taskId}.`);
      }
    }
    const criterionIds = record.criterionIds === undefined
      ? undefined
      : parseCriterionRefs(record.criterionIds, findingId, tasks);
    const evidence = textArray(record, "evidence", findingId, 1);
    return {
      findingId,
      severity,
      category: category as PlanCritiqueCategory,
      taskIds: [...new Set(taskIds)],
      ...(criterionIds ? { criterionIds } : {}),
      claim: requiredText(record, "claim"),
      evidence,
    };
  });
}

function parseCriterionRefs(
  value: unknown,
  findingId: string,
  tasks: Readonly<Record<string, BuildTask>>,
): Array<{ taskId: string; criterionId: string }> {
  if (!Array.isArray(value)) throw new Error(`Plan critique finding ${findingId} criterionIds is invalid.`);
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Plan critique finding ${findingId} criterion reference is invalid.`);
    }
    const record = candidate as Record<string, unknown>;
    const taskId = requiredText(record, "taskId");
    const criterionId = requiredText(record, "criterionId");
    const known = tasks[taskId]?.acceptanceCriteria?.some((criterion) => criterion.id === criterionId);
    if (!known) {
      throw new Error(`Plan critique finding ${findingId} references unknown criterion ${taskId}:${criterionId}.`);
    }
    return { taskId, criterionId };
  });
}

function textArray(record: Record<string, unknown>, key: string, findingId: string, min: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Plan critique finding ${findingId} ${key} must contain non-empty strings.`);
  }
  if (value.length < min) {
    throw new Error(`Plan critique finding ${findingId} requires at least one ${key === "evidence" ? "evidence string" : key}.`);
  }
  return [...(value as string[])];
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}
```

Adjust the two test regexes above to the exact messages produced (`requires at least one evidence string`, `references unknown task Z`).

- [ ] **Step 4: Run the contract tests to verify they pass**

Run: `npx tsx --test runner-v2/test/plan-critique-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing reducer tests**

Create `runner-v2/test/plan-critique.test.ts` with a seeded `SqliteSchedulerStore` (as in `request-replan.test.ts`: `run.initialized`, then `plan.created` revision 1 with five planned tasks `A`–`E`, each with one criterion, `E` depending on `A` and `B`, and `riskDeclaration: { risk: "low", rationale: "routine" }`). Helper `binding(runtimeId, modelId, sessionId)` returns a `VerifierRuntimeBinding` with `providerId: "google"`, `modelIdentity: modelId`. Tests:

```ts
test("plan risk is recorded once, recomputed by the kernel, and gates the scheduler", () => {
  // policy
  assert.throws(() => append("plan_critique.policy_configured", "critique-policy:user", { mode: "always" }, USER), /Only the runner may configure plan critique policy/);
  append("plan_critique.policy_configured", "critique-policy", { mode: "risk_based" });
  assert.equal(planCritiquePending(projection()), true, "no risk yet blocks workers");
  // risk must match the kernel recomputation
  assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:bad", {
    planRevision: 1, architectDeclaration: "low", stricterQualification: false,
    assessment: { risk: "low", reasons: [] },
  }), /conflicts with the kernel recomputation/);
  append("plan_critique.risk_assessed", "critique-risk", {
    planRevision: 1, architectDeclaration: "low", stricterQualification: false,
    assessment: assessPlanRisk({ architectDeclaration: "low", stricterQualification: false, tasks: Object.values(projection().tasks) }),
  });
  assert.deepEqual(projection().planCritique?.risk?.assessment.reasons.map((r) => r.code), ["task_count", "dependency_fan_in"]);
  assert.equal(planCritiquePending(projection()), true, "high risk without a resolved critique blocks workers");
});

test("a critique is requested for the current plan by an independent runtime, submitted by that runtime, and resolved by the Architect", () => {
  // ...policy + risk as above...
  assert.throws(() => append("plan_critique.requested", "critique:not-independent", {
    critiqueId: "critique-1", planRevision: 1,
    runtime: binding("openai:architect", "architect", "plan-critic:s1"),
    excludedModels: [{ source: "architect", runtimeId: "openai:architect", modelIdentity: "architect" }],
  }), /not independent from the Architect/);
  append("plan_critique.requested", "critique:1", {
    critiqueId: "critique-1", planRevision: 1,
    runtime: binding("google:verifier", "verifier", "plan-critic:s1"),
    excludedModels: [{ source: "architect", runtimeId: "openai:architect", modelIdentity: "architect" }],
  });
  assert.throws(() => append("plan_critique.submitted", "critique:1:foreign", {
    critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
  }, { role: "verifier", id: "fallback:verifier" }), /does not match the selected critic runtime/);
  append("plan_critique.submitted", "critique:1:submitted", {
    critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
    findings: [
      { findingId: "F-1", severity: "blocking", category: "overlapping_scope", taskIds: ["A", "B"], claim: "A and B both own src/cache.ts.", evidence: ["A objective mentions src/cache.ts", "B objective mentions src/cache.ts"] },
      { findingId: "F-2", severity: "advisory", category: "missing_failure_mode", taskIds: ["E"], claim: "E ignores empty input.", evidence: ["E criteria never mention empty input"] },
    ],
  }, { role: "verifier", id: "google:verifier" });
  assert.deepEqual(projection().planCritique?.current?.blockingFindingIds, ["F-1"]);
  assert.equal(planCritiquePending(projection()), true);
  // runner may not auto-resolve while blocking findings exist
  assert.throws(() => append("plan_critique.resolved", "critique:1:auto", {
    critiqueId: "critique-1", planRevision: 1, resolutions: [],
  }), /blocking findings require an Architect resolution/);
  // every blocking finding needs exactly one resolution; plan_reconciled needs a reconciliation touching its tasks
  assert.throws(() => append("plan_critique.resolved", "critique:1:partial", {
    critiqueId: "critique-1", planRevision: 1, resolutions: [],
  }, ARCHITECT), /blocking finding F-1 has no resolution/);
  assert.throws(() => append("plan_critique.resolved", "critique:1:no-recon", {
    critiqueId: "critique-1", planRevision: 1,
    resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "merge A and B" }],
  }, ARCHITECT), /plan_reconciled resolutions require a planReconciliation/);
  append("plan_critique.resolved", "critique:1:resolved", {
    critiqueId: "critique-1", planRevision: 1,
    resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "B is folded into A." }],
    planReconciliation: { revision: 2, summary: "Fold B into A.", taskUpdates: [{ taskId: "B", action: "cancel" }] },
  }, ARCHITECT);
  const resolved = projection();
  assert.equal(resolved.planRevision, 2);
  assert.equal(resolved.tasks.B.status, "cancelled");
  assert.equal(resolved.planCritique?.current?.status, "resolved");
  assert.equal(resolved.planCritique?.current?.resolution?.resolvedBy, "architect");
  assert.equal(planCritiquePending(resolved), false);
  // one round only
  assert.throws(() => append("plan_critique.requested", "critique:2", {
    critiqueId: "critique-2", planRevision: 2,
    runtime: binding("google:verifier", "verifier", "plan-critic:s2"),
    excludedModels: [{ source: "architect", runtimeId: "openai:architect", modelIdentity: "architect" }],
  }), /already resolved for this run/);
});

test("a critique with no blocking findings is auto-resolved by the runner, and skips are durable", () => {
  // policy + risk + request, then submit findings: [] (or advisory only)
  append("plan_critique.resolved", "critique:1:auto", { critiqueId: "critique-1", planRevision: 1, resolutions: [] });
  assert.equal(projection().planCritique?.current?.resolution?.resolvedBy, "runner");
  // skip on a fresh store: policy off
  append("plan_critique.skipped", "critique:skipped", { planRevision: 1, reason: "low_plan_risk" });
  assert.equal(planCritiquePending(projection()), false);
});

test("workers cannot start before the critique is resolved", async () => {
  // policy + risk (high) with no critique; TaskScheduler.tick() must dispatch nothing
});
```

Write each test fully with the seeded store (the sketches above show the assertions and messages the reducer must produce). `USER` and `ARCHITECT` are actor constants.

- [ ] **Step 6: Run the reducer tests to verify they fail**

Run: `npx tsx --test runner-v2/test/plan-critique.test.ts`
Expected: FAIL: unknown event type / `planCritiquePending` not exported.

- [ ] **Step 7: Implement the reducer**

In `runner-v2/src/verifier-contracts.ts` add `export` to `parseExcludedModels` and `parseRuntimeBinding`.

In `runner-v2/src/scheduler-store.ts`:

1. Event types: add the six `plan_critique.*` names.
2. Projection fields: `planRiskDeclaration?: { risk: PlanRiskLevel; rationale?: string; source: "architect" | "legacy_default" }` and `planCritique?: PlanCritiqueState` (clone in the projection cloner).
3. In `plan.created`: read optional `riskDeclaration` (`risk` must be `low`/`high`, `rationale` non-empty when present); set `next.planRiskDeclaration = { risk, rationale, source: "architect" }` or `{ risk: "low", source: "legacy_default" }` when absent.
4. Reducer cases, each guarded by actor role exactly as named in the tests:
   - `plan_critique.policy_configured` (runner): `mode` in `PLAN_CRITIQUE_MODES`; conflict when already configured differently; sets `planCritique = { policy: { mode }, history: [] }`.
   - `plan_critique.risk_assessed` (runner): requires policy; `planRevision === current.planRevision`; `architectDeclaration === (current.planRiskDeclaration?.risk ?? "low")`; `stricterQualification === (current.verifierPolicy?.alwaysRequireIndependentVerifier ?? false)`; `assessment` must `sameValue` the kernel `assessPlanRisk` over `Object.values(current.tasks)`; else throw `Plan risk assessment conflicts with the kernel recomputation.`; one risk per run (throw if already present with a different planRevision).
   - `plan_critique.skipped` (runner): requires policy; reason in `PlanCritiqueSkipReason`; forbidden when a current critique is `submitted` or `resolved`.
   - `plan_critique.requested` (runner): requires policy and risk; `planRevision === current.planRevision`; every non-cancelled ordinary task still `planned` with `attempt === 0` (else `Plan critique cannot start after a worker was dispatched.`); `runtime = parseRuntimeBinding(payload.runtime)`; `excludedModels = parseExcludedModels(payload.excludedModels)`; throw `Plan critic model is not independent from the Architect.` when its identity is excluded; throw `Plan critique is already resolved for this run.` when a resolved critique exists; a pending `requested` critique may be superseded (payload `supersedesCritiqueId` must name it) and moves to history with `supersededByCritiqueId`.
   - `plan_critique.submitted` (verifier actor whose `id === current.runtime.runtimeId`, else `Plan critique submission does not match the selected critic runtime.`): `critiqueId`, `planRevision`, and `sessionId` must match; `findings = parsePlanCritiqueFindings(payload.findings, current.tasks)`; sets status `submitted`, `findings`, `blockingFindingIds`, `submittedAt`; identical resubmission is idempotent, a conflicting one throws.
   - `plan_critique.resolved` (architect, or runner only when `blockingFindingIds.length === 0`, else `Plan critique blocking findings require an Architect resolution.`): current must be `submitted` with matching ids; `resolutions` must cover every blocking finding exactly once (`Plan critique blocking finding F-1 has no resolution.` / duplicate / unknown finding); each `rejected` needs a non-empty rationale; if any `plan_reconciled`: `planReconciliation` required (`Plan critique plan_reconciled resolutions require a planReconciliation.`), parsed with `parsePlanReconciliation`, revision must be `current.planRevision + 1`, and for each `plan_reconciled` finding with non-empty `taskIds` at least one of them must appear in `taskUpdates`; apply with `applyPlanReconciliation`; set status `resolved`, `resolution: { planRevisionAfter: next.planRevision, resolvedBy, resolutions }`, `resolvedAt`.
5. Export:

```ts
export function planCritiquePending(projection: SchedulerProjection): boolean {
  const state = projection.planCritique;
  if (!state?.policy || state.policy.mode === "off") return false;
  if (state.skipped) return false;
  if (!state.risk) return true;
  if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return false;
  return state.current?.status !== "resolved";
}
```

In `runner-v2/src/task-scheduler.ts` `tick()`, after the acceptance-contract early return, add `if (planCritiquePending(projection)) return;`.

In `runner-v2/src/architect-tools.ts` `planTasksTool`: optional `riskDeclaration: objectSchema({ risk: { enum: ["low", "high"] }, rationale: { type: "string", minLength: 1 } }, ["risk", "rationale"])` passed through to the `plan.created` payload.

In `runner-v2/src/build-spec.ts`: `planCritique?: PlanCritiqueMode` validated against `PLAN_CRITIQUE_MODES`, cloned; test in `build-spec-store.test.ts`.

- [ ] **Step 8: Run the tests to verify they pass, then commit**

Run: `npx tsx --test runner-v2/test/plan-critique.test.ts runner-v2/test/plan-critique-contracts.test.ts runner-v2/test/scheduler-store.test.ts runner-v2/test/task-scheduler.test.ts runner-v2/test/build-spec-store.test.ts`
Expected: PASS. Then `npm run typecheck:runner-v2` and `npm run test:runner-v2`.

Prove-red injections: drop the independence check on `plan_critique.requested`; allow the runner to resolve blocking findings; skip the `planCritiquePending` early return in `tick()`. Each must turn its test red; restore.

```bash
git add runner-v2/src/plan-critique-contracts.ts runner-v2/src/verifier-contracts.ts runner-v2/src/scheduler-store.ts runner-v2/src/task-scheduler.ts runner-v2/src/architect-tools.ts runner-v2/src/build-spec.ts runner-v2/test/plan-critique-contracts.test.ts runner-v2/test/plan-critique.test.ts runner-v2/test/build-spec-store.test.ts runner-v2/test/task-scheduler.test.ts
git commit -m "feat(runner-v2): plan critique contracts, events, and reducer (RG-1.1, RG-1.3)"
```

---

### Task P6.5.5b: RG-1 — Independent plan critic runtime

**Purpose:** Run one independent model over the task graph at the baseline revision with read-only tools and a typed `submit_plan_critique` lifecycle tool. This is the verifier runtime's shape applied before implementation: same selection rule, same session/budget/workspace machinery, no diff to see because nothing has been built yet.

**Files:**
- Create: `runner-v2/src/plan-critique-authority.ts`
- Create: `runner-v2/src/plan-critique-tools.ts`
- Create: `runner-v2/src/native-plan-critic-runtime.ts`
- Modify: `runner-v2/src/native-verifier-runtime.ts` (export `createInspectionTools`, `verifierExcludedModels`)
- Modify: `runner-v2/src/agent-contracts.ts`, `runner-v2/src/agent-loop.ts` (`plan_critique_submitted` lifecycle signal and result)
- Modify: `runner-v2/src/agent-prompts.ts` (`PLAN_CRITIC_INVARIANTS`, `buildPlanCritiqueContext`)
- Test: new `runner-v2/test/native-plan-critic-runtime.test.ts`; `runner-v2/test/agent-loop.test.ts`

**Interfaces:**
- Produces: `PlanCritiqueAuthority` (`requestCritique`, `currentCritique`, `submitFindings`), `SchedulerPlanCritiqueAuthority`, `createSubmitPlanCritiqueTool`, `NativePlanCriticRuntime.critique(request)`, `NativePlanCritiqueRequest`, `NativePlanCritiqueResult`, `buildPlanCritiqueContext`.
- Consumes: P6.5.5a contracts and events; `createInspectionTools` and `verifierExcludedModels` from the verifier runtime; `recordContextPack` from P6.5.4.

- [ ] **Step 1: Lifecycle signal (test first)**

In `runner-v2/test/agent-loop.test.ts` add a test where a scripted model calls a registered lifecycle tool whose output carries `lifecycle: { type: "plan_critique_submitted", critiqueId: "critique-1", blockingFindingCount: 1 }`; assert the loop returns `{ status: "plan_critique_submitted", critiqueId: "critique-1", blockingFindingCount: 1, turns: 1 }`. Run: FAIL (type error / unexpected status). Then add the signal variant to `AgentLifecycleSignal` in `agent-contracts.ts`, the result variant to `AgentLoopResult`, and the case in `lifecycleResult` in `agent-loop.ts`. Run: PASS.

- [ ] **Step 2: Authority**

Create `runner-v2/src/plan-critique-authority.ts` mirroring `SchedulerVerifierVerdictAuthority`:

```ts
export interface RequestPlanCritiqueInput {
  runId: string; critiqueId: string; planRevision: number;
  runtime: VerifierRuntimeBinding; excludedModels: VerifierExcludedModel[]; occurredAt: string;
}
export interface SubmitPlanCritiqueInput {
  runId: string; critiqueId: string; planRevision: number; sessionId: string;
  actor: AgentActor & { role: "verifier" }; findings: PlanCritiqueFinding[]; occurredAt: string;
}
export interface PlanCritiqueAuthority {
  requestCritique(input: RequestPlanCritiqueInput): PlanCritiqueProjection;
  currentCritique(runId: string): PlanCritiqueProjection | undefined;
  submitFindings(input: SubmitPlanCritiqueInput): PlanCritiqueProjection;
}
```

`SchedulerPlanCritiqueAuthority(store, runnerId = "native-plan-critic-runtime")` appends `plan_critique.requested` (idempotency `plan-critique:request:${critiqueId}`, with `supersedesCritiqueId` when a different `requested` critique is current) and `plan_critique.submitted` (idempotency `plan-critique:submit:${critiqueId}`), each followed by a read-back assertion exactly like the verifier authority.

- [ ] **Step 3: Tool**

Create `runner-v2/src/plan-critique-tools.ts` with `createSubmitPlanCritiqueTool({ authority, runId, critiqueId, planRevision, runtimeId, sessionId, tasks, clock })`: definition `name: "submit_plan_critique"`, description `Submit the typed plan critique: zero or more findings, each with severity, category, task/criterion references, a claim, and evidence. Blocking findings force one Architect resolution; this tool grants no plan authority.`; input schema `{ findings: array of { findingId, severity enum, category enum, taskIds string[], criterionIds? [{taskId, criterionId}], claim, evidence string[] minItems 1 }, additionalProperties: false }`; `readOnly: true`, `effect: "none"`, `lifecycle: true`; `validate` runs `parsePlanCritiqueFindings(record.findings, tasks)`; `assessAccess` capability `plan_critique.submit`; `execute` asserts the bound context (same check as `assertBoundContext` in `verifier-tools.ts`) then calls `authority.submitFindings` and returns `lifecycle: { type: "plan_critique_submitted", critiqueId, blockingFindingCount }`.

- [ ] **Step 4: Prompt and context**

In `runner-v2/src/agent-prompts.ts` add:

```ts
export const PLAN_CRITIC_INVARIANTS = [
  "You are an independent AIBoard plan critic inspecting one task graph before any worker starts.",
  "The repository you can read is the exact baseline revision; nothing has been implemented yet.",
  "Assume the plan contains at least one defect. For every task ask: is each criterion objectively testable; do tasks overlap in file ownership; are dependencies complete and acyclic in meaning, not just in graph shape; which failure modes are omitted; which assumptions about the repository are unproven (check them with the read-only tools); is any task too large for one worker; can each task be verified independently; is integration explicitly owned by a task.",
  "A blocking finding must cite concrete evidence: a criterion text, a file path, a symbol, or a dependency pair. Advisory findings record concerns that do not stop implementation.",
  "You have no authority to edit files, change the plan, assign work, or complete the run. Finish by calling submit_plan_critique exactly once.",
].join("\n");

export interface BuildPlanCritiqueContextInput {
  limits: ContextLimits;
  objective: string;
  planRevision: number;
  baselineRevision: string;
  tasks: readonly unknown[];
  riskReasons: readonly unknown[];
  guidance: readonly unknown[];
}

export function buildPlanCritiqueContext(input: BuildPlanCritiqueContextInput): ContextPack {
  return new ContextAssembler(input.limits).assemble([
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("critic-authority", "system", PLAN_CRITIC_INVARIANTS),
    required("build-objective", "user-intent", input.objective),
    required("baseline-revision", "revision", `${input.baselineRevision} (plan revision ${input.planRevision})`),
    required("task-graph", "task-graph", JSON.stringify(input.tasks, null, 2)),
    required("risk-reasons", "risk", JSON.stringify(input.riskReasons, null, 2)),
    required("durable-guidance", "guidance", JSON.stringify(input.guidance, null, 2)),
  ]);
}
```

`tasks` is the projection's non-cancelled ordinary tasks reduced to `{ id, objective, dependencies, requiredCapabilities, acceptanceCriteria }`.

- [ ] **Step 5: Runtime (test first)**

Create `runner-v2/test/native-plan-critic-runtime.test.ts` by copying the fixture pattern of `native-verifier-runtime.test.ts` (`ScriptedModel`, workspace stub, `RuntimeRouter`, `FakePlanCritiqueAuthority` mirroring `FakeVerifierVerdictAuthority`). Tests:
1. `critic receives the task graph at the baseline revision with read-only tools plus submit_plan_critique`: assert every non-lifecycle tool is `readOnly && effect === "none"`, `submit_plan_critique` is present, `fs.write`/`plan_tasks`/`review_task`/`submit_verifier_verdict` are absent, the user context contains each task id and criterion text and the baseline revision, and contains neither `accepted-change-history` nor `final-verification`; `workspaceRequests` equals `[BASELINE_REVISION]`.
2. `critic submits typed findings once and the result is durable`: scripted `submit_plan_critique` call → `result.status === "submitted"`, `authority.submissions.length === 1`, `result.findings[0].findingId === "F-1"`, the session is `completed`.
3. `critic is unavailable when every candidate shares the Architect model identity`: `status: "unavailable", reason: "no_independent_healthy_capability_match"`, no model calls.
4. `a durably submitted critique replays without another model call`: `authority.afterRequest` returns a submitted critique → `replayed: true`, zero requests.
5. `critic model calls are attributed to the verifier budget role`: with a budget ledger, reservations carry `role: "verifier"` and a `plan-critic:` session id.

Run: FAIL (module missing). Then create `runner-v2/src/native-plan-critic-runtime.ts`:

```ts
export interface NativePlanCritiqueRequest {
  readonly runId: string;
  readonly objective: string;
  readonly planRevision: number;
  readonly baselineRevision: string;
  readonly architectRuntimeId: string;
  readonly tasks: readonly BuildTask[];
  readonly riskReasons: readonly PlanRiskReason[];
  readonly guidance: readonly VerifierGuidanceSnapshot[];
  readonly preferredRuntimeId?: string;
  readonly providerRetryDeadlineMs?: number;
  readonly signal?: AbortSignal;
}

export type NativePlanCritiqueResult =
  | { status: "submitted"; critiqueId: string; sessionId: string; runtimeId: string; findings: PlanCritiqueFinding[]; replayed: boolean }
  | { status: "unavailable"; reason: "no_independent_healthy_capability_match" | "runtime_unavailable"; runtimeId?: string }
  | { status: "suspended"; sessionId: string; runtimeId: string; reason: string; error?: string };

export interface NativePlanCriticRuntimeOptions {
  router: RuntimeRouter;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  verifierRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  workspaceManager: VerifierWorkspaceProvider;
  critiqueAuthority: PlanCritiqueAuthority;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  maxTurns?: number;
  clock?: () => string;
}
```

`NativePlanCriticRuntime.critique(request)` follows `NativeVerifierRuntime.inspect` step for step with these substitutions: selection uses `acceptedChangeAuthorRuntimeIds: []`; the workspace is `workspaceManager.create(request.baselineRevision)`; the context is `buildPlanCritiqueContext`; the session id is `plan-critic:${runId}:${sha256(runId, planRevision, runtimeId, contextDigest).slice(0, 24)}`; the critique id is `plan-critique:${sha256(runId, planRevision, sessionId)}`; `critiqueAuthority.requestCritique` replaces `requestReview` (bind-check mirrors `assertBoundVerifierReview` on critiqueId, planRevision, runtime, excluded models); a current `submitted` critique returns `replayed: true` without a model call; tools come from the exported `createInspectionTools` (evidence tools excluded since no evidence exists yet: pass an `evidenceStore` stub or make that parameter optional) plus `createSubmitPlanCritiqueTool`; the loop result `plan_critique_submitted` is verified durable through `currentCritique` before `sessions.complete`; every other result maps to `suspended`/`unavailable` exactly as in the verifier. Record the context manifest with `purpose: "critic:plan_critique"`, `role: "verifier"`, `repositoryRevision: request.baselineRevision`. Export `createInspectionTools` and `verifierExcludedModels` from `native-verifier-runtime.ts` (rename nothing).

- [ ] **Step 6: Run, prove red, commit**

Run: `npx tsx --test runner-v2/test/native-plan-critic-runtime.test.ts runner-v2/test/native-verifier-runtime.test.ts runner-v2/test/agent-loop.test.ts` — Expected: PASS. Prove-red: register `fs.write` in the critic broker (red on test 1); skip the durable read-back after the lifecycle result (red on test 2). Restore. Then `npm run typecheck:runner-v2` and `npm run test:runner-v2`.

```bash
git add runner-v2/src/plan-critique-authority.ts runner-v2/src/plan-critique-tools.ts runner-v2/src/native-plan-critic-runtime.ts runner-v2/src/native-verifier-runtime.ts runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/agent-prompts.ts runner-v2/test/native-plan-critic-runtime.test.ts runner-v2/test/agent-loop.test.ts
git commit -m "feat(runner-v2): independent read-only plan critic runtime (RG-1.2)"
```

---

### Task P6.5.5c: RG-1 — Build-runtime critique stage, Architect resolution tool, factory wiring

**Purpose:** Put the critic into the deterministic dispatcher: after planning and before the first worker, assess plan risk, skip or run the critic, auto-resolve advisory-only critiques, and route blocking findings to exactly one Architect resolution. Unavailable critics reuse the P4 verifier-selection pause; repeated critic failures on non-strict runs end in a durable skip.

**Files:**
- Modify: `runner-v2/src/user-steering-contracts.ts` (`plan_critique_resolution_required` reason + parser)
- Modify: `runner-v2/src/scheduler-store.ts` (`architectLifecycleEventMatchesReason`, `architectActionReasonIsApplicable`, `isArchitectLifecycleEvent`)
- Modify: `runner-v2/src/architect-tools.ts` (`resolve_plan_critique`, `planCritiqueResolutionAvailable` option)
- Modify: `runner-v2/src/agent-contracts.ts`, `runner-v2/src/agent-loop.ts` (`plan_critique_resolved` architect action)
- Modify: `runner-v2/src/build-runtime.ts` (`PlanCriticDriver`, `configurePlanCritiquePolicy`, `advancePlanCritique`)
- Modify: `runner-v2/src/native-architect-runtime.ts` (prompt line; reason switch in `architectInspectionWorkspace`; tool option)
- Modify: `runner-v2/src/native-build-factory.ts` (critic runtime + driver + `buildPlanCritiqueRequest`)
- Test: new `runner-v2/test/plan-critique-runtime.test.ts`; `runner-v2/test/user-steering.test.ts`; `runner-v2/test/native-architect-runtime.test.ts`

**Interfaces:**
- Produces: `PlanCriticDriver`, `PlanCriticResult` (build-runtime), reason `{ type: "plan_critique_resolution_required"; critiqueId: string; planRevision: number; blockingFindingIds: string[] }`, tool `resolve_plan_critique`, `buildPlanCritiqueRequest` (factory).
- Consumes: P6.5.5a/b.

- [ ] **Step 1: Architect action reason (test first)**

In `runner-v2/test/user-steering.test.ts` add: `parseArchitectActionReason({ type: "plan_critique_resolution_required", critiqueId: "critique-1", planRevision: 1, blockingFindingIds: ["F-1"] })` round-trips; an empty `blockingFindingIds` throws `Plan critique resolution reason requires blocking findings.`; an extra key throws. Run: FAIL. Add the union member and parser case in `user-steering-contracts.ts`; add the `case` in `architectLifecycleEventMatchesReason` (`plan_critique.resolved` by an architect actor with matching `critiqueId`), in `architectActionReasonIsApplicable` (current critique `submitted`, same `critiqueId`/`planRevision`, `sameValue(blockingFindingIds)`), and add `"plan_critique.resolved"` to `isArchitectLifecycleEvent`. Mirror the reason in `lib/client/runner-v2.ts` `NativeArchitectActionReason`. Run: PASS.

- [ ] **Step 2: Architect tool (test first)**

In `runner-v2/test/native-architect-runtime.test.ts` (or `architect-user-steering-tools.test.ts`, whichever holds the tool-level tests) add: with a seeded store holding a submitted critique with blocking `F-1`, `createArchitectTools({ ..., planCritiqueResolutionAvailable: true })` exposes `resolve_plan_critique`; calling it with `resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }]` appends `plan_critique.resolved` and returns lifecycle `{ type: "architect_action", action: "plan_critique_resolved", referenceId: "critique-1" }`; calling it against a stale `critiqueId` returns `errorOutput("stale_plan_critique", ...)`; without the option the tool is absent. Run: FAIL. Implement `resolvePlanCritiqueTool(store, clock)` in `architect-tools.ts` with `lifecycleTool({ name: "resolve_plan_critique", description: "Resolve every blocking plan-critique finding exactly once: reconcile the plan (one atomic planReconciliation) for accepted findings, reject the rest with evidence-based rationale", schema: objectSchema({ critiqueId, planRevision, resolutions: array of objectSchema({ findingId, resolution enum ["plan_reconciled","rejected"], rationale }), planReconciliation: planReconciliationSchema() }, ["critiqueId","planRevision","resolutions"]) })`; `execute` checks `projection.planCritique?.current` is `submitted` with matching ids, then `appendEvent(store, { type: "plan_critique.resolved", actor architect, idempotencyKey: \`plan-critique:resolve:${critiqueId}\`, payload: input }, { type: "architect_action", action: "plan_critique_resolved", referenceId: critiqueId })`. Add `"plan_critique_resolved"` to the `architect_action` action unions in `agent-contracts.ts` and `agent-loop.ts`. Register the tool in `createArchitectTools` when `options.planCritiqueResolutionAvailable`. Run: PASS.

- [ ] **Step 3: Dispatcher stage (test first)**

Create `runner-v2/test/plan-critique-runtime.test.ts` using `SqliteSchedulerStore` and `BuildRuntime` with fake drivers (pattern: `createRuntime` in `test/support/verifier-run-fixture.ts`, but seeded only with `run.initialized`; the fake Architect appends `plan.created` on `plan_required` and `plan_critique.resolved` on `plan_critique_resolution_required`; the fake worker records calls and returns `{ type: "failed", reason: "unused" }`; the fake critic is a `PlanCriticDriver` whose `critique` appends `plan_critique.requested` + `plan_critique.submitted` through `SchedulerPlanCritiqueAuthority` with scripted findings). Tests:

1. `mode off never calls the critic and dispatches workers` — three steps: plan, then workers advanced; `criticCalls === 0`; projection has `planCritique.policy.mode === "off"` and no risk event.
2. `low plan risk is skipped durably before workers start` — plan with three tasks → step yields `{ status: "progressed", action: "plan_risk_assessed" }`, then `{ status: "progressed", action: "plan_critique_skipped" }`, projection `planCritique.skipped.reason === "low_plan_risk"`, then workers advance; `criticCalls === 0`.
3. `high plan risk runs the critic once and auto-resolves an advisory-only critique` — five tasks; after the risk step the critic runs (`plan_critique_submitted`), then `plan_critique_resolved_by_runner`, then workers; `criticCalls === 1`; `workerCalls > 0` only after the resolved event's sequence.
4. `blocking findings route to exactly one Architect resolution before any worker` — critic submits blocking `F-1`; the next step calls the Architect with reason `plan_critique_resolution_required` (assert the captured reason); the fake Architect resolves with a reconciliation cancelling `B`; then workers advance on plan revision 2; `architectReasons.filter(r => r.type === "plan_critique_resolution_required").length === 1`; no second critic call ever.
5. `an unavailable critic pauses for verifier selection` — critic returns `unavailable` → `{ status: "paused", action: "verifier_selection_required" }`, projection `verifierSelection.reason === "plan_critique_no_independent_runtime"`; after `selectVerifierRuntime("fallback:verifier", "select:1")` the next step calls the critic with `preferredRuntimeId: "fallback:verifier"`.
6. `three provider failures on a non-strict run end in a durable critic_failed skip; a strict run pauses instead` — critic returns `suspended` with reason `provider_error` three times → skipped with reason `critic_failed` then workers; with `stricterQualification: true` the third failure yields the selection pause.
7. `plan_only runs skip the critique with reason plan_only`.

Run: FAIL (`planCritic` option unknown). Then in `runner-v2/src/build-runtime.ts`:

```ts
export type PlanCriticResult =
  | { status: "submitted"; critiqueId: string }
  | { status: "unavailable"; reason: "no_independent_healthy_capability_match" | "runtime_unavailable" }
  | { status: "suspended"; reason: string; runtimeId?: string; error?: string };

export interface PlanCriticDriver {
  candidateRuntimeIds: readonly string[];
  mode: PlanCritiqueMode;
  stricterQualification: boolean;
  architectDeclaration(projection: SchedulerProjection): PlanRiskLevel;
  critique(input: {
    runId: string;
    projection: SchedulerProjection;
    riskReasons: readonly PlanRiskReason[];
    preferredRuntimeId?: string;
    signal?: AbortSignal;
  }): Promise<PlanCriticResult>;
}
```

`BuildRuntimeOptions.planCritic?: PlanCriticDriver`. In the constructor call `this.configurePlanCritiquePolicy()` after `configureRepairPolicy()`: append `plan_critique.policy_configured` with `mode: planCritic?.mode ?? "off"` unless a policy event or a `plan.created` event already exists (pre-P6.5 in-flight runs stay unchanged). In `stepOnce`, immediately after the `planRevision === 0` branch:

```ts
    const critique = await this.advancePlanCritique(projection);
    if (critique) return critique;
```

with:

```ts
  private async advancePlanCritique(projection: SchedulerProjection): Promise<BuildStepResult | undefined> {
    const driver = this.planCritic;
    const state = projection.planCritique;
    if (!driver || !state?.policy || state.policy.mode === "off" || state.skipped) return undefined;
    if (state.current?.status === "resolved") return undefined;
    const skip = (reason: PlanCritiqueSkipReason): BuildStepResult => {
      this.store.append({
        runId: this.runId, type: "plan_critique.skipped", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:skip:${projection.planRevision}:${reason}`,
        payload: { planRevision: projection.planRevision, reason },
      });
      return { status: "progressed", action: "plan_critique_skipped" };
    };
    if (this.runPolicy === "plan_only") return skip("plan_only");
    if (!state.risk) {
      const input = {
        architectDeclaration: driver.architectDeclaration(projection),
        stricterQualification: driver.stricterQualification,
        tasks: Object.values(projection.tasks),
      };
      this.store.append({
        runId: this.runId, type: "plan_critique.risk_assessed", occurredAt: this.clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `plan-critique:risk:${projection.planRevision}`,
        payload: {
          planRevision: projection.planRevision,
          architectDeclaration: input.architectDeclaration,
          stricterQualification: input.stricterQualification,
          assessment: assessPlanRisk(input),
        },
      });
      return { status: "progressed", action: "plan_risk_assessed" };
    }
    if (!planCritiqueRequired(state.policy.mode, state.risk.assessment)) return skip("low_plan_risk");
    const current = state.current;
    if (current?.status === "submitted") {
      if ((current.blockingFindingIds ?? []).length === 0) {
        this.store.append({
          runId: this.runId, type: "plan_critique.resolved", occurredAt: this.clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `plan-critique:resolve:${current.critiqueId}`,
          payload: { critiqueId: current.critiqueId, planRevision: current.planRevision, resolutions: [] },
        });
        return { status: "progressed", action: "plan_critique_resolved_by_runner" };
      }
      await this.runArchitect({
        type: "plan_critique_resolution_required",
        critiqueId: current.critiqueId,
        planRevision: current.planRevision,
        blockingFindingIds: [...current.blockingFindingIds!],
      }, projection);
      if (this.projection().planCritique?.current?.status !== "resolved") {
        throw new Error("Architect returned from plan_critique_resolution_required without a typed action.");
      }
      return this.afterArchitect("plan_critique_resolution_required");
    }
    const result = await driver.critique({
      runId: this.runId,
      projection,
      riskReasons: state.risk.assessment.reasons,
      ...(projection.verifierSelection?.status === "selected" && projection.verifierSelection.selectedRuntimeId
        ? { preferredRuntimeId: projection.verifierSelection.selectedRuntimeId }
        : {}),
      signal: this.activeLifecycleSignal(),
    });
    if (result.status === "submitted") return { status: "progressed", action: "plan_critique_submitted" };
    if (result.status === "suspended" && result.reason === "cancelled" && this.projection().status === "paused") {
      return { status: "paused", action: "plan_critic_interrupted" };
    }
    const failures = this.projection().planCritique?.history.length ?? 0;
    if (result.status === "suspended" && result.reason === "provider_error" && failures < 2) {
      return { status: "progressed", action: "plan_critic_provider_failed" };
    }
    if (!driver.stricterQualification && result.status === "suspended") return skip("critic_failed");
    this.store.append({
      runId: this.runId, type: "verifier.selection_required", occurredAt: this.clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `verifier-selection:plan-critique:${projection.planRevision}:${result.status === "unavailable" ? result.reason : result.reason}`,
      payload: {
        reason: "plan_critique_no_independent_runtime",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: [...driver.candidateRuntimeIds],
      },
    });
    return { status: "paused", action: "verifier_selection_required" };
  }
```

`failures` counts superseded critique requests (each provider failure leaves a `requested` critique that the next attempt supersedes into `history`). The `verifier.selection_required` reducer requires `verifierPolicy`; `configureVerifierPolicy()` already runs in the constructor, and `PlanCriticDriver.candidateRuntimeIds` must equal the verifier policy candidates (assert this in the constructor, like the existing candidate checks). Pass `planCritiqueResolutionAvailable: true` in the Architect tool options when a critique is `submitted`.

- [ ] **Step 4: Prompts and inspection workspace**

In `native-architect-runtime.ts` add the system line: `"When plan critique resolution is requested, read every blocking finding, inspect the baseline repository where a finding cites files, then call resolve_plan_critique exactly once: reconcile the plan for findings you accept (cancel, revise, or add tasks in one planReconciliation) and reject the rest with evidence-based rationale."`; in `architectInspectionWorkspace` route `plan_critique_resolution_required` to the canonical project root (same branch as `plan_required`). In `planTasksTool`'s description add `; declare riskDeclaration low or high with a rationale`.

- [ ] **Step 5: Factory wiring**

In `native-build-factory.ts`, next to `nativeVerifier`, construct `const planCritic = new NativePlanCriticRuntime({ router: verifierRouter, candidates, models, verifierRuntimeIds: spec.verifierRuntimeIds, sessions, artifacts: this.artifacts, workspaceManager: <the same object passed to NativeVerifierRuntime>, critiqueAuthority: new SchedulerPlanCritiqueAuthority(schedulerStore), budgetLedger, ledger, modelCostEstimators, modelCostBases, contextManifests, recordContextPackText })` and the driver:

```ts
    const planCriticDriver: PlanCriticDriver = {
      candidateRuntimeIds: [...spec.verifierRuntimeIds],
      mode: spec.planCritique ?? "risk_based",
      stricterQualification: spec.alwaysRequireIndependentVerifier,
      architectDeclaration: (projection) => projection.planRiskDeclaration?.risk ?? "low",
      critique: async ({ projection, riskReasons, preferredRuntimeId, signal }) => {
        const result = await planCritic.critique(buildPlanCritiqueRequest({
          runId: spec.runId,
          objective: spec.objective,
          architectRuntimeId: projection.runtime.architect.runtimeId ?? spec.architectRuntimeId,
          projection,
          baselineRevision: integrationManager.revision,
          riskReasons,
          ...(preferredRuntimeId ? { preferredRuntimeId } : {}),
          ...(signal ? { signal } : {}),
          providerRetryDeadlineMs: runnerProviderRetryDeadlineMs(
            spec.budgetLimits.maxActiveMs,
            budgetLedger.snapshot(spec.runId).effective.activeMs,
            Date.now(),
          ),
        }));
        if (result.status === "submitted") {
          await verifierWorkspace.cleanup();
          return { status: "submitted", critiqueId: result.critiqueId };
        }
        if (result.status === "unavailable") return { status: "unavailable", reason: result.reason };
        return { status: "suspended", reason: result.reason, runtimeId: result.runtimeId, ...(result.error ? { error: result.error } : {}) };
      },
    };
```

`buildPlanCritiqueRequest` (exported from the factory next to `buildNativeVerifierInspectionRequest`) maps the projection to `NativePlanCritiqueRequest`: `planRevision`, non-cancelled ordinary tasks, `guidance` built exactly like the verifier's guidance list. Pass `planCritic: planCriticDriver` into `BuildRuntime` options. The critic must run only when the verifier workspace is not holding a different revision: `verifierWorkspace.cleanup()` after a submitted critique guarantees the later verdict-time `create(integrationRevision)` succeeds; add a factory test in `native-verifier-factory.test.ts` that a submitted critique leaves no `verifier-workspaces/<run>` directory.

- [ ] **Step 6: Run, prove red, commit**

Run: `npx tsx --test runner-v2/test/plan-critique-runtime.test.ts runner-v2/test/user-steering.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/native-verifier-factory.test.ts runner-v2/test/build-runtime.test.ts` — Expected: PASS. Prove-red: move the critique stage below `scheduler.tick()` (red: workers start before resolution in test 4); make the runner auto-resolve regardless of blocking findings (red: reducer throws in test 4); return `undefined` for `unavailable` (red: test 5). Restore. Then `npm run typecheck:runner-v2` and `npm run test:runner-v2`.

```bash
git add runner-v2/src/user-steering-contracts.ts runner-v2/src/scheduler-store.ts runner-v2/src/architect-tools.ts runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/build-runtime.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/native-build-factory.ts lib/client/runner-v2.ts runner-v2/test/plan-critique-runtime.test.ts runner-v2/test/user-steering.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/native-verifier-factory.test.ts
git commit -m "feat(runner-v2): risk-gated plan critique before the first worker (RG-1.4, RG-1.5)"
```

---

### Task P6.5.5d: RG-1 — Plan critique in the client, UI, and audit

**Files:**
- Modify: `lib/client/runner-v2.ts` (`NativePlanCritiqueState` on `NativeBuildProjection.planCritique`, `planRiskDeclaration`)
- Modify: `components/RunnerV2ObservabilityPanel.tsx` (attention item, summary line, findings list, reason label)
- Modify: `lib/client/native-build-activity.ts` only if it maps event types to phases (grep `final_verification.` there; mirror for `plan_critique.`)
- Test: `scripts/test-runner-v2-observability.mts`, `scripts/test-runner-v2-client.mts`

- [ ] **Step 1: Types**

Mirror `PlanCritiqueState`, `PlanCritiqueProjection`, and `PlanCritiqueFinding` as `NativePlanCritiqueState`, `NativePlanCritiqueProjection`, `NativePlanCritiqueFinding` in `lib/client/runner-v2.ts`; add `planCritique?: NativePlanCritiqueState` and `planRiskDeclaration?: { risk: "low" | "high"; rationale?: string; source: "architect" | "legacy_default" }` to `NativeBuildProjection`. Add a reason label `plan_critique_resolution_required: "Resolving plan critique"` wherever the panel maps reason types to labels (grep `final_verification_repair_plan_required` in `components/`).

- [ ] **Step 2: UI (test first)**

In `scripts/test-runner-v2-observability.mts` add assertions: a projection with a `submitted` critique holding one blocking finding renders the attention title `Plan critique found blocking issues` with the finding claim in the detail; a `skipped` critique renders `Plan critique: skipped (low plan risk)`; a `resolved` critique renders `Plan critique: resolved (1 blocking, 1 advisory)`. Run: FAIL. Implement in `RunnerV2ObservabilityPanel.tsx`: attention item keyed `plan-critique:blocking`; a summary line in the build control section; a collapsible findings list showing severity, category, task ids, claim, and evidence strings, and the Architect resolution per blocking finding. Run: PASS.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

```bash
git add lib/client/runner-v2.ts components/RunnerV2ObservabilityPanel.tsx lib/client/native-build-activity.ts scripts/test-runner-v2-observability.mts scripts/test-runner-v2-client.mts
git commit -m "feat(runner-v2): surface plan critique risk, findings, and resolution in the UI (RG-1.6)"
```

**Acceptance criteria (P6.5.5 as a whole):**
- Plan risk is assessed exactly once per run from the Architect declaration, the strict flag, task count, and dependency fan-in; the reducer recomputes and rejects a conflicting assessment.
- With `risk_based` (default) a low-risk plan records a durable skip and workers start immediately; a high-risk plan runs one independent critic whose model identity differs from the Architect's, with read-only tools over the baseline revision.
- Findings are validated against the current plan; blocking findings block every worker until one Architect `resolve_plan_critique` (reconciling or rejecting each finding) lands; advisory-only critiques are auto-resolved by the runner.
- The critique runs once per run; a plan reconciled by the resolution is not re-critiqued.
- No independent runtime → the P4 selection pause; repeated provider failure → durable `critic_failed` skip on non-strict runs, pause on strict runs. Nothing is waived silently.
- Restart after `plan_critique.submitted` resumes at resolution without another critic call; restart after `plan_critique.requested` resumes the same session.
- UI shows risk, findings, and the resolution; audit contains every event.

**Cleanup and rollback:** the critic uses the existing independent-verifier workspace and cleans it after submission; whole-packet revert per sub-packet in reverse order (d → c → b → a).

---

### Task P6.5.6: RG-6 — Two-pass adversarial independent verifier

**Purpose:** Today the verifier gets criteria, Architect verdict rationale, accepted diffs, and final-verification facts in one pass with a procedural prompt, so it tends to confirm the implementation it is shown. This packet splits verification: pass 1 runs on a detached worktree at the run **baseline** revision with no diff, no reviews, and no final-verification facts, and must record typed expectations per criterion; pass 2 runs on the integration revision with those expectations, an adversarial stance, and a richer verdict schema. The kernel refuses a two-pass verdict without recorded expectations. Runs created before P6.5 keep single-pass semantics.

**Files:**
- Modify: `runner-v2/src/verification-workspace.ts` (`workspaceSuffix` option)
- Modify: `runner-v2/src/verifier-contracts.ts` (`VerifierExpectation`, `parseVerifierExpectations`, review fields `twoPass`, `baselineRevision`, `expectations`, `expectationsSessionId`; verdict `location`, `reproduction`)
- Modify: `runner-v2/src/verifier-verdict-authority.ts` (`recordExpectations`; request input `twoPass`, `baselineRevision`)
- Modify: `runner-v2/src/verifier-tools.ts` (`createRecordVerificationExpectationsTool`; verdict schema)
- Modify: `runner-v2/src/scheduler-store.ts` (`verifier.policy_configured.twoPass`, `verifier.review_requested` fields, new `verifier.expectations_recorded`, verdict gate)
- Modify: `runner-v2/src/agent-contracts.ts`, `runner-v2/src/agent-loop.ts` (`verifier_expectations_recorded` lifecycle signal and result)
- Modify: `runner-v2/src/agent-prompts.ts` (`VERIFIER_ADVERSARIAL_STANCE`, `buildVerifierExpectationsContext`, `expectations` section in `buildVerifierContext`)
- Modify: `runner-v2/src/native-verifier-runtime.ts` (`VerifierWorkspaceProvider.createBaseline`, request `baselineRevision`/`twoPass`, pass-1 loop)
- Modify: `runner-v2/src/build-runtime.ts` (`IndependentVerifierDriver.twoPass`, policy payload)
- Modify: `runner-v2/src/build-spec.ts` (`verifierTwoPass?: boolean`)
- Modify: `runner-v2/src/native-build-factory.ts` (`verifierBaselineWorkspace`, `runBaselineRevision`, request fields, cleanup)
- Modify: `lib/client/runner-v2.ts`, `components/RunnerV2ObservabilityPanel.tsx` (expectations, location, reproduction)
- Test: `runner-v2/test/verification-workspace.test.ts`, `runner-v2/test/verifier-contracts.test.ts`, `runner-v2/test/native-verifier-runtime.test.ts`, `runner-v2/test/agent-loop.test.ts`, `runner-v2/test/native-verifier-factory.test.ts`, `runner-v2/test/build-spec-store.test.ts`, `scripts/test-runner-v2-observability.mts`

**Interfaces:**
- Produces: `VerifierExpectation`, `parseVerifierExpectations(value, criteria)`, `VerifierReviewProjection.twoPass?/baselineRevision?/expectations?/expectationsSessionId?`, `VerifierCriterionVerdict.location?/reproduction?`, `VerifierVerdictAuthority.recordExpectations`, `createRecordVerificationExpectationsTool`, `VERIFIER_ADVERSARIAL_STANCE`, `buildVerifierExpectationsContext`, `VerifierWorkspaceProvider.createBaseline`, `runBaselineRevision(schedulerEvents, projection)`.
- Consumes: `acceptedFailures` (P6.5.1), `recordContextPack` (P6.5.4).

- [ ] **Step 1: Baseline workspace suffix (test first)**

In `runner-v2/test/verification-workspace.test.ts` add: two managers for the same run and kind `independent-verifier`, one with `workspaceSuffix: "baseline"`, create worktrees at two different existing revisions; both `path`s differ, both `metadataPath`s differ, both metadata files record their own revision, and `cleanup()` on one leaves the other intact. Run: FAIL. In `verification-workspace.ts` add `workspaceSuffix?: string` to the options; `workspaceId = suffix ? \`${safeName(runId)}-${safeName(suffix)}\` : safeName(runId)`; everything else derives from `workspaceId` already. Run: PASS.

- [ ] **Step 2: Contracts (test first)**

In `runner-v2/test/verifier-contracts.test.ts` add:

```ts
test("verifier expectations cover every criterion exactly once with concrete behaviors and edge cases", () => {
  const criteria = [{ taskId: "task_ui", criterionId: "criterion_ui" }];
  const parsed = parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui",
    expectedBehaviors: ["The membership card renders the organization name."],
    edgeCases: ["No memberships", "Two memberships with the same user id"],
    regressionSurfaces: ["src/app.ts render path"],
    requiredTests: ["MembershipCardRendersOrganization"],
  }], criteria);
  assert.equal(parsed.length, 1);
  assert.throws(() => parseVerifierExpectations([], criteria), /must represent every build criterion exactly once/);
  assert.throws(() => parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui", expectedBehaviors: [], edgeCases: ["x"], regressionSurfaces: [], requiredTests: [],
  }], criteria), /expectedBehaviors requires at least one entry/);
});

test("an unsatisfied two-pass verdict carries a location and reproduction steps", () => {
  const verdict = parseVerifierCriterionVerdicts([{
    taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied",
    rationale: "Invalidation ignores the organization id.", evidenceIds: ["evidence_ui"],
    location: { path: "src/membership-service.ts", lines: "118-132" },
    reproduction: ["Create the same user in two organizations", "Remove membership in A", "Observe B's cache entry removed"],
  }]);
  assert.deepEqual(verdict[0]?.location, { path: "src/membership-service.ts", lines: "118-132" });
  assert.equal(verdict[0]?.reproduction?.length, 3);
  assert.throws(() => parseVerifierCriterionVerdicts([{
    taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied", rationale: "x", evidenceIds: ["e"],
    location: { path: "" },
  }]), /location path must be non-empty/);
});
```

Run: FAIL. Implement in `verifier-contracts.ts`:

```ts
export interface VerifierExpectation extends VerifierCriterionReference {
  expectedBehaviors: string[];
  edgeCases: string[];
  regressionSurfaces: string[];
  requiredTests: string[];
}

export function parseVerifierExpectations(
  value: unknown,
  expectedCriteria: readonly VerifierCriterionReference[],
): VerifierExpectation[] {
  if (!Array.isArray(value)) throw new Error("Verifier expectations must be an array.");
  const parsed = value.map((candidate, index) => {
    const record = requiredRecord(candidate, `Verifier expectation ${index}`);
    const lists = (key: "expectedBehaviors" | "edgeCases" | "regressionSurfaces" | "requiredTests", min: number) => {
      const items = requiredStringArray(record, key);
      if (items.length < min) throw new Error(`Verifier expectation ${index} ${key} requires at least one entry.`);
      return items;
    };
    return {
      taskId: requiredString(record, "taskId"),
      criterionId: requiredString(record, "criterionId"),
      expectedBehaviors: lists("expectedBehaviors", 1),
      edgeCases: lists("edgeCases", 1),
      regressionSurfaces: lists("regressionSurfaces", 0),
      requiredTests: lists("requiredTests", 0),
    };
  });
  assertExactVerifierCriteria(parsed, expectedCriteria, "Verifier expectations");
  return parsed;
}
```

Add to `VerifierCriterionVerdict`: `location?: { path: string; lines?: string }; reproduction?: string[];` parsed in `parseCriterionVerdict` (path non-empty, `lines` optional string matching `/^\d+(-\d+)?$/`, reproduction non-empty strings) and cloned. Add to `VerifierReviewProjection`: `twoPass?: boolean; baselineRevision?: string; expectations?: VerifierExpectation[]; expectationsSessionId?: string;` and parse `twoPass`/`baselineRevision` in `parseVerifierReviewRequest` (baseline must match `REVISION_PATTERN` when present; `twoPass === true` requires `baselineRevision`). Run: PASS.

- [ ] **Step 3: Reducer and authority (test first)**

In `runner-v2/test/plan-critique.test.ts`'s sibling style, add to `runner-v2/test/verifier-contracts.test.ts` (it owns the seeded verifier run fixture): under `verifier.policy_configured` with `twoPass: true`, `appendVerifierRequest` with `twoPass: true, baselineRevision: BASELINE` (extend `verifierRequestPayload(overrides)`); a `verifier.verdict_submitted` before expectations throws `Two-pass verifier verdict requires recorded expectations.`; `verifier.expectations_recorded` from a foreign runtime throws; from the bound runtime with exact criteria records `expectations` and `expectationsSessionId`; an unsatisfied verdict without `reproduction` under two-pass throws `Two-pass unsatisfied verdicts require reproduction steps.`; a complete verdict then succeeds. Also: a review without `twoPass` (legacy) accepts a verdict with no expectations. Run: FAIL.

Implement in `scheduler-store.ts`: add `"verifier.expectations_recorded"` to `SchedulerEventType`; `VerifierPolicyProjection.twoPass: boolean` parsed from `verifier.policy_configured` (absent → `false`); reducer case:

```ts
    case "verifier.expectations_recorded": {
      if (event.actor.role !== "verifier") {
        throw new Error("Only the selected verifier may record expectations.");
      }
      recordVerifierExpectations(next, event, event.occurredAt);
      break;
    }
```

`recordVerifierExpectations` requires `current` review in `requested` status and `current` state, `reviewId`/`targetRevision`/`baselineRevision` matching, `event.actor.id === current.runtime.runtimeId`, `twoPass === true`, then sets `expectations = parseVerifierExpectations(payload.expectations, current.criteria)` and `expectationsSessionId = requiredString(payload, "sessionId")`; identical re-record is idempotent, conflicting throws. In `recordVerifierVerdict` add, before parsing: `if (current.twoPass && !current.expectations) throw new Error("Two-pass verifier verdict requires recorded expectations.");` and after parsing: for each unsatisfied criterion verdict under `current.twoPass`, require `reproduction?.length` (else `Two-pass unsatisfied verdicts require reproduction steps.`). In `validateSchedulerEvidenceEvent` nothing changes (expectations cite no evidence).

In `verifier-verdict-authority.ts`: `RequestVerifierReviewInput` gains `twoPass?: boolean; baselineRevision?: string` (forwarded in the payload); add:

```ts
export interface RecordVerifierExpectationsInput {
  runId: string; reviewId: string; targetRevision: string; baselineRevision: string;
  sessionId: string; actor: AgentActor & { role: "verifier" };
  expectations: VerifierExpectation[]; occurredAt: string;
}
```

and `recordExpectations(input)` on the interface and class (event `verifier.expectations_recorded`, idempotency `verifier:expectations:${reviewId}`, read-back assertion). Update `FakeVerifierVerdictAuthority` in the runtime test accordingly. Run: PASS.

- [ ] **Step 4: Lifecycle signal, tool, prompts**

- `agent-contracts.ts` / `agent-loop.ts`: add `{ type: "verifier_expectations_recorded"; reviewId: string }` and the matching `AgentLoopResult` status `verifier_expectations_recorded` (test in `agent-loop.test.ts` as in P6.5.5b Step 1).
- `verifier-tools.ts`: `createRecordVerificationExpectationsTool({ authority, runId, reviewId, targetRevision, baselineRevision, runtimeId, sessionId, criteria, clock })` — `name: "record_verification_expectations"`, description `Record, before seeing any implementation, what each criterion must do, its edge cases, likely regression surfaces, and the tests that should exist. Exactly one entry per protected task/criterion pair.`; schema `{ expectations: array of { taskId, criterionId, expectedBehaviors string[] minItems 1, edgeCases string[] minItems 1, regressionSurfaces string[], requiredTests string[] } }`; `readOnly: true`, `effect: "none"`, `lifecycle: true`; validate with `parseVerifierExpectations(record.expectations, criteria)`; execute asserts the bound context and calls `authority.recordExpectations`, returning `lifecycle: { type: "verifier_expectations_recorded", reviewId }`. Extend the verdict tool schema with `location: objectSchema({ path: { type: "string", minLength: 1 }, lines: { type: "string", pattern: "^\\d+(-\\d+)?$" } }, ["path"])` and `reproduction: { type: "array", items: { type: "string", minLength: 1 } }`.
- `agent-prompts.ts`:

```ts
export const VERIFIER_ADVERSARIAL_STANCE = [
  "Assume the integrated change contains at least one defect that the Architect's review missed.",
  "For every criterion, use your recorded expectations: try to falsify each expected behavior and each edge case against the exact revision before you accept it.",
  "A satisfied verdict must name which expected behaviors and edge cases you checked and how the cited evidence proves them.",
  "An unsatisfied verdict must give a file location and concrete reproduction steps; it must not restate the Architect's rationale.",
  "Architect review summaries are claims to test, not evidence.",
].join("\n");

export interface BuildVerifierExpectationsContextInput {
  limits: ContextLimits;
  objective: string;
  baselineRevision: string;
  targetRevision: string;
  criteria: readonly unknown[];
  guidance: readonly unknown[];
  riskReasons: readonly unknown[];
}

export function buildVerifierExpectationsContext(input: BuildVerifierExpectationsContextInput): ContextPack {
  return new ContextAssembler(input.limits).assemble([
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("verifier-authority", "system", VERIFIER_AUTHORITY_INVARIANTS),
    required("expectations-stage", "system", "You are inspecting the BASELINE revision: the repository as it was before this build's changes. No diff, review, or verification result is available yet. Derive expectations from the criteria and the existing code and tests, then call record_verification_expectations exactly once."),
    required("build-objective", "user-intent", input.objective),
    required("baseline-revision", "revision", input.baselineRevision),
    required("integration-revision", "revision", input.targetRevision),
    required("build-criteria", "criteria", JSON.stringify(input.criteria, null, 2)),
    required("durable-guidance", "guidance", JSON.stringify(input.guidance, null, 2)),
    required("risk-reasons", "risk", JSON.stringify(input.riskReasons, null, 2)),
  ]);
}
```

`BuildVerifierContextInput` gains `expectations?: readonly unknown[]`; when present `buildVerifierContext` inserts `required("verifier-adversarial-stance", "system", VERIFIER_ADVERSARIAL_STANCE)` after `verifier-authority` and `required("recorded-expectations", "expectations", JSON.stringify(input.expectations, null, 2))` before `accepted-reviews`.

- [ ] **Step 5: Runtime two-pass flow (test first)**

In `runner-v2/test/native-verifier-runtime.test.ts`: extend the workspace stub with `createBaseline(revision)` (records into `baselineRequests`, returns a workspace at `BASELINE_REVISION` under a second temp directory) and `cleanupBaseline()` (counts calls); `verifierRequest(runId, overrides)` gains `baselineRevision: BASELINE_REVISION` and `twoPass: true` when the fixture is two-pass. Tests:

```ts
test("two-pass verification records expectations on the baseline before it can see the implementation", async () => {
  const authority = new FakeVerifierVerdictAuthority();
  const fixture = createFixture("two-pass", [
    { blocks: [{ type: "tool_call", callId: "exp-1", name: "record_verification_expectations", arguments: {
      expectations: [{ taskId: "task_ui", criterionId: "criterion_ui",
        expectedBehaviors: ["UI matches the request"], edgeCases: ["empty state"],
        regressionSurfaces: ["src/app.ts"], requiredTests: ["renders empty state"] }] } }],
      stopReason: "tool_calls" },
    { blocks: [{ type: "tool_call", callId: "verdict-1", name: "submit_verifier_verdict", arguments: {
      criterionVerdicts: [{ taskId: "task_ui", criterionId: "criterion_ui", verdict: "satisfied",
        rationale: "Checked both expected behaviors against the revision.", evidenceIds: ["evidence_ui"] }] } }],
      stopReason: "tool_calls" },
  ], TARGET_REVISION, authority, false, false, { twoPass: true });
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_two_pass", { twoPass: true }));
    assert.equal(result.status, "verdict_submitted");
    assert.deepEqual(fixture.baselineRequests, [BASELINE_REVISION]);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);
    const passOne = JSON.stringify(fixture.model.requests[0]!.messages);
    for (const forbidden of ["accepted-change-history", "final-verification", "accepted-reviews", HASH]) {
      assert.doesNotMatch(passOne, new RegExp(escapeRegExp(forbidden)), forbidden);
    }
    assert.match(passOne, /baseline-revision/);
    assert.equal(fixture.model.requests[0]!.tools.some((tool) => tool.name === "record_verification_expectations"), true);
    assert.equal(fixture.model.requests[0]!.tools.some((tool) => tool.name === "submit_verifier_verdict"), false);
    const passTwo = JSON.stringify(fixture.model.requests[1]!.messages);
    assert.match(passTwo, /recorded-expectations/);
    assert.match(passTwo, /Assume the integrated change contains at least one defect/);
    assert.match(passTwo, new RegExp(escapeRegExp(HASH)));
    assert.equal(authority.expectations.length, 1);
    assert.equal(fixture.baselineCleanupCalls, 1);
    assert.notEqual(authority.expectations[0]?.sessionId, result.sessionId, "pass 1 uses its own session");
  } finally {
    fixture.close();
  }
});

test("restart after durable expectations resumes at pass 2 without repeating pass 1", async () => {
  // authority.afterRequest returns a review that already carries expectations; scripted turns contain only the verdict call;
  // assert model.requests.length === 1, baselineRequests is empty, status verdict_submitted.
});

test("a two-pass verdict without expectations is refused by the authority", async () => {
  // FakeVerifierVerdictAuthority.submitVerdict throws when the current review is twoPass and has no expectations;
  // scripted turns contain only the verdict call on a twoPass request; assert status suspended with reason protocol_error or the tool error text surfaces in the replayed messages.
});
```

Run: FAIL. Implement in `native-verifier-runtime.ts`: `VerifierWorkspaceProvider` gains `createBaseline(baselineRevision: string): Promise<VerificationWorkspace>` and `cleanupBaseline(): Promise<void>`; `NativeVerifierInspectionRequest` gains `readonly baselineRevision?: string; readonly twoPass?: boolean` (`assertInspectionRequest`: `twoPass` requires a valid `baselineRevision`). In `inspect`, after `durableReview` is bound and before building pass-2 messages: when `request.twoPass && durableReview && !durableReview.expectations`:
1. `const baseline = await this.options.workspaceManager.createBaseline(request.baselineRevision!)`; assert `baseline.targetRevision === request.baselineRevision`.
2. Build `buildVerifierExpectationsContext(...)`; `expectationsSessionId = verifierSessionId(runId, baselineRevision, runtimeId, digest, "expectations")`; create or load that session exactly like the main session; record a context manifest with `purpose: "verifier:expectations"` and `repositoryRevision: baselineRevision`.
3. Tools: `createInspectionTools({ workspacePath: baseline.path, ..., lifecycleTool: createRecordVerificationExpectationsTool({...}) })` — the verdict tool is NOT registered in pass 1.
4. `runAgentLoop` with the same model/budget/retry wiring; on `verifier_expectations_recorded` verify `verdictAuthority.currentReview(runId)?.expectations` is durable, complete the pass-1 session, `await this.options.workspaceManager.cleanupBaseline()`; on any other result return the same `suspended`/failure mapping as the main loop (the baseline workspace stays for resume).
5. Continue into pass 2 with `context = buildVerifierContext({ ...existing, expectations: durableReview.expectations })` where `durableReview` is re-read from the authority.

`requestReview` passes `twoPass: request.twoPass === true` and `baselineRevision`. `assertBoundVerifierReview` also compares `twoPass` and `baselineRevision`. Run: PASS.

- [ ] **Step 6: Build runtime, spec, factory**

- `build-spec.ts`: `verifierTwoPass?: boolean` (boolean when present; cloned; legacy recovery leaves it undefined). Test in `build-spec-store.test.ts`.
- `build-runtime.ts`: `IndependentVerifierDriver.twoPass?: boolean`; `configureVerifierPolicy()` includes `twoPass: this.independentVerifier?.twoPass === true` in the payload only when the policy event does not exist yet (existing runs keep their durable policy). `IndependentVerifierRequest` is unchanged.
- `native-build-factory.ts`: create `const verifierBaselineWorkspace = new VerificationWorkspaceManager({ repositoryRoot: integrationManager.path, stateDirectory: this.options.stateDirectory, runId: spec.runId, integrationManager, kind: "independent-verifier", workspaceSuffix: "baseline" })`; register `constructionResources.add("independent_verifier_baseline_workspace", () => verifierBaselineWorkspace.cleanup())`; pass `createBaseline: (revision) => verifierBaselineWorkspace.create(revision)` and `cleanupBaseline: () => verifierBaselineWorkspace.cleanup()` on the `workspaceManager` object given to `NativeVerifierRuntime`; add `() => verifierBaselineWorkspace.cleanup()` to the settled-run cleanup list and after `verdict_submitted`; driver `twoPass: spec.verifierTwoPass ?? true`. Export and use:

```ts
export function runBaselineRevision(
  schedulerEvents: readonly SchedulerEvent[],
  projection: SchedulerProjection,
): string {
  const first = schedulerEvents.find(
    (event) =>
      event.type === "integration.revision_advanced" &&
      typeof event.payload.previousIntegrationRevision === "string" &&
      event.payload.previousIntegrationRevision.trim().length > 0,
  );
  const baseline = first
    ? (first.payload.previousIntegrationRevision as string)
    : projection.integrationRevision;
  if (!baseline) throw new Error("Run baseline revision is unknown.");
  return baseline;
}
```

`buildNativeVerifierInspectionRequest` gains `schedulerEvents` and `twoPass` inputs and emits `baselineRevision: runBaselineRevision(schedulerEvents, projection)` plus `twoPass`. Test `runBaselineRevision` in `native-verifier-factory.test.ts` (first advanced event wins; fallback to the integration revision; throws when neither exists).

- [ ] **Step 7: Client and UI**

`lib/client/runner-v2.ts`: `NativeVerifierReviewProjection` gains `twoPass?`, `baselineRevision?`, `expectations?: Array<{ taskId; criterionId; expectedBehaviors: string[]; edgeCases: string[]; regressionSurfaces: string[]; requiredTests: string[] }>`; verdict items gain `location?` and `reproduction?`; `NativeIndependentVerifierObservability["policy"]` gains `twoPass: boolean`. Panel: in the independent-verifier section render `Expectations recorded (N criteria)` when present, and for each unsatisfied verdict the `location.path:lines` and a numbered reproduction list. Assert both in `scripts/test-runner-v2-observability.mts`.

- [ ] **Step 8: Prove red, gates, commit**

Injections: (a) register the verdict tool in pass 1 (red: pass-1 tool assertion); (b) skip the `!current.expectations` check in `recordVerifierVerdict` (red: reducer test); (c) include `accepted-change-history` in the expectations context (red: forbidden-section assertion); (d) skip `cleanupBaseline()` (red: cleanup count). Restore each. Then:

```bash
npm run typecheck:runner-v2
```

```bash
npm run test:runner-v2
```

```bash
npm run build
```

```bash
git add runner-v2/src/verification-workspace.ts runner-v2/src/verifier-contracts.ts runner-v2/src/verifier-verdict-authority.ts runner-v2/src/verifier-tools.ts runner-v2/src/scheduler-store.ts runner-v2/src/agent-contracts.ts runner-v2/src/agent-loop.ts runner-v2/src/agent-prompts.ts runner-v2/src/native-verifier-runtime.ts runner-v2/src/build-runtime.ts runner-v2/src/build-spec.ts runner-v2/src/native-build-factory.ts lib/client/runner-v2.ts components/RunnerV2ObservabilityPanel.tsx runner-v2/test/verification-workspace.test.ts runner-v2/test/verifier-contracts.test.ts runner-v2/test/native-verifier-runtime.test.ts runner-v2/test/agent-loop.test.ts runner-v2/test/native-verifier-factory.test.ts runner-v2/test/build-spec-store.test.ts runner-v2/test/support/verifier-run-fixture.ts scripts/test-runner-v2-observability.mts
git commit -m "feat(runner-v2): two-pass adversarial independent verifier (RG-6)"
```

**Acceptance criteria (P6.5.6):**
- Under two-pass policy the verifier's first model call sees the baseline worktree, the criteria, guidance, and risk reasons only; it cannot see diffs, Architect reviews, or final-verification facts and cannot call the verdict tool.
- Expectations are typed, cover every criterion exactly once, and are durable before pass 2 starts; the reducer refuses a two-pass verdict without them and an unsatisfied two-pass verdict without reproduction steps.
- Pass 2 receives the expectations and the adversarial stance; the verdict schema carries optional location and reproduction.
- Restart after durable expectations runs only pass 2; restart during pass 1 resumes the pass-1 session.
- The baseline worktree is cleaned after pass 1 and on settled-run cleanup; the integration-revision worktree behaves as before.
- Runs whose durable verifier policy lacks `twoPass` keep single-pass replay semantics; new runs default to two-pass.

**Cleanup and rollback:** whole-packet revert; runs that recorded `verifier.expectations_recorded` cannot be resumed by an older runner (document in the packet report).

---

# Phase exit gate

- [ ] Every packet commit is on `codex/runner-v2-robust-build` with its prove-red evidence (pre-fix red, injected red, final green) recorded per packet in `.superpowers/sdd/2026-08-26-runner-v2-robust-build-improvements/task-6.5-report.md`, each tied to an exact revision.
- [ ] `npm run typecheck:runner-v2`, targeted ESLint, `npm run test:runner-v2`, and `npm run build` are green at the final revision (stop the dev server before the build; restart it afterward).
- [ ] Adversarial re-audit, one line of evidence each:
  - Stale evidence: an approval citing evidence from a prior attempt is still rejected (P1 gate unchanged) and a satisfied verdict citing a failing command is rejected (RG-2).
  - Missing evidence: a plan-critique finding with no evidence string, an expectation with no edge case, and a repair-cycle extension with no pause are all rejected.
  - Restart: terminate after `plan_critique.submitted`, after `repair.cycle_limit_reached`, and after `verifier.expectations_recorded`; each resumes without a duplicate model call.
  - Duplicate events: re-append every new event with its idempotency key; the projection is unchanged.
  - Authority bypass: a worker actor on `plan_critique.resolved`, a runner actor on `repair.cycle_limit_extended`, an Architect actor on `verifier.expectations_recorded`, and a non-verifier actor on `plan_critique.submitted` are all rejected.
  - Ordering: with a submitted blocking critique, `TaskScheduler.tick()` dispatches nothing; after resolution it dispatches.
- [ ] Legacy replay: a scheduler database recorded before P6.5 rebuilds identically (no `repair.policy_configured`, no `plan_critique.*`, single-pass verifier policy), and its completed run stays read-only.
- [ ] The SDD ledger row for 6.5 is `verified_100_percent` with the base and final revisions, or the phase reports the exact blocked output with the genuine decision named.
- [ ] Output exactly one of: `PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN` or `PHASE BLOCKED — GENUINE USER DECISION REQUIRED`.

# Self-review notes for the plan author

- Spec coverage: RG-1 → P6.5.5a–d; RG-2 → P6.5.1; RG-3 → P6.5.3; RG-4 → P6.5.2; RG-5 → P6.5.4; RG-6 → P6.5.6. Every sub-requirement in "Requirements assigned" names its packet and verification anchor.
- Type consistency across packets: `acceptedFailures` (P6.5.1) is reused by verifier verdicts in P6.5.6; `emptyProjectionForTest` and `verifier-run-fixture.ts` exports are introduced in P6.5.2/P6.5.3 and reused by P6.5.5 and P6.5.6; `recordContextPack` (P6.5.4) is called by the critic (P6.5.5b) and by verifier pass 1 (P6.5.6); `createInspectionTools` and `verifierExcludedModels` are exported in P6.5.5b and reused unchanged; `verifier.selection_required` with reason `plan_critique_no_independent_runtime` reuses the P4 reducer and UI without change.
- Deliberately not in scope (future ledger): soft per-task path hints and overlap-aware scheduling; giving the verifier `run_evidence_command` in its disposable worktree; a fresh-context completion review pack; task-level risk and per-task independent review; capability-profile model routing; ADR store.
