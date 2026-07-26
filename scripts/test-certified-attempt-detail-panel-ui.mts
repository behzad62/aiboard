/* Certified attempt detail panel UI checks (run: npx tsx scripts/test-certified-attempt-detail-panel-ui.mts) */
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttemptDetailPanel } from "../components/benchmark/certified/AttemptDetailPanel";
import { __replaceBenchmarkStoreForTests } from "../lib/benchmark/store";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const source = readFileSync("components/benchmark/certified/AttemptDetailPanel.tsx", "utf8");

check(
  "attempt detail renders canonical model-call and role effort details",
  !source.includes('Section title="Traces"') &&
    source.includes('title="Model calls"') &&
    source.includes("VariantRosterBadges") &&
    source.includes("teamRoleDetails") &&
    source.includes("modelTraceRows"),
  "model effort evidence should be visible in the latest certified attempt"
);
check(
  "attempt detail does not render generic run event section",
  !source.includes('Section title="Run events"') &&
    !source.includes('title="Model and harness events"'),
  "generic model and harness events should stay out of the detail panel"
);
check(
  "attempt detail keeps classified failures visible",
  source.includes('title="Artifacts and failures"') &&
    source.includes('title="Failures"'),
  "failure rows should remain visible for debugging"
);

__replaceBenchmarkStoreForTests({
  benchmarkAttemptsV2: [{
    id: "attempt-effort-panel",
    runId: "run-effort-panel",
    caseId: "case-effort-panel",
    teamCompositionId: "team-effort-panel",
    mode: "certified",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    status: "failed_model",
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: "2026-07-26T00:00:01.000Z",
    verifiedQuality: 0,
    jobSuccessScore: 0,
    efficiencyScore: 0,
    costUsd: null,
    inputTokens: 1,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: ["trace-effort-panel"],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "test",
  }],
  benchmarkTeamCompositions: [{
    id: "team-effort-panel",
    name: "Effort panel team",
    comboHash: "team-effort-panel",
    roles: [{
      role: "reviewer",
      slot: "reviewer",
      modelId: "foundry:claude-opus-5",
      providerId: "foundry",
      displayName: "Claude Opus",
      reasoningEffort: "xhigh",
      temperature: 0,
    }],
  }],
  benchmarkTraces: [{
    id: "trace-effort-panel",
    runId: "run-effort-panel",
    caseId: "case-effort-panel",
    attemptId: "attempt-effort-panel",
    modelId: "foundry:claude-opus-5",
    providerId: "foundry",
    reasoningEffort: "xhigh",
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: "2026-07-26T00:00:01.000Z",
    error: "provider failed visibly",
    retryHistory: [],
  }],
});
const rendered = renderToStaticMarkup(
  React.createElement(AttemptDetailPanel, {
    summary: {
      runId: "run-effort-panel",
      status: "completed",
      track: "teamiq",
      suiteId: "suite-effort-panel",
      startedAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:00:01.000Z",
      attemptCount: 1,
      verifierCount: 0,
      artifactCount: 0,
      traceCount: 1,
      eventCount: 0,
      toolCallCount: 0,
      failureCount: 0,
      dashboard: {},
    } as never,
  })
);
check(
  "rendered latest attempt shows per-role effort, model effort, and failed calls",
  rendered.includes("reviewer:") &&
    rendered.includes("Claude Opus") &&
    rendered.includes("Extra high") &&
    rendered.includes("foundry:claude-opus-5") &&
    rendered.includes("provider failed visibly"),
  rendered
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
