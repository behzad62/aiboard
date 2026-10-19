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
import { workerSelectionPreference } from "../src/native-worker-driver.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";

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

test("tasks spread over every healthy worker: least loaded first, a retry keeps its worker, poor workers last", () => {
  const router = new RuntimeRouter({ candidates: runtimes, health: new ProviderHealthRegistry() });
  const pick = (preference: Parameters<RuntimeRouter["selectWorker"]>[2]) =>
    router.selectWorker(["code"], new Set(), preference).runtime?.runtimeId;
  assert.equal(pick({}), "openai:gpt-code", "ties go to the owner's order");
  assert.equal(pick({ activeAssignments: new Map([["openai:gpt-code", 1]]) }), "anthropic:claude-code");
  assert.equal(
    pick({ activeAssignments: new Map([["openai:gpt-code", 2], ["anthropic:claude-code", 1]]) }),
    "anthropic:claude-code",
  );
  assert.equal(
    pick({ activeAssignments: new Map([["anthropic:claude-code", 3]]), affinity: ["anthropic:claude-code"] }),
    "anthropic:claude-code",
    "a retry stays on the worker that has its context cached",
  );
  assert.equal(pick({ affinity: ["openai:gpt-code"], demoted: new Set(["openai:gpt-code"]) }), "anthropic:claude-code");
  assert.equal(
    pick({ demoted: new Set(["openai:gpt-code", "anthropic:claude-code"]) }),
    "openai:gpt-code",
    "with every worker demoted, the build still runs",
  );
  assert.equal(
    router.selectWorker(["code"], new Set(["openai:gpt-code"]), { affinity: ["openai:gpt-code"] }).runtime?.runtimeId,
    "anthropic:claude-code",
    "failover never returns the failed worker",
  );
});

test("the selection preference is read from the run's own assignments", () => {
  const task = (id: string, status: string, attempt: number) => ({ id, status, attempt });
  const projection = {
    tasks: {
      a: task("a", "running", 1),
      b: task("b", "running", 1),
      c: task("c", "integrated", 1),
      d: task("d", "running", 3),
      e: task("e", "assigned", 2),
    },
    runtime: {
      workerAssignments: {
        "a:1": { runtimeId: "w1" },
        "b:1": { runtimeId: "w1" },
        "c:1": { runtimeId: "w2" },
        "d:1": { runtimeId: "w3" },
        "d:2": { runtimeId: "w3" },
        "d:3": { runtimeId: "w2" },
        "e:1": { runtimeId: "w2" },
      },
    },
  } as unknown as SchedulerProjection;
  const preference = workerSelectionPreference(projection, "e");
  assert.deepEqual([...preference.activeAssignments!], [["w1", 2], ["w2", 1]]);
  assert.deepEqual(preference.affinity, ["w2"]);
  assert.deepEqual([...preference.demoted!], ["w3"], "w3 lost two attempts and has no approved task");
  assert.deepEqual([...workerSelectionPreference(projection, "a").activeAssignments!], [["w1", 1], ["w2", 1]]);
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

test("verifier selection excludes Architect and accepted-author model identities", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const verifierRuntimes: AgentRuntimeCandidate[] = [
    ...runtimes,
    {
      runtimeId: "openrouter:openai/gpt-code",
      providerId: "openrouter",
      modelId: "openai/gpt-code",
      capabilities: ["code"],
      priority: 0,
    },
    {
      runtimeId: "bedrock:anthropic/claude-code",
      providerId: "bedrock",
      modelId: "anthropic/claude-code",
      capabilities: ["code"],
      priority: 0,
    },
    {
      runtimeId: "google:gemini-code",
      providerId: "google",
      modelId: "gemini-code",
      capabilities: ["code"],
      priority: 4,
    },
  ];
  const router = new RuntimeRouter({ candidates: verifierRuntimes, health });

  const selected = router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: [
      "openrouter:openai/gpt-code",
      "bedrock:anthropic/claude-code",
      "google:gemini-code",
    ],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: ["anthropic:claude-code"],
  });
  assert.equal(selected.status, "assigned");
  assert.equal(selected.runtime?.runtimeId, "google:gemini-code");
  if (selected.status === "assigned") {
    assert.equal(selected.independence, "distinct_model");
  }

  const sharedIdentity = router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: [
      "openrouter:openai/gpt-code",
      "bedrock:anthropic/claude-code",
    ],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: ["anthropic:claude-code"],
  });
  assert.equal(sharedIdentity.status, "assigned");
  if (sharedIdentity.status === "assigned") {
    assert.equal(sharedIdentity.runtime.runtimeId, "bedrock:anthropic/claude-code");
    assert.equal(sharedIdentity.independence, "fresh_context");
  }
});

