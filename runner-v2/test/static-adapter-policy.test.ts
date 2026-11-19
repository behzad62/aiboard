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
  "src/launcher.ts",
  "src/native-process-backend.ts",
  "src/oci-execution-isolation-provider.ts",
  "src/windows-job-process-host.ts",
  "src/windows-process-semantic-probes.ts",
  "src/windows-birth/session.mjs",
  "src/managed-process-supervisor.mjs",
  "src/portable-process-child.mjs",
  "src/portable-process-posix-control.mjs",
  "src/portable-process-supervisor.mjs",
  "src/extension-mcp-launcher.ts",
  "src/self-update.ts",
  "src/machine-hint.ts",
  "src/shell-inventory.ts",
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

test("launcher bootstrap starts only the fixed Runner V2 and peer runner entrypoints and the OS URL opener", () => {
  const launcher = readFileSync(join(sourceRoot, "launcher.ts"), "utf8");
  assert.match(launcher, /new URL\("\.\.\/bin\/aiboard-runner-v2\.mjs", import\.meta\.url\)/);
  assert.match(launcher, /spawnRunner\(process\.execPath, runnerSpawnArguments\(identity, stateDirectory, args\.runnerFlags\)/);
  assert.match(launcher, /stdio: \["ignore", "pipe", "pipe", "ipc"\]/);
  assert.equal((launcher.match(/\bspawnRunner\s*\(/g) ?? []).length, 1);
  // Combined launches (L1e) start only the three fixed in-repo peer runners, by Node, with fixed arguments.
  for (const entry of ["../../lib/account-provider-runner.mjs", "../../scripts/runner.mjs", "../../scripts/bench-runner.mjs"]) {
    assert.ok(launcher.includes(`fileURLToPath(new URL("${entry}", import.meta.url))`), entry);
  }
  assert.match(launcher, /spawnPeer\(kind, process\.execPath, peerSpawnArguments\(kind, input\.identity, input\.stateDirectory, input\.port\)/);
  assert.equal((launcher.match(/\bspawnPeer\s*\(/g) ?? []).length, 1);
  assert.match(launcher, /\(\(_kind, command, args, options\) => spawn\(command, args, options\)\)/);
  assert.equal((launcher.match(/\bspawn\s*\(/g) ?? []).length, 2);
  assert.match(launcher, /const child = spawn\(command, args, options\);/);
  assert.doesNotMatch(launcher, /\b(?:exec|execFile|fork|spawnSync|execSync|execFileSync)\s*\(/);
});


test("the AIBoard home CLI starts no process, makes no network call, and runs before any Runner start", () => {
  const homeCli = readFileSync(join(sourceRoot, "home-cli.ts"), "utf8");
  assert.doesNotMatch(homeCli, rawChildProcessImport);
  assert.doesNotMatch(homeCli, /from\s+["'](?:node:)?(?:http|https|net|tls|dgram|dns)["']|\bfetch\s*\(|WebSocket/);
  // It writes only through the home store: no direct file writes.
  assert.doesNotMatch(homeCli, /from\s+["'](?:node:)?fs(?:\/promises)?["']/);
  assert.match(homeCli, /applyHomeBatch\(/);
  const launcher = readFileSync(join(sourceRoot, "launcher.ts"), "utf8");
  const dispatch = launcher.indexOf("if (args.home) {");
  assert.ok(dispatch > 0, "the launcher dispatches home commands");
  for (const later of ["await projectIdentity(", "spawnRunner(process.execPath", "const version = await readRunnerVersion();"]) {
    assert.ok(launcher.indexOf(later, launcher.indexOf("export async function runLauncher")) > dispatch, `home commands return before ${later}`);
  }
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
test("CW5a: the managed transport refuses a batch launch before any streaming launch state, after the abort check", () => {
  const transport = readFileSync(join(sourceRoot, "execution-host-managed-transport.ts"), "utf8");
  const abort = transport.indexOf("if (signal.aborted) throw cancelled();");
  const check = transport.indexOf('if (executable && requiredLifecycleScope === "process_group" && options.windowsBatchArgv !== undefined)');
  const assertion = transport.indexOf("assertWindowsBatchLaunchAvailable(executable.path, options.windowsBatchArgv)");
  const open = transport.indexOf("await run.openStreaming(");
  assert.ok(abort > 0 && check > abort, "a cancelled or expired start reports that before the batch refusal");
  assert.ok(assertion > check && open > assertion, "the batch refusal precedes every streaming launch effect");
  assert.equal((transport.match(/assertWindowsBatchLaunchAvailable\(/g) ?? []).length, 1);
  // Only a record already saved stopped with pid 0, with no session and no unreleased host launch, is answered from the record.
  assert.match(transport, /const neverStarted = \(target: ManagedProcessTarget\): boolean => \{\s*if \(target\.status !== "stopped" \|\| target\.pid !== 0 \|\| recordOf\(target\)\) return false;\s*const launch = run\.streamingState\.readHostLaunch\(launchId\(target\.processId\)\);\s*return !launch \|\| launch\.state === "released";/);
  assert.doesNotMatch(transport, /ManagedLaunchNeverStartedError/);
  const service = readFileSync(join(sourceRoot, "managed-process.ts"), "utf8");
  const start = service.slice(service.indexOf("  async start("), service.indexOf("  async poll("));
  assert.match(start, /catch \(primary\) \{\s*try \{ await this\.stopExact\(/, "every failed start runs the exact stop");
  assert.match(start, /AggregateError\(\[primary, cleanup\], "Managed failed start retains unverified exact cleanup\."\)/);
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
  // Both launches (managed and LSP) go through StartSuspended, the one CreateProcess call.
  assert.equal([...jobHost.matchAll(/StartSuspended\(launch, commandLine/g)].length, 2);
  const createProcessFlags = [...jobHost.matchAll(/CreateProcess\([\s\S]*?true, ([^,]+),/g)].map((match) => match[1]!.trim());
  assert.deepEqual(createProcessFlags, ["creationFlags"]);
  assert.deepEqual(
    [...jobHost.matchAll(/creationFlags (?:\|?=) ([^;]+);/g)].map((match) => match[1]!.trim()),
    ["CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW", "EXTENDED_STARTUPINFO_PRESENT"],
    "CreateProcess must not request CREATE_BREAKAWAY_FROM_JOB",
  );
  // Two process attributes, and only these: the desktop app policy keeps a packaged root's descendants in the Job
  // (DISABLE_PROCESS_TREE; never the breakaway-enabling values), and the Job list creates the root inside the Job.
  assert.match(jobHost, /PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE = 0x00000002;/);
  assert.doesNotMatch(jobHost, /DESKTOP_APP_BREAKAWAY_ENABLE|DESKTOP_APP_BREAKAWAY_OVERRIDE/);
  assert.deepEqual([...jobHost.matchAll(/Marshal\.WriteInt32\(policy, ([^)]+)\)/g)].map((match) => match[1]),
    ["PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE"]);
  assert.match(jobHost, /PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;/);
  assert.deepEqual([...jobHost.matchAll(/UpdateProcThreadAttribute\(attributeList, 0, new IntPtr\(([A-Z_]+)\)/g)].map((match) => match[1]),
    ["PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY", "PROC_THREAD_ATTRIBUTE_JOB_LIST"]);
  assert.deepEqual([...jobHost.matchAll(/Marshal\.WriteIntPtr\(jobs, ([^)]+)\)/g)].map((match) => match[1]), ["job"], "the Job list names this Job only");
  // The Job list is left out only for an app execution alias (Windows refuses it for a packaged program), or the
  // stricter-only test fault that takes that Assign path; any other root (a plain symbolic link included) is created
  // inside the Job.
  assert.deepEqual([...jobHost.matchAll(/bool useJobList = ([^;]+);/g)].map((match) => match[1]),
    ["!ForceAssignPath && !appExecLink"]);
  assert.match(jobHost, /IO_REPARSE_TAG_APPEXECLINK = 0x8000001B;/);
  // Only that one reparse tag is an alias: any other reparse point (a plain symbolic link, a mount point) keeps the Job
  // attribute. The check returns the tag comparison and nothing else that could say yes.
  const aliasCheck = /private static bool IsAppExecLink\(string path\)\s*\{([\s\S]*?)\r?\n    \}\r?\n/.exec(jobHost)?.[1] ?? "";
  assert.ok(aliasCheck, "IsAppExecLink is present");
  assert.deepEqual([...aliasCheck.matchAll(/return ([^;]+);/g)].map((match) => match[1]),
    ["false", "false", "unchecked((uint)Marshal.ReadInt32(buffer, 0)) == IO_REPARSE_TAG_APPEXECLINK", "false"]);
  // Every create outside the Job is preceded by the host's written intent, and the non-interactive host (no event file)
  // refuses such a create before it happens.
  assert.match(jobHost, /if \(!useJobList\) EmitAssignIntent\(intentEventPath\);\s*if \(CreateSuspended\(launch,/);
  assert.match(jobHost, /EmitAssignIntent\(intentEventPath\);\s*return CreateSuspended\(launch, [\s\S]*?job, false,/);
  assert.match(jobHost, /environmentBlock, cwd, startup, job, null, out contained, out processInfo\)/, "the non-interactive host passes no intent file");
  assert.match(jobHost, /if \(String\.IsNullOrWhiteSpace\(eventPath\)\)\s*throw new InvalidOperationException\("The root would be created outside the Job/);
  assert.deepEqual([...jobHost.matchAll(/ForceAssignPath = ([^;]+);/g)].map((match) => match[1]),
    ["injectedFault == \"assign_path_exit_after_create\" || injectedFault == \"assign_path_exit_before_assign\""]);
  // On the Assign path the suspended root's exact identity is written before the Assign.
  const assignPath = /EmitAssignPending\(eventPath, processInfo\.dwProcessId, CreationTime\(processInfo\.hProcess\)\);[\s\S]*?AssignProcessToJobObject\(job, processInfo\.hProcess\)/;
  assert.match(jobHost, assignPath);
  assert.equal([...jobHost.matchAll(/AssignProcessToJobObject\(job, /g)].length, 1, "one Assign, after the exact identity");
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


