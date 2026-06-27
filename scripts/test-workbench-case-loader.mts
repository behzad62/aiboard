/* WorkBench case loader checks (run: npx tsx scripts/test-workbench-case-loader.mts) */
import {
  createWorkBenchCaseHash,
  loadWorkBenchCaseFromJson,
  toBenchmarkCaseV2,
} from "../lib/benchmark/workbench/case-loader";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function expectThrow(name: string, action: () => unknown, pattern: RegExp): void {
  try {
    action();
    check(name, false, "did not throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, pattern.test(message), message);
  }
}

const manifest = {
  schemaVersion: 1,
  id: "workbench-ts-0001",
  title: "Add CSV report output",
  description: "Add a CSV output option while preserving JSON output.",
  difficulty: "medium",
  tags: ["typescript", "cli"],
  caseVersion: "0.1.0",
  prompt: {
    userRequest: "Add --format csv to the report command.",
    publicContext: "The existing JSON format must not change.",
    hiddenNotesHash: "hidden:abc123",
  },
  repo: {
    url: "fixture://workbench-ts-0001",
    baseCommit: "fixture-base",
    shallowClone: true,
    fixtureHash: "fixture:abc123",
  },
  environment: {
    timeoutSeconds: 1200,
    memoryMb: 2048,
    network: "dependency-only",
    setupCommand: "npm ci",
  },
  verifier: {
    command: "npm test -- --runInBand",
    resultFile: "verifier-result.json",
    timeoutSeconds: 120,
    publicCommand: "npm test",
  },
  budget: {
    maxUsd: 2,
    maxWallClockSeconds: 1200,
    maxModelCalls: 20,
    maxToolCalls: 100,
    maxInputTokens: 200_000,
    maxOutputTokens: 50_000,
  },
  scoring: {
    scoringVersion: "certified-v0.1",
    costTargetUsd: 1,
    timeTargetSeconds: 600,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CANARY-0001",
    referenceSolutionPrivate: true,
    publicAfter: "2027-01-01",
  },
};

const loaded = loadWorkBenchCaseFromJson(JSON.stringify(manifest));

check("case loader preserves required identity fields", loaded.id === manifest.id && loaded.title === manifest.title, loaded);
check("case loader defaults to local runner environment", loaded.environment.type === "local-runner", loaded.environment);
check("case loader records setup and verifier commands in allowlist", loaded.allowedCommands.includes("npm ci") && loaded.allowedCommands.includes("npm test -- --runInBand"), loaded.allowedCommands);
check("case hash is deterministic", createWorkBenchCaseHash(loaded) === createWorkBenchCaseHash(loadWorkBenchCaseFromJson(JSON.stringify(manifest))));

const caseV2 = toBenchmarkCaseV2(loaded, "2026-06-27T10:00:00.000Z");
check("case loader converts to BenchmarkCaseV2 WorkBench track", caseV2.schemaVersion === 2 && caseV2.track === "workbench", caseV2);
check("case loader maps verifier scorer to verifier-json", caseV2.verifier.scorer === "verifier-json" && caseV2.verifier.resultFile === "verifier-result.json", caseV2.verifier);
check("case loader preserves scoring targets", caseV2.scoring.costTargetUsd === 1 && caseV2.scoring.timeTargetSeconds === 600, caseV2.scoring);

expectThrow(
  "case loader rejects path traversal result files",
  () => loadWorkBenchCaseFromJson(JSON.stringify({ ...manifest, verifier: { ...manifest.verifier, resultFile: "../secret.json" } })),
  /resultFile/i
);
expectThrow(
  "case loader rejects absolute result files",
  () => loadWorkBenchCaseFromJson(JSON.stringify({ ...manifest, verifier: { ...manifest.verifier, resultFile: "C:\\\\temp\\\\result.json" } })),
  /resultFile/i
);
expectThrow(
  "case loader rejects command-based network none",
  () => loadWorkBenchCaseFromJson(JSON.stringify({ ...manifest, environment: { ...manifest.environment, network: "none" } })),
  /network none/i
);
expectThrow(
  "case loader rejects open network for v0.1",
  () => loadWorkBenchCaseFromJson(JSON.stringify({ ...manifest, environment: { ...manifest.environment, network: "open" } })),
  /network/i
);
expectThrow(
  "case loader rejects empty verifier command",
  () => loadWorkBenchCaseFromJson(JSON.stringify({ ...manifest, verifier: { ...manifest.verifier, command: "" } })),
  /verifier/i
);
expectThrow(
  "case loader rejects non-object JSON",
  () => loadWorkBenchCaseFromJson("[]"),
  /manifest/i
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
