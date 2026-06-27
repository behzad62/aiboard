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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
