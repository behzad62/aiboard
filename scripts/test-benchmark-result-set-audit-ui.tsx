import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BenchmarkResultSetAudit,
  buildBenchmarkResultSetAuditRows,
  latestCompletedResultSetIds,
} from "../components/benchmark/BenchmarkResultSetAudit";
import type {
  BenchmarkAttemptV2,
  BenchmarkResultSet,
} from "../lib/benchmark/types";

function resultSet(
  id: string,
  status: BenchmarkResultSet["status"],
  failure?: BenchmarkResultSet["failure"]
): BenchmarkResultSet {
  return {
    id,
    schemaVersion: 1,
    executionId: `execution-${id}`,
    anchorRunId: `run-${id}`,
    runIds: [`run-${id}`],
    configurationKey: `configuration-${id}`,
    configuration: {
      subjectKind: "model",
      displayName: `Model ${id}`,
      providerId: "account",
      modelId: `model-${id}`,
      reasoningEffort: "medium",
      roles: [],
      tracks: [
        {
          track: "gameiq",
          suiteId: "suite",
          caseManifest: [],
          maxTokens: 4096,
        },
      ],
    },
    expectedAttempts: [],
    status,
    createdAt: "2026-07-29T08:00:00.000Z",
    completedAt:
      status === "completed" ? "2026-07-29T09:00:00.000Z" : undefined,
    terminalAt:
      status === "pending" ? undefined : "2026-07-29T09:00:00.000Z",
    failure,
  };
}

function attempt(resultSetId: string): BenchmarkAttemptV2 {
  return {
    id: `attempt-${resultSetId}`,
    resultSetId,
    runId: `run-${resultSetId}`,
    caseId: "case",
    teamCompositionId: "team",
    mode: "certified",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-29T08:00:00.000Z",
    completedAt: "2026-07-29T09:00:00.000Z",
    verifiedQuality: 1,
    jobSuccessScore: 100,
    efficiencyScore: 90,
    costUsd: null,
    inputTokens: 120,
    outputTokens: 30,
    modelCalls: 3,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "harness",
    promptSetVersion: "prompt",
    scoringVersion: "score",
  };
}

const sets = [
  resultSet("pending", "pending"),
  resultSet("completed", "completed"),
  resultSet("provider", "failed", {
    kind: "provider",
    code: "provider_unavailable",
    message: "Provider unavailable. Authorization: Bearer secret-token-value",
  }),
  resultSet("cancelled", "cancelled"),
  resultSet("interrupted", "failed", {
    kind: "stale_pending",
    code: "interrupted",
    message: "Interrupted after C:\\Users\\someone\\project",
  }),
  resultSet("deleting", "deleting"),
];
const attempts = [...sets.map((set) => attempt(set.id)), attempt("legacy")];
attempts[attempts.length - 1]!.resultSetId = undefined;

const rows = buildBenchmarkResultSetAuditRows(sets, attempts);
assert.deepEqual(
  rows.map((row) => row.statusLabel),
  [
    "Running",
    "Published",
    "Provider failed",
    "Cancelled",
    "Interrupted",
    "Deleting",
    "Legacy evidence",
  ]
);
assert.equal(rows[0]!.physicalCalls, 3);
assert.equal(rows[0]!.totalTokens, 150);
assert.equal(rows.at(-1)!.canDelete, false);
assert.equal(rows.find((row) => row.id === "provider")!.canDelete, true);
assert.ok(!rows.find((row) => row.id === "provider")!.failureMessage.includes("secret-token-value"));
assert.ok(!rows.find((row) => row.id === "interrupted")!.failureMessage.includes("C:\\Users"));
assert.deepEqual([...latestCompletedResultSetIds(rows)], ["completed"]);

const markup = renderToStaticMarkup(
  <BenchmarkResultSetAudit
    rows={rows}
    deletingIds={new Set()}
    deleteInFlight={false}
    onDelete={() => undefined}
  />
);
for (const label of [
  "Published",
  "Running",
  "Provider failed",
  "Cancelled",
  "Interrupted",
  "Deleting",
  "Legacy evidence",
  "Physical calls",
  "Tokens",
  "GameIQ",
]) {
  assert.ok(markup.includes(label), label);
}
assert.ok(markup.includes("Delete snapshot"));
assert.ok(!markup.includes("secret-token-value"));
assert.ok(!markup.includes("C:\\Users"));

console.log("PASS");
