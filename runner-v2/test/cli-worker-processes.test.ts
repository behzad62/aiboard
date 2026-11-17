// CLI workers CW3: the free checks and the Test through the real execution host (cli-worker-processes.ts), the Windows
// Job or the POSIX process group, as a worker's processes run. A fake CLI only (test/support/fake-cli.mjs): no real CLI
// is started. The OS seam stays win32, so the Windows-only v1 path runs on every CI host; the process host is this
// host's own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { CliWorkerDetection } from "../src/cli-worker-detection.js";
import { createExecutionHostCliWorkerProcesses } from "../src/cli-worker-processes.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { cliFixture, FAKE_CLI_SCRIPT, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";

const CLAUDE = "C:\\Tools\\claude.exe";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("through the execution host: checks and a Test run with AIBOARD_MCP_DEPTH=2, the Test folder goes after the verified stop, and a timed-out Test's tree is stopped", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiboard-cli-processes-")));
  const project = join(root, "project"), state = join(root, "state"), scenarios = join(root, "scenarios");
  for (const folder of [project, state, scenarios]) mkdirSync(folder, { recursive: true });
  // The host passes only its filtered environment, so the scenario rides in argv: this wrapper takes it off argv,
  // records the depth the CLI was given, and runs the fake CLI.
  const wrapper = join(root, "fake-cli-wrapper.mjs");
  writeFileSync(wrapper, [
    `import { writeFileSync } from "node:fs";`,
    `const scenario = process.argv.splice(2, 1)[0];`,
    `process.env.AIBOARD_FAKE_CLI_SCENARIO = scenario;`,
    `writeFileSync(scenario + ".depth", String(process.env.AIBOARD_MCP_DEPTH ?? ""));`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLI_SCRIPT).href)});`,
  ].join("\n"));
  const version = join(root, "version.txt");
  writeFileSync(version, "2.1.326 (Claude Code)\n");
  const scenarioFor = (name: string, run: Partial<FakeCliScenario>): string => writeFakeCliScenario(scenarios, {
    cli: "claude-code",
    responses: [
      { args: ["--version"], stdout: version },
      { args: ["auth", "status"], stdout: cliFixture("claude-code/free/auth-status.logged-in.json") },
    ],
    record: `${name}-run.json`,
    ...run,
  }, `${name}.json`);
  let scenario = scenarioFor("passing", { stdout: cliFixture("claude-code/success.windows.stdout.json") });
  const capabilitiesConfig = emptyRunnerCapabilitiesConfig();
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  try {
    const detection = new CliWorkerDetection({
      stateDirectory: state,
      processes: createExecutionHostCliWorkerProcesses({
        host,
        capabilitiesConfig: () => capabilitiesConfig,
        capabilityContract: async () => await createRunnerCapabilityContract(capabilitiesConfig, { commandSearchDirectory: state }),
      }),
      lookup: async (name) => (name === "claude" ? { status: "found", path: CLAUDE } : { status: "missing" }),
      platform: "win32",
      isRoot: () => false,
      inspect: async () => "file",
      command: (_path, args) => ({ executable: process.execPath, arguments: [wrapper, scenario, ...args] }),
      testTimeoutMs: 3_000,
    });

    const check = await detection.check("claude-code");
    assert.equal(check.status, "ready", JSON.stringify(check));
    assert.equal(check.version, "2.1.326");
    assert.equal(readFileSync(`${scenario}.depth`, "utf8"), "2", "a probe's CLI gets AIBOARD_MCP_DEPTH=2");

    const passed = await detection.test("claude-code", { model: null });
    assert.equal(passed.lastTest.outcome, "passed", JSON.stringify(passed));
    assert.equal(passed.stopVerified, true);
    const record = JSON.parse(readFileSync(join(scenarios, "passing-run.json"), "utf8")) as FakeCliRecord;
    assert.ok(realpathSync(join(record.cwd, "..", "..")) === realpathSync(join(state, "cli-worker-tests")), record.cwd);
    assert.match(record.stdin, /connection test from AIBoard/);
    assert.equal(readFileSync(`${scenario}.depth`, "utf8"), "2", "the Test's CLI gets AIBOARD_MCP_DEPTH=2");
    const tests = join(state, "cli-worker-tests");
    assert.deepEqual(existsSync(tests) ? readdirSync(tests) : [], [], "the Test folder is removed after the verified stop");

    // A CLI that never answers, with a child of its own: the deadline, then the binding's stop takes the whole tree.
    scenario = scenarioFor("hanging", { holdMs: 60_000, grandchildMs: 60_000 });
    const timedOut = await detection.test("claude-code", { model: null });
    assert.equal(timedOut.lastTest.outcome, "timed_out", JSON.stringify(timedOut));
    assert.equal(timedOut.stopVerified, true);
    const hanging = JSON.parse(readFileSync(join(scenarios, "hanging-run.json"), "utf8")) as FakeCliRecord;
    assert.ok(hanging.grandchildPid, "the fake started its child");
    assert.equal(alive(hanging.grandchildPid!), false, "the CLI's own child was stopped with it");
    assert.deepEqual(readdirSync(tests), []);

    // Checks and Tests leave no history: each binding's run root and process records went with it after its proven
    // stop, so the shared record store (bounded at 4096 records, which every Build's processes share) gains nothing.
    const listed = (folder: string) => (existsSync(folder) ? readdirSync(folder) : []);
    assert.deepEqual(listed(join(state, "transient-runs")), [], "every transient run folder was removed");
    assert.deepEqual(listed(join(state, "builds")).filter((name) => name.includes("cli-worker")), [], "no run root under builds/");
    assert.deepEqual(listed(join(state, "managed-processes")).filter((name) => name.endsWith(".json")), [], "no record in the shared store");
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
