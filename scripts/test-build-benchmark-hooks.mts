/* Build benchmark hook checks (run: npx tsx scripts/test-build-benchmark-hooks.mts) */
import {
  buildBenchmarkTraceContext,
  resolveBuildModelContent,
  shouldBlockBuildBenchmarkAction,
  validateBuildBenchmarkCommand,
  type BuildHooks,
} from "../lib/client/build-engine";
import type { SelectedModel, StructuredOutputFormat } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const benchmark: NonNullable<BuildHooks["benchmark"]> = {
  attemptId: "attempt-hook-test",
  runId: "run-hook-test",
  caseId: "case-hook-test",
  harnessProfile: "aiboard-build-multi-worker",
  noHumanApproval: true,
  runnerOnly: true,
  disableMcp: true,
  allowedCommands: ["npm test", "node verifier.mjs"],
};

check(
  "benchmark command allowlist accepts exact configured command",
  validateBuildBenchmarkCommand("npm test", benchmark).allowed
);
check(
  "benchmark command allowlist rejects unlisted shell command",
  !validateBuildBenchmarkCommand("git push origin main", benchmark).allowed,
  validateBuildBenchmarkCommand("git push origin main", benchmark)
);
check(
  "non-benchmark command policy stays permissive",
  validateBuildBenchmarkCommand("git push origin main", undefined).allowed
);

check(
  "benchmark policy blocks MCP when disabled",
  shouldBlockBuildBenchmarkAction("tool", benchmark).blocked,
  shouldBlockBuildBenchmarkAction("tool", benchmark)
);
check(
  "benchmark policy blocks external fetches",
  shouldBlockBuildBenchmarkAction("fetch", benchmark).blocked,
  shouldBlockBuildBenchmarkAction("fetch", benchmark)
);
check(
  "benchmark policy blocks repo side effects but allows repo inspection",
  shouldBlockBuildBenchmarkAction("repo_commit", benchmark).blocked &&
    shouldBlockBuildBenchmarkAction("repo_push", benchmark).blocked &&
    !shouldBlockBuildBenchmarkAction("repo_status", benchmark).blocked,
  {
    repoCommit: shouldBlockBuildBenchmarkAction("repo_commit", benchmark),
    repoStatus: shouldBlockBuildBenchmarkAction("repo_status", benchmark),
  }
);
check(
  "benchmark trace context links model calls to certified attempt",
  JSON.stringify(buildBenchmarkTraceContext(benchmark)) ===
    JSON.stringify({
      attemptId: "attempt-hook-test",
      runId: "run-hook-test",
      caseId: "case-hook-test",
    }),
  buildBenchmarkTraceContext(benchmark)
);

const model: SelectedModel = {
  modelId: "fake:oracle",
  providerId: "fake",
  displayName: "Oracle",
};
const structuredOutput: StructuredOutputFormat = {
  name: "architect_action",
  schema: { type: "object", properties: { action: { type: "string" } } },
  strict: true,
};

let collected = false;
let overrideInput: unknown = null;
let emittedToken = "";
const resolved = await resolveBuildModelContent({
  model,
  messages: [{ role: "user", content: "Plan the work" }],
  maxTokens: 512,
  label: "Architect plan",
  structuredOutput,
  hooks: {
    modelCallOverride: async (input) => {
      overrideInput = input;
      return "{\"action\":\"plan\",\"tasks\":[]}";
    },
  },
  collect: async () => {
    collected = true;
    return "provider";
  },
  emitToken: (token) => {
    emittedToken += token;
  },
});

check(
  "modelCallOverride supplies content without calling provider collector",
  resolved.overrideUsed &&
    resolved.content.includes("\"plan\"") &&
    !collected &&
    emittedToken === resolved.content,
  { resolved, collected, emittedToken }
);
check(
  "modelCallOverride receives structured output metadata",
  (overrideInput as { structuredOutput?: StructuredOutputFormat } | null)
    ?.structuredOutput?.name === "architect_action",
  overrideInput
);

const fallback = await resolveBuildModelContent({
  model,
  messages: [{ role: "user", content: "No override" }],
  maxTokens: 64,
  label: "Fallback",
  collect: async () => "provider-content",
});

check(
  "model content resolver falls back to provider collector",
  !fallback.overrideUsed && fallback.content === "provider-content",
  fallback
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
