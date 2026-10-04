import { workingTreeForRunner, unknownChildEnvironment, settleWorkingTreeIdentity } from "./command-evidence-identity.js";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { computeAffectedTests, isRunnableTestFile } from "./affected-tests.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ChangeSet } from "./change-set.js";
import {
  deliveryClaimsFromSubmission,
  testsOutcome,
  type DeliveryAffectedTestsRecord,
  type DeliveryBoundaryCheck,
  type DeliveryProbeRecord,
  type DeliveryTestReport,
} from "./delivery-acceptance.js";
import type { EvidenceStore, CommandEvidenceFact } from "./evidence-store.js";
import type { FinalVerificationCategory, FinalVerificationPlan } from "./final-verification-contracts.js";
import {
  inspectFinalVerificationExecutionProfile,
  type FinalVerificationExecutionProfile,
} from "./final-verification-profile.js";
import { FinalVerificationRuntime, type FinalVerificationCommand } from "./final-verification-runtime.js";
import type { GitRunner } from "./git-repository.js";
import {
  runBreakItProbe,
  type MutableFile,
  type MutationFileSystem,
} from "./mutation-probe.js";
import type { DeliverableReviewInputs, DeliveryDepthRunner } from "./native-deliverable-review.js";
import { outputFor, type OneShotCommandExecutor } from "./one-shot-command-executor.js";
import { effectiveTestIntegrityException, readyPlanIdentity, type SchedulerProjection } from "./scheduler-store.js";
import { inspectTestIntegrityPin } from "./test-integrity-profile.js";
import { testIntegrityBaselineFindings, assertNoConfiguredTestSuite, executedTestCount, testIntegrityPinDigest, testIntegrityExceptionMatches, unresolvedTestIntegrityFindings } from "./test-integrity.js";
import type { TestIntegrityBaselineInput, TestIntegrityBoundary } from "./test-integrity-contracts.js";
import type { BuildTask, TaskContractRef } from "./task-contracts.js";
import type { ExecutionTaskContract } from "./planning-contracts.js";
import {
  outcomeFromReportReading,
  readJUnitReport,
  readTrxReport,
} from "./test-report-readers.js";
import type { VerificationWorkspaceManager } from "./verification-workspace.js";

/**
 * T6a (B1/B2/B3): the real inputs and audited executions behind the
 * deliverable review and the post-integration boundary. Every command runs
 * through the shared one-shot executor (FinalVerificationRuntime for the
 * project test/build commands, runner-internal grants for probe commands)
 * and is recorded as command evidence. Nothing here spawns a process itself.
 */

export interface DeliveryWorkspaceSlot {
  /** Creates (after cleaning any stale one) the checkout pinned at `targetRevision`. */
  create(targetRevision: string): Promise<{ path: string; manager: VerificationWorkspaceManager }>;
  current(): VerificationWorkspaceManager | undefined;
  cleanup(): Promise<void>;
}

export function createDeliveryWorkspaceSlot(
  managerFor: (targetRevision?: string) => VerificationWorkspaceManager,
): DeliveryWorkspaceSlot {
  let manager: VerificationWorkspaceManager | undefined;
  const cleanup = async () => {
    await (manager ?? managerFor()).cleanup();
    manager = undefined;
  };
  return {
    create: async (targetRevision) => {
      await cleanup();
      manager = managerFor(targetRevision);
      const workspace = await manager.create();
      return { path: workspace.path, manager };
    },
    current: () => manager,
    cleanup,
  };
}

/** The worker's durable submission, read back from its session. */
export interface DurableSubmission {
  changeSet: ChangeSet;
  summary: string;
  authorRuntimeId: string;
}

/**
 * Builds the reviewer inputs from durable state only: the task's contract
 * criteria, the session's change set, the diff bytes by artifact hash, the
 * worker's own submit_task summary, and the authoritative accepted contract
 * when supplied (C5). Missing inputs throw (the review is then recorded as
 * not performed and the run pauses), never placeholders.
 */
export async function loadDeliverableReviewInputs(input: {
  task: BuildTask;
  submission: DurableSubmission;
  artifacts: Pick<ArtifactStore, "get">;
  /** C5: the authoritative accepted contract resolved from durable state. */
  contract?: ExecutionTaskContract;
  /** C5: the exact accepted revision/digest/task identity the contract was resolved at. */
  contractRef?: TaskContractRef;
}): Promise<DeliverableReviewInputs> {
  const { task, submission } = input;
  const changeSet = submission.changeSet;
  if (changeSet.id !== task.changeSetId) {
    throw new Error(`Submitted change set ${task.changeSetId} is unavailable.`);
  }
  if (task.submissionScope && JSON.stringify(task.submissionScope) !== JSON.stringify(changeSet.submissionScope)) throw new Error("Submitted scope record differs from its durable kernel binding.");
  if (task.reviewSignals && JSON.stringify(task.reviewSignals) !== JSON.stringify(changeSet.reviewSignals)) throw new Error("Submitted review signals differ from their durable kernel binding.");
  if (task.encodingSubmission && JSON.stringify(task.encodingSubmission) !== JSON.stringify(changeSet.encodingSubmission)) throw new Error("Submitted encoding record differs from its durable kernel binding.");
  const diffText = (await input.artifacts.get(changeSet.diffArtifactHash)).toString("utf8");
  const criteria = (task.acceptanceCriteria ?? []).map((criterion) => ({ id: criterion.id, text: criterion.text }));
  return {
    taskId: task.id,
    attempt: task.attempt,
    changeSetId: changeSet.id,
    baselineRevision: changeSet.baselineRevision,
    taskRevision: changeSet.taskRevision,
    diffArtifactHash: changeSet.diffArtifactHash,
    diffText,
    changedPaths: [...changeSet.changedPaths],
    objective: task.objective,
    criteria,
    workerSummary: submission.summary,
    unresolvedConcerns: [...changeSet.unresolvedConcerns],
    claims: deliveryClaimsFromSubmission({
      summary: submission.summary,
      criteria,
      links: changeSet.criterionEvidenceLinks ?? [],
    }),
    authorRuntimeId: submission.authorRuntimeId,
    ...(input.contract ? { contract: input.contract } : {}),
    ...(input.contractRef ? { contractRef: input.contractRef } : {}),
  };
}

