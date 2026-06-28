/* Certified WorkBench runner checks (run: npx tsx scripts/test-certified-workbench-runner.mts) */
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
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

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(toBenchmarkCaseV2(workBenchCase, "2026-06-28T10:00:00.000Z"));
await saveBenchmarkTeamComposition(team);

const runner = await startPassingBenchRunner("prepared-workbench-attempt");
try {
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

  check("certified WorkBench run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
  check("certified WorkBench attempt persists verifier score", attempt?.id === "prepared-workbench-attempt" && attempt.status === "passed" && attempt.verifiedQuality === 1, attempt);
  check("certified WorkBench verifier persists", verifiers[0]?.attemptId === attempt?.id && verifiers[0]?.passed, verifiers[0]);
  check("certified WorkBench artifacts persist", bundle.artifacts.some((artifact) => artifact.attemptId === attempt?.id && artifact.kind === "patch"), bundle.artifacts);
  check("certified WorkBench dashboard updates", summary.dashboard.summary.certifiedAttempts === 1 && summary.dashboard.summary.verifiedPassRate === 1, summary.dashboard.summary);
} finally {
  await runner.stop();
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