test("verifier selection prefers a distinct model, falls back to fresh context, and stays unavailable when every candidate is excluded", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const router = new RuntimeRouter({
    candidates: [
      ...runtimes,
      {
        runtimeId: "google:gemini-code",
        providerId: "google",
        modelId: "gemini-code",
        capabilities: ["code"],
        priority: 4,
      },
    ],
    health,
  });
  const distinct = router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: ["openai:gpt-code", "google:gemini-code"],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: [],
  });
  assert.equal(distinct.status, "assigned");
  if (distinct.status === "assigned") {
    assert.equal(distinct.runtime.runtimeId, "google:gemini-code");
    assert.equal(distinct.independence, "distinct_model");
  }

  const onlyArchitect = router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: ["openai:gpt-code"],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: [],
  });
  assert.equal(onlyArchitect.status, "assigned");
  if (onlyArchitect.status === "assigned") {
    assert.equal(onlyArchitect.runtime.runtimeId, "openai:gpt-code");
    assert.equal(onlyArchitect.independence, "fresh_context");
  }

  assert.deepEqual(router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: ["google:gemini-code"],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: [],
    excludedRuntimeIds: new Set(["google:gemini-code"]),
  }), {
    status: "unavailable",
    reason: "no_independent_healthy_capability_match",
    requiredCapabilities: ["code"],
  });

  health.recordFailure("google", {
    kind: "provider_unavailable",
    message: "provider down",
  });
  assert.deepEqual(router.selectVerifier({
    requiredCapabilities: ["code"],
    candidateRuntimeIds: ["google:gemini-code"],
    architectRuntimeId: "openai:gpt-code",
    acceptedChangeAuthorRuntimeIds: [],
  }), {
    status: "unavailable",
    reason: "no_independent_healthy_capability_match",
    requiredCapabilities: ["code"],
  });
});

test("the owner's Reviewer ranks first, even on the Architect's model, and falls back when unavailable or an author", () => {
  const health = new ProviderHealthRegistry({ clock: () => 1_000 });
  const candidates: AgentRuntimeCandidate[] = [
    { runtimeId: "openai:gpt-code", providerId: "openai", modelId: "gpt-code", capabilities: ["code"], priority: 0 },
    { runtimeId: "openai:gpt-code@high", providerId: "openai", modelId: "gpt-code", capabilities: ["code"], priority: 1 },
    { runtimeId: "anthropic:claude-code", providerId: "anthropic", modelId: "claude-code", capabilities: ["code"], priority: 2 },
    { runtimeId: "google:gemini-code", providerId: "google", modelId: "gemini-code", capabilities: ["code"], priority: 3 },
  ];
  const all = candidates.map((candidate) => candidate.runtimeId);
  const select = (router: RuntimeRouter, authors: string[] = []) => {
    const selection = router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: all,
      architectRuntimeId: "openai:gpt-code",
      acceptedChangeAuthorRuntimeIds: authors,
    });
    assert.equal(selection.status, "assigned");
    return selection.status === "assigned" ? [selection.runtime.runtimeId, selection.independence] : [];
  };

  // A distinct Reviewer below another distinct candidate in priority still wins.
  const google = new RuntimeRouter({ candidates, health, preferredVerifierRuntimeId: "google:gemini-code" });
  assert.deepEqual(select(google), ["google:gemini-code", "distinct_model"]);
  // The owner may deliberately review with the Architect's model at another effort: fresh context.
  const sameModel = new RuntimeRouter({ candidates, health, preferredVerifierRuntimeId: "openai:gpt-code@high" });
  assert.deepEqual(select(sameModel), ["openai:gpt-code@high", "fresh_context"]);
  // A Reviewer that authored the change never reviews it.
  assert.deepEqual(select(google, ["google:gemini-code"]), ["anthropic:claude-code", "distinct_model"]);
  // Without a preference the priority-ordered distinct choice is unchanged.
  assert.deepEqual(select(new RuntimeRouter({ candidates, health })), ["anthropic:claude-code", "distinct_model"]);
  // An unavailable Reviewer falls back to the next candidate.
  health.recordFailure("google", { kind: "usage_limit", message: "no credits" });
  assert.deepEqual(select(google), ["anthropic:claude-code", "distinct_model"]);
});

test("verifier selection fails closed for unknown configured or author runtimes", () => {
  const router = new RuntimeRouter({
    candidates: runtimes,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  assert.throws(
    () => router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["missing:verifier"],
      architectRuntimeId: "openai:gpt-code",
      acceptedChangeAuthorRuntimeIds: [],
    }),
    /unknown verifier candidate/i
  );
  assert.throws(
    () => router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["anthropic:claude-code"],
      architectRuntimeId: "openai:gpt-code",
      acceptedChangeAuthorRuntimeIds: ["missing:author"],
    }),
    /unknown accepted change author/i
  );
});

test("provider failures are classified from transport metadata before routing", () => {
  assert.equal(
    classifyProviderFailure({ status: 429, code: "usage_limit_reached", message: "limit" }).kind,
    "usage_limit"
  );
  assert.equal(
    classifyProviderFailure({
      status: 200,
      message: "The usage limit has been reached",
      name: "ProviderTransportError",
    }).kind,
    "usage_limit",
    "stream errors arrive after an HTTP 200 response but must still enter cooldown"
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
