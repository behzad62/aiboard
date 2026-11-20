// CLI workers CW3: the free checks and the Test through the real execution host (cli-worker-processes.ts), the Windows
// Job or the POSIX process group, as a worker's processes run. A fake CLI only (test/support/fake-cli.mjs): no real CLI
// is started. The OS seam stays win32, so the Windows-only v1 path runs on every CI host; the process host is this
// host's own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import test, { type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { CliWorkerDetection } from "../src/cli-worker-detection.js";
import { createExecutionHostCliWorkerProcesses, type CliWorkerProcesses, type CliWorkerProcessOutput } from "../src/cli-worker-processes.js";
import { createExecutionHost } from "../src/execution-host.js";
import { MANAGED_OUTPUT_LIVE_TAIL_BYTES } from "../src/managed-process-output.js";
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
      // Each running process's start time and its reads so far (all, and those that brought no text).
      const running = new Map<string, { startedAt: number; reads: number; empty: number; lost: Set<string> }>();
      return {
        async start(spec) {
          const began = Date.now();
          const started = await session.start(spec);
          // The CLI's own argv, after the wrapper and the scenario; long arguments (the Test's schema) cut short.
          const name = `${input.purpose} ${spec.args.slice(2).map((arg) => (arg.length > 40 ? `${arg.slice(0, 40)}…` : arg)).join(" ")}`;
          const state = { startedAt: Date.now(), reads: 0, empty: 0, lost: new Set<string>() };
          running.set(name, state);
          let stdoutChars = 0;
          return {
            closeInput: async (text) => await started.closeInput(text),
            async read(waitMs) {
              const output = await started.read(waitMs);
              stdoutChars += output.stdout.length;
              state.reads += 1;
              if (!output.stdout && !output.stderr) state.empty += 1;
              for (const reason of output.lost) state.lost.add(reason);
              if (output.exited) {
                running.delete(name);
                notes.push(`${name}: started in ${state.startedAt - began} ms, exited ${output.exitCode} after ${Date.now() - state.startedAt} ms, ${stdoutChars} stdout chars, ${state.reads} reads (${state.empty} empty)${state.lost.size ? `, output lost: ${[...state.lost].join(",")}` : ""}`);
              }
              return output;
            },
            rewind() {
              notes.push(`${name}: read again from the start`);
              stdoutChars = 0;
              started.rewind();
            },
          };
        },
        async close() {
          for (const [name, state] of running) notes.push(`${name}: no exit read after ${Date.now() - state.startedAt} ms, ${state.reads} reads (${state.empty} empty)${state.lost.size ? `, output lost: ${[...state.lost].join(",")}` : ""}`);
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

test("through the execution host: checks and a Test run with AIBOARD_MCP_DEPTH=2, the Test folder goes after the verified stop, and a timed-out Test's tree is stopped", { timeout: 120_000 }, async (t) => {
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
  // A step at its bound can outlast the test's own timeout. node:test aborts this signal then, while the body is still
  // pending, and also once any test ends, so it prints only while the body has not reached its finally.
  let settled = false;
  t.signal.addEventListener("abort", () => { if (!settled) console.error(`the test was aborted${trace()}`); }, { once: true });
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
    assert.equal(await fakeGrandchildAlive(hanging), false, "the CLI's own child was stopped with it");
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
    console.error(`the test failed${trace()}`);
    throw error;
  } finally {
    settled = true;
    let closed = false;
    try {
      await host.close();
      closed = true;
    } catch (error) {
      // A close that fails after the body failed must not hide the body's error (CI runs 44349809623 and 44350732167
      // showed only the close). Either way its nested causes are printed in full.
      console.error(`host.close failed${bodyFailed ? " after the test had already failed" : ""}: ${inspect(error, { depth: Infinity })}${trace()}`);
      if (!bodyFailed) throw error;
    }
    // The folders stay when the stop was not proven: a process may still hold or write them.
    if (closed) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        if (!bodyFailed) throw error;
        console.error(`the test folder could not be removed: ${inspect(error)}`);
      }
    }
  }
});