/** The last submit_task summary in a worker session checkpoint. */
export function submitTaskSummary(messages: readonly { role: string; content: unknown }[]): string | undefined {
  let summary: string | undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; name?: string; arguments?: unknown }[]) {
      if (block.type !== "tool_call" || block.name !== "submit_task") continue;
      const args = block.arguments as { summary?: unknown } | undefined;
      if (typeof args?.summary === "string" && args.summary.trim()) summary = args.summary.trim();
    }
  }
  return summary;
}

export function currentWorkerAuthor(projection: SchedulerProjection, task: BuildTask): string | undefined {
  return projection.runtime.workerAssignments[`${task.id}:${task.attempt}`]?.runtimeId;
}

/** Changed (new-side) line numbers per file from a unified diff. */
export function changedLinesFromDiff(diffText: string): Map<string, number[]> {
  const lines = new Map<string, number[]>();
  let file: string | undefined;
  let next = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!file || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      lines.set(file, [...(lines.get(file) ?? []), next]);
      next += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      next += 1;
    }
  }
  return lines;
}

/** Project file inventory and build files for the module-graph rung. */
export async function projectInventory(git: GitRunner, workspacePath: string): Promise<{
  allFiles: string[];
  fileContents: Map<string, string>;
  fullSuiteTests: string[];
}> {
  const listed = await git({ cwd: workspacePath, args: ["ls-files", "-z"] } as Parameters<GitRunner>[0]);
  if (listed.exitCode !== 0) throw new Error(`Could not list project files: ${listed.stderr}`);
  const allFiles = listed.stdout.split("\0").filter(Boolean).sort();
  const fileContents = new Map<string, string>();
  for (const path of allFiles) {
    if (!isModuleGraphBuildFile(path)) continue;
    fileContents.set(path, readFileSync(join(workspacePath, path), "utf8"));
  }
  return { allFiles, fileContents, fullSuiteTests: allFiles.filter((path) => isRunnableTestFile(path)) };
}

const BUILD_FILE_NAMES = new Set([
  "package.json", "tsconfig.json", "pom.xml", "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts", "cargo.toml", "go.mod", "cmakelists.txt",
  "directory.build.props", "directory.packages.props",
]);

function isModuleGraphBuildFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (BUILD_FILE_NAMES.has(name) || name.endsWith(".csproj") || name.endsWith(".sln")) return true;
  // Gradle convention plugins live in build-logic/ or buildSrc/.
  return /(^|\/)(build-logic|buildSrc)\//.test(path) && (name.endsWith(".gradle") || name.endsWith(".gradle.kts") || name.endsWith(".kts"));
}

export interface DeliveryCommandRun {
  command: string;
  args: string[];
  evidenceIds: string[];
  exitCode: number | null;
  ran: boolean;
  reason?: string;
  /** `tests` only: this run's own machine-readable report reading. */
  report?: DeliveryTestReport;
}

/**
 * Owner decision "real counts": how the runner makes a detected test runner
 * write a machine-readable report to a fresh, runner-owned path. Only flags
 * the tool really supports are used; otherwise the plan says why not.
 */
export interface TestReportPlan {
  runner: string;
  command?: FinalVerificationCommand;
  /** Relative to the checkout root; unique per run, never a committed file. */
  reportPath?: string;
  format?: "junit" | "trx";
  unsupported?: string;
  /**
   * R6-B1: the run filters tests by name or `.only`; at least one real
   * (non-file-level) test case must appear in the report.
   */
  filtered?: boolean;
}

