/**
 * Shared qualification harness: evidence roots, isolated scenario processes,
 * bounded convergence, and failure diagnostics. Test-only; never product authority.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tsxCli = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const registeredFixtureRoots = new Set<string>();
const deferredFixtureRemovals = new Set<string>();
let fixtureRegistrationSequence = 0;
let diagnosticCaptureSequence = 0;

export function qualificationArtifactRoot(env = process.env): string {
  const configured = env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT?.trim();
  if (configured) {
    mkdirSync(configured, { recursive: true });
    return resolve(configured);
  }
  const root = mkdtempSync(join(tmpdir(), "runner-v2-qual-evidence-"));
  return root;
}

export function createQualificationFixtureRoot(prefix: string, evidenceRoot?: string): string {
  // Fixtures stay under OS tmpdir so git-fixture confinement and exact-owned
  // cleanup namespaces remain valid. Register them in the artifact-visible root
  // so the parent can capture durable evidence before timeout termination.
  const root = resolve(mkdtempSync(join(tmpdir(), `aiboard-qual-${prefix}-`)));
  registeredFixtureRoots.add(root);
  const evidence = evidenceRoot ?? process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT;
  if (evidence) {
    const scenario = process.env.RUNNER_V2_QUALIFICATION_SCENARIO?.trim() || prefix;
    const mapDir = join(evidence, "fixture-roots", sanitize(scenario));
    mkdirSync(mapDir, { recursive: true });
    fixtureRegistrationSequence += 1;
    writeFileSync(
      join(mapDir, `${String(process.pid)}-${String(fixtureRegistrationSequence)}-${sanitize(prefix)}.path.txt`),
      `${root}\n`,
    );
  }
  return root;
}

/** Delete only after the scenario body and exact-owned cleanup both succeeded. */
export function deferQualificationFixtureRemoval(root: string): void {
  deferredFixtureRemovals.add(resolve(root));
}

export function registeredQualificationFixtureRoots(): readonly string[] {
  return [...registeredFixtureRoots];
}

export function qualificationFixtureRootsFromEvidence(evidenceRoot: string, scenario: string): string[] {
  const mapDir = join(evidenceRoot, "fixture-roots", sanitize(scenario));
  if (!existsSync(mapDir)) return [];
  const roots = new Set<string>();
  for (const entry of readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".path.txt")) continue;
    try {
      const root = readFileSync(join(mapDir, entry.name), "utf8").trim();
      if (root) roots.add(resolve(root));
    } catch {
      // Diagnostic discovery is best-effort; a corrupt pointer never authorizes cleanup.
    }
  }
  return [...roots];
}

function flushDeferredFixtureRemovals(): void {
  for (const root of deferredFixtureRemovals) {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    registeredFixtureRoots.delete(root);
  }
  deferredFixtureRemovals.clear();
}

class QualificationScenarioSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "QualificationScenarioSkip";
  }
}

export function skipQualificationScenario(reason: string): never {
  const bounded = reason.trim().slice(0, 1_000);
  if (!bounded) throw new Error("Qualification skip reason must be non-empty.");
  throw new QualificationScenarioSkip(bounded);
}

function qualificationSkipMarkerPath(evidenceRoot: string, scenario: string): string {
  return join(evidenceRoot, "skip-markers", `${sanitize(scenario)}.json`);
}

export type ConvergenceDecision =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }
  | { kind: "retry" };

