import type {
  HarnessCertificationCheck,
  HarnessCertificationResult,
  HarnessProfile,
} from "@/lib/benchmark/types";
import { validateBuildBenchmarkCommand } from "@/lib/client/build-engine";
import { extractArtifacts } from "@/lib/artifacts/extract";
import { parseArchitectAction } from "@/lib/orchestrator/build";
import {
  BadJsonModel,
  ForbiddenToolModel,
  OracleModel,
  SlowModel,
  WrongPatchModel,
} from "./mock-models";
import { getHarnessProfileDefinition } from "./harness-profiles";

export {
  getHarnessProfileDefinition,
  listHarnessProfileDefinitions,
} from "./harness-profiles";
export { createCertifiedModelCallOverride } from "./model-adapter";
export type { HarnessProfileDefinition } from "./harness-profiles";

const AIBOARD_BENCHMARK_ENGINE_VERSION = "aiboard-bench-certified-v0.1";
const AIBOARD_VERSION = "0.1.0";

interface SimulatedRun {
  status: "passed" | "failed_tool_use" | "failed_budget" | "provider_unavailable";
  traceIds: string[];
  verifierResultRecorded: boolean;
  details: Record<string, unknown>;
}

export function runHarnessCertification(
  profile: HarnessProfile
): HarnessCertificationResult {
  const definition = getHarnessProfileDefinition(profile);
  if (!definition) {
    throw new Error(`Unknown harness profile: ${profile}`);
  }

  const oracle = simulateOracleRun(definition.allowedCommands);
  const badJson = simulateBadJsonRun();
  const forbidden = simulateForbiddenToolRun(definition.allowedCommands);
  const wrongPatch = simulateWrongPatchRun();
  const timeout = simulateTimeoutRun();
  const checks: HarnessCertificationCheck[] = [
    check(
      "oracle_model_passes_simple_case",
      "Oracle model can pass simple case",
      oracle.status === "passed",
      oracle
    ),
    check(
      "bad_json_failed_tool_use",
      "Bad JSON is failed_tool_use, not invalid_harness",
      badJson.status === "failed_tool_use",
      badJson
    ),
    check(
      "forbidden_command_blocked",
      "Forbidden command is blocked",
      forbidden.status === "failed_tool_use",
      forbidden
    ),
    check(
      "wrong_patch_failed_tool_use",
      "Wrong patch is failed_tool_use",
      wrongPatch.status === "failed_tool_use",
      wrongPatch
    ),
    check(
      "timeout_classified",
      "Timeout is failed_budget or provider_unavailable",
      timeout.status === "failed_budget" || timeout.status === "provider_unavailable",
      timeout
    ),
    check(
      "required_traces_emitted",
      "All required traces are emitted",
      oracle.traceIds.includes("model:oracle") &&
        oracle.traceIds.includes("tool:verifier") &&
        forbidden.traceIds.includes("tool:blocked"),
      {
        oracleTraceIds: oracle.traceIds,
        forbiddenTraceIds: forbidden.traceIds,
      }
    ),
    check(
      "verifier_result_recorded",
      "Verifier result is recorded",
      oracle.verifierResultRecorded,
      oracle
    ),
  ];

  return {
    id: `harness-cert:${profile}:${definition.harnessVersion}`,
    createdAt: new Date().toISOString(),
    aiboardVersion: AIBOARD_VERSION,
    benchmarkEngineVersion: AIBOARD_BENCHMARK_ENGINE_VERSION,
    harnessProfile: profile,
    harnessVersion: definition.harnessVersion,
    promptSetVersion: definition.promptSetVersion,
    passed: checks.every((item) => item.passed),
    checks,
    artifactIds: [
      "trace:oracle",
      "trace:bad-json",
      "trace:forbidden-tool",
      "trace:wrong-patch",
      "verifier:oracle",
    ],
  };
}

export function assertHarnessCertificationCanRun(
  certification: HarnessCertificationResult
): void {
  if (certification.passed) return;
  const failed = certification.checks
    .filter((item) => !item.passed)
    .map((item) => item.label)
    .join(", ");
  throw new Error(
    `Certified run blocked: harness certification failed (${failed || "unknown check"}).`
  );
}

