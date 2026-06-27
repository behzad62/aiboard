/* WorkBench executor checks (run: npx tsx scripts/test-workbench-executor.mts) */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBenchRunner, runBenchCommand } from "../lib/client/bench-runner";
import { executeWorkBenchVerifierOnly } from "../lib/benchmark/workbench/executor";
import type { WorkBenchCase } from "../lib/benchmark/workbench/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<unknown>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
}

async function waitForHealth(url: string, token: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = await checkBenchRunner({ url, token });
    if (health.ok) return;
    lastError = health.error ?? JSON.stringify(health);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`bench runner did not become healthy: ${lastError}`);
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.killed || child.exitCode !== null) {
      resolveStop();
      return;
    }
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "aiboard-workbench-executor-"));
const fixtureRoot = join(root, "fixture");
const runsRoot = join(root, ".aiboard-bench", "runs");
const port = 20_000 + Math.floor(Math.random() * 10_000);
const token = `test-token-${Date.now()}`;
const url = `http://127.0.0.1:${port}`;
const modelCommand = `node -e "require('fs').writeFileSync('index.js','module.exports = (a,b) => a * b;')"`;
const verifierCommand = "node verifier.js";

await mkdir(fixtureRoot, { recursive: true });
await writeFile(join(fixtureRoot, ".keep"), "", "utf8");
await writeFile(join(fixtureRoot, "index.js"), "module.exports = (a,b) => a - b;\n", "utf8");
await writeFile(
  join(fixtureRoot, "verifier.js"),
  [
    "const fs = require('fs');",
    "const add = require('./index.js');",
    "const passed = add(2, 3) === 5;",
    "const result = {",
    "  passed,",
    "  score: passed ? 1 : 0,",
    "  summary: passed ? 'ok' : 'bad math',",
    "  assertions: [{ id: 'add', label: 'add returns a sum', passed, weight: 1 }],",
    "};",
    "fs.writeFileSync('verifier-result.json', JSON.stringify(result));",
    "console.log(JSON.stringify(result));",
    "process.exit(passed ? 0 : 1);",
  ].join("\n"),
  "utf8"
);

const caseRecord: WorkBenchCase = {
  schemaVersion: 1,
  id: "workbench-executor-0001",
  title: "Fix add",
  description: "The exported function must return a sum.",
  difficulty: "easy",
  tags: ["fixture"],
  caseVersion: "0.1.0",
  prompt: {
    userRequest: "Fix the add function so it returns a + b.",
    publicContext: "Run the verifier before reporting success.",
  },
  repo: {
    url: fixtureRoot,
    baseCommit: "fixture-base",
    shallowClone: true,
    fixtureHash: "fixture:add",
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 30,
    network: "dependency-only",
  },
  verifier: {
    command: verifierCommand,
    resultFile: "verifier-result.json",
    timeoutSeconds: 10,
  },
  budget: { maxUsd: 1, maxWallClockSeconds: 30 },
  scoring: {
    scoringVersion: "certified-v0.1",
    costTargetUsd: 1,
    timeTargetSeconds: 30,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-WORKBENCH-EXECUTOR",
    referenceSolutionPrivate: true,
  },
  allowedCommands: [modelCommand, verifierCommand],
};

await expectReject(
  "executor refuses verifier-only scoring without runBuild",
  () =>
    executeWorkBenchVerifierOnly({
      case: caseRecord,
      runner: { url: "http://127.0.0.1:9", token },
      attemptId: "attempt-missing-runbuild",
      runId: "run-missing-runbuild",
      teamCompositionId: "team-fixture",
    }),
  /runBuild/i
);

const child = spawn(process.execPath, [
  join(repoRoot, "scripts", "bench-runner.mjs"),
  "--port",
  String(port),
  "--token",
  token,
  "--root",
  runsRoot,
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  await waitForHealth(url, token);
  const result = await executeWorkBenchVerifierOnly({
    case: caseRecord,
    runner: { url, token },
    attemptId: "attempt-workbench-executor",
    runId: "run-workbench-executor",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async (context) => {
      check("executor passes canonical attempt id to build callback", context.attemptId === "attempt-workbench-executor", context);
      const commandResult = await runBenchCommand(context.runner, {
        attemptId: context.attemptId,
        command: modelCommand,
        timeoutSeconds: 10,
      });
      return {
        traceIds: ["trace-model-call-1"],
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        modelCalls: 1,
        toolCalls: 1,
        validToolCalls: commandResult.exitCode === 0 ? 1 : 0,
      };
    },
  });

  check("executor runs model path before verifier", result.attempt.modelCalls === 1 && result.attempt.traceIds.includes("trace-model-call-1"), result.attempt);
  check("failed verifier maps to failed_verifier", result.attempt.status === "failed_verifier", result.attempt);
  check("executor returns verifier result", result.verifierResult.passed === false && result.parsedVerifierResult.score === 0, result.verifierResult);
  check("executor creates patch artifact", result.artifacts.some((artifact) => artifact.kind === "patch" && artifact.content.includes("a * b")), result.artifacts);
  check("executor creates verifier artifact", result.artifacts.some((artifact) => artifact.id === "attempt-workbench-executor:verifier-result"), result.artifacts);
  check("attempt references concrete artifacts", result.attempt.artifactIds.includes("attempt-workbench-executor:patch") && result.attempt.artifactIds.includes("attempt-workbench-executor:verifier-result"), result.attempt.artifactIds);
} catch (error) {
  check("workbench executor contract did not throw", false, {
    error: error instanceof Error ? error.message : String(error),
    stderr,
  });
} finally {
  await stop(child);
  await rm(root, { recursive: true, force: true });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
