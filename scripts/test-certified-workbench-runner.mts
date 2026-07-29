/* Certified WorkBench runner checks (run: npx tsx scripts/test-certified-workbench-runner.mts) */
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
  listBenchmarkRuns,
  listBenchmarkToolCallTraces,
  listBenchmarkTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  createPendingBenchmarkResultSet,
  publishBenchmarkResultSetIfComplete,
} from "../lib/benchmark/certified/result-set-publication";
import { runCertifiedWorkBench } from "../lib/benchmark/workbench/certified-runner";
import { toBenchmarkCaseV2 } from "../lib/benchmark/workbench/case-loader";
import type { BenchmarkTeamComposition } from "../lib/benchmark/types";
import type { WorkBenchCase } from "../lib/benchmark/workbench/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function startPassingBenchRunner(preparedAttemptId: string): Promise<{
  url: string;
  token: string;
  stop: () => Promise<void>;
}> {
  const token = `workbench-runner-${Date.now()}`;
  const verifierJson = JSON.stringify({
    passed: true,
    score: 1,
    summary: "ok",
    assertions: [{ id: "verifier", label: "verifier", passed: true, weight: 1 }],
  });
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    await readJsonRequest(req);
    if (req.headers["x-runner-token"] !== token) {
      sendJsonResponse(res, 401, { error: "token required" });
      return;
    }
    switch (path) {
      case "/bench/prepare":
        sendJsonResponse(res, 200, {
          attemptId: preparedAttemptId,
          caseId: "workbench-certified-runner",
          root: "/fake/workspace",
        });
        return;
      case "/bench/run-verifier":
        sendJsonResponse(res, 200, {
          passed: true,
          score: 1,
          durationMs: 10,
          exitCode: 0,
          stdoutPreview: verifierJson,
          stderrPreview: "",
          resultJson: verifierJson,
          artifactIds: ["verifier-result.json"],
        });
        return;
      case "/bench/diff":
        sendJsonResponse(res, 200, { diff: "--- a/index.ts\n+++ b/index.ts\n+fixed\n" });
        return;
      case "/bench/cleanup":
        sendJsonResponse(res, 200, { removed: true });
        return;
      default:
        sendJsonResponse(res, 404, { error: `unknown endpoint ${path}` });
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake runner did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    stop: () => stopServer(server),
  };
}

async function readJsonRequest(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolveStop, rejectStop) => {
    server.close((error) => {
      if (error) rejectStop(error);
      else resolveStop();
    });
  });
}

