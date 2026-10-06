import { createHash } from "node:crypto";
/** E1: mechanical comparison only. Authority for exceptions stays in durable kernel records. */
export interface TestIntegrityPin {
  revision: string;
  commands: readonly { executable: string; args: readonly string[] }[];
  /** Actual package test script, not merely the package-manager wrapper argv. */
  script?: string;
  configDigest: string;
  hasTestSignals?: boolean;
}

export interface TestIntegrityBinding {
  taskId: string;
  integrationRevision: string;
  planRevisionId: string;
  planDigest: string;
  baselineRevision: string;
  submissionAttempt: number;
  changeSetId: string;
  baselinePinDigest: string;
  candidatePinDigest: string;
}

export interface TestIntegrityException extends TestIntegrityBinding {
  id: string;
  kind: "plan_revision_reason" | "reviewed_consolidation";
  reason: string;
  /** Consolidation requires an independently accepted proof reference. */
  behaviorProof?: string;
  /** Set only after the caller verified a durable Architect/reviewer authority record. */
  authoritySequence: number;
  allowedChanges: readonly TestIntegrityFinding["code"][];
  minimumExecuted: number;
}

export interface TestIntegrityFinding {
  code: "test_command_changed" | "test_config_changed" | "suite_shrank" | "baseline_counts_unknown";
  message: string;
}

export function testIntegrityExceptionMatches(exception: TestIntegrityException | undefined, binding: TestIntegrityBinding): boolean {
  if (!exception || !exception.id.trim() || !exception.reason.trim() ||
    !Number.isSafeInteger(exception.authoritySequence) || exception.authoritySequence < 1 ||
    !Number.isSafeInteger(exception.minimumExecuted) || exception.minimumExecuted < 1 || !Array.isArray(exception.allowedChanges)) return false;
  if (exception.kind !== "plan_revision_reason" && exception.kind !== "reviewed_consolidation") return false;
  if (exception.kind === "reviewed_consolidation" && !exception.behaviorProof?.trim()) return false;
  const identityKeys: readonly (keyof TestIntegrityBinding)[] = ["taskId", "integrationRevision", "planRevisionId", "planDigest", "baselineRevision", "submissionAttempt", "changeSetId", "baselinePinDigest", "candidatePinDigest"];
  return identityKeys.every((key) => exception[key] === binding[key]);
}

export function testIntegrityPinDigest(pin: TestIntegrityPin): string {
  return createHash("sha256").update(JSON.stringify({ commands: pin.commands, script: pin.script ?? null, configDigest: pin.configDigest, hasTestSignals: pin.hasTestSignals ?? null })).digest("hex");
}

export function testIntegrityProfileFindings(baseline: TestIntegrityPin, candidate: TestIntegrityPin): TestIntegrityFinding[] {
  const findings: TestIntegrityFinding[] = [];
  if (baseline.script !== candidate.script || JSON.stringify(baseline.commands) !== JSON.stringify(candidate.commands)) {
    findings.push({ code: "test_command_changed", message: "Test command changed from the trusted integration baseline." });
  }
  if (baseline.configDigest !== candidate.configDigest) findings.push({ code: "test_config_changed", message: "Test configuration changed from the trusted integration baseline." });
  return findings;
}

/** Skipped/selected counts cannot substitute for actually executed cases. */
export function executedTestCount(counts: { passed: number; failed: number } | undefined): number | undefined {
  if (!counts || !Number.isSafeInteger(counts.passed) || !Number.isSafeInteger(counts.failed) || counts.passed < 0 || counts.failed < 0) return undefined;
  const executed = counts.passed + counts.failed;
  return Number.isSafeInteger(executed) && executed > 0 ? executed : undefined;
}

