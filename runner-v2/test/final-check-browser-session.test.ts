// VF4b (docs/plans/2026-11-13-build-verification.md §4.5): a final check drives a real Playwright CLI browser session.
// The check is a `start` check whose program is `playwright-cli-session` (no args, ready on "Daemon listening on")
// and whose steps run `playwright-cli` against a page the test serves. It runs through the Runner's real paths:
// ExecutionHost -> bindRun (with the Playwright CLI environment and the managed stop observer, as
// native-build-factory wires them) -> FinalVerificationRuntime.runCheckV2, its managed adapter for the program and the
// binding's one-shot executor for the steps, the VF2 lookup with the owner's PATH, VF6 outputs.
//
// It needs a browser and takes about 10 s, so it is not in PR CI (the owner's rule: PR CI jobs stay at about three
// minutes). It runs locally, in Docker, and on Windows, macOS and Linux through the portable workflow's manual
// `final-check-browser` scope. In-memory coverage of the same ownership is final-check-browser-ownership.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import { createExecutionHost } from "../src/execution-host.js";
import { withResolvedVerificationPlan } from "../src/final-verification-profile.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  installPlaywrightCliShims,
  PLAYWRIGHT_CLI_COMMAND,
  PLAYWRIGHT_CLI_OUTPUT_FOLDER,
  PLAYWRIGHT_CLI_READY_PATTERN,
  PLAYWRIGHT_CLI_SESSION_COMMAND,
  playwrightCliSessionName,
  PlaywrightCliSessions,
  POSIX_BROWSER_EXIT_GRACE_MS,
  resolvePlaywrightCliInstall,
  type PlaywrightCliBrowser,
} from "../src/playwright-cli.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { completeVerificationPlanV2, type VerificationPlanV2 } from "../src/verification-plan-v2.js";
import { loadPlaywrightRegistry } from "../src/verification-inventory.js";
import { emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import { captureGitBaseline, FinalVerificationRuntime, IntegrationManager, VerificationWorkspaceManager } from "./support/git-fixture.js";

const WINDOWS = process.platform === "win32";
const TASK_ID = "final-verification-0123456789ab";

function installedBrowser(): PlaywrightCliBrowser | undefined {
  try {
    const registry = loadPlaywrightRegistry();
    for (const id of ["chrome", "msedge", "chromium"] as const) {
      const path = registry.findExecutable(id)?.executablePath("javascript");
      if (path && existsSync(path)) return id;
    }
  } catch { /* no registry */ }
  return undefined;
}
const BROWSER = installedBrowser();
// The manual workflow scope sets this, so a host without a browser fails instead of skipping.
const REQUIRE_BROWSER = process.env.AIBOARD_TEST_REQUIRE_PLAYWRIGHT_BROWSER === "1";

// ---------------------------------------------------------------- the processes of a session's state folder

type Row = { pid: number; command: string };
function processTable(): Row[] {
  if (WINDOWS) {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return out.split(/\r?\n/).map((line) => /^(\d+)\t(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ pid: Number(m[1]), command: m[2]! }));
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,stat=,args="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).map((line) => /^\s*(\d+)\s+(\S+)\s?(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m && !m[2]!.startsWith("Z"))
    .map((m) => ({ pid: Number(m[1]), command: m[3]! }));
}
/** The daemon (its --config) and Chrome (its profile) both name the owner's state folder. */
function sessionProcesses(folder: string): Row[] {
  return processTable().filter((row) => (WINDOWS ? row.command.toLowerCase().includes(folder.toLowerCase()) : row.command.includes(folder))
    && row.pid !== process.pid && !/Get-CimInstance/.test(row.command));
}
async function waitFor<T>(read: () => T, done: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function browserPlan(url: string): VerificationPlanV2 {
  const completed = completeVerificationPlanV2({
    checks: [{
      id: "home-page", label: "home page renders", kind: "start",
      start: {
        executable: PLAYWRIGHT_CLI_SESSION_COMMAND, args: [], ready: { outputLine: PLAYWRIGHT_CLI_READY_PATTERN },
        steps: [
          { label: "open the page", executable: PLAYWRIGHT_CLI_COMMAND, args: ["--json", "goto", url] },
          { label: "screenshot", executable: PLAYWRIGHT_CLI_COMMAND, args: ["--json", "screenshot", `--filename=${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`],
            outputs: [`${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`] },
          { label: "console", executable: PLAYWRIGHT_CLI_COMMAND, args: ["--json", "console"] },
          { label: "sessions", executable: PLAYWRIGHT_CLI_COMMAND, args: ["list"] },
        ],
      },
    }],
    skipped: [],
  }, []);
  assert.equal(completed.ok, true, completed.ok ? "" : completed.issues.join(" "));
  return (completed as { plan: VerificationPlanV2 }).plan;
}

test("a final check starts a Playwright CLI session as its program, drives it from its steps, keeps the screenshot and leaves nothing running",
  { skip: BROWSER || REQUIRE_BROWSER ? false : "no Chrome, Edge or Playwright Chromium on this machine", timeout: 120_000 }, async () => {
    assert.ok(BROWSER, "a browser is installed");
    // Each resource is released, newest first, whatever fails: a setup failure must never leave the page's server or
    // a checkout keeping the test process alive until the job's timeout.
    const teardown: Array<() => unknown> = [];
    let closed = false;
    try {
      const html = "<!doctype html><title>VF4b probe</title><h1>Hello VF4b</h1><script>console.log('final-check-page-loaded')</script>";
      const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      teardown.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      // A short root: the POSIX socket path budget (VF7b) applies to the owner folder. Its real path, as git reports
      // it (macOS's /var -> /private/var, a Windows runner's 8.3 short name), which the integration checkout compares.
      const root = realpathSync.native(await mkdtemp(join(tmpdir(), "fc-")));
      teardown.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
      const project = join(root, "p"), state = join(root, "s");
      await mkdir(project); await mkdir(state);
      await writeFile(join(project, "README.md"), "baseline\n");
      const runId = "vf4b-browser";
      const artifacts = new ArtifactStore(join(state, "artifacts"));
      const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
      teardown.push(() => evidence.close());
      const binDirectory = installPlaywrightCliShims(join(state, "pw", "bin"), resolvePlaywrightCliInstall());
      const sessions = new PlaywrightCliSessions({ stateRoot: join(state, "pw"), binDirectory });
      sessions.configureRun(runId, { browser: BROWSER! });
      teardown.push(() => { for (const row of sessionProcesses(join(state, "pw"))) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } } });
      const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
      const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
      teardown.push(() => integration.cleanup());
      await integration.initialize();
      const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
      teardown.push(() => closed ? undefined : host.close());
      const run = await host.bindRun({
        runId, permissionProfile: "full", capabilityContract: { digest: "e".repeat(64) } as never, capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
        processEnvironment: sessions.environmentFor, managedStopObserver: sessions.stopObserver(),
      });
      teardown.push(() => closed ? undefined : run.close());
      const workspace = new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, targetRevision: integration.revision });
      teardown.push(() => workspace.cleanup());
      const owner = { runId, sessionId: TASK_ID };
      const ownerFolder = sessions.ownerFolder(owner);
      const revision = integration.revision;
      const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), browserPlan(url));
      const runtime = new FinalVerificationRuntime({
        execution: run.commandExecution,
        managedProcessService: run.managedProcesses,
        managedProcessAuthority: { executionGrants: run.executionGrants, permissionProfile: "full" },
        workspaceManager: workspace,
        artifacts,
        evidenceStore: evidence,
        runId,
        taskId: TASK_ID,
        attempt: 1,
        generationId: "final-verification-generation-0123456789ab",
        integrationRevision: () => revision,
        // As native-build-factory builds it: the Runner's filtered environment plus the owner's PATH folders.
        toolLookup: createCheckToolLookup({ environment: () => host.filteredEnvironmentSource(), processEnvironment: sessions.environmentFor }),
      });
      const started = Date.now();
      const result = await runtime.runCheckV2({ executionProfile: profile, checkId: "home-page" });
      console.log(`final browser check: ${result.check.outcome} in ${Date.now() - started} ms on ${process.platform} with ${BROWSER}`);
      if (result.check.outcome !== "passed") {
        // Printed at once: a failed teardown afterwards can turn the assertion into a timeout that hides it.
        console.log(`final browser check issues:\n${result.check.issues.join("\n")}`);
        for (const fact of result.check.facts as unknown as Array<{ label?: string; stdoutArtifactHash?: string; stderrArtifactHash?: string }>) {
          for (const [stream, hash] of [["stdout", fact.stdoutArtifactHash], ["stderr", fact.stderrArtifactHash]] as const) {
            if (!hash) continue;
            const text = Buffer.from(await artifacts.get(hash)).toString("utf8").trim();
            if (text) console.log(`--- ${fact.label} ${stream}:\n${text.slice(-2_000)}`);
          }
        }
      }
      assert.equal(result.check.outcome, "passed", result.check.issues.join("\n"));

      // The program is the session, it became ready on its line, and its stop was proven.
      type Fact = { executable: string; args: string[]; readinessSatisfied?: boolean; cleanupRequested?: boolean; cleanupSucceeded?: boolean;
        stdoutArtifactHash: string; outputs?: { files: Array<{ path: string; artifactHash: string }> } };
      const facts = result.check.facts as unknown as Fact[];
      assert.equal(facts.length, 5, "the program and four steps");
      assert.deepEqual([facts[0]!.executable, facts[0]!.args], [PLAYWRIGHT_CLI_SESSION_COMMAND, []]);
      assert.deepEqual([facts[0]!.readinessSatisfied, facts[0]!.cleanupRequested, facts[0]!.cleanupSucceeded], [true, true, true]);
      // The steps reached the program's browser: the page loaded, the console has its line.
      const stdoutOf = async (fact: Fact) => Buffer.from(await artifacts.get(fact.stdoutArtifactHash)).toString("utf8");
      const goto = await stdoutOf(facts[1]!);
      assert.doesNotMatch(goto, /"isError":\s*true/, goto);
      assert.match(goto, /"snapshot"/, goto);
      assert.match(await stdoutOf(facts[3]!), /final-check-page-loaded/);
      // The screenshot is kept as the step's evidence.
      assert.deepEqual(facts[2]!.outputs?.files.map((file) => file.path), [`${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`]);
      assert.equal(Buffer.from(await artifacts.get(facts[2]!.outputs!.files[0]!.artifactHash)).subarray(1, 4).toString("latin1"), "PNG");

      // One owner: a step lists the program's session from its own registry, under the check owner's session name
      // (the stop may already have cleaned the registry up), and no other owner folder was made.
      const listed = await stdoutOf(facts[4]!);
      assert.ok(listed.includes(playwrightCliSessionName(runId, TASK_ID)), listed);
      assert.ok(!listed.includes(playwrightCliSessionName(runId, `final-verification:${TASK_ID}`)), listed);
      const ownerFolders = existsSync(sessions.runFolder(runId)) ? readdirSync(sessions.runFolder(runId)).filter((name) => /^t-[0-9a-f]{8}$/.test(name)) : [];
      assert.ok(ownerFolders.every((name) => name === ownerFolder.split(/[\\/]/).at(-1)), JSON.stringify(ownerFolders));
      // The program's stop left nothing of the session (Windows' Job proves the tree; POSIX ran the browser check).
      assert.deepEqual(await waitFor(() => sessionProcesses(ownerFolder), (rows) => rows.length === 0, POSIX_BROWSER_EXIT_GRACE_MS), []);
      if (!WINDOWS) {
        const records = sessions.cleanupRecords().filter((record) => record.sessionId === TASK_ID);
        assert.equal(records.length, 1, JSON.stringify(sessions.cleanupRecords()));
        assert.ok(["exited", "none"].includes(records[0]!.status), JSON.stringify(records));
        assert.ok(records[0]!.attributed.length > 0, "the session's browser was attributed through its profile");
      }
      closed = true;
      await run.close();
      await host.close();
      await sessions.removeRun(runId);
      assert.equal(existsSync(sessions.runFolder(runId)), false, "the run's state folders are removed");
    } finally {
      for (const release of teardown.reverse()) {
        try { await release(); } catch (error) { console.log(`final-check browser test teardown: ${(error as Error).message}`); }
      }
    }
  });