const workBenchCase: WorkBenchCase = {
  schemaVersion: 1,
  id: "workbench-certified-runner",
  title: "Certified WorkBench fixture",
  description: "Patch a fixture and pass verifier.",
  difficulty: "easy",
  tags: ["fixture"],
  caseVersion: "0.1.0",
  prompt: {
    userRequest: "Fix the fixture.",
  },
  repo: {
    url: "fixture://inline",
    baseCommit: "fixture-base",
    shallowClone: true,
    fixtureHash: "fixture:certified-runner",
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 30,
    network: "dependency-only",
  },
  verifier: {
    command: "node verifier.js",
    resultFile: "verifier-result.json",
    timeoutSeconds: 10,
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 4,
  },
  scoring: {
    scoringVersion: "certified-v0.1",
    costTargetUsd: 1,
    timeTargetSeconds: 30,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-WORKBENCH-RUNNER",
    referenceSolutionPrivate: true,
  },
  allowedCommands: ["node verifier.js"],
};
const team: BenchmarkTeamComposition = {
  id: "team-certified-workbench",
  name: "Certified WorkBench build team",
  comboHash: "combo:certified-workbench",
  roles: [
    {
      role: "architect",
      slot: "architect",
      modelId: "openai:gpt-workbench",
      providerId: "openai",
      displayName: "GPT WorkBench",
      temperature: 0,
    },
  ],
};
const roleTeam: BenchmarkTeamComposition = {
  id: "team-certified-workbench-roles",
  name: "Architect Worker Reviewer team",
  comboHash: "combo:certified-workbench-roles",
  strategy: "architect_worker_reviewer",
  roles: [
    {
      role: "architect",
      slot: "01-architect",
      modelId: "openai:gpt-architect",
      providerId: "openai",
      displayName: "GPT Architect",
      temperature: 0,
    },
    {
      role: "worker",
      slot: "02-worker",
      modelId: "anthropic:claude-worker",
      providerId: "anthropic",
      displayName: "Claude Worker",
      temperature: 0,
    },
    {
      role: "reviewer",
      slot: "03-reviewer",
      modelId: "google:gemini-reviewer",
      providerId: "google",
      displayName: "Gemini Reviewer",
      temperature: 0,
    },
  ],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(toBenchmarkCaseV2(workBenchCase, "2026-06-28T10:00:00.000Z"));
await saveBenchmarkTeamComposition(team);
await saveBenchmarkTeamComposition(roleTeam);
const workBenchCaseV2 = toBenchmarkCaseV2(
  workBenchCase,
  "2026-06-28T10:00:00.000Z"
);
await createPendingBenchmarkResultSet({
  id: "result-certified-workbench",
  schemaVersion: 1,
  executionId: "execution-certified-workbench",
  anchorRunId: "run-certified-workbench",
  runIds: ["run-certified-workbench"],
  configurationKey: "workbench-certified-team",
  configuration: {
    subjectKind: "team",
    displayName: team.name,
    roles: team.roles.map((role) => ({
      role: role.role,
      slot: role.slot,
      providerId: role.providerId,
      modelId: role.modelId,
      reasoningEffort: role.reasoningEffort ?? "default",
      maxTokens: role.maxTokens ?? null,
    })),
    tracks: [{
      track: "workbench",
      suiteId: "suite-certified-workbench",
      caseManifest: [{
        caseId: workBenchCaseV2.id,
        caseVersion: workBenchCaseV2.caseVersion,
        scoringVersion: workBenchCaseV2.scoring.scoringVersion,
      }],
      maxTokens: null,
    }],
  },
  expectedAttempts: [{
    runId: "run-certified-workbench",
    track: "workbench",
    suiteId: "suite-certified-workbench",
    caseId: workBenchCaseV2.id,
    caseVersion: workBenchCaseV2.caseVersion,
    scoringVersion: workBenchCaseV2.scoring.scoringVersion,
    teamCompositionId: team.id,
  }],
});

const runner = await startPassingBenchRunner("prepared-workbench-attempt");
try {
  let pendingObservedBeforeWorkBenchAdmission = false;
  const traceStore: Array<{
    id: string;
    runId?: string;
    attemptId?: string;
    caseId?: string;
    modelId: string;
    providerId: string;
    startedAt: string;
    retryHistory: Array<{ attempt: number; status: "parsed"; message: string }>;
  }> = [];
  const summary = await runCertifiedBenchmark({
    runId: "run-certified-workbench",
    suiteId: "suite-certified-workbench",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    caseIds: [workBenchCase.id],
    teamCompositionIds: [team.id],
    certification: runHarnessCertification("aiboard-build-multi-worker"),
    resultSetOwnership: {
      byTeamCompositionId: {
        [team.id]: "result-certified-workbench",
      },
    },
    onSubjectCompleted: async (teamCompositionId) => {
      if (teamCompositionId === team.id) {
        await publishBenchmarkResultSetIfComplete(
          "result-certified-workbench"
        );
      }
    },
    runner: (context) =>
      runCertifiedWorkBench({
        context,
        cases: [workBenchCase],
        runner: { url: runner.url, token: runner.token },
        teamCompositionIds: [team.id],
        models: [
          {
            modelId: "openai:gpt-workbench",
            providerId: "openai",
            displayName: "GPT WorkBench",
          },
        ],
        runBuildDiscussion: async (_discussion, _models, _emit, hooks) => {
          pendingObservedBeforeWorkBenchAdmission ||=
            (await listBenchmarkResultSets()).some(
              (resultSet) =>
                resultSet.id === "result-certified-workbench" &&
                resultSet.status === "pending"
            );
          const benchmark = hooks?.benchmark;
          if (!benchmark) throw new Error("missing benchmark hook");
          traceStore.push({
            id: `${benchmark.attemptId}:trace:model`,
            runId: benchmark.runId,
            attemptId: benchmark.attemptId,
            caseId: benchmark.caseId,
            modelId: "openai:gpt-workbench",
            providerId: "openai",
            startedAt: "2026-06-28T10:00:00.000Z",
            retryHistory: [{ attempt: 1, status: "parsed", message: "ok" }],
          });
        },
        getBenchmarkTraces: () => traceStore,
      }),
  });

  const attempts = await listBenchmarkAttemptsV2();
  const verifiers = await listBenchmarkVerifierResults();
  const bundle = exportBenchmarkReportBundleV2();
  const attempt = attempts[0];
  const resultSet = (await listBenchmarkResultSets()).find(
    (item) => item.id === "result-certified-workbench"
  );

  check("certified WorkBench run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
  check(
    "WorkBench result manifest exists before build admission and publishes atomically",
    pendingObservedBeforeWorkBenchAdmission &&
      resultSet?.status === "completed" &&
      attempt?.resultSetId === resultSet.id,
    { pendingObservedBeforeWorkBenchAdmission, resultSet, attempt }
  );
  check("certified WorkBench attempt persists verifier score", attempt?.id === "prepared-workbench-attempt" && attempt.status === "passed" && attempt.verifiedQuality === 1, attempt);
  check("certified WorkBench verifier persists", verifiers[0]?.attemptId === attempt?.id && verifiers[0]?.passed, verifiers[0]);
  check("certified WorkBench artifacts persist", bundle.artifacts.some((artifact) => artifact.attemptId === attempt?.id && artifact.kind === "patch"), bundle.artifacts);
  check("certified WorkBench dashboard updates", summary.dashboard.summary.certifiedAttempts === 1 && summary.dashboard.summary.verifiedPassRate === 1, summary.dashboard.summary);
} finally {
  await runner.stop();
}

const roleRunner = await startPassingBenchRunner("prepared-workbench-role-attempt");
try {
  let capturedDiscussion: {
    judgeModelId?: string | null;
    reviewerModelId?: string | null;
    modelIds?: string;
  } | null = null;
  let capturedModels: string[] = [];
  const roleTraceStore: Array<{
    id: string;
    runId?: string;
    attemptId?: string;
    caseId?: string;
    modelId: string;
    providerId: string;
    startedAt: string;
    retryHistory: Array<{ attempt: number; status: "parsed"; message: string }>;
  }> = [];
  await runCertifiedBenchmark({
    runId: "run-certified-workbench-roles",
    suiteId: "suite-certified-workbench",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    caseIds: [workBenchCase.id],
    teamCompositionIds: [roleTeam.id],
    certification: runHarnessCertification("aiboard-build-multi-worker"),
    runner: (context) =>
      runCertifiedWorkBench({
        context,
        cases: [workBenchCase],
        runner: { url: roleRunner.url, token: roleRunner.token },
        teamCompositions: [roleTeam],
        runBuildDiscussion: async (discussion, models, _emit, hooks) => {
          const benchmark = hooks?.benchmark;
          if (!benchmark) throw new Error("missing benchmark hook");
          capturedDiscussion = {
            judgeModelId: discussion.judgeModelId,
            reviewerModelId: discussion.reviewerModelId,
            modelIds: discussion.modelIds,
          };
          capturedModels = models.map((item) => item.modelId);
          roleTraceStore.push({
            id: `${benchmark.attemptId}:trace:model`,
            runId: benchmark.runId,
            attemptId: benchmark.attemptId,
            caseId: benchmark.caseId,
            modelId: "anthropic:claude-worker",
            providerId: "anthropic",
            startedAt: "2026-06-28T10:00:00.000Z",
            retryHistory: [{ attempt: 1, status: "parsed", message: "ok" }],
          });
        },
        getBenchmarkTraces: () => roleTraceStore,
      }),
  });
  const discussionModelIds = capturedDiscussion?.modelIds
    ? (JSON.parse(capturedDiscussion.modelIds) as string[])
    : [];
  check(
    "certified WorkBench maps team roles into Build discussion",
    capturedDiscussion?.judgeModelId === "openai:gpt-architect" &&
      capturedDiscussion.reviewerModelId === "google:gemini-reviewer" &&
      JSON.stringify(discussionModelIds) === JSON.stringify(["anthropic:claude-worker"]) &&
      JSON.stringify(capturedModels) ===
        JSON.stringify([
          "openai:gpt-architect",
          "anthropic:claude-worker",
          "google:gemini-reviewer",
        ]),
    { capturedDiscussion, discussionModelIds, capturedModels }
  );
} finally {
  await roleRunner.stop();
}

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(
  toBenchmarkCaseV2(workBenchCase, "2026-06-28T10:00:00.000Z")
);
await saveBenchmarkTeamComposition(team);
const preparedRecoveryAttemptId = "prepared-workbench-recovery-attempt";
const recoveryRunner = await startPassingBenchRunner(preparedRecoveryAttemptId);
let durablePreparedOwners: unknown = null;
try {
  const recoverySummary = await runCertifiedBenchmark({
    runId: "run-certified-workbench-prepared-recovery",
    suiteId: "suite-certified-workbench",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    caseIds: [workBenchCase.id],
    teamCompositionIds: [team.id],
    certification: runHarnessCertification("aiboard-build-multi-worker"),
    runner: async (context) => {
      await runCertifiedWorkBench({
        context,
        cases: [workBenchCase],
        runner: { url: recoveryRunner.url, token: recoveryRunner.token },
        teamCompositionIds: [team.id],
        runBuild: async (buildInput) => {
          const running = (await listBenchmarkRuns()).find(
            (candidate) => candidate.id === context.runId
          );
          durablePreparedOwners = running
            ? (JSON.parse(running.summaryJson) as { attemptOwners?: unknown })
                .attemptOwners
            : null;
          await context.recordTrace({
            id: `${buildInput.attemptId}:trace:model`,
            runId: context.runId,
            caseId: workBenchCase.id,
            attemptId: buildInput.attemptId,
            modelId: "openai:gpt-workbench",
            providerId: "openai",
            participantId: team.id,
            schemaMode: "text",
            startedAt: context.startedAt,
            completedAt: new Date().toISOString(),
            latencyMs: 12,
            inputTokens: 17,
            outputTokens: 5,
            estimatedUsd: 0.02,
            rawResponse: "patched",
            retryHistory: [
              { attempt: 1, status: "parsed", message: "ok" },
            ],
          });
          await context.recordToolCall({
            id: `${buildInput.attemptId}:tool:run`,
            attemptId: buildInput.attemptId,
            caseId: workBenchCase.id,
            toolName: "run",
            command: "node verifier.js",
            status: "ok",
            exitCode: 0,
            startedAt: context.startedAt,
            completedAt: new Date().toISOString(),
            durationMs: 3,
          });
          return {
            traceIds: [`${buildInput.attemptId}:trace:model`],
            costUsd: 0.02,
            inputTokens: 17,
            outputTokens: 5,
            modelCalls: 1,
            toolCalls: 1,
            validToolCalls: 1,
            durationMs: 12,
          };
        },
      });
      throw new Error("Fatal after prepared WorkBench execution.");
    },
  });
  const recoveredAttempts = (await listBenchmarkAttemptsV2()).filter(
    (attempt) => attempt.runId === recoverySummary.runId
  );
  const recoveredTraces = (await listBenchmarkTraces()).filter(
    (trace) => trace.runId === recoverySummary.runId
  );
  const recoveredTools = (await listBenchmarkToolCallTraces()).filter(
    (trace) => trace.attemptId === preparedRecoveryAttemptId
  );
  const recoveredAttempt = recoveredAttempts[0];
  check(
    "WorkBench durably registers only the authoritative prepared owner before build work",
    Array.isArray(durablePreparedOwners) &&
      durablePreparedOwners.length === 1 &&
      (durablePreparedOwners[0] as { attemptId?: unknown }).attemptId ===
        preparedRecoveryAttemptId,
    durablePreparedOwners
  );
  check(
    "fatal post-preparation recovery creates exactly one prepared-id attempt",
    recoverySummary.status === "failed" &&
      recoveredAttempts.length === 1 &&
      recoveredAttempt?.id === preparedRecoveryAttemptId,
    { recoverySummary, recoveredAttempts }
  );
  check(
    "recovered WorkBench usage and tools remain exact-owned by the prepared id",
    recoveredTraces.length === 1 &&
      recoveredTraces[0]?.attemptId === preparedRecoveryAttemptId &&
      recoveredTools.length === 1 &&
      recoveredAttempt?.traceIds[0] === recoveredTraces[0]?.id &&
      recoveredAttempt.modelCalls === 1 &&
      recoveredAttempt.toolCalls === 1 &&
      recoveredAttempt.inputTokens === 17 &&
      recoveredAttempt.outputTokens === 5 &&
      recoveredAttempt.costUsd === 0.02,
    { recoveredAttempt, recoveredTraces, recoveredTools }
  );
} finally {
  await recoveryRunner.stop();
}

const conflictingWorkBenchCase: WorkBenchCase = {
  ...workBenchCase,
  id: "workbench-certified-runner-conflicting-case",
  title: "Certified WorkBench conflicting prepared owner fixture",
  contamination: {
    ...workBenchCase.contamination,
    canary: "AIBENCH-CERTIFIED-WORKBENCH-OWNER-CONFLICT",
  },
};
const duplicatePreparedAttemptId = "prepared-workbench-duplicate-attempt";

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(
  toBenchmarkCaseV2(workBenchCase, "2026-06-28T10:00:00.000Z")
);
await saveBenchmarkCaseV2(
  toBenchmarkCaseV2(conflictingWorkBenchCase, "2026-06-28T10:00:00.000Z")
);
await saveBenchmarkTeamComposition(team);
const duplicatePreparedRunner = await startPassingBenchRunner(
  duplicatePreparedAttemptId
);
let durableFirstPreparedOwner: unknown = null;
const duplicatePreparedBuildCases: string[] = [];
try {
  const duplicatePreparedSummary = await runCertifiedBenchmark({
    runId: "run-certified-workbench-duplicate-prepared-owner",
    suiteId: "suite-certified-workbench",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    caseIds: [workBenchCase.id, conflictingWorkBenchCase.id],
    teamCompositionIds: [team.id],
    certification: runHarnessCertification("aiboard-build-multi-worker"),
    runner: (context) =>
      runCertifiedWorkBench({
        context,
        cases: [workBenchCase, conflictingWorkBenchCase],
        runner: {
          url: duplicatePreparedRunner.url,
          token: duplicatePreparedRunner.token,
        },
        teamCompositionIds: [team.id],
        runBuild: async (buildInput) => {
          duplicatePreparedBuildCases.push(buildInput.case.id);
          const running = (await listBenchmarkRuns()).find(
            (candidate) => candidate.id === context.runId
          );
          durableFirstPreparedOwner = running
            ? (JSON.parse(running.summaryJson) as { attemptOwners?: unknown })
                .attemptOwners
            : null;
          await context.recordTrace({
            id: `${buildInput.attemptId}:trace:${buildInput.case.id}`,
            runId: context.runId,
            caseId: buildInput.case.id,
            attemptId: buildInput.attemptId,
            modelId: "openai:gpt-workbench",
            providerId: "openai",
            participantId: team.id,
            schemaMode: "text",
            startedAt: context.startedAt,
            completedAt: new Date().toISOString(),
            latencyMs: 7,
            inputTokens: 11,
            outputTokens: 3,
            estimatedUsd: 0.01,
            rawResponse: "first case evidence",
            retryHistory: [
              { attempt: 1, status: "parsed", message: "ok" },
            ],
          });
          await context.recordToolCall({
            id: `${buildInput.attemptId}:tool:${buildInput.case.id}`,
            attemptId: buildInput.attemptId,
            caseId: buildInput.case.id,
            toolName: "run",
            command: "node verifier.js",
            status: "ok",
            exitCode: 0,
            startedAt: context.startedAt,
            completedAt: new Date().toISOString(),
            durationMs: 2,
          });
          return {
            traceIds: [
              `${buildInput.attemptId}:trace:${buildInput.case.id}`,
            ],
            costUsd: 0.01,
            inputTokens: 11,
            outputTokens: 3,
            modelCalls: 1,
            toolCalls: 1,
            validToolCalls: 1,
            durationMs: 7,
          };
        },
      }),
  });
  const duplicatePreparedAttempts = (await listBenchmarkAttemptsV2()).filter(
    (attempt) => attempt.runId === duplicatePreparedSummary.runId
  );
  const duplicatePreparedVerifiers =
    await listBenchmarkVerifierResults();
  const duplicatePreparedTraces = (await listBenchmarkTraces()).filter(
    (trace) => trace.runId === duplicatePreparedSummary.runId
  );
  const duplicatePreparedTools = (await listBenchmarkToolCallTraces()).filter(
    (trace) => trace.attemptId === duplicatePreparedAttemptId
  );
  const duplicatePreparedArtifacts =
    exportBenchmarkReportBundleV2().artifacts;
  const recoveredFirstOwnerAttempt = duplicatePreparedAttempts.find(
    (attempt) => attempt.id === duplicatePreparedAttemptId
  );
  const genericConflictingCaseAttempt = duplicatePreparedAttempts.find(
    (attempt) => attempt.caseId === conflictingWorkBenchCase.id
  );
  check(
    "duplicate prepared owner aborts the certified WorkBench run fail-closed",
    duplicatePreparedSummary.status === "failed" &&
      JSON.stringify(duplicatePreparedBuildCases) ===
        JSON.stringify([workBenchCase.id]),
    { duplicatePreparedSummary, duplicatePreparedBuildCases }
  );
  check(
    "duplicate prepared owner preserves the first durable owner mapping",
    Array.isArray(durableFirstPreparedOwner) &&
      durableFirstPreparedOwner.length === 1 &&
      (durableFirstPreparedOwner[0] as {
        attemptId?: unknown;
        caseId?: unknown;
      }).attemptId === duplicatePreparedAttemptId &&
      (durableFirstPreparedOwner[0] as {
        attemptId?: unknown;
        caseId?: unknown;
      }).caseId === workBenchCase.id,
    durableFirstPreparedOwner
  );
  check(
    "conflicting case cannot overwrite attempt or verifier evidence under the duplicate id",
    duplicatePreparedAttempts.length === 2 &&
      recoveredFirstOwnerAttempt?.caseId === workBenchCase.id &&
      genericConflictingCaseAttempt?.id !== duplicatePreparedAttemptId &&
      genericConflictingCaseAttempt?.traceIds.length === 0 &&
      genericConflictingCaseAttempt?.modelCalls === 0 &&
      genericConflictingCaseAttempt?.toolCalls === 0 &&
      duplicatePreparedVerifiers.length === 1 &&
      duplicatePreparedVerifiers[0]?.attemptId ===
        duplicatePreparedAttemptId &&
      duplicatePreparedVerifiers[0]?.caseId === workBenchCase.id &&
      duplicatePreparedVerifiers[0]?.passed === true,
    { duplicatePreparedAttempts, duplicatePreparedVerifiers }
  );
  check(
    "conflicting case creates no model, tool, or artifact evidence",
    duplicatePreparedTraces.length === 1 &&
      duplicatePreparedTraces[0]?.caseId === workBenchCase.id &&
      duplicatePreparedTools.length === 1 &&
      duplicatePreparedTools[0]?.caseId === workBenchCase.id &&
      duplicatePreparedArtifacts.length === 2 &&
      duplicatePreparedArtifacts.every(
        (artifact) =>
          artifact.attemptId === duplicatePreparedAttemptId &&
          artifact.caseId === workBenchCase.id
      ),
    {
      duplicatePreparedTraces,
      duplicatePreparedTools,
      duplicatePreparedArtifacts,
    }
  );
} finally {
  await duplicatePreparedRunner.stop();
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
