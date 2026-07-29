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
  BenchmarkFailure,
  BenchmarkModelCallTrace,
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
  resultSet("unpublished-completed", "completed"),
  resultSet("provider", "failed", {
    kind: "infrastructure",
    code: "unpublished_infrastructure_failure",
    message: "Provider unavailable. Authorization: Bearer secret-token-value",
  }),
  resultSet("infrastructure", "failed", {
    kind: "infrastructure",
    code: "persistence_failed",
    message: "Could not persist the result set.",
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
attempts.find((item) => item.resultSetId === "provider")!.status =
  "provider_unavailable";
attempts[attempts.length - 1]!.resultSetId = undefined;
const infrastructureSet = sets.find((set) => set.id === "infrastructure")!;
infrastructureSet.configuration = {
  subjectKind: "team",
  displayName: "Builder team",
  strategy: "architect_worker",
  roles: [
    {
      role: "architect",
      slot: "architect",
      providerId: "account",
      modelId: "architect-model",
      reasoningEffort: "high",
      maxTokens: 12288,
    },
    {
      role: "worker",
      slot: "worker",
      providerId: "local",
      modelId: "worker-model",
      reasoningEffort: "medium",
      maxTokens: 4096,
    },
  ],
  tracks: infrastructureSet.configuration.tracks,
};

const traceOnlySet = resultSet("trace-only", "failed", {
  kind: "infrastructure",
  code: "unpublished_infrastructure_failure",
  message: "Provider unavailable.",
});
traceOnlySet.configuration.displayName =
  "Authorization: Bearer secret-token-value C:\\Users\\someone\\private-model";
traceOnlySet.configuration.modelId =
  "C:\\Users\\someone\\models\\private-model";
traceOnlySet.configuration.tracks = [
  {
    track: "gameiq",
    suiteId: "suite-v2",
    caseManifest: [
      {
        caseId: "case-a",
        caseVersion: "case-v3",
        scoringVersion: "score-v5",
      },
    ],
    maxTokens: 8192,
  },
];
const traceOnlyTrace: BenchmarkModelCallTrace = {
  id: "trace-only-call",
  resultSetId: traceOnlySet.id,
  runId: traceOnlySet.anchorRunId,
  modelId: "private-model",
  providerId: "account",
  startedAt: traceOnlySet.createdAt,
  completedAt: traceOnlySet.terminalAt,
  inputTokens: 321,
  outputTokens: 79,
  totalTokens: 400,
  retryHistory: [
    {
      attempt: 1,
      status: "provider_error",
      message: "Provider unavailable.",
    },
  ],
};
const providerFailure: BenchmarkFailure = {
  id: "failure-provider",
  resultSetId: "provider",
  runId: "run-provider",
  attemptId: "attempt-provider",
  caseId: "case",
  domain: "model-call",
  source: "provider",
  code: "provider_unavailable",
  severity: "error",
  message: "Provider unavailable.",
  createdAt: "2026-07-29T09:00:00.000Z",
};
const rows = buildBenchmarkResultSetAuditRows(
  [...sets, traceOnlySet],
  attempts,
  {
    traces: [traceOnlyTrace],
    failures: [providerFailure],
    publishedResultSetIds: new Set(["completed"]),
  }
);
assert.deepEqual(
  rows.map((row) => row.statusLabel),
  [
    "Running",
    "Published",
    "Unpublished",
    "Provider failed",
    "Unpublished",
    "Cancelled",
    "Interrupted",
    "Deleting",
    "Provider failed",
    "Legacy evidence",
  ]
);
assert.equal(rows[0]!.physicalCalls, 3);
assert.equal(rows[0]!.totalTokens, 150);
assert.equal(rows.at(-1)!.canDelete, false);
assert.equal(rows.find((row) => row.id === "provider")!.canDelete, true);
assert.ok(!rows.find((row) => row.id === "provider")!.failureMessage.includes("secret-token-value"));
assert.ok(!rows.find((row) => row.id === "interrupted")!.failureMessage.includes("C:\\Users"));
assert.equal(rows.find((row) => row.id === "trace-only")!.physicalCalls, 1);
assert.equal(rows.find((row) => row.id === "trace-only")!.totalTokens, 400);
assert.match(
  rows.find((row) => row.id === "infrastructure")!.configuration,
  /architect: account\/architect-model.*high reasoning.*12,288 tokens.*worker: local\/worker-model.*4,096 tokens/
);
assert.ok(!rows.find((row) => row.id === "trace-only")!.subject.includes("secret-token-value"));
assert.ok(!rows.find((row) => row.id === "trace-only")!.subject.includes("C:\\Users"));
assert.match(
  rows.find((row) => row.id === "trace-only")!.tracks.join(" "),
  /suite-v2.*8,192.*case-a@case-v3.*score-v5/
);
assert.deepEqual([...latestCompletedResultSetIds(rows)].sort(), [
  "completed",
  "unpublished-completed",
]);

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
  "Unpublished",
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
