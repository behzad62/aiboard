import assert from "node:assert/strict";
import test from "node:test";

import {
  assessChangeRisk,
  CHANGE_RISK_SIGNALS,
  isTestPath,
  resolveAuthorTier,
  SHARED_KERNEL_SURFACE,
  SIGNAL_ACCEPTED_FAILURES_WAIVER,
  SIGNAL_AUTHOR_MODEL_TIER,
  SIGNAL_MULTIPLE_ATTEMPTS,
  SIGNAL_SHARED_KERNEL_SURFACE,
  SIGNAL_SIZE,
  SIGNAL_SOURCE_WITHOUT_TEST,
} from "../src/change-risk.js";
import { assessBuildRisk } from "../src/risk-policy.js";

test("change-risk exports six signals as constants and stays distinct from risk-policy", () => {
  assert.deepEqual([...CHANGE_RISK_SIGNALS], [
    SIGNAL_AUTHOR_MODEL_TIER,
    SIGNAL_SHARED_KERNEL_SURFACE,
    SIGNAL_SOURCE_WITHOUT_TEST,
    SIGNAL_MULTIPLE_ATTEMPTS,
    SIGNAL_ACCEPTED_FAILURES_WAIVER,
    SIGNAL_SIZE,
  ]);
  assert.ok(SHARED_KERNEL_SURFACE.has("scheduler-store.ts"));
  // The two models coexist: risk-policy answers low/high for the final
  // verifier gate; change-risk answers low/medium/high for review depth.
  const build = assessBuildRisk({
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: { destructiveEffects: false, credentialEffects: false, externalWriteEffects: false, integrationConflict: false, changedPaths: [] },
  });
  assert.equal(build.risk, "low");
  const change = assessChangeRisk({
    authorModelId: "m", changedFiles: ["docs/note.md"], linesAdded: 2, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: false,
  });
  assert.equal(change.tier, "low");
});

test("change-risk is deterministic for identical inputs", () => {
  const input = {
    authorModelId: "worker_a",
    changedFiles: ["runner-v2/src/scheduler-store.ts", "runner-v2/test/scheduler-store.test.ts"],
    linesAdded: 120,
    linesRemoved: 30,
    attempts: 1,
    acceptedFailuresUsed: false,
  };
  const first = assessChangeRisk(input);
  const second = assessChangeRisk({ ...input, changedFiles: [...input.changedFiles].reverse() });
  assert.deepEqual(first, second);
});

test("a lower author tier raises risk; no-history uses the recorded default", () => {
  const base = {
    changedFiles: ["src/small.ts", "test/small.test.ts"],
    linesAdded: 10,
    linesRemoved: 0,
    attempts: 1,
    acceptedFailuresUsed: false,
  };
  const snapshot = {
    snapshotId: "snap_1",
    records: {
      good_model: { tasksReviewed: 10, defectsFound: 0 },
      bad_model: { tasksReviewed: 10, defectsFound: 5 },
    },
  };
  const frontier = assessChangeRisk({ ...base, authorModelId: "good_model", trackRecordSnapshot: snapshot });
  const fast = assessChangeRisk({ ...base, authorModelId: "bad_model", trackRecordSnapshot: snapshot });
  assert.equal(frontier.authorTier, "frontier");
  assert.equal(fast.authorTier, "fast");
  assert.ok(fast.score > frontier.score);
  const def = resolveAuthorTier({ authorModelId: "unknown_model", snapshot });
  assert.equal(def.usedDefault, true);
  assert.equal(def.tier, "standard");
});

test("source without test, multiple attempts, waiver, and kernel touch each raise risk", () => {
  const clean = assessChangeRisk({
    authorModelId: "m", changedFiles: ["src/a.ts", "test/a.test.ts"],
    linesAdded: 10, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: false,
  });
  const noTest = assessChangeRisk({
    authorModelId: "m", changedFiles: ["src/a.ts"],
    linesAdded: 10, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: false,
  });
  assert.ok(noTest.score > clean.score);
  const multi = assessChangeRisk({
    authorModelId: "m", changedFiles: ["src/a.ts", "test/a.test.ts"],
    linesAdded: 10, linesRemoved: 0, attempts: 3, acceptedFailuresUsed: false,
  });
  assert.ok(multi.score > clean.score);
  const waiver = assessChangeRisk({
    authorModelId: "m", changedFiles: ["src/a.ts", "test/a.test.ts"],
    linesAdded: 10, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: true,
  });
  assert.ok(waiver.score > clean.score);
  const kernel = assessChangeRisk({
    authorModelId: "m", changedFiles: ["runner-v2/src/scheduler-store.ts", "runner-v2/test/x.test.ts"],
    kernelSurface: [...SHARED_KERNEL_SURFACE],
    linesAdded: 10, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: false,
  });
  assert.ok(kernel.score > clean.score);
});

