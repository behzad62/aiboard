import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderHealthRegistry,
  classifyProviderFailure,
} from "../src/provider-health.js";
import {
  RuntimeRouter,
  type AgentRuntimeCandidate,
  type WorkerHandoffPackage,
} from "../src/runtime-router.js";

const runtimes: AgentRuntimeCandidate[] = [
  {
    runtimeId: "openai:gpt-code",
    providerId: "openai",
    modelId: "gpt-code",
    capabilities: ["code", "vision"],
    priority: 1,
  },
  {
    runtimeId: "anthropic:claude-code",
    providerId: "anthropic",
    modelId: "claude-code",
    capabilities: ["code"],
    priority: 2,
  },
  {
    runtimeId: "local:text-only",
    providerId: "local",
    modelId: "text-only",
    capabilities: ["text"],
    priority: 3,
  },
];

test("confirmed usage limit cooldown prevents wasteful worker retries", () => {
  let now = 1_000;
  const health = new ProviderHealthRegistry({ clock: () => now });
  const router = new RuntimeRouter({ candidates: runtimes, health });
  router.recordFailure("openai:gpt-code", {
    kind: "usage_limit",
    message: "Usage limit reached",
    retryAfterMs: 60_000,
  });
  const selected = router.selectWorker(["code"]);
  assert.equal(selected.status, "assigned");
  assert.equal(selected.runtime?.runtimeId, "anthropic:claude-code");

  router.recordFailure("anthropic:claude-code", {
    kind: "provider_unavailable",
    message: "Provider unavailable",
    retryAfterMs: 30_000,
  });
  assert.equal(router.selectWorker(["code"]).status, "unavailable");
  now += 30_001;
  assert.equal(
    router.selectWorker(["code"]).runtime?.runtimeId,
    "anthropic:claude-code",
    "the longer usage-limit cooldown must still suppress OpenAI"
  );
  now += 30_000;
  assert.equal(router.selectWorker(["code"]).runtime?.runtimeId, "openai:gpt-code");
});

test("worker failure automatically hands the same checkpoint to a compatible runtime", () => {
  const health = new ProviderHealthRegistry({ clock: () => 10_000 });
  const decisions: unknown[] = [];
  const router = new RuntimeRouter({
    candidates: runtimes,
    health,
    onDecision: (decision) => decisions.push(decision),
  });
  const handoff: WorkerHandoffPackage = {
    runId: "run_1",
    taskId: "task_a",
    sessionId: "worker_task_a_attempt_1",
    attempt: 1,
    checkpointArtifactHash: "a".repeat(64),
    workspacePath: "C:/work/task_a",
  };
  const route = router.routeWorkerFailure({
    currentRuntimeId: "openai:gpt-code",
    requiredCapabilities: ["code"],
    failure: { kind: "provider_unavailable", message: "503" },
    handoff,
  });
  assert.equal(route.status, "assigned");
  assert.equal(route.runtime?.runtimeId, "anthropic:claude-code");
  assert.deepEqual(route.handoff, handoff);
  assert.equal(decisions.length, 1);
  assert.equal(router.selectWorker(["vision"]).status, "unavailable");
});

test("provider health snapshot survives restart and success clears cooldown", () => {
  let now = 5_000;
  const first = new ProviderHealthRegistry({ clock: () => now });
  first.recordFailure("openai", {
    kind: "rate_limit",
    message: "429",
    retryAfterMs: 20_000,
  });
  const recovered = new ProviderHealthRegistry({
    clock: () => now,
    initial: first.snapshot(),
  });
  assert.equal(recovered.isAvailable("openai"), false);
  recovered.recordSuccess("openai");
  assert.equal(recovered.isAvailable("openai"), true);
  now += 20_001;
  assert.equal(first.isAvailable("openai"), true);
});

test("all compatible workers unavailable returns a pause decision", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const router = new RuntimeRouter({ candidates: runtimes, health });
  for (const runtime of runtimes.slice(0, 2)) {
    router.recordFailure(runtime.runtimeId, {
      kind: "authentication",
      message: "Login expired",
    });
  }
  const selection = router.selectWorker(["code"]);
  assert.deepEqual(selection, {
    status: "unavailable",
    reason: "no_healthy_capability_match",
    requiredCapabilities: ["code"],
  });
});

test("a general-purpose native runtime does not hard-reject Architect capability labels", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const router = new RuntimeRouter({
    health,
    candidates: [{
      runtimeId: "general:agent",
      providerId: "general",
      modelId: "agent",
      capabilities: ["*"],
      priority: 1,
    }],
  });
  const selected = router.selectWorker(["repo-edit", "javascript", "tests"]);
  assert.equal(selected.status, "assigned");
  assert.equal(selected.runtime?.runtimeId, "general:agent");
});

test("Architect handoff always waits for explicit user selection", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const router = new RuntimeRouter({ candidates: runtimes, health });
  const handoff = router.selectArchitectHandoff(["code"]);
  assert.equal(handoff.status, "user_selection_required");
  assert.deepEqual(
    handoff.candidates.map((candidate) => candidate.runtimeId),
    ["openai:gpt-code", "anthropic:claude-code"]
  );
  assert.equal("runtime" in handoff, false, "the router must not auto-select an Architect");
  assert.throws(
    () => router.confirmArchitectHandoff("local:text-only", ["code"]),
    /capabilities/i
  );
  assert.equal(
    router.confirmArchitectHandoff("anthropic:claude-code", ["code"]).runtimeId,
    "anthropic:claude-code"
  );
});

test("provider failures are classified from transport metadata before routing", () => {
  assert.equal(
    classifyProviderFailure({ status: 429, code: "usage_limit_reached", message: "limit" }).kind,
    "usage_limit"
  );
  assert.equal(
    classifyProviderFailure({ status: 429, code: "rate_limit", message: "slow down" }).kind,
    "rate_limit"
  );
  assert.equal(
    classifyProviderFailure({ status: 401, message: "expired" }).kind,
    "authentication"
  );
  assert.equal(
    classifyProviderFailure({ status: 503, message: "offline" }).kind,
    "provider_unavailable"
  );
  assert.equal(classifyProviderFailure(new Error("socket reset")).kind, "transient");
});
