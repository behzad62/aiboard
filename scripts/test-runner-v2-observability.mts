import assert from "node:assert/strict";

import { runnerObservabilitySummary } from "../components/RunnerV2ObservabilityPanel";

const summary = runnerObservabilitySummary({
  runId: "run_1",
  budget: {
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    },
    lastSequence: 42,
  },
  agents: [{
    sessionId: "worker:run_1:T1:1",
    actor: { role: "worker", id: "worker_1" },
    status: "submitted",
    turns: 4,
    lastSequence: 8,
  }],
  tools: [{
    sequence: 1,
    sessionId: "worker:run_1:T1:1",
    callId: "read_1",
    toolName: "fs.read",
    status: "completed",
    occurredAt: "2026-07-12T00:00:00.000Z",
    isError: false,
  }],
  evidence: [],
  memories: [],
  skills: [{
    id: "built-in:verification",
    name: "verification",
    description: "Gather fresh evidence",
    source: "built-in",
    digest: "a".repeat(64),
  }],
  processes: [],
});

assert.deepEqual(summary, {
  modelCalls: 9,
  toolCalls: 27,
  totalTokens: 15_000,
  agents: 1,
  suspendedAgents: 0,
  toolErrors: 0,
  evidence: 0,
  memories: 0,
  skills: 1,
  runningProcesses: 0,
});

console.log("PASS Runner V2 observability panel");