// ---------------------------------------------------------------------------
// Bounded investigation: thresholds measured against the fourteen P6.5 packet
// commits (non-merge, non-docs-open commits on codex/runner-v2-p6-5).
// Defect labels come ONLY from the P6.5 ledger's review-found defects.
// ---------------------------------------------------------------------------

interface PacketCommit {
  readonly sha: string;
  readonly files: readonly string[];
  readonly added: number;
  readonly removed: number;
  readonly attempts: number;
  readonly defectCarrying: boolean;
  readonly executionOnlyDefect: boolean;
  readonly triviallySafe: boolean;
}

const P65_COMMITS: readonly PacketCommit[] = [
  {
    sha: "9c437b47", defectCarrying: false, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 449, removed: 1,
    files: ["app/discussion/discussion-client.tsx", "components/BuildTaskBoard.tsx", "lib/client/runner-v2.ts",
      "runner-v2/src/acceptance-contracts.ts", "runner-v2/src/architect-tools.ts", "runner-v2/src/native-architect-runtime.ts",
      "runner-v2/src/scheduler-store.ts", "runner-v2/src/verifier-contracts.ts", "runner-v2/src/verifier-tools.ts",
      "runner-v2/test/acceptance-contracts.test.ts", "runner-v2/test/scheduler-store.test.ts",
      "runner-v2/test/support/evidence-fixtures.ts", "scripts/test-build-task-board-ui.tsx"],
  },
  {
    sha: "86c523ec", defectCarrying: false, executionOnlyDefect: false, triviallySafe: true, attempts: 1,
    added: 116, removed: 1,
    files: ["runner-v2/test/verifier-contracts.test.ts"],
  },
  {
    sha: "919ea31a", defectCarrying: true, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 425, removed: 28,
    files: ["components/RunnerV2ObservabilityPanel.tsx", "lib/client/runner-v2.ts", "runner-v2/src/native-architect-runtime.ts",
      "runner-v2/src/native-worker-driver.ts", "runner-v2/src/scheduler-store.ts", "runner-v2/src/task-contracts.ts",
      "runner-v2/src/worker-lifecycle-tools.ts", "runner-v2/test/guidance-review.test.ts", "runner-v2/test/native-worker-driver.test.ts",
      "runner-v2/test/request-replan.test.ts", "runner-v2/test/scheduler-store.test.ts",
      "runner-v2/test/support/projection-fixtures.ts", "scripts/test-runner-v2-observability.mts"],
  },
  {
    sha: "f49b8a12", defectCarrying: false, executionOnlyDefect: false, triviallySafe: false, attempts: 2,
    added: 220, removed: 6,
    files: ["runner-v2/src/scheduler-store.ts", "runner-v2/src/task-graph.ts", "runner-v2/test/native-worker-driver.test.ts",
      "runner-v2/test/request-replan.test.ts", "runner-v2/test/task-graph.test.ts"],
  },
  {
    sha: "d42bd321", defectCarrying: true, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 1577, removed: 297,
    files: ["app/discussion/discussion-client.tsx", "components/RunnerV2ObservabilityPanel.tsx", "lib/client/runner-v2.ts",
      "runner-v2/src/build-runtime-registry.ts", "runner-v2/src/build-runtime.ts", "runner-v2/src/build-spec.ts",
      "runner-v2/src/control-server.ts", "runner-v2/src/native-build-factory.ts", "runner-v2/src/native-build-manager.ts",
      "runner-v2/src/scheduler-store.ts", "runner-v2/test/build-runtime.test.ts", "runner-v2/test/build-spec-store.test.ts",
      "runner-v2/test/control-server.test.ts", "runner-v2/test/repair-cycles.test.ts",
      "runner-v2/test/support/verifier-run-fixture.ts", "runner-v2/test/verifier-contracts.test.ts",
      "scripts/test-runner-v2-client.mts", "scripts/test-runner-v2-observability.mts"],
  },
  {
    sha: "1aab6713", defectCarrying: true, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 1118, removed: 23,
    files: ["components/RunnerV2ObservabilityPanel.tsx", "lib/client/runner-v2.ts", "runner-v2/src/build-observability.ts",
      "runner-v2/src/build-runtime-registry.ts", "runner-v2/src/build-spec.ts", "runner-v2/src/context-assembler.ts",
      "runner-v2/src/context-manifest-store.ts", "runner-v2/src/control-server.ts", "runner-v2/src/native-architect-runtime.ts",
      "runner-v2/src/native-build-factory.ts", "runner-v2/src/native-build-manager.ts", "runner-v2/src/native-verifier-runtime.ts",
      "runner-v2/src/native-worker-driver.ts", "runner-v2/src/sqlite-context-manifest-store.ts",
      "runner-v2/test/build-spec-store.test.ts", "runner-v2/test/context-assembler.test.ts",
      "runner-v2/test/context-manifest-store.test.ts", "runner-v2/test/control-server.test.ts",
      "runner-v2/test/native-architect-runtime.test.ts", "runner-v2/test/native-build-manager.test.ts",
      "runner-v2/test/native-verifier-runtime.test.ts", "runner-v2/test/native-worker-driver.test.ts",
      "scripts/test-runner-v2-client.mts", "scripts/test-runner-v2-observability.mts"],
  },
  {
    sha: "002d2461", defectCarrying: false, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 1894, removed: 7,
    files: ["runner-v2/src/architect-tools.ts", "runner-v2/src/build-spec.ts", "runner-v2/src/plan-critique-contracts.ts",
      "runner-v2/src/scheduler-store.ts", "runner-v2/src/task-scheduler.ts", "runner-v2/src/verifier-contracts.ts",
      "runner-v2/test/build-spec-store.test.ts", "runner-v2/test/plan-critique-contracts.test.ts",
      "runner-v2/test/plan-critique.test.ts", "runner-v2/test/task-scheduler.test.ts"],
  },
  {
    sha: "fb1cfe67", defectCarrying: true, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 2352, removed: 10,
    files: ["runner-v2/src/agent-contracts.ts", "runner-v2/src/agent-loop.ts", "runner-v2/src/agent-prompts.ts",
      "runner-v2/src/native-plan-critic-runtime.ts", "runner-v2/src/native-verifier-runtime.ts",
      "runner-v2/src/plan-critique-authority.ts", "runner-v2/src/plan-critique-tools.ts",
      "runner-v2/test/agent-loop.test.ts", "runner-v2/test/native-plan-critic-runtime.test.ts",
      "runner-v2/test/plan-critique-authority.test.ts"],
  },
  {
    sha: "f0420eb6", defectCarrying: false, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 1608, removed: 16,
    files: ["lib/client/runner-v2.ts", "runner-v2/src/agent-contracts.ts", "runner-v2/src/agent-loop.ts",
      "runner-v2/src/architect-tools.ts", "runner-v2/src/build-runtime.ts", "runner-v2/src/native-architect-runtime.ts",
      "runner-v2/src/native-build-factory.ts", "runner-v2/src/scheduler-store.ts", "runner-v2/src/user-steering-contracts.ts",
      "runner-v2/test/build-runtime.test.ts", "runner-v2/test/native-architect-runtime.test.ts",
      "runner-v2/test/native-final-verification-factory.test.ts", "runner-v2/test/native-verifier-factory.test.ts",
      "runner-v2/test/plan-critique-runtime.test.ts", "runner-v2/test/user-steering.test.ts"],
  },
  {
    sha: "0b5bc926", defectCarrying: false, executionOnlyDefect: false, triviallySafe: false, attempts: 1,
    added: 876, removed: 2,
    files: ["components/RunnerV2ObservabilityPanel.tsx", "lib/client/runner-v2.ts",
      "runner-v2/test/plan-critique-runtime.test.ts", "scripts/test-runner-v2-client.mts",
      "scripts/test-runner-v2-observability.mts"],
  },
  {
    sha: "58f71603", defectCarrying: true, executionOnlyDefect: true, triviallySafe: false, attempts: 1,
    added: 1981, removed: 31,
    files: ["components/RunnerV2ObservabilityPanel.tsx", "lib/client/runner-v2.ts", "runner-v2/src/agent-contracts.ts",
      "runner-v2/src/agent-loop.ts", "runner-v2/src/agent-prompts.ts", "runner-v2/src/build-observability.ts",
      "runner-v2/src/build-runtime.ts", "runner-v2/src/build-spec.ts", "runner-v2/src/native-build-factory.ts",
      "runner-v2/src/native-verifier-runtime.ts", "runner-v2/src/scheduler-store.ts", "runner-v2/src/verification-workspace.ts",
      "runner-v2/src/verifier-contracts.ts", "runner-v2/src/verifier-tools.ts", "runner-v2/src/verifier-verdict-authority.ts",
      "runner-v2/test/agent-loop.test.ts", "runner-v2/test/build-spec-store.test.ts",
      "runner-v2/test/native-build-capabilities.test.ts", "runner-v2/test/native-plan-critic-runtime.test.ts",
      "runner-v2/test/native-verifier-factory.test.ts", "runner-v2/test/native-verifier-runtime.test.ts",
      "runner-v2/test/plan-critique-runtime.test.ts", "runner-v2/test/support/verifier-run-fixture.ts",
      "runner-v2/test/verification-workspace.test.ts", "runner-v2/test/verifier-contracts.test.ts",
      "runner-v2/test/verifier-observability.test.ts", "scripts/test-runner-v2-observability.mts"],
  },
  {
    sha: "cb84807f", defectCarrying: false, executionOnlyDefect: false, triviallySafe: true, attempts: 1,
    added: 1, removed: 1,
    files: ["runner-v2/test/filesystem-mutation-routing.test.ts"],
  },
  {
    sha: "b4bdad41", defectCarrying: false, executionOnlyDefect: false, triviallySafe: true, attempts: 1,
    added: 0, removed: 0,
    files: ["public/aiboard-account-provider-runner.zip", "public/aiboard-runner-v2.zip", "public/aiboard-workbench-runner.zip"],
  },
  {
    sha: "d61878b1", defectCarrying: false, executionOnlyDefect: false, triviallySafe: true, attempts: 1,
    added: 0, removed: 0,
    files: ["public/aiboard-account-provider-runner.zip"],
  },
];