export function planTestReport(input: {
  checkoutPath: string;
  command: FinalVerificationCommand;
  reportName: string;
  /** The NODE_OPTIONS the child would otherwise inherit (kept, never replaced). */
  ambientNodeOptions?: string;
  /** Script-shell rules differ (cmd.exe does not treat `'` as a quote). */
  platform?: NodeJS.Platform;
}): TestReportPlan {
  let manifest: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } = {};
  try {
    manifest = JSON.parse(readFileSync(join(input.checkoutPath, "package.json"), "utf8"));
  } catch {
    return { runner: "unknown", unsupported: "The project has no readable package.json test script." };
  }
  const script = typeof manifest.scripts?.test === "string" ? manifest.scripts.test : "";
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  // R5-B2: only `&&` chains are judged. With `&&` the script exits 0 only
  // if every command exited 0, so the earlier commands succeeded and the
  // LAST command (which must be the test runner) produced the report.
  // `||`, `;`, `|`, `&` or a newline can mask a failing command.
  // N-R6-1: the splitter models only plain words, double quotes and `&&`.
  // Any other shell syntax (substitution, escapes, comments, negation,
  // grouping, redirection, cmd.exe carets/variables, and `'` on Windows,
  // where cmd.exe does not treat it as a quote) could hide a failing
  // command, so such a script is not judged.
  const platform = input.platform ?? process.platform;
  const unmodeled = /[$`\\#!()<>^%]/.exec(script) ?? (platform === "win32" ? /'/.exec(script) : null);
  if (unmodeled) {
    return {
      runner: `script "${script}"`,
      unsupported: `the test script uses the shell character "${unmodeled[0]}", which the runner cannot model safely; use plain commands joined only by "&&".`,
    };
  }
  const split = splitAndChain(script);
  if ("separator" in split) {
    return {
      runner: `script "${script}"`,
      unsupported: `the test script joins commands with "${split.separator}", which can hide a failing command; only "&&" chains are judged.`,
    };
  }
  const segments = split.segments;
  const last = segments.at(-1) ?? "";
  const tokens = last.split(/\s+/).filter(Boolean);
  const runArgs = input.command.args;
  const runIndex = runArgs.lastIndexOf("run");
  if (runIndex < 0 || runArgs[runIndex + 1] !== "test") {
    return { runner: `script "${script}"`, unsupported: "The test command is not the package test script." };
  }
  // npm needs `--` to forward arguments to the script; pnpm and yarn forward directly.
  const managerText = [input.command.executable, ...runArgs].join(" ").toLowerCase();
  const separator = /pnpm|yarn/.test(managerText) ? [] : ["--"];
  const withArgs = (extra: string[]): FinalVerificationCommand => ({
    ...input.command,
    args: [...runArgs, ...separator, ...extra],
  });
  const head = tokens[0] === "npx" ? tokens.slice(1) : tokens;
  const junit = `.aiboard-report-${input.reportName}.xml`;
  // R7-B1: `tsx --test` starts node's own test runner and forwards
  // NODE_OPTIONS to it, so it writes the same report as `node --test`.
  if (/^(node(\.exe)?|tsx(\.exe|\.cmd)?)$/i.test(head[0] ?? "") && head.includes("--test")) {
    // R5-B3: node treats every argument after the first file/glob as another
    // test pattern, so appended reporter flags would be ignored. NODE_OPTIONS
    // reaches the node process whatever its positional arguments are, and it
    // survives npm (which forwards the environment to the script).
    if (head.some((token) => token.startsWith("--test-reporter"))) {
      return { runner: "node --test", unsupported: "the test script sets its own --test-reporter, which would replace the runner's JUnit reporter." };
    }
    const ambient = input.ambientNodeOptions?.trim() ?? "";
    if (/(^|\s)--test-reporter/.test(ambient)) {
      return { runner: "node --test", unsupported: "the environment's NODE_OPTIONS sets its own --test-reporter, which would replace the runner's JUnit reporter." };
    }
    // N-R6-2: an absolute, double-quoted destination (forward slashes, which
    // node accepts on Windows and which need no escaping inside NODE_OPTIONS)
    // so `cd <dir> && node --test` still writes to the runner-owned path.
    const destination = resolve(input.checkoutPath, junit).replaceAll("\\", "/");
    // The project's own NODE_OPTIONS is kept; the reporter flags are appended.
    const reporterFlags = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="${destination}"`;
    const filterPattern = /(^|\s)--test-(name-pattern|skip-pattern|only)\b/;
    return {
      runner: "node --test",
      format: "junit",
      reportPath: junit,
      filtered: head.some((token) => filterPattern.test(token)) || filterPattern.test(ambient),
      command: {
        ...input.command,
        environment: {
          NODE_OPTIONS: ambient ? `${ambient} ${reporterFlags}` : reporterFlags,
          NODE_TEST_CONTEXT: undefined,
        },
      },
    };
  }
  if (head[0] === "vitest") {
    return {
      runner: "vitest",
      format: "junit",
      reportPath: junit,
      command: withArgs(["--reporter=default", "--reporter=junit", `--outputFile.junit=${junit}`]),
    };
  }
  if (head[0] === "pytest" || (head[0]?.startsWith("python") && head[1] === "-m" && head[2] === "pytest")) {
    return { runner: "pytest", format: "junit", reportPath: junit, command: withArgs([`--junitxml=${junit}`]) };
  }
  if (head[0] === "dotnet" && head[1] === "test") {
    const trx = `.aiboard-report-${input.reportName}.trx`;
    return {
      runner: "dotnet test",
      format: "trx",
      reportPath: trx,
      command: withArgs(["--logger", `trx;LogFileName=${join(input.checkoutPath, trx)}`]),
    };
  }
  if (head[0] === "mocha" && "mocha-junit-reporter" in dependencies) {
    return {
      runner: "mocha",
      format: "junit",
      reportPath: junit,
      command: withArgs(["--reporter", "mocha-junit-reporter", "--reporter-options", `mochaFile=${junit}`]),
    };
  }
  if (head[0] === "jest") {
    return { runner: "jest", unsupported: "jest writes JUnit only through the jest-junit reporter configured by environment (JEST_JUNIT_OUTPUT_FILE), which the runner cannot set for this command." };
  }
  if (head[0] === "mocha") {
    return { runner: "mocha", unsupported: "mocha has no built-in JUnit reporter and mocha-junit-reporter is not a project dependency." };
  }
  if (head[0] === "go" && head[1] === "test") {
    return { runner: "go test", unsupported: "the runner has no reader for go test -json output." };
  }
  return {
    runner: last ? `"${last}"` : "unknown",
    unsupported: `the test command "${last || script}" is not a test runner the runner can make write a machine-readable report.`,
  };
}

/** Splits a shell script on `&&` only; any other separator outside quotes is reported. */
export function splitAndChain(script: string): { segments: string[] } | { separator: string } {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (pair === "||") return { separator: "||" };
    if (char === "|" || char === "&" || char === ";" || char === "\n") {
      return { separator: char === "\n" ? "newline" : char };
    }
    current += char;
  }
  segments.push(current.trim());
  return { segments: segments.filter(Boolean) };
}

/**
 * R5-B1: node's JUnit reporter writes its own run totals as comments. A
 * childless `describe` appears as a `<testcase>` element but is not a test,
 * so for `node --test` the counts come from node's summary.
 */
export function nodeJunitSummary(xml: string): { tests: number; pass: number; fail: number; skipped: number; todo: number; cancelled: number } | undefined {
  const value = (name: string): number | undefined => {
    const match = new RegExp(`<!--\\s*${name}\\s+(\\d+)\\s*-->`).exec(xml);
    return match ? Number(match[1]) : undefined;
  };
  const tests = value("tests");
  const pass = value("pass");
  const fail = value("fail");
  if (tests === undefined || pass === undefined || fail === undefined) return undefined;
  return { tests, pass, fail, skipped: value("skipped") ?? 0, todo: value("todo") ?? 0, cancelled: value("cancelled") ?? 0 };
}

/**
 * R6-B1: the `<testcase>` elements of a node JUnit report. A file-level
 * entry is one whose name is the path of its own file (node's synthetic
 * wrapper for a file that reported no subtests).
 */