/** Expected passes; definitive invalid fails immediately; persistent unknown fails with evidence. */
export async function boundedConverge(input: Readonly<{
  deadlineMs: number;
  pollMs?: number;
  sample: () => ConvergenceDecision | Promise<ConvergenceDecision>;
  evidence: () => string | Promise<string>;
  label: string;
}>): Promise<void> {
  const pollMs = input.pollMs ?? 20;
  const deadline = Date.now() + input.deadlineMs;
  let last = "not sampled";
  for (;;) {
    const decision = await input.sample();
    if (decision.kind === "pass") return;
    if (decision.kind === "fail") {
      throw new Error(`${input.label}: ${decision.reason}; evidence=${await input.evidence()}`);
    }
    last = "unknown/retry";
    if (Date.now() >= deadline) {
      throw new Error(`${input.label}: persistent unknown after ${input.deadlineMs}ms (${last}); evidence=${await input.evidence()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function safeProcessSnapshot(): Readonly<{
  pid: number;
  ppid: number;
  platform: string;
  arch: string;
  node: string;
  cwd: string;
  title: string;
  argv: readonly string[];
  memoryUsage: NodeJS.MemoryUsage;
  /** Intentionally omits env — never dump secrets. */
}> {
  return {
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd: process.cwd(),
    title: process.title,
    argv: process.argv,
    memoryUsage: process.memoryUsage(),
  };
}

export function writeQualificationDiagnostics(input: Readonly<{
  evidenceRoot: string;
  scenario: string;
  fixtureRoots?: readonly string[];
  extra?: Record<string, unknown>;
  error?: unknown;
}>): string {
  const dir = join(input.evidenceRoot, "diagnostics", sanitize(input.scenario));
  mkdirSync(dir, { recursive: true });
  diagnosticCaptureSequence += 1;
  const captureId = `${String(Date.now())}-${String(process.pid)}-${String(diagnosticCaptureSequence)}`;
  const captureDir = join(dir, "captures", captureId);
  mkdirSync(captureDir, { recursive: true });
  const fixtureRoots = input.fixtureRoots
    ?? qualificationFixtureRootsFromEvidence(input.evidenceRoot, input.scenario);
  const payload = {
    scenario: input.scenario,
    capturedAt: new Date().toISOString(),
    process: safeProcessSnapshot(),
    fixtureRoots,
    timings: { capturedAtMs: Date.now() },
    error: summarizeError(input.error),
    extra: input.extra ?? {},
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(join(captureDir, "summary.json"), serialized);
  const firstSummary = join(dir, "summary.json");
  if (!existsSync(firstSummary)) writeFileSync(firstSummary, serialized);
  for (const root of fixtureRoots) {
    try {
      captureFixtureTree(root, join(captureDir, "fixtures", sanitize(root)));
    } catch (captureError) {
      writeFileSync(join(captureDir, `fixture-capture-failed-${sanitize(root)}.txt`),
        String(captureError instanceof Error ? captureError.stack ?? captureError.message : captureError));
    }
  }
  return captureDir;
}

function captureFixtureTree(sourceRoot: string, destRoot: string): void {
  if (!existsSync(sourceRoot)) {
    mkdirSync(dirname(destRoot), { recursive: true });
    writeFileSync(`${destRoot}.missing.txt`, `missing: ${sourceRoot}\n`);
    return;
  }
  mkdirSync(destRoot, { recursive: true });
  const interesting = [
    "state.json",
    "lock-holder.json",
    "control.json",
    "child-prepared.json",
    "child-status.json",
    "fence.sqlite",
    "fence.sqlite-wal",
    "fence.sqlite-shm",
    "owned-fence.sqlite",
    "owned-fence.sqlite-wal",
    "owned-fence.sqlite-shm",
  ];
  walkCopySelected(sourceRoot, destRoot, interesting, 0, []);
}

function walkCopySelected(
  source: string,
  dest: string,
  interesting: readonly string[],
  depth: number,
  relativeSegments: readonly string[],
): void {
  if (depth > 8) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    const childSegments = [...relativeSegments, entry.name];
    if (entry.isDirectory()) {
      walkCopySelected(from, to, interesting, depth + 1, childSegments);
      continue;
    }
    if (!entry.isFile()) continue;
    const base = entry.name.toLowerCase();
    const parentRole = relativeSegments.at(-1)?.toLowerCase();
    const portableChannelEvidence = ["output", "ack", "input"].includes(parentRole ?? "")
      && /^(stdout|stderr|input)-\d{12}\.json$/.test(base);
    const hostOutputEvidence = ["stdout.log", "stderr.log", "job-events.jsonl", "supervisor.jsonl"].includes(base);
    const keep = interesting.some((name) => base === name.toLowerCase())
      || base.endsWith(".sqlite")
      || base.endsWith(".sqlite-wal")
      || base.endsWith(".sqlite-shm")
      || base === "state.json"
      || portableChannelEvidence
      || hostOutputEvidence
      || base.endsWith(".json") && (base.includes("ack") || base.includes("output") || base.includes("client-state"));
    if (!keep) continue;
    try {
      const size = statSync(from).size;
      if (size > 2 * 1024 * 1024) {
        writeFileSync(`${to}.omitted.txt`, `omitted large file bytes=${size}\n`);
        continue;
      }
      writeFileSync(to, readFileSync(from));
    } catch (error) {
      writeFileSync(`${to}.read-failed.txt`, String(error));
    }
  }
}

export async function runIsolatedScenario(input: Readonly<{
  scenarioFileUrl: string | URL;
  evidenceRoot: string;
  scenarioName: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** Only Docker/local capability probes may intentionally skip; qualification is fail-closed by default. */
  allowSkip?: boolean;
}>): Promise<"passed" | "skipped"> {
  const scenarioPath = fileURLToPath(input.scenarioFileUrl);
  const skipMarker = qualificationSkipMarkerPath(input.evidenceRoot, input.scenarioName);
  rmSync(skipMarker, { force: true });
  const started = Date.now();
  const child = spawn(process.execPath, [tsxCli, scenarioPath], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    env: {
      ...process.env,
      ...input.env,
      NODE_NO_WARNINGS: "1",
      RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT: input.evidenceRoot,
      RUNNER_V2_QUALIFICATION_SCENARIO: input.scenarioName,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    closed.then(() => false as const),
    new Promise<true>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(true), input.timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (timedOut) {
    const timeoutError = new Error(`scenario timed out after ${input.timeoutMs}ms`);
    const diag = writeQualificationDiagnostics({
      evidenceRoot: input.evidenceRoot,
      scenario: input.scenarioName,
      error: timeoutError,
      extra: {
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 64_000),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 64_000),
        elapsedMs: Date.now() - started,
        timedOut: true,
        childPid: child.pid,
        phase: "before-timeout-termination",
      },
    });
    await terminateIsolatedChild(child, closed);
    throw new Error(`Isolated qualification scenario timed out: ${input.scenarioName}; diagnostics=${diag}`);
  }
  const result = await closed;
  const outText = Buffer.concat(stdout).toString("utf8");
  const errText = Buffer.concat(stderr).toString("utf8");
  const diagDir = join(input.evidenceRoot, "diagnostics", sanitize(input.scenarioName));
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(join(diagDir, "stdout.txt"), outText);
  writeFileSync(join(diagDir, "stderr.txt"), errText);
  writeFileSync(join(diagDir, "timing.json"),
    `${JSON.stringify({ elapsedMs: Date.now() - started, code: result.code, signal: result.signal }, null, 2)}\n`);
  if (result.code !== 0) {
    writeQualificationDiagnostics({
      evidenceRoot: input.evidenceRoot,
      scenario: input.scenarioName,
      error: new Error(`exit ${String(result.code)} signal ${String(result.signal)}`),
      extra: { stdout: outText.slice(0, 64_000), stderr: errText.slice(0, 64_000), childPid: child.pid },
    });
    assert.equal(result.code, 0,
      `Isolated scenario ${input.scenarioName} failed (code=${String(result.code)}, signal=${String(result.signal)}):\n${errText || outText}`);
  }
  const structuredSkip = existsSync(skipMarker);
  const textOnlySkip = /^SKIP\b/m.test(outText) || /^QUAL_SKIP\b/m.test(outText);
  if (textOnlySkip && !structuredSkip) {
    const error = new Error(`Isolated qualification scenario emitted unstructured skip text without a skip marker: ${input.scenarioName}`);
    writeQualificationDiagnostics({
      evidenceRoot: input.evidenceRoot,
      scenario: input.scenarioName,
      error,
      extra: { stdout: outText.slice(0, 64_000), stderr: errText.slice(0, 64_000), childPid: child.pid },
    });
    throw error;
  }
  if (structuredSkip && !input.allowSkip) {
    const error = new Error(`Isolated qualification scenario attempted an unapproved skip: ${input.scenarioName}`);
    writeQualificationDiagnostics({
      evidenceRoot: input.evidenceRoot,
      scenario: input.scenarioName,
      error,
      extra: { stdout: outText.slice(0, 64_000), stderr: errText.slice(0, 64_000), childPid: child.pid },
    });
    throw error;
  }
  return structuredSkip ? "skipped" : "passed";
}

async function terminateIsolatedChild(
  child: ReturnType<typeof spawn>,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed;
    return;
  }
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true as const),
    new Promise<false>((resolveGrace) => {
      const timer = setTimeout(() => resolveGrace(false), 5_000);
      timer.unref();
    }),
  ]);
  if (graceful) return;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  const forced = await Promise.race([
    closed.then(() => true as const),
    new Promise<false>((resolveForced) => {
      const timer = setTimeout(() => resolveForced(false), 5_000);
      timer.unref();
    }),
  ]);
  if (!forced) throw new Error(`Isolated qualification child ${String(child.pid)} did not exit after forced termination.`);
}

export function summarizeError(error: unknown, depth = 0): unknown {
  if (depth > 5) return "bounded";
  if (!(error instanceof Error)) return String(error).slice(0, 500);
  return {
    name: error.name,
    message: error.message.slice(0, 1_000),
    code: (error as { code?: unknown }).code,
    ...(error instanceof AggregateError ? { errors: error.errors.map((item) => summarizeError(item, depth + 1)) } : {}),
    ...(error.cause ? { cause: summarizeError(error.cause, depth + 1) } : {}),
  };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export async function exitScenarioMain(run: () => Promise<void>): Promise<void> {
  try {
    await run();
    flushDeferredFixtureRemovals();
    process.exit(0);
  } catch (error) {
    const evidenceRoot = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT;
    const scenario = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "scenario";
    if (error instanceof QualificationScenarioSkip) {
      if (!evidenceRoot) {
        writeSync(2, `Qualification skip marker root is unavailable: ${error.reason}\n`);
        process.exit(1);
      }
      const marker = qualificationSkipMarkerPath(evidenceRoot, scenario);
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `${JSON.stringify({ scenario, reason: error.reason }, null, 2)}\n`);
      writeSync(1, `QUAL_SKIP ${error.reason}\n`);
      process.exit(0);
    }
    if (evidenceRoot) {
      writeQualificationDiagnostics({
        evidenceRoot,
        scenario,
        fixtureRoots: registeredQualificationFixtureRoots(),
        error,
      });
    }
    writeSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
}