test("P6.5 threshold measurement: fourteen commits replayed with the three-part criterion", () => {
  assert.equal(P65_COMMITS.length, 14);
  // The Runner V2 project policy selects the Runner V2 kernel set, so the
  // measurement passes it explicitly (an omitted surface is unconfigured).
  const kernelSurface = [...SHARED_KERNEL_SURFACE];
  const tiers = new Map(P65_COMMITS.map((commit) => {
    const assessment = assessChangeRisk({
      authorModelId: "p6.5-worker",
      changedFiles: commit.files,
      kernelSurface,
      linesAdded: commit.added,
      linesRemoved: commit.removed,
      attempts: commit.attempts,
      acceptedFailuresUsed: false,
    });
    return [commit.sha, assessment.tier] as const;
  }));
  for (const commit of P65_COMMITS.filter((c) => c.defectCarrying)) {
    assert.notEqual(tiers.get(commit.sha), "low", `${commit.sha} carries a ledger defect and must not be low`);
  }
  assert.ok(P65_COMMITS.some((c) => c.triviallySafe && tiers.get(c.sha) === "low"), "at least one trivially safe commit is low");
  assert.ok(P65_COMMITS.some((c) => c.executionOnlyDefect && tiers.get(c.sha) === "high"), "an execution-only-defect commit is high");
});