// Codex's real `debug models` prints about 0.8 MB at once (each model carries its instructions). Under the execution
// host the live reads keep only the newest MANAGED_OUTPUT_LIVE_TAIL_BYTES, so the first read skipped the start, the JSON
// did not parse, and Settings offered AIBoard's own OpenAI catalog instead of Codex's models (owner, 2026-11-20). The
// probe now reads its whole output again from the finalized record once the CLI exited. Every run prints its probes'
// timings, reads and lost output (a passing one too), so these tests' own CI times can be measured.
async function largeProbeThroughHost(t: TestContext, stateThroughAlias: boolean) {
  // The real path without 8.3 short names (GitHub's Windows temp is under RUNNER~1): the Runner refuses an output spill
  // root whose real path is spelled differently (spill_root_invalid), and without a spill the start is gone for good.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-cli-probe-")));
  const project = join(root, "project"), scenarios = join(root, "scenarios");
  let state = join(root, "state");
  for (const folder of [project, state, scenarios]) mkdirSync(folder, { recursive: true });
  // The state folder reached through a junction (Windows) or a symlink: the spill root then looks like an alias.
  const alias = stateThroughAlias ? join(root, "state-alias") : undefined;
  if (alias) {
    symlinkSync(state, alias, process.platform === "win32" ? "junction" : "dir");
    state = alias;
  }
  const wrapper = join(root, "fake-cli-wrapper.mjs");
  writeFileSync(wrapper, [
    `const scenario = process.argv.splice(2, 1)[0];`,
    `process.env.AIBOARD_FAKE_CLI_SCENARIO = scenario;`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLI_SCRIPT).href)});`,
  ].join("\n"));
  // The CW0 fixture is trimmed to 23 KB; each model gets instructions as long as the real ones, about 1 MB in all.
  const list = JSON.parse(readFileSync(cliFixture("codex-cli/free/debug-models.json"), "utf8")) as { models: Array<Record<string, unknown>> };
  for (const [index, model] of list.models.entries()) model.base_instructions = `${index}:${"You are Codex, a coding agent. ".repeat(3_000)}`;
  const models = join(root, "debug-models.json");
  writeFileSync(models, JSON.stringify(list, null, 1));
  assert.ok(statSync(models).size > 4 * MANAGED_OUTPUT_LIVE_TAIL_BYTES, "the list is far longer than the live tail");
  const version = join(root, "version.txt");
  writeFileSync(version, "codex-cli 0.171.0\n");
  const scenario = writeFakeCliScenario(scenarios, {
    cli: "codex-cli",
    responses: [
      { args: ["--version"], stdout: version },
      { args: ["login", "status"], stderr: cliFixture("codex-cli/free/login-status.logged-in.txt") },
      { args: ["debug", "models"], stdout: models },
    ],
    record: "probe-run.json",
  }, "probe.json");
  const capabilitiesConfig = emptyRunnerCapabilitiesConfig();
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...PROCESS_HOST_FACTS });
  const notes: string[] = [];
  let bodyFailed = false;
  try {
    const detection = new CliWorkerDetection({
      stateDirectory: state,
      processes: traced(createExecutionHostCliWorkerProcesses({
        host,
        capabilitiesConfig: () => capabilitiesConfig,
        capabilityContract: async () => await createRunnerCapabilityContract(capabilitiesConfig, { commandSearchDirectory: state }),
      }), notes),
      lookup: async (name) => (name === "codex" ? { status: "found", path: "C:\\Tools\\codex.exe" } : { status: "missing" }),
      platform: "win32",
      isRoot: () => false,
      inspect: async () => "file",
      windowsJobContainment: async () => (process.platform === "win32" ? (await host.windowsProcessFacts?.())?.jobContainment : "verified"),
      command: (_path, args) => ({ executable: process.execPath, arguments: [wrapper, scenario, ...args] }),
      probeTimeoutMs: CI_STEP_BOUND_MS,
    });
    const check = await detection.check("codex-cli", {});
    return { check, notes, trace: `\nprocesses:\n  ${notes.join("\n  ")}`, listed: list.models.filter((model) => model.visibility === "list").map((model) => model.slug) };
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    for (const note of notes) t.diagnostic(note);
    try {
      await host.close();
      // The alias first, so removing the folder never walks through it.
      if (alias) rmSync(alias);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (!bodyFailed) throw error;
      console.error(`cleanup after the failure: ${inspect(error, { depth: Infinity })}`);
    }
  }
}

test("through the execution host: a free probe that prints far more than the live tail at once is read whole", { timeout: 120_000 }, async (t) => {
  const { check, trace, listed } = await largeProbeThroughHost(t, false);
  assert.equal(check.modelsSource, "cli", `${check.modelsNote ?? "no note"}${trace}`);
  assert.ok(listed.length > 0);
  // Whether the live reads fell behind the CLI's one write (and so read it again) depends on the host's speed; the
  // trace says which happened, and the scripted test below drives the re-read itself.
  assert.deepEqual(check.models?.filter((model) => model.id !== null).map((model) => model.id), listed, trace);
});

// A record that lost output (here its spill root, reached through an alias, was refused) never reads `complete`, so the
// probe used to read it as running until its bound (Windows CI run 44765956605). It now ends once the record is
// released: the probe sees the start is missing and falls back to the catalog, without parsing the tail.
test("through the execution host: a free probe whose output record lost its start ends at once and is not parsed", { timeout: 120_000 }, async (t) => {
  const { check, notes, trace } = await largeProbeThroughHost(t, true);
  assert.ok(notes.some((note) => /^check debug models: started in .* exited 0 after .*output lost: .*spill_root_invalid/.test(note)), `the probe did not end with its loss${trace}`);
  assert.ok(!notes.some((note) => note.includes("no exit read")), trace);
  assert.equal(check.modelsSource, "catalog", trace);
});

/**
 * A process double whose reads follow a script per probe: `live` is what each read returns before any rewind (as a
 * host whose live reads skipped the start returns it), `whole` what reads return after one. Rewinds are noted.
 */
function scriptedProcesses(scripts: Record<string, { live: CliWorkerProcessOutput; whole?: CliWorkerProcessOutput }>, rewinds: string[]): CliWorkerProcesses {
  return {
    async open() {
      return {
        async start({ args }) {
          const name = args.join(" ");
          const script = scripts[name];
          if (!script) throw new Error(`no script for ${name}`);
          let rewound = false;
          return {
            async closeInput() {},
            async read(waitMs) {
              if (!script.live.exited) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 20)));
              return { ...(rewound && script.whole ? script.whole : script.live) };
            },
            rewind() { rewound = true; rewinds.push(name); },
          };
        },
        async close() {},
      };
    },
  };
}

test("a free probe whose live reads skipped its start is read again once it exited, and only then", async (t) => {
  const state = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-cli-scripted-")));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const list = readFileSync(cliFixture("codex-cli/free/debug-models.json"), "utf8");
  const listed = (JSON.parse(list) as { models: Array<{ slug: string; visibility: string }> }).models.filter((model) => model.visibility === "list").map((model) => model.slug);
  const exited = (stdout: string, extra: Partial<CliWorkerProcessOutput> = {}): CliWorkerProcessOutput => ({ stdout, stderr: "", gap: false, lost: [], exited: true, exitCode: 0, ...extra });
  const base = {
    "--version": { live: exited("codex-cli 0.171.0\n") },
    "login status": { live: exited("", { stderr: readFileSync(cliFixture("codex-cli/free/login-status.logged-in.txt"), "utf8") }) },
  };
  // The tail only, as the live reads left it once the start was skipped.
  const tail = list.slice(Math.floor(list.length / 2));
  const check = async (models: { live: CliWorkerProcessOutput; whole?: CliWorkerProcessOutput }, probeTimeoutMs = CI_STEP_BOUND_MS) => {
    const rewinds: string[] = [];
    const detection = new CliWorkerDetection({
      stateDirectory: state,
      processes: scriptedProcesses({ ...base, "debug models": models }, rewinds),
      lookup: async (name) => (name === "codex" ? { status: "found", path: "C:\\Tools\\codex.exe" } : { status: "missing" }),
      platform: "win32",
      isRoot: () => false,
      inspect: async () => "file",
      windowsJobContainment: async () => "verified",
      command: (_path, args) => ({ executable: "codex", arguments: [...args] }),
      probeTimeoutMs,
    });
    return { result: await detection.check("codex-cli", {}), rewinds };
  };

  const reread = await check({ live: exited(tail, { gap: true }), whole: exited(list) });
  assert.deepEqual(reread.rewinds, ["debug models"]);
  assert.equal(reread.result.modelsSource, "cli", reread.result.modelsNote ?? "no note");
  assert.deepEqual(reread.result.models?.filter((model) => model.id !== null).map((model) => model.id), listed);

  // The finalized record skipped a stretch too (no spill): the start stays unknown, so nothing is parsed from the middle.
  const stillCut = await check({ live: exited(tail, { gap: true }), whole: exited(tail, { gap: true }) });
  assert.deepEqual(stillCut.rewinds, ["debug models"]);
  assert.equal(stillCut.result.modelsSource, "catalog");

  // A probe still running at its bound is not read again: it did not finish. 300 ms is a deadline that must pass.
  const running = await check({ live: { stdout: "", stderr: "", gap: true, lost: [], exited: false, exitCode: null }, whole: exited(list) }, 300);
  assert.deepEqual(running.rewinds, []);
  assert.equal(running.result.modelsSource, "catalog");

  // No gap: read once, as before.
  const whole = await check({ live: exited(list) });
  assert.deepEqual(whole.rewinds, []);
  assert.equal(whole.result.modelsSource, "cli");
});