export function nodeJunitTestCases(xml: string, checkoutPath: string): Array<{ name: string; fileLevel: boolean; failed: boolean; skipped: boolean }> {
  const decode = (value: string) => value
    .replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const attribute = (attributes: string, name: string): string | undefined => {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes);
    return match ? decode(match[1]!) : undefined;
  };
  const normalize = (path: string) => {
    const slashed = path.replaceAll("\\", "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const tail = (path: string) => normalize(path).replace(/^(\.\.?\/)+/, "");
  const entries: Array<{ name: string; fileLevel: boolean; failed: boolean; skipped: boolean }> = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const attributes = match[1] ?? "";
    const body = match[3] ?? "";
    const name = attribute(attributes, "name") ?? "";
    const file = attribute(attributes, "file");
    const fileLevel = file !== undefined && (
      normalize(resolve(checkoutPath, name)) === normalize(file) ||
      normalize(name) === normalize(relative(checkoutPath, file)) ||
      normalize(name) === normalize(file) ||
      // node names the entry relative to its own cwd (for example after
      // `cd test && node --test`, or `../test/x.test.mjs` after `cd src`);
      // leading `./` and `../` segments are dropped before the suffix match.
      // A real test named exactly like its own file path is also treated as
      // file-level, which only undercounts.
      (tail(name) !== "" && normalize(file).endsWith(`/${tail(name)}`))
    );
    entries.push({ name, fileLevel, failed: /<failure\b/.test(body), skipped: /<skipped\b/.test(body) });
  }
  return entries;
}

/** The real counts of one `node --test` junit report (pure; no file access). */
export function nodeJunitOutcome(xml: string, checkoutPath: string, filtered: boolean): {
  status: "passed" | "failed" | "unknown";
  counts?: { selected: number; passed: number; failed: number; skipped: number };
  failingTestIds?: string[];
  reason?: string;
} {
  const summary = nodeJunitSummary(xml);
  if (!summary) {
    return { status: "unknown", reason: "The node --test JUnit report has no tests/pass/fail summary, so the executed tests cannot be counted." };
  }
  // R6-B1: node reports a file with no subtests (for example every test
  // filtered out by --test-name-pattern, or no test() call) as one passing
  // file-level test. Those synthetic entries are not executed tests.
  const cases = nodeJunitTestCases(xml, checkoutPath);
  const synthetic = cases.filter((entry) => entry.fileLevel && !entry.failed);
  const realCases = cases.filter((entry) => !entry.fileLevel && !entry.skipped);
  const failingTestIds = realCases.filter((entry) => entry.failed).map((entry) => entry.name).sort();
  const failed = summary.fail + summary.cancelled;
  const executed = Math.max(0, summary.tests - synthetic.length);
  const passed = Math.max(0, summary.pass - synthetic.length);
  const enough = executed >= 1 && passed >= 1 && (!filtered || realCases.length >= 1);
  const status = failed > 0 ? "failed" : enough ? "passed" : "unknown";
  return {
    status,
    counts: { selected: executed, passed, failed, skipped: summary.skipped + summary.todo },
    failingTestIds,
    ...(status === "unknown"
      ? {
          reason: `node --test ran ${executed} real tests and ${passed} passed (${synthetic.length} file-level entries for files without tests and suites without tests do not count${filtered ? "; the script filters tests by name or .only" : ""}); at least one executed test is required.`,
        }
      : {}),
  };
}

function npmrcSetsNodeOptions(checkoutPath: string): boolean {
  try {
    return /^\s*node-options\s*=/m.test(readFileSync(join(checkoutPath, ".npmrc"), "utf8"));
  } catch {
    return false;
  }
}