export function testIntegrityCountFindings(baselineExecuted: number | undefined, candidateExecuted: number | undefined): TestIntegrityFinding[] {
  if (baselineExecuted === undefined || !Number.isSafeInteger(baselineExecuted) || baselineExecuted < 1) {
    return [{ code: "baseline_counts_unknown", message: "The trusted baseline has no recorded executed-test count; establish baseline evidence before acceptance." }];
  }
  if (candidateExecuted === undefined || !Number.isSafeInteger(candidateExecuted) || candidateExecuted < 1) {
    // Existing real-count outcome rules own the candidate's unknown report; an exception cannot turn it green.
    return [];
  }
  return candidateExecuted < baselineExecuted ? [{ code: "suite_shrank", message: `Suite shrank ${baselineExecuted}→${candidateExecuted} executed tests.` }] : [];
}

export function unresolvedTestIntegrityFindings(input: {
  findings: readonly TestIntegrityFinding[];
  binding: TestIntegrityBinding;
  exception?: TestIntegrityException;
  candidateExecuted?: number;
}): readonly TestIntegrityFinding[] {
  if (!testIntegrityExceptionMatches(input.exception, input.binding)) return input.findings;
  if (input.candidateExecuted !== undefined && input.candidateExecuted < input.exception!.minimumExecuted) return input.findings;
  // A reason/disposition can authorize a changed suite, never fabricate missing baseline proof.
  return input.findings.filter((finding) => finding.code === "baseline_counts_unknown" ||
    !input.exception!.allowedChanges.includes(finding.code) ||
    (finding.code === "suite_shrank" && (input.candidateExecuted === undefined || input.candidateExecuted < input.exception!.minimumExecuted)));
}

/** Positive proof of a known unconfigured initial project, never an invented count. */
export function assertNoConfiguredTestSuite(pin: TestIntegrityPin, inventory: string, digest: string): void {
  if (pin.commands.length || pin.script !== undefined || pin.hasTestSignals !== false ||
    createHash("sha256").update(inventory).digest("hex") !== digest) throw new Error("Unconfigured test baseline requires exact immutable inventory proof.");
  for (const row of inventory.split("\0").filter(Boolean)) {
    const match = /^\d+ blob [a-f0-9]+\t([\s\S]+)$/.exec(row);
    if (!match || knownTestSuitePath(match[1]!)) throw new Error("Initial inventory contains test-suite signals or is malformed.");
  }
}
export function knownTestSuitePath(path: string): boolean {
  const name = path.split("/").at(-1)!.toLowerCase();
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(path) ||
    /(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(name) ||
    /^(?:vitest|jest|playwright|cypress|mocha|pytest|tox|conftest|setup|pyproject|ava|karma|tap|nyc|coverage)(?:[._-]|$)/.test(name) ||
    name === "pom.xml" || name === "build.gradle" || name === "build.gradle.kts" ||
    name === "settings.gradle" || name === "settings.gradle.kts" || name === "gradle.properties" ||
    name === "cmakelists.txt" || name === "cargo.toml" || name === "go.mod" ||
    /\.cmake$/.test(name) || /\.(?:cs|fs|vb)proj$/.test(name) || /\.(?:sln|slnx)$/.test(name) ||
    /^\.(?:mocha|nyc|tap|ava|c8|test).*rc/.test(name);
}

export function testIntegrityBaselineFindings(baseline: { kind: "executed_report" | "no_configured_test_suite"; pin: TestIntegrityPin; executed?: number }, candidate: TestIntegrityPin, candidateExecuted?: number, options?: { executedScope?: "full_test_script" | "selected" }): TestIntegrityFinding[] {
  // A proven unconfigured initial project may introduce its first suite. The
  // separate raw tests gate still demands a completed positive machine report.
  if (baseline.kind === "no_configured_test_suite") return [];
  // IV-2: an intentional selected run executes fewer tests than the full
  // baseline by design; the count comparison would falsely report
  // suite_shrank. Profile/config checks still apply, and the separate
  // real-counts gate still demands a positive machine report.
  if (options?.executedScope === "selected") return testIntegrityProfileFindings(baseline.pin, candidate);
  return [...testIntegrityProfileFindings(baseline.pin, candidate), ...testIntegrityCountFindings(baseline.executed, candidateExecuted)];
}
