import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(runnerRoot, "src");
const binRoot = join(runnerRoot, "bin");
const auditRoots = [sourceRoot, binRoot];
const allowedRawProcessBoundaries = new Set([
  "src/native-process-backend.ts",
  "src/oci-execution-isolation-provider.ts",
  "src/windows-job-process-host.ts",
  "src/windows-process-semantic-probes.ts",
  "src/managed-process-supervisor.mjs",
  "src/owned-fence-lock.mjs",
  "src/portable-process-child.mjs",
  "src/portable-process-posix-control.mjs",
  "src/portable-process-supervisor.mjs",
]);
const allowedNativeScriptProcessBoundaries = new Set([
  "src/managed-process-job-host.ps1",
]);
const rawChildProcessImport = /(?:from\s+["'](?:node:)?child_process["']|(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)|import\s+["'](?:node:)?child_process["'])/;
const boundaryMarker = "RUNNER_RAW_PROCESS_BOUNDARY:";
const nativeProcessCreationSurface = /\bCreateProcess\b|\bStart-Process\b|\bSystem\.Diagnostics\.Process\b|(?:^|\s)-EncodedCommand\b/m;


test("raw child_process audit detects supported import syntaxes and runtime roots", () => {
  for (const source of [
    'import { spawn } from "node:child_process";',
    'import { spawn } from "child_process";',
    'const childProcess = require("node:child_process");',
    'const childProcess = require("child_process");',
    'const childProcess = await import("node:child_process");',
    'const childProcess = await import("child_process");',
  ]) {
    assert.match(source, rawChildProcessImport);
  }
  assert.deepEqual(
    auditRoots.map((root) => relative(runnerRoot, root).replaceAll("\\", "/")),
    ["src", "bin"],
  );
});
test("raw child_process access is confined to explicit audited platform adapter boundaries", () => {
  const offenders: string[] = [];
  const missingMarkers: string[] = [];
  for (const path of auditRoots.flatMap(sourceCodeFiles)) {
    const source = readFileSync(path, "utf8");
    if (!rawChildProcessImport.test(source)) continue;
    const name = relative(runnerRoot, path).replaceAll("\\", "/");
    if (!allowedRawProcessBoundaries.has(name)) offenders.push(name);
    else if (!source.includes(boundaryMarker)) missingMarkers.push(name);
  }
  assert.deepEqual(offenders, [], `Unexpected raw process boundaries: ${offenders.join(", ")}`);
  assert.deepEqual(missingMarkers, [], `Raw process boundaries lack audit markers: ${missingMarkers.join(", ")}`);
});


test("native script process creation is confined to explicit audited platform boundaries", () => {
  const offenders: string[] = [];
  const missingMarkers: string[] = [];
  for (const path of auditRoots.flatMap(nativeScriptFiles)) {
    const source = readFileSync(path, "utf8");
    if (!nativeProcessCreationSurface.test(source)) continue;
    const name = relative(runnerRoot, path).replaceAll("\\", "/");
    if (!allowedNativeScriptProcessBoundaries.has(name)) offenders.push(name);
    else if (!source.includes(boundaryMarker)) missingMarkers.push(name);
  }
  assert.deepEqual(offenders, [], `Unexpected native script process boundaries: ${offenders.join(", ")}`);
  assert.deepEqual(missingMarkers, [], `Native script process boundaries lack audit markers: ${missingMarkers.join(", ")}`);
});
test("architecture documents every audited raw process boundary", () => {
  const architecture = readFileSync(join(runnerRoot, "..", "docs", "runner-v2", "architecture.md"), "utf8");
  const undocumented = [...allowedRawProcessBoundaries, ...allowedNativeScriptProcessBoundaries].filter((path) => !architecture.includes(`\`${path}\``));
  assert.deepEqual(undocumented, [], `Architecture omits audited raw process boundaries: ${undocumented.join(", ")}`);
});
test("authorized stop cleanup budget reaches every production joiner and physical stop layer", () => {
  const cleanupBudget = readFileSync(join(sourceRoot, "cleanup-timeouts.ts"), "utf8");
  assert.match(cleanupBudget, /export const AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS = 60_000;/);
  const usesSharedBudget = [
    "streaming-process-session-runtime.ts",
    "execution-host.ts",
    "execution-host-managed-transport.ts",
    "execution-host-mcp-transport.ts",
    "execution-host-lsp-transport.ts",
    "execution-host-streaming.ts",
    "managed-process.ts",
    "native-build-factory.ts",
    "process-recovery.ts",
    "windows-job-process-host.ts",
  ];
  for (const name of usesSharedBudget) {
    const source = readFileSync(join(sourceRoot, name), "utf8");
    assert.match(source, /AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS/, `${name} does not share the authorized-stop cleanup budget`);
  }
  const supervisor = readFileSync(join(sourceRoot, "managed-process-supervisor.mjs"), "utf8");
  assert.match(supervisor, /MAX_STOP_DEADLINE_MS = 60_000/);
  assert.doesNotMatch(supervisor, /Math\.min\(30_000, requestedDeadline/);
  const nativeHost = readFileSync(join(sourceRoot, "windows-job-process-host.ts"), "utf8");
  assert.match(nativeHost, /DEFAULT_CONTROL_DEADLINE_MS = 5_000/);
  assert.match(nativeHost, /this\.controlDeadlineMs = options\.controlDeadlineMs \?\? DEFAULT_CONTROL_DEADLINE_MS/);
  assert.match(nativeHost, /"\/write"[\s\S]{0,220}this\.controlDeadlineMs \+ 250/);
  assert.doesNotMatch(nativeHost, /"\/write"[\s\S]{0,220}this\.stopDeadlineMs \+ 250/);
  const jobHost = readFileSync(join(sourceRoot, "managed-process-job-host.ps1"), "utf8");
  assert.match(jobHost, /DefaultStopDeadlineMs = 60000/);
  assert.doesNotMatch(jobHost, /Math\.Min\(30000, deadlineMs\)/);
  const harness = readFileSync(join(runnerRoot, "test", "support", "real-streaming-harness.ts"), "utf8");
  assert.match(harness, /AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS/);
});
test("Windows Job host LimitFlags and CreateProcess flags never enable breakaway", () => {
  const jobHost = readFileSync(join(sourceRoot, "managed-process-job-host.ps1"), "utf8");
  assert.match(
    jobHost,
    /limits\.BasicLimitInformation\.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;/,
    "Job limits must stay exactly KILL_ON_JOB_CLOSE",
  );
  assert.doesNotMatch(jobHost, /JOB_OBJECT_LIMIT_BREAKAWAY_OK/);
  assert.doesNotMatch(jobHost, /JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK/);
  assert.doesNotMatch(jobHost, /CREATE_BREAKAWAY_FROM_JOB/);
  assert.doesNotMatch(jobHost, /\b0x00000800\b/);
  assert.doesNotMatch(jobHost, /\b0x00001000\b/);
  assert.doesNotMatch(jobHost, /\b0x01000000\b/);
  const createProcessFlags = [...jobHost.matchAll(/CreateProcess\([\s\S]*?true, ([^,]+),/g)].map((match) => match[1]!.trim());
  assert.deepEqual(
    createProcessFlags,
    [
      "CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW",
      "CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW",
    ],
    "CreateProcess must not request CREATE_BREAKAWAY_FROM_JOB",
  );
});function sourceCodeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceCodeFiles(path);
    return entry.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}
function nativeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return nativeScriptFiles(path);
    return entry.isFile() && /\.ps1$/.test(entry.name) ? [path] : [];
  });
}