/** A test runner that rejected the report flags (for example no JUnit reporter). */
export function reporterUnsupportedIn(stderr: string): boolean {
  return /ERR_INVALID_ARG_VALUE[\s\S]*reporter|Unknown test reporter|reporter[^\n]*junit[^\n]*(not found|unknown|invalid)|Cannot find (module|package) ['"]?junit/i.test(stderr);
}

/** Reads the report this run wrote; anything missing or unreadable is `unknown`. */
async function readRunReport(
  plan: TestReportPlan,
  checkoutPath: string,
  artifacts: ArtifactStore,
  stderr: string,
): Promise<DeliveryTestReport> {
  if (!plan.reportPath || !plan.format) {
    return { status: "unknown", runner: plan.runner, reason: `No machine-readable test report: ${plan.unsupported ?? "not supported"}` };
  }
  if (reporterUnsupportedIn(stderr)) {
    return {
      status: "unknown",
      runner: plan.runner,
      format: plan.format,
      path: plan.reportPath,
      reporterUnsupported: true,
      reason: `${plan.runner} rejected the ${plan.format} report flags (for example a Node version without the JUnit reporter); upgrade the runner or change the test script.`,
    };
  }
  const absolute = join(checkoutPath, plan.reportPath);
  if (!existsSync(absolute)) {
    return {
      status: "unknown",
      runner: plan.runner,
      format: plan.format,
      path: plan.reportPath,
      reason: plan.runner === "node --test"
        ? `node --test wrote no junit report at ${plan.reportPath}: ${npmrcSetsNodeOptions(checkoutPath)
          ? "the project's .npmrc sets node-options, which replaces the NODE_OPTIONS that carries the runner's reporter; remove node-options from .npmrc or move it into the environment."
          : "the NODE_OPTIONS that carries the runner's reporter did not reach the node --test process (a wrapper tool or script replaced it), or node exited before reporting."}`
        : `${plan.runner} wrote no ${plan.format} report at ${plan.reportPath}: the runner appends the report flags to the test script, so the script must end with the ${plan.runner} command.`,
    };
  }
  const bytes = readFileSync(absolute);
  const artifact = await artifacts.put(bytes, "application/xml", `delivery test report ${plan.reportPath}`);
  const text = bytes.toString("utf8");
  if (plan.runner === "node --test") {
    const outcome = nodeJunitOutcome(text, checkoutPath, plan.filtered === true);
    if (!outcome.counts) {
      return { status: "unknown", runner: plan.runner, format: plan.format, path: plan.reportPath, artifactHash: artifact.hash, reason: outcome.reason! };
    }
    return {
      status: outcome.status,
      runner: plan.runner,
      format: plan.format,
      path: plan.reportPath,
      artifactHash: artifact.hash,
      counts: outcome.counts,
      ...(outcome.failingTestIds?.length ? { failingTestIds: [...outcome.failingTestIds] } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }
  const reading = plan.format === "junit" ? readJUnitReport(text) : readTrxReport(text);
  const outcome = outcomeFromReportReading(reading);
  return {
    status: outcome.outcome,
    runner: plan.runner,
    format: plan.format,
    path: plan.reportPath,
    artifactHash: artifact.hash,
    counts: { ...outcome.counts },
    ...(reading.status === "unknown"
      ? { reason: reading.reason }
      : outcome.outcome === "unknown"
        ? { reason: `The ${plan.format} report shows ${outcome.counts.selected} selected and ${outcome.counts.passed} passed tests; at least one executed test is required.` }
        : {}),
  };
}

/**
 * Runs one project check category (`tests` or `build`) with the detected
 * project command in the pinned checkout, through FinalVerificationRuntime
 * and the audited executor. The profile is inspected on the clean checkout
 * before any command runs.
 */
export async function runDeliveryCategory(input: {
  category: "tests" | "build";
  ambientNodeOptions?: string;
  profile: FinalVerificationExecutionProfile;
  manager: VerificationWorkspaceManager;
  runId: string;
  evidenceTaskId: string;
  generationId: string;
  git: GitRunner;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  execution: OneShotCommandExecutor;
  signal?: AbortSignal;
}): Promise<DeliveryCommandRun> {
  const commands = input.profile.commands[input.category];
  const first = commands?.at(-1);
  if (!commands || !first) {
    return { command: "", args: [], evidenceIds: [], exitCode: null, ran: false, reason: `No project ${input.category} command was detected.` };
  }
  const runtime = new FinalVerificationRuntime({
    git: input.git,
    workspaceManager: input.manager,
    artifacts: input.artifacts,
    evidenceStore: input.evidenceStore,
    runId: input.runId,
    taskId: input.evidenceTaskId,
    actor: { role: "verifier", id: "delivery-check-runtime" },
    generationId: input.generationId,
    checkCategory: input.category,
    execution: input.execution,
  });
  const profile: FinalVerificationExecutionProfile = { ...input.profile, commands: { ...input.profile.commands } };
  delete profile.runtimeSmoke;
  delete profile.browser;
  delete profile.portLease;
  // Real counts: make the tests command write a report to a fresh path this
  // run owns. The same command goes into the profile copy, so the runtime's
  // profile comparison still holds.
  let reportPlan: TestReportPlan | undefined;
  if (input.category === "tests") {
    const reportName = createHash("sha256").update(`${input.generationId}:${randomUUID()}`).digest("hex").slice(0, 24);
    reportPlan = planTestReport({
      checkoutPath: input.manager.path,
      command: first,
      reportName,
      ...(input.ambientNodeOptions !== undefined ? { ambientNodeOptions: input.ambientNodeOptions } : {}),
    });
    if (reportPlan.reportPath && existsSync(join(input.manager.path, reportPlan.reportPath))) {
      throw new Error(`Test report path ${reportPlan.reportPath} already exists; refusing to read a report this run did not write.`);
    }
    if (reportPlan.command) profile.commands.tests = [...commands.slice(0, -1), reportPlan.command];
  }
  // R4-B1: FinalVerificationRuntime compares every category's commands with
  // the profile, so the full command map is passed; the plan and the
  // category argument select which one runs.
  const run = await runtime.runCategory({
    plan: deliveryCheckPlan(input.category),
    executionProfile: profile,
    commands: {
      ...(profile.commands.build ? { build: profile.commands.build } : {}),
      ...(profile.commands.tests ? { tests: profile.commands.tests } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  }, input.category);
  const evidenceIds = [...run.check.evidenceIds];
  const records = evidenceIds.length > 0
    ? input.evidenceStore.getByIds({ runId: input.runId, ids: evidenceIds })
    : [];
  const last = records.find((record) => record.id === evidenceIds.at(-1));
  const exitCode = last?.fact.kind === "command" ? (last.fact as CommandEvidenceFact).exitCode : null;
  const ranCommand = input.category === "tests" ? profile.commands.tests!.at(-1)! : first;
  const lastFact = last?.fact.kind === "command" ? last.fact as CommandEvidenceFact : undefined;
  const stderr = lastFact?.stderrArtifactHash
    ? (await input.artifacts.get(lastFact.stderrArtifactHash)).toString("utf8")
    : "";
  const report = reportPlan ? await readRunReport(reportPlan, input.manager.path, input.artifacts, stderr) : undefined;
  return {
    command: ranCommand.executable,
    args: [...ranCommand.args],
    evidenceIds,
    exitCode,
    ran: evidenceIds.length > 0,
    ...(run.check.issues.length > 0 ? { reason: run.check.issues.join(" ") } : {}),
    ...(report ? { report } : {}),
  };
}

function deliveryCheckPlan(category: "tests" | "build"): FinalVerificationPlan {
  const inspection = { paths: ["package.json"], summary: "T6a delivery check runs only the selected project command category." };
  return {
    checks: (["build", "tests", "runtime_smoke", "browser"] as FinalVerificationCategory[]).map((name) => name === category
      ? { category: name, status: "required" as const }
      : { category: name, status: "not_applicable" as const, rationale: "Not part of this delivery check.", repositoryInspection: inspection }),
  } as FinalVerificationPlan;
}

function outcomeFor(exitCode: number | null): "passed" | "failed" | "unknown" {
  return exitCode === null ? "unknown" : exitCode === 0 ? "passed" : "failed";
}

export interface DeliveryExecutionOptions {
  runId: string;
  /** The ambient NODE_OPTIONS the audited executor passes to children. */
  ambientNodeOptions?: () => string | undefined;
  git: GitRunner;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  execution: OneShotCommandExecutor;
  reviewWorkspace: DeliveryWorkspaceSlot;
  /** Supplied by the filesystem-mutation owner (native-build-factory.ts). */
  probeFileSystem(workspacePath: string): MutationFileSystem;
  clock?: () => string;
}

/**
 * High-tier depth (OA-4/OA-11/OA-13): the affected-test selection from the
 * real changed files and the project inventory, the project test command run
 * through the audited executor, the produced report read if any, and the
 * break-it probe on the changed lines through runner-internal audited grants.
 */
export function createDeliveryDepthRunner(options: DeliveryExecutionOptions): DeliveryDepthRunner {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    run: async (input) => {
      const manager = options.reviewWorkspace.current();
      if (!manager) throw new Error("High-tier review requires the task-revision checkout.");
      const inventory = await projectInventory(options.git, input.workspacePath);
      const selection = computeAffectedTests({
        changedFiles: [...input.changedFiles],
        moduleGraph: { allFiles: inventory.allFiles, fileContents: inventory.fileContents },
        fullSuiteTests: inventory.fullSuiteTests,
      });
      const profile = await inspectFinalVerificationExecutionProfile({
        repositoryRoot: input.workspacePath,
        targetRevision: input.taskRevision,
        execute: options.git,
      });
      const ambientNodeOptions = options.ambientNodeOptions?.();
      const tests = await runDeliveryCategory({
        ...(ambientNodeOptions !== undefined ? { ambientNodeOptions } : {}),
        category: "tests",
        profile,
        manager,
        runId: input.runId,
        evidenceTaskId: `delivery:${input.taskId}`,
        generationId: `${input.reviewId}:tests`,
        git: options.git,
        artifacts: options.artifacts,
        evidenceStore: options.evidenceStore,
        execution: options.execution,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const affectedTests: DeliveryAffectedTestsRecord = {
        executedScope: "full_test_script",
        selectionRung: selection.rung,
        changedFiles: [...input.changedFiles],
        selectedTests: [...selection.tests],
        fullSuiteCount: inventory.fullSuiteTests.length,
        command: tests.command || "none",
        args: tests.args,
        evidenceIds: tests.evidenceIds,
        exitCode: tests.exitCode,
        outcome: testsOutcome(tests.exitCode, tests.report),
        report: tests.report ?? { status: "unknown", runner: "none", reason: tests.reason ?? "No project test command was detected." },
      };
      const probe = await runDeliveryProbe({
        ...input,
        options,
        testCommand: tests.command ? { command: tests.command, args: tests.args } : undefined,
        clock,
      });
      return { affectedTests, probe };
    },
  };
}

async function runDeliveryProbe(input: {
  runId: string;
  taskId: string;
  reviewId: string;
  sessionId: string;
  reviewerRuntimeId: string;
  workspacePath: string;
  changedFiles: readonly string[];
  diffText: string;
  signal?: AbortSignal;
  options: DeliveryExecutionOptions;
  testCommand?: { command: string; args: string[] };
  clock: () => string;
}): Promise<DeliveryProbeRecord> {
  if (!input.testCommand) {
    return { rung: "not_available", mutantsGenerated: 0, mutantsExecuted: 0, mutantsCaught: 0, survivors: [], partial: false, evidenceIds: [], notes: ["No project test command; the probe cannot run."] };
  }
  const fileSystem = input.options.probeFileSystem(input.workspacePath);
  const changed = changedLinesFromDiff(input.diffText);
  const files: MutableFile[] = [];
  for (const path of input.changedFiles) {
    const lines = changed.get(path);
    if (!lines || lines.length === 0) continue;
    const absolute = join(input.workspacePath, path);
    if (!existsSync(absolute)) continue;
    files.push({ path, content: fileSystem.readFile(absolute), changedLineNumbers: lines });
  }
  const evidenceIds: string[] = [];
  let ordinal = 0;
  const result = await runBreakItProbe({
    files,
    affectedTestCommand: input.testCommand,
    maxMutants: 6,
    maxMs: 5 * 60_000,
    perCommandTimeoutMs: 2 * 60_000,
    fileSystem,
    runner: {
      now: () => Date.now(),
      run: async (command) => {
        ordinal += 1;
        const callId = `probe-${ordinal}`;
        const workingTreeIdentity = await workingTreeForRunner(input.options.git, command.cwd);
        const startedAt = input.clock();
        const executed = await input.options.execution.execute({
          executable: command.command,
          arguments: [...command.args],
          workingDirectory: command.cwd,
          timeoutMs: command.timeoutMs,
          // The probe's test runs must not inherit a parent test runner's context.
          explicitEnvironment: { NODE_TEST_CONTEXT: undefined },
          context: {
            runId: input.runId,
            sessionId: `${input.sessionId}:probe`,
            actor: { role: "verifier", id: input.reviewerRuntimeId },
            taskId: `delivery:${input.taskId}`,
            callId,
            toolName: "delivery.probe-command",
            runnerInternal: true,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        });
        const stdout = Buffer.from(outputFor(executed.process, "stdout").tail);
        const stderr = Buffer.from(outputFor(executed.process, "stderr").tail);
        const [stdoutArtifact, stderrArtifact] = await Promise.all([
          input.options.artifacts.put(stdout, "text/plain", "delivery probe stdout"),
          input.options.artifacts.put(stderr, "text/plain", "delivery probe stderr"),
        ]);
        const fact: CommandEvidenceFact = {
          kind: "command",
          workingTreeIdentity: settleWorkingTreeIdentity(workingTreeIdentity, await workingTreeForRunner(input.options.git, command.cwd)),
          childEnvironmentIdentity: executed.childEnvironmentIdentity ?? unknownChildEnvironment(),
          ...(executed.childEnvironmentAudit ? {childEnvironmentAudit: executed.childEnvironmentAudit} : {}),
          label: `OA-11 probe ${ordinal}`,
          command: command.command,
          args: [...command.args],
          cwd: command.cwd,
          startedAt,
          finishedAt: input.clock(),
          exitCode: executed.process.exitCode ?? null,
          signal: executed.process.signal ?? null,
          timedOut: executed.process.outcome === "timed_out",
          cancelled: executed.process.outcome === "cancelled",
          outputTruncated: executed.process.output.some((entry) => entry.truncated),
          stdoutArtifactHash: stdoutArtifact.hash,
          stderrArtifactHash: stderrArtifact.hash,
        };
        const record = input.options.evidenceStore.record({
          runId: input.runId,
          taskId: `delivery:${input.taskId}`,
          actor: { role: "verifier", id: input.reviewerRuntimeId },
          fact,
          createdAt: fact.finishedAt,
          idempotencyKey: `delivery-probe:${input.reviewId}:${ordinal}`,
        });
        evidenceIds.push(record.id);
        return {
          exitCode: fact.exitCode,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut: fact.timedOut,
        };
      },
    },
  });
  return {
    rung: result.rung,
    mutantsGenerated: result.mutantsGenerated,
    mutantsExecuted: result.mutantsExecuted,
    mutantsCaught: result.mutantsCaught,
    survivors: result.survivors.map((mutant) => `${mutant.id} ${mutant.file}:${mutant.lineNumber}: ${mutant.original} -> ${mutant.mutated}`),
    partial: result.partial,
    evidenceIds,
    notes: [...result.notes],
  };
}

/**
 * B3: the integrated-boundary check. It runs the project build (when the
 * project has one) and test commands on a clean checkout of the CURRENT
 * integration revision, and records the affected-test selection for the
 * task's changed files. A check that cannot run is `unknown`, never passed.
 */
export function createDeliveryBoundaryDriver(options: {
  runId: string;
  git: GitRunner;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  execution: OneShotCommandExecutor;
  boundaryWorkspace: DeliveryWorkspaceSlot;
  changedFilesFor(taskId: string): Promise<string[]>;
  ambientNodeOptions?: () => string | undefined;
  testIntegrity?: {
    projection(): SchedulerProjection;
    baselineWorkspace: DeliveryWorkspaceSlot;
    recordBaseline(taskId: string, baseline: TestIntegrityBaselineInput): void;
  };
}) {
  const captureInitialBaseline = async (taskId: string, signal?: AbortSignal) => {
      const trustedProjection = options.testIntegrity?.projection();
      if (trustedProjection?.testIntegrity && !trustedProjection.testIntegrity.baseline) {
        const revision = trustedProjection.testIntegrity.initialRevision;
        if (!revision) throw new Error("Trusted test-integrity baseline revision is unavailable.");
        const initial = await options.testIntegrity!.baselineWorkspace.create(revision);
        try {
          const profile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: initial.path, targetRevision: revision, execute: options.git });
          const pin = await inspectTestIntegrityPin({ git: options.git, repositoryRoot: initial.path, revision, commands: profile.commands.tests ?? [] });
          if (!pin.commands.length && pin.script === undefined && pin.hasTestSignals === false) {
            const workingTreeIdentity = await workingTreeForRunner(options.git, initial.path);
            const startedAt = new Date().toISOString(); const args = ["ls-tree", "-r", "-z", revision];
            // Use the owned, audited Git primitive, which settles bounded binary/NUL
            // inventory output and throws on cancellation/output loss/unknown completion.
            if (signal?.aborted) throw new Error("Initial test inventory was cancelled.");
            const observed = await options.git({ cwd: initial.path, args, maxOutputBytes: 4 * 1024 * 1024 });
            if (observed.exitCode !== 0 || signal?.aborted) throw new Error("Initial test inventory command is incomplete.");
            const [out, err] = await Promise.all([options.artifacts.put(Buffer.from(observed.stdout), "application/octet-stream", "immutable initial test inventory"), options.artifacts.put(Buffer.from(observed.stderr), "text/plain", "initial test inventory stderr")]);
            const inventory = observed.stdout;
            assertNoConfiguredTestSuite(pin, inventory, out.hash);
            const fact: CommandEvidenceFact = { kind: "command", workingTreeIdentity: settleWorkingTreeIdentity(workingTreeIdentity, await workingTreeForRunner(options.git, initial.path)), childEnvironmentIdentity: unknownChildEnvironment(), label: "initial test-suite inventory", command: "git", args, cwd: initial.path, startedAt, finishedAt: new Date().toISOString(), exitCode: observed.exitCode, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: out.hash, stderrArtifactHash: err.hash, repositoryRevision: revision };
            const record = options.evidenceStore.record({ runId: options.runId, taskId: `delivery:${taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" }, fact, createdAt: fact.finishedAt, idempotencyKey: `test-integrity:${taskId}:initial-tests:inventory:${randomUUID()}` });
            options.testIntegrity!.recordBaseline(taskId, { kind: "no_configured_test_suite", pin, pinDigest: testIntegrityPinDigest(pin), inventory, inventoryDigest: out.hash, evidenceIds: [record.id] });
            return;
          }
          const ambientNodeOptions = options.ambientNodeOptions?.();
          const run = await runDeliveryCategory({ category: "tests", profile, manager: initial.manager,
            runId: options.runId, evidenceTaskId: `delivery:${taskId}`,
            generationId: `test-integrity:${taskId}:initial-tests:${randomUUID()}`, git: options.git,
            artifacts: options.artifacts, evidenceStore: options.evidenceStore, execution: options.execution,
            ...(ambientNodeOptions !== undefined ? { ambientNodeOptions } : {}), ...(signal ? { signal } : {}) });
          const executed = executedTestCount(run.report?.counts);
          if (!run.report || run.report.status === "unknown" || executed === undefined) throw new Error("Trusted initial test baseline has no usable executed-test report.");
          options.testIntegrity!.recordBaseline(taskId, { kind: "executed_report", pin, pinDigest: testIntegrityPinDigest(pin), executed, report: run.report, evidenceIds: run.evidenceIds });
        } finally { await options.testIntegrity!.baselineWorkspace.cleanup(); }
      }
  };
  return {
    captureInitialBaseline,
    check: async (input: { runId: string; taskId: string; boundaryId: string; attempt: number; integrationRevision: string; signal?: AbortSignal }) => {
      await captureInitialBaseline(input.taskId, input.signal);
      const trustedProjection = options.testIntegrity?.projection();
      const changedFiles = await options.changedFilesFor(input.taskId);
      const workspace = await options.boundaryWorkspace.create(input.integrationRevision);
      try {
        const inventory = await projectInventory(options.git, workspace.path);
        const selection = computeAffectedTests({
          changedFiles,
          moduleGraph: { allFiles: inventory.allFiles, fileContents: inventory.fileContents },
          fullSuiteTests: inventory.fullSuiteTests,
        });
        const profile = await inspectFinalVerificationExecutionProfile({
          repositoryRoot: workspace.path,
          targetRevision: input.integrationRevision,
          execute: options.git,
        });
        const checks: DeliveryBoundaryCheck[] = [];
        let testIntegrity: TestIntegrityBoundary | undefined;
        if (trustedProjection?.testIntegrity) {
          const baseline = trustedProjection.testIntegrity.baseline;
          const ready = readyPlanIdentity(trustedProjection);
          const review = trustedProjection.delivery?.reviews[input.taskId];
          if (!baseline || !ready || !review) throw new Error("Test-integrity boundary lacks its trusted identity records.");
          const candidatePin = await inspectTestIntegrityPin({ git: options.git, repositoryRoot: workspace.path, revision: input.integrationRevision, commands: profile.commands.tests ?? [] });
          testIntegrity = { version: 1, taskId: input.taskId, integrationRevision: input.integrationRevision,
            planRevisionId: ready.revisionId, planDigest: ready.digest, baselineRevision: baseline.pin.revision,
            baselinePinDigest: baseline.pinDigest, candidatePinDigest: testIntegrityPinDigest(candidatePin),
            submissionAttempt: review.submissionAttempt, changeSetId: review.changeSetId, candidatePin };
          const explicit = Object.values(trustedProjection.testIntegrity.exceptions).findLast((exception) => testIntegrityExceptionMatches(exception, testIntegrity!));
          if (explicit) testIntegrity.exceptionId = explicit.id;
          const findings = unresolvedTestIntegrityFindings({ findings: testIntegrityBaselineFindings(baseline, candidatePin),
            binding: testIntegrity, exception: effectiveTestIntegrityException(trustedProjection, testIntegrity) });
          if (findings.length) {
            // No hidden package/config rewrite and no narrowed candidate script execution.
            checks.push({ checkId: "tests", evidenceIds: [], exitCode: null, outcome: "unknown",
              report: { status: "unknown", runner: "not_run", reason: "Test integrity blocked the changed candidate command/configuration before execution." } });
            checks.push({ checkId: "test_integrity", evidenceIds: [...baseline.evidenceIds], exitCode: 1, outcome: "failed", reason: findings.map((finding) => finding.message).join(" ") });
            return { changedFiles, selection: { rung: selection.rung, selectedTests: [...selection.tests] }, checks, testIntegrity };
          }
        }
        const categories: Array<"build" | "tests"> = profile.commands.build ? ["build", "tests"] : ["tests"];
        for (const category of categories) {
          const ambientNodeOptions = options.ambientNodeOptions?.();
          const run = await runDeliveryCategory({
            ...(ambientNodeOptions !== undefined ? { ambientNodeOptions } : {}),
            category,
            profile,
            manager: workspace.manager,
            runId: input.runId,
            evidenceTaskId: `delivery:${input.taskId}`,
            // N-R4-3: attempt-scoped so a retried run never reuses keys.
            generationId: `${input.boundaryId}:${input.attempt}:${category}`,
            git: options.git,
            artifacts: options.artifacts,
            evidenceStore: options.evidenceStore,
            execution: options.execution,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const report = category === "tests"
            ? run.report ?? { status: "unknown" as const, runner: "none", reason: run.reason ?? "No project test command was detected." }
            : undefined;
          const outcome = !run.ran ? "unknown" : report ? testsOutcome(run.exitCode, report) : outcomeFor(run.exitCode);
          // Real counts: say which runner ran and what report is missing.
          const reason = outcome === "passed"
            ? undefined
            : report && report.status === "unknown" && run.exitCode === 0
              ? `Tests exited 0 but did not prove a run: ${report.reason ?? "no readable report"} (runner: ${report.runner}).`
              : run.reason;
          checks.push({
            checkId: category,
            ...(run.command ? { command: run.command, args: run.args } : {}),
            evidenceIds: run.evidenceIds,
            exitCode: run.exitCode,
            outcome,
            ...(reason ? { reason } : {}),
            ...(report ? { report } : {}),
          });
        }
        if (testIntegrity && trustedProjection?.testIntegrity?.baseline) {
          const baseline = trustedProjection.testIntegrity.baseline;
          const tests = checks.find((check) => check.checkId === "tests");
          const candidateExecuted = executedTestCount(tests?.report?.counts);
          if (candidateExecuted !== undefined) testIntegrity.candidateExecuted = candidateExecuted;
          const findings = testIntegrityBaselineFindings(baseline, testIntegrity.candidatePin, candidateExecuted);
          const unresolved = unresolvedTestIntegrityFindings({ findings, binding: testIntegrity,
            exception: effectiveTestIntegrityException(trustedProjection, testIntegrity), candidateExecuted });
          checks.push({ checkId: "test_integrity", evidenceIds: [...new Set([...baseline.evidenceIds, ...(tests?.evidenceIds ?? [])])],
            exitCode: unresolved.length ? 1 : 0, outcome: unresolved.length ? "failed" : "passed",
            ...(unresolved.length ? { reason: unresolved.map((finding) => finding.message).join(" ") } : {}) });
        }
        return {
          changedFiles,
          selection: { rung: selection.rung, selectedTests: [...selection.tests] },
          checks,
          ...(testIntegrity ? { testIntegrity } : {}),
        };
      } finally {
        await options.boundaryWorkspace.cleanup().catch(() => undefined);
      }
    },
  };
}
