// CLI workers CW3: the free checks and the Test through the real execution host (cli-worker-processes.ts), the Windows
// Job or the POSIX process group, as a worker's processes run. A fake CLI only (test/support/fake-cli.mjs): no real CLI
// is started. The OS seam stays win32, so the Windows-only v1 path runs on every CI host; the process host is this
// host's own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { CliWorkerDetection } from "../src/cli-worker-detection.js";
import { createExecutionHostCliWorkerProcesses, type CliWorkerProcesses } from "../src/cli-worker-processes.js";
import { createExecutionHost } from "../src/execution-host.js";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { cliFixture, FAKE_CLI_SCRIPT, fakeGrandchildAlive, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";

const CLAUDE = "C:\\Tools\\claude.exe";
const CANARIES = ["canary@example.test", "Canary Org", "00000000-0000-4000-8000-000000000000"];

// Every bound a step of the test below waits on, as the owner's rule sets it: 1.5x the slowest passing GitHub CI run of
// the whole test, 37,919 ms on Windows (50 Windows portable-contract runs, 2026-11-17 to 11-19; median 23.7 s), since no
// step takes longer than its whole test. The probes had the product's 8 s bound and the passing Test 30 s; the probes'
// version came back unknown once (CI run 44500809465). The hanging Test's 1.5 s is a deadline that must pass, not a bound.
const CI_STEP_BOUND_MS = 56_879;

/** Wraps the sessions to note how each process and each session's stop ended, so a failure names its cause. */
function traced(processes: CliWorkerProcesses, notes: string[]): CliWorkerProcesses {
  return {
    async open(input) {
      const session = await processes.open(input);
      const running = new Map<string, number>();
      return {
        async start(spec) {
          const began = Date.now();
          const started = await session.start(spec);
          const name = `${input.purpose} ${spec.args.slice(2).join(" ")}`;
          const startedAt = Date.now();
          running.set(name, startedAt);
          let stdoutChars = 0;
          return {
            closeInput: async (text) => await started.closeInput(text),
            async read(waitMs) {
              const output = await started.read(waitMs);
              stdoutChars += output.stdout.length;
              if (output.exited) {
                running.delete(name);
                notes.push(`${name}: started in ${startedAt - began} ms, exited ${output.exitCode} after ${Date.now() - startedAt} ms, ${stdoutChars} stdout chars`);
              }
              return output;
            },
          };
        },
        async close() {
          for (const [name, startedAt] of running) notes.push(`${name}: no exit read after ${Date.now() - startedAt} ms`);
          try {
            await session.close();
            notes.push(`${input.purpose} session: stop proven`);
          } catch (error) {
            notes.push(`${input.purpose} session: stop not proven: ${inspect(error, { depth: Infinity })}`);
            throw error;
          }
        },
      };
    },
  };
}

// The host's process facts are injected, not probed: the probe alone takes about 9 s on a Windows host. On Windows they
// name the Job as the only backend (no portable fallback), so a Job that does not work fails this test instead of
// passing on the fallback; GitHub's Windows image verifies Job containment and refuses .cmd launches, as here.
const PROCESS_HOST_FACTS = process.platform === "win32"
  ? { processHostFacts: { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "verified" } as const }
  : {};

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
  // The shared Job host as the Runner makes it, keeping spares warm (runner-start.ts): a check or Test must never wake one.
  const sharedJobHost = createWindowsJobProcessHost({
    stateDirectory: join(state, "managed-processes-job-host"),
    platform: process.platform === "win32" ? "win32" : "linux",
    spare: { keepWarm: true, idleTimeoutMs: 60_000, maxSpares: 4 },
  });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), windowsJobHost: sharedJobHost, ...PROCESS_HOST_FACTS });
  const notes: string[] = [];
  const trace = () => `\nprocesses:\n  ${notes.join("\n  ")}`;
  let bodyFailed = false;
  try {
    // The passing Test ends on its result event, so its deadline is only a bound; the hanging one waits it out.
    const detection = (testTimeoutMs: number) => new CliWorkerDetection({
      stateDirectory: state,
      processes: traced(createExecutionHostCliWorkerProcesses({
        host,
        capabilitiesConfig: () => capabilitiesConfig,
        capabilityContract: async () => await createRunnerCapabilityContract(capabilitiesConfig, { commandSearchDirectory: state }),
      }), notes),
      lookup: async (name) => (name === "claude" ? { status: "found", path: CLAUDE } : { status: "missing" }),
      platform: "win32",
      isRoot: () => false,
      inspect: async () => "file",
      // On Windows the host's own Job fact decides (§3.11); a POSIX host has none, and the win32 seam needs one.
      windowsJobContainment: async () => (process.platform === "win32" ? (await host.windowsProcessFacts?.())?.jobContainment : "verified"),
      command: (_path, args) => ({ executable: process.execPath, arguments: [wrapper, scenario, ...args] }),
      probeTimeoutMs: CI_STEP_BOUND_MS,
      testTimeoutMs,
    });

    // A Test runs the free checks first (their probes in their own transient binding), then the CLI.
    const passed = await detection(CI_STEP_BOUND_MS).test("claude-code", { model: null });
    assert.equal(passed.lastTest.outcome, "passed", JSON.stringify(passed) + trace());
    assert.equal(passed.lastTest.cliVersion, "2.1.326", "the probes' version reached the result" + trace());
    assert.equal(passed.stopVerified, true);
    const record = JSON.parse(readFileSync(join(scenarios, "passing-run.json"), "utf8")) as FakeCliRecord;
    // Native real paths on both sides: GitHub's Windows image gives the CLI a long cwd and tmpdir() an 8.3 one.
    assert.equal(realpathSync.native(join(record.cwd, "..", "..")), realpathSync.native(join(state, "cli-worker-tests")), record.cwd);
    assert.match(record.stdin, /connection test from AIBoard/);
    assert.equal(readFileSync(`${scenario}.depth`, "utf8"), "2", "the Test's CLI gets AIBOARD_MCP_DEPTH=2");
    const tests = join(state, "cli-worker-tests");
    assert.deepEqual(existsSync(tests) ? readdirSync(tests) : [], [], "the Test folder is removed after the verified stop");

    // A CLI that never answers, with a child of its own: the deadline, then the binding's stop takes the whole tree.
    // On Windows the child is detached, outside libuv's own kill-on-close job, so only the Runner's Job can stop it.
    scenario = scenarioFor("hanging", { holdMs: 60_000, grandchildMs: 60_000, ...(process.platform === "win32" ? { grandchildDetached: true } : {}) });
    const timedOut = await detection(1_500).test("claude-code", { model: null });
    assert.equal(timedOut.lastTest.outcome, "timed_out", JSON.stringify(timedOut) + trace());
    assert.equal(timedOut.stopVerified, true);
    const hanging = JSON.parse(readFileSync(join(scenarios, "hanging-run.json"), "utf8")) as FakeCliRecord;
    assert.ok(hanging.grandchildPid, "the fake started its child");
    assert.equal(fakeGrandchildAlive(hanging), false, "the CLI's own child was stopped with it");
    assert.deepEqual(readdirSync(tests), []);

    // Checks and Tests leave no history: each binding's run root and process records went with it after its proven
    // stop, so the shared record store (bounded at 4096 records, which every Build's processes share) gains nothing.
    assert.deepEqual(sharedJobHost.spareStats?.(), { prestarts: 0, claims: 0, fallbacks: 0 }, "no check or Test woke a spare of the shared Job host");
    const listed = (folder: string) => (existsSync(folder) ? readdirSync(folder) : []);
    assert.deepEqual(listed(join(state, "transient-runs")), [], "every transient run folder was removed");
    assert.deepEqual(listed(join(state, "builds")).filter((name) => name.includes("cli-worker")), [], "no run root under builds/");
    assert.deepEqual(listed(join(state, "managed-processes")).filter((name) => name.endsWith(".json")), [], "no record in the shared store");
    assert.deepEqual(listed(join(state, "managed-processes-job-host")).filter((name) => name.startsWith("process_")), [],
      "no record or output log in the shared Windows Job host");
    // §3.2: the account fields `auth status` prints are never stored. Nothing under the state folder holds one.
    const holding: string[] = [];
    const scan = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile() && CANARIES.some((canary) => readFileSync(path).toString("latin1").includes(canary))) holding.push(path);
      }
    };
    scan(state);
    assert.deepEqual(holding, [], "no file under the state folder holds an account field");
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    try {
      await host.close();
    } catch (error) {
      // A close that fails after the body failed must not hide the body's error (CI runs 44349809623 and 44350732167
      // showed only the close). Either way its nested causes are printed in full; the folders stay, as nothing was proven.
      console.error(`host.close failed${bodyFailed ? " after the test had already failed" : ""}: ${inspect(error, { depth: Infinity })}${trace()}`);
      if (!bodyFailed) throw error;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