test("repair N9 (cycle 2): language test suffixes count as tests, lookalikes stay source", () => {
  for (const file of [
    "pkg/sched_test.go", "pkg/sched_test.py", "src/cart_test.rs",
    "test_thing.py", "spec/cart_spec.rb", "src/cart.spec.ts", "src/cart.test.ts",
    "tests/root.js", "test/root.js", "__tests__/root.js",
    "tests/Shop.Core.Tests/CartTests.cs", "src/UnitTest1.cs",
    "core/src/test/java/CTest.java", "x/FooTest.java",
  ]) {
    assert.equal(isTestPath(file), true, file);
  }
  for (const file of [
    "pkg/sched.go", "src/Contest.cs", "src/contest.java", "src/latest.ts",
    "tests/Shop.Core.Tests/Shop.Core.Tests.csproj",
  ]) {
    assert.equal(isTestPath(file), false, file);
  }
  const goPaired = assessChangeRisk({
    authorModelId: "m", changedFiles: ["pkg/sched.go", "pkg/sched_test.go"],
    kernelSurface: [], linesAdded: 10, linesRemoved: 0, attempts: 1, acceptedFailuresUsed: false,
  });
  const goSource = goPaired.signals.find((s) => s.signal === SIGNAL_SOURCE_WITHOUT_TEST);
  assert.equal(goSource?.points, 0);
  assert.match(goSource?.detail ?? "", /pairing ok/);
});

test("repair N8: shared-kernel surface is project-configurable with Runner V2 names as default", () => {
  const base = {
    authorModelId: "m",
    changedFiles: ["src/core/scheduler.py", "test/scheduler.test.ts"],
    linesAdded: 10,
    linesRemoved: 0,
    attempts: 1,
    acceptedFailuresUsed: false,
  };
  const runnerDefault = assessChangeRisk(base);
  assert.equal(runnerDefault.tier, "low");
  const defaultKernel = runnerDefault.signals.find((s) => s.signal === SIGNAL_SHARED_KERNEL_SURFACE);
  assert.equal(defaultKernel?.points, 0);
  assert.match(defaultKernel?.detail ?? "", /unconfigured/);
  const project = assessChangeRisk({ ...base, kernelSurface: ["scheduler.py"] });
  const kernel = project.signals.find((s) => s.signal === SIGNAL_SHARED_KERNEL_SURFACE);
  assert.equal(kernel?.points, 2);
  assert.match(kernel?.detail ?? "", /scheduler\.py/);
  assert.notEqual(project.digest, runnerDefault.digest);
  const again = assessChangeRisk({ ...base, kernelSurface: ["scheduler.py"] });
  assert.deepEqual(again, project);
});
