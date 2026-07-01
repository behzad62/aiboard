/* Certified benchmark redaction checks (run: npx tsx scripts/test-benchmark-redaction.mts) */
import {
  redactAbsoluteLocalPaths,
  redactBenchmarkBundle,
  redactKnownSecrets,
  scanArtifactForSecrets,
} from "../lib/benchmark/redaction";
import type { BenchmarkReportBundleV2 } from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const apiText = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
const redactedApi = redactKnownSecrets(apiText);
check("API-like key redacted", !redactedApi.includes("sk-proj-") && redactedApi.includes("[REDACTED_SECRET]"), redactedApi);

const runnerText = "runner token=aiboard-runner-token-1234567890abcdef";
const redactedRunner = redactKnownSecrets(runnerText);
check("runner token redacted", !redactedRunner.includes("aiboard-runner-token"), redactedRunner);
const runnerHeaderText = "x-runner-token: 1234567890abcdef1234567890abcdef";
const redactedRunnerHeader = redactKnownSecrets(runnerHeaderText);
check("runner token header redacted", !redactedRunnerHeader.includes("1234567890abcdef"), redactedRunnerHeader);

const pathText = "C:\\Users\\b_a_s\\source\\repos\\ai-discussion-board and /Users/alice/project";
const redactedPath = redactAbsoluteLocalPaths(pathText);
check("absolute local paths redacted", !redactedPath.includes("b_a_s") && !redactedPath.includes("alice"), redactedPath);

const privateKeyScan = scanArtifactForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
check("SSH private key blocked", privateKeyScan.blocked && privateKeyScan.findings.some((finding) => finding.kind === "ssh_private_key"), privateKeyScan);
const truncatedPrivateKeyScan = scanArtifactForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----");
check("SSH private key header blocked", truncatedPrivateKeyScan.blocked, truncatedPrivateKeyScan);

const bundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-06-27T10:00:00.000Z",
  suites: [],
  runs: [],
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: [
    {
      id: "artifact-1",
      kind: "log",
      label: "Runner log",
      mimeType: "text/plain",
      content: `${apiText}\n${pathText}`,
      createdAt: "2026-06-27T10:00:00.000Z",
    },
  ],
  failures: [],
  traces: [],
  caseV2: [],
  attemptsV2: [],
  verifierResults: [],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [],
  harnessCertifications: [],
};

const redactedBundle = redactBenchmarkBundle(bundle);
check("bundle artifact content redacted", !redactedBundle.artifacts[0]?.content.includes("sk-proj-") && !redactedBundle.artifacts[0]?.content.includes("b_a_s"), redactedBundle.artifacts[0]);
check("bundle redaction summary reports scanned artifacts", redactedBundle.redactionSummary?.scannedArtifacts === 1 && (redactedBundle.redactionSummary?.redactedSecrets ?? 0) > 0, redactedBundle.redactionSummary);

// Secrets and absolute paths also leak through traces / tool-calls / run-events /
// verifier output / failures, not just artifacts. Redaction must cover them all.
const leakyBundle: BenchmarkReportBundleV2 = {
  ...bundle,
  traces: [
    {
      id: "trace-1",
      modelId: "openai:gpt",
      providerId: "openai",
      startedAt: "2026-06-27T10:00:00.000Z",
      rawResponse: "leaked key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 here",
      error: "failed at /Users/alice/project/run.ts",
      retryHistory: [
        {
          attempt: 1,
          status: "parse_error",
          message: "C:\\Users\\b_a_s\\source\\repos\\x failed",
        },
      ],
    },
  ] as unknown as BenchmarkReportBundleV2["traces"],
  toolCallTraces: [
    {
      id: "tool-1",
      attemptId: "a1",
      caseId: "c1",
      toolName: "run",
      status: "ok",
      startedAt: "2026-06-27T10:00:00.000Z",
      command: "curl -H 'x-runner-token: aiboard-runner-token-1234567890abcdef' http://x",
      outputPreview: "wrote C:\\Users\\b_a_s\\out.txt",
    },
  ] as unknown as BenchmarkReportBundleV2["toolCallTraces"],
  runEvents: [
    {
      id: "event-1",
      attemptId: "a1",
      caseId: "c1",
      type: "model_call_failed",
      phase: "run",
      at: "2026-06-27T10:00:00.000Z",
      message: "token=aiboard-runner-token-deadbeefcafe1234 rejected",
    },
  ] as unknown as BenchmarkReportBundleV2["runEvents"],
  verifierResults: [
    {
      id: "vr-1",
      attemptId: "a1",
      caseId: "c1",
      passed: true,
      score: 1,
      durationMs: 0,
      resultJson: "{}",
      stderrPreview: "boom at /Users/alice/secret/path",
      assertionResults: [],
      artifactIds: [],
    },
  ] as unknown as BenchmarkReportBundleV2["verifierResults"],
  failures: [
    {
      id: "fail-1",
      domain: "build",
      source: "benchmark",
      code: "boom",
      severity: "error",
      message: "crash at C:\\Users\\b_a_s\\app",
      details: "anthropic key sk-ant-abcdefghijklmnopqrstuvwxyz12345",
      createdAt: "2026-06-27T10:00:00.000Z",
    },
  ] as unknown as BenchmarkReportBundleV2["failures"],
};

const redactedLeaky = redactBenchmarkBundle(leakyBundle);
const leakyBlob = JSON.stringify(redactedLeaky);
check("trace rawResponse api key redacted", !leakyBlob.includes("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"), leakyBlob.slice(0, 120));
check("trace error + retry path redacted", !leakyBlob.includes("alice/project") && !leakyBlob.includes("repos\\\\x"), "");
check("tool-call runner token + path redacted", !leakyBlob.includes("aiboard-runner-token-1234567890abcdef") && !leakyBlob.includes("b_a_s\\\\out"), "");
check("run-event runner token redacted", !leakyBlob.includes("aiboard-runner-token-deadbeefcafe1234"), "");
check("verifier stderr path redacted", !leakyBlob.includes("alice/secret"), "");
check("failure message path + details key redacted", !leakyBlob.includes("b_a_s\\\\app") && !leakyBlob.includes("sk-ant-abcdefghijklmnopqrstuvwxyz12345"), "");
check(
  "redaction summary counts records across all channels",
  (redactedLeaky.redactionSummary?.scannedRecords ?? 0) >= 6 && (redactedLeaky.redactionSummary?.redactedSecrets ?? 0) >= 4,
  redactedLeaky.redactionSummary
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