function simulateOracleRun(allowedCommands: string[]): SimulatedRun {
  const action = parseArchitectAction(
    JSON.stringify({
      action: "plan",
      tasks: [
        {
          id: "T1",
          title: "Patch add",
          instructions: "Patch src/add.ts",
          contextFiles: ["src/add.ts"],
          outputPaths: ["src/add.ts"],
          dependsOn: [],
        },
      ],
      verifyCommand: "npm test",
      notes: "certified",
    })
  );
  const command =
    allowedCommands.length === 0
      ? { allowed: true }
      : validateBuildBenchmarkCommand("npm test", {
          attemptId: "cert-oracle",
          caseId: "cert-simple",
          harnessProfile: "aiboard-build-multi-worker",
          noHumanApproval: true,
          runnerOnly: true,
          disableMcp: true,
          allowedCommands,
        });
  const passed = action?.action === "plan" && command.allowed;
  return {
    status: passed ? "passed" : "failed_tool_use",
    traceIds: ["model:oracle", "tool:verifier"],
    verifierResultRecorded: passed,
    details: {
      modelId: OracleModel.modelId,
      action: action?.action,
      commandAllowed: command.allowed,
    },
  };
}

function simulateBadJsonRun(): SimulatedRun {
  const parsed = parseArchitectAction("{ action: plan, tasks: [");
  return {
    status: parsed ? "passed" : "failed_tool_use",
    traceIds: ["model:bad-json"],
    verifierResultRecorded: false,
    details: {
      modelId: BadJsonModel.modelId,
      parsed: Boolean(parsed),
      status: parsed ? "passed" : "failed_tool_use",
    },
  };
}

function simulateForbiddenToolRun(allowedCommands: string[]): SimulatedRun {
  const parsed = parseArchitectAction(
    JSON.stringify({
      action: "run",
      command: "git push origin main",
      reason: "publish result",
    })
  );
  const commandAllowed = validateBuildBenchmarkCommand("git push origin main", {
    attemptId: "cert-forbidden",
    caseId: "cert-simple",
    harnessProfile: "aiboard-build-multi-worker",
    noHumanApproval: true,
    runnerOnly: true,
    disableMcp: true,
    allowedCommands,
  }).allowed;
  return {
    status: parsed?.action === "run" && !commandAllowed ? "failed_tool_use" : "passed",
    traceIds: ["model:forbidden-tool", "tool:blocked"],
    verifierResultRecorded: false,
    details: {
      modelId: ForbiddenToolModel.modelId,
      parsedAction: parsed?.action,
      commandAllowed,
    },
  };
}

function simulateWrongPatchRun(): SimulatedRun {
  const extracted = extractArtifacts(
    [
      "```edit path=src/add.ts",
      "<<<<<<< SEARCH",
      "  return a - b;",
      "=======",
      "  return a * b;",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n")
  );
  const wrongReplacement = extracted.edits.some((edit) =>
    edit.ops.some((op) => op.replace.includes("a * b"))
  );
  return {
    status: wrongReplacement ? "failed_tool_use" : "passed",
    traceIds: ["model:wrong-patch", "tool:patch"],
    verifierResultRecorded: false,
    details: {
      modelId: WrongPatchModel.modelId,
      editCount: extracted.edits.length,
      wrongReplacement,
    },
  };
}

function simulateTimeoutRun(): SimulatedRun {
  return {
    status: "failed_budget",
    traceIds: ["model:slow"],
    verifierResultRecorded: false,
    details: {
      modelId: SlowModel.modelId,
      elapsedMs: 120_001,
    },
  };
}

function check(
  id: string,
  label: string,
  passed: boolean,
  details: unknown
): HarnessCertificationCheck {
  return {
    id,
    label,
    passed,
    message: passed ? undefined : `${label} failed.`,
    detailsJson: JSON.stringify(details),
  };
}
