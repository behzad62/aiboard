import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CheckToolLookup, CheckToolLookupResult } from "../src/check-tool-lookup.js";
import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import type { FinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  boundEnvironmentInventory,
  collectEnvironmentInventory,
  firstVersionLine,
  INVENTORY_VERSION_PROBE_TIMEOUT_MS,
  inventoryCheckCommands,
  inventoryVersionArgs,
  loadPlaywrightRegistry,
  MAX_INVENTORY_TOOLS,
  MAX_INVENTORY_VERSION_LENGTH,
  oneShotInventoryRunner,
  parseEnvironmentInventory,
  parseLddMissingLibraries,
  playwrightBrowserInventory,
  renderEnvironmentInventory,
  type EnvironmentInventory,
  type InventoryBrowserRecord,
  type InventoryProbeRequest,
  type InventoryProbeResult,
  type PlaywrightRegistryLike,
} from "../src/verification-inventory.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { captureGitBaseline, NativeBuildFactory, runGit } from "./support/git-fixture.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

const NO_BROWSERS = async () => ({ browsers: [] as InventoryBrowserRecord[], notes: [] as string[] });

function fakeLookup(found: Record<string, string>, unknown: Record<string, string> = {}): CheckToolLookup {
  return async (executable): Promise<CheckToolLookupResult> => {
    if (found[executable]) return { status: "found", path: found[executable]! };
    if (unknown[executable]) return { status: "unknown", reason: unknown[executable]! };
    return { status: "missing" };
  };
}

function recordingRunner(answer: (request: InventoryProbeRequest) => InventoryProbeResult) {
  const requests: InventoryProbeRequest[] = [];
  return {
    requests,
    run: async (request: InventoryProbeRequest) => {
      requests.push(request);
      return answer(request);
    },
  };
}

function profileWith(partial: Partial<FinalVerificationExecutionProfile>): FinalVerificationExecutionProfile {
  return { version: 1, targetRevision: "rev", inspectedPaths: [], detectedSignals: [], commands: {}, ...partial };
}

function inventoryFixture(overrides: Partial<EnvironmentInventory> = {}): EnvironmentInventory {
  return {
    version: 1,
    trigger: "planning",
    platform: "linux",
    arch: "x64",
    runnerNode: "v24.0.0",
    tools: [
      { name: "git", status: "found", path: "/usr/bin/git", version: "git version 2.43.0", usedBy: ["runner"] },
      { name: "pytest", status: "missing", usedBy: ["tests: pytest"] },
    ],
    toolsOmitted: 0,
    browsers: [{ id: "chrome", status: "missing" }, { id: "msedge", status: "missing" }, { id: "chromium", status: "found", path: "/cache/chrome", version: "149.0" }],
    playwrightBrowser: "chromium",
    notes: [],
    ...overrides,
  };
}

test("VF1 the inventory lists Git, Node and every check's executable, and records a missing tool with its name", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-vf1-checkout-"));
  try {
    const checks = inventoryCheckCommands(profileWith({
      commands: {
        build: [{ label: "dotnet build", executable: "dotnet", args: ["build"] }],
        tests: [{ label: "pytest", executable: "pytest", args: [] }],
      },
      runtimeSmoke: {
        label: "serve", executable: "go", args: ["run", "."], readiness: { kind: "http", path: "/", status: 200 } as never,
        steps: [{ label: "pair", executable: "go", args: ["run", "./cmd/pair"] }],
      },
      tiers: { fast: [{ label: "lint", executable: "dotnet", args: ["format", "--verify-no-changes"] }] },
    }));
    const runner = recordingRunner((request) => ({
      outcome: "exited",
      exitCode: 0,
      stdout: `${request.executable} ${request.args.join(" ")} 1.2.3\nsecond line\n`,
      stderr: "",
    }));
    const inventory = await collectEnvironmentInventory({
      trigger: "planning",
      revision: "abc123",
      cwd: checkout,
      checks,
      lookup: fakeLookup({ git: "/usr/bin/git", node: "/usr/bin/node", dotnet: "/usr/bin/dotnet", go: "/usr/local/go/bin/go" }),
      run: runner.run,
      browsers: NO_BROWSERS,
      platform: "linux",
    });
    assert.deepEqual(inventory.tools.map((tool) => [tool.name, tool.status]), [
      ["git", "found"], ["node", "found"], ["dotnet", "found"], ["pytest", "missing"], ["go", "found"],
    ]);
    const pytest = inventory.tools.find((tool) => tool.name === "pytest")!;
    assert.deepEqual(pytest, { name: "pytest", status: "missing", usedBy: ["tests: pytest"] });
    assert.deepEqual(inventory.tools.find((tool) => tool.name === "dotnet")?.usedBy, ["build: dotnet build", "tier fast: lint"]);
    assert.deepEqual(inventory.tools.find((tool) => tool.name === "go")?.usedBy, ["start: serve", "start step: pair"]);
    // Only found tools are probed, each once, with the family's own version flag.
    assert.deepEqual(runner.requests.map((request) => [request.executable, ...request.args]), [
      ["/usr/bin/git", "--version"], ["/usr/bin/node", "--version"], ["/usr/bin/dotnet", "--version"], ["/usr/local/go/bin/go", "version"],
    ]);
    assert.equal(inventory.tools.find((tool) => tool.name === "go")?.version, "/usr/local/go/bin/go version 1.2.3");
    for (const request of runner.requests) {
      // A short timeout, the checkout as the folder, and nothing allowed to download.
      assert.equal(request.timeoutMs, INVENTORY_VERSION_PROBE_TIMEOUT_MS);
      assert.ok(request.timeoutMs <= 10_000);
      assert.equal(request.cwd, checkout);
      assert.equal(request.environment.GOTOOLCHAIN, "local");
      assert.equal(request.environment.RUSTUP_AUTO_INSTALL, "0");
      assert.equal(request.environment.COREPACK_ENABLE_NETWORK, "0");
      assert.equal(request.environment.npm_config_offline, "true");
    }
    assert.equal(inventory.revision, "abc123");
    assert.equal(inventory.trigger, "planning");
    assert.deepEqual(parseEnvironmentInventory(JSON.parse(JSON.stringify(inventory))), inventory);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("VF1 version probes report what happened: a timeout, a non-zero exit, no output, a path and a Node script", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-vf1-outcomes-"));
  const npmBin = mkdtempSync(join(tmpdir(), "aiboard-vf1-npm-"));
  const npmCli = join(npmBin, "npm-cli.js");
  writeFileSync(npmCli, "");
  try {
    const runner = recordingRunner((request) => {
      if (request.executable === "/bin/slow") return { outcome: "timed_out", stdout: "", stderr: "" };
      if (request.executable === "/bin/broken") return { outcome: "exited", exitCode: 2, stdout: "", stderr: "\u001b[31merror: no SDK\u001b[0m\n" };
      if (request.executable === "/bin/quiet") return { outcome: "exited", exitCode: 0, stdout: "\n \n", stderr: "" };
      return { outcome: "exited", exitCode: 0, stdout: "10.9.0\n", stderr: "" };
    });
    const inventory = await collectEnvironmentInventory({
      trigger: "resume",
      cwd: checkout,
      checks: [
        { label: "build: slow", executable: "slow", args: [] },
        { label: "build: broken", executable: "broken", args: [] },
        { label: "tests: quiet", executable: "quiet", args: [] },
        { label: "tests: wrapper", executable: "./gradlew", args: ["test"] },
        { label: "build: package build", executable: "/runner/node", args: [npmCli, "run", "build"] },
        { label: "tier fast: shell", executable: "cmd", args: ["/c", "check.bat"] },
      ],
      lookup: fakeLookup(
        { git: "/bin/git", node: "/bin/node", slow: "/bin/slow", broken: "/bin/broken", quiet: "/bin/quiet", cmd: "/bin/cmd" },
        { "./gradlew": "The executable names a path, not a tool on PATH." },
      ),
      run: runner.run,
      browsers: NO_BROWSERS,
      platform: "linux",
      nodeExecPath: "/runner/node",
    });
    const tool = (name: string) => inventory.tools.find((entry) => entry.name === name);
    assert.match(tool("slow")?.versionNote ?? "", /timed out after 8 s/);
    assert.equal(tool("broken")?.versionNote, "The version probe exited 2: error: no SDK");
    assert.equal(tool("quiet")?.versionNote, "The version probe printed nothing.");
    assert.deepEqual(tool("gradlew"), { name: "gradlew", status: "unknown", note: "The executable names a path, not a tool on PATH.", usedBy: ["tests: wrapper"] });
    // npm runs as the Runner's Node with npm-cli.js; it is recorded as npm and probed the same way.
    assert.deepEqual(tool("npm"), { name: "npm", status: "found", path: npmCli, version: "10.9.0", usedBy: ["build: package build"] });
    assert.ok(runner.requests.some((request) => request.executable === "/runner/node" && request.args[0] === npmCli && request.args[1] === "--version"));
    // A shell without a version flag is recorded and never run.
    assert.equal(tool("cmd")?.versionNote, "No version flag is probed for this tool.");
    assert.ok(!runner.requests.some((request) => request.executable === "/bin/cmd"));
    assert.ok(!runner.requests.some((request) => request.executable.includes("gradlew")));
    assert.equal(inventory.trigger, "resume");
  } finally {
    rmSync(npmBin, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("VF1 a tool the Windows launcher would find in the checkout is recorded but its version is not run", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-vf1-local-"));
  try {
    const runner = recordingRunner(() => ({ outcome: "exited", exitCode: 0, stdout: "x 1\n", stderr: "" }));
    const inventory = await collectEnvironmentInventory({
      trigger: "planning",
      cwd: checkout,
      checks: [{ label: "tests: pytest", executable: "pytest", args: [] }],
      lookup: fakeLookup({ git: "C:/git.exe", node: "C:/node.exe", pytest: join(checkout, "pytest.bat") }),
      run: runner.run,
      browsers: NO_BROWSERS,
      platform: "win32",
    });
    assert.equal(inventory.tools.find((tool) => tool.name === "pytest")?.versionNote, "A file of the project; its version is not probed.");
    assert.equal(runner.requests.length, 2);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("VF1 the payload is bounded: a tool cap with a count, truncated version lines and notes", async () => {
  const checks = Array.from({ length: 30 }, (_, index) => ({ label: `tier full: tool ${index}`, executable: `tool${index}`, args: [] }));
  const found = Object.fromEntries([["git", "/g"], ["node", "/n"], ...checks.map((check) => [check.executable, `/bin/${check.executable}`])]);
  const runner = recordingRunner(() => ({ outcome: "exited", exitCode: 0, stdout: `${"v".repeat(500)}\n`, stderr: "" }));
  const inventory = await collectEnvironmentInventory({
    trigger: "planning",
    cwd: tmpdir(),
    checks,
    checksNote: "n".repeat(2_000),
    lookup: fakeLookup(found),
    run: runner.run,
    browsers: NO_BROWSERS,
    platform: "linux",
  });
  assert.equal(inventory.tools.length, MAX_INVENTORY_TOOLS);
  assert.equal(inventory.toolsOmitted, 32 - MAX_INVENTORY_TOOLS);
  assert.equal(runner.requests.length, MAX_INVENTORY_TOOLS, "omitted tools are not probed");
  for (const tool of inventory.tools) assert.ok((tool.version ?? "").length <= MAX_INVENTORY_VERSION_LENGTH);
  assert.ok(inventory.notes[0]!.length <= 300);
  assert.ok(Buffer.byteLength(JSON.stringify(inventory)) < 16_000);
  assert.deepEqual(boundEnvironmentInventory(inventory), inventory);
  assert.equal(firstVersionLine("-----------\nGradle 8.5\n", ""), "Gradle 8.5");
  assert.equal(firstVersionLine("", "openjdk version \"21\"\n"), "openjdk version \"21\"");
  assert.deepEqual(inventoryVersionArgs("go.exe"), ["version"]);
  assert.deepEqual(inventoryVersionArgs("cmake"), ["--version"]);
  assert.deepEqual(inventoryVersionArgs("java"), ["-version"]);
  assert.equal(inventoryVersionArgs("powershell.exe"), undefined);
});

test("VF1 real probes run through the Runner's one-shot executor, with no project file written", async (t) => {
  const fixture = createProductionOneShotCommandFixture(t);
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-vf1-real-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(join(checkout, "package.json"), "{}\n");
  const before = readdirSync(checkout).sort();
  const executed: { executable: string; timeoutMs: number; runnerInternal: boolean | undefined; actor: string }[] = [];
  const execution = {
    execute: async (request: Parameters<typeof fixture.runnerOwnedExecution.execute>[0]) => {
      executed.push({ executable: request.executable, timeoutMs: request.timeoutMs, runnerInternal: request.context.runnerInternal, actor: request.context.actor.role });
      return await fixture.runnerOwnedExecution.execute(request);
    },
  };
  const inventory = await collectEnvironmentInventory({
    trigger: "planning",
    cwd: checkout,
    checks: [{ label: "tests: missing tool", executable: "aiboard-vf1-no-such-tool", args: ["run"] }],
    lookup: createCheckToolLookup({ environment: () => process.env }),
    run: oneShotInventoryRunner(execution, { runId: "run_vf1_real" }),
    browsers: NO_BROWSERS,
  });
  const git = inventory.tools.find((tool) => tool.name === "git");
  const node = inventory.tools.find((tool) => tool.name === "node");
  assert.equal(git?.status, "found");
  assert.match(git?.version ?? "", /^git version /);
  assert.equal(node?.status, "found");
  assert.match(node?.version ?? "", /^v\d+\./);
  assert.deepEqual(inventory.tools.find((tool) => tool.name === "aiboard-vf1-no-such-tool"), {
    name: "aiboard-vf1-no-such-tool", status: "missing", usedBy: ["tests: missing tool"],
  });
  assert.equal(executed.length, 2, "one probe per found tool, none for the missing one");
  for (const entry of executed) {
    assert.equal(entry.timeoutMs, INVENTORY_VERSION_PROBE_TIMEOUT_MS);
    assert.equal(entry.runnerInternal, true);
    assert.equal(entry.actor, "runner_internal");
  }
  assert.deepEqual(readdirSync(checkout).sort(), before, "the probes wrote nothing into the checkout");
});

test("VF1 the browser for the Playwright CLI: Chrome first, then Edge, then Playwright's Chromium", async () => {
  const registry = (paths: Record<string, string | undefined>): PlaywrightRegistryLike => ({
    findExecutable: (name) => ({ executablePath: () => paths[name], ...(name === "chromium" ? { browserVersion: "149.0.7827.55" } : {}) }),
  });
  const lookup = fakeLookup({});
  const run = async () => ({ outcome: "exited" as const, exitCode: 0, stdout: "", stderr: "" });
  const exists = (path: string) => !path.includes("absent");
  const edgeOnly = await playwrightBrowserInventory({ platform: "win32", cwd: tmpdir(), lookup, run, exists,
    registry: () => registry({ chrome: undefined, msedge: "C:/Edge/msedge.exe", chromium: "C:/ms-playwright/absent/chrome.exe" }) });
  assert.deepEqual(edgeOnly.browsers, [
    { id: "chrome", status: "missing" },
    { id: "msedge", status: "found", path: "C:/Edge/msedge.exe" },
    { id: "chromium", status: "missing", version: "149.0.7827.55" },
  ]);
  const chosen = await collectEnvironmentInventory({ trigger: "planning", cwd: tmpdir(), checks: [], lookup, run, browsers: async () => edgeOnly, platform: "win32" });
  assert.equal(chosen.playwrightBrowser, "msedge");
  const all = await playwrightBrowserInventory({ platform: "win32", cwd: tmpdir(), lookup, run, exists,
    registry: () => registry({ chrome: "C:/Chrome/chrome.exe", msedge: "C:/Edge/msedge.exe", chromium: "C:/ms-playwright/chrome.exe" }) });
  assert.equal((await collectEnvironmentInventory({ trigger: "planning", cwd: tmpdir(), checks: [], lookup, run, browsers: async () => all, platform: "win32" })).playwrightBrowser, "chrome");
  const none = await playwrightBrowserInventory({ platform: "win32", cwd: tmpdir(), lookup, run, exists,
    registry: () => { throw new Error("no registry"); } });
  assert.deepEqual(none.browsers.map((browser) => browser.status), ["unknown", "unknown", "unknown"]);
  assert.match(none.notes[0] ?? "", /registry could not be read: no registry/);
});

test("VF1 Linux: Playwright's Chromium with missing shared libraries is recorded and not chosen; ldd starts no browser", async () => {
  const requests: InventoryProbeRequest[] = [];
  const result = await playwrightBrowserInventory({
    platform: "linux",
    cwd: "/checkout",
    lookup: fakeLookup({ ldd: "/usr/bin/ldd" }),
    run: async (request) => {
      requests.push(request);
      return { outcome: "exited", exitCode: 0, stdout: "\tlinux-vdso.so.1 (0x00007ffd)\n\tlibnspr4.so => not found\n\tlibnss3.so => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n", stderr: "" };
    },
    exists: () => true,
    registry: () => ({ findExecutable: (name) => name === "chromium" ? { executablePath: () => "/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome", browserVersion: "149.0" } : { executablePath: () => undefined } }),
  });
  assert.deepEqual(requests.map((request) => [request.executable, ...request.args]), [["/usr/bin/ldd", "/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"]]);
  assert.deepEqual(result.browsers.find((browser) => browser.id === "chromium")?.missingLibraries, ["libnspr4.so", "libnss3.so"]);
  const inventory = await collectEnvironmentInventory({ trigger: "planning", cwd: "/checkout", checks: [], lookup: fakeLookup({}), run: async () => ({ outcome: "exited", exitCode: 0, stdout: "", stderr: "" }), browsers: async () => result, platform: "linux" });
  assert.equal(inventory.playwrightBrowser, null);
  assert.deepEqual(parseLddMissingLibraries("libx.so => not found\nlibx.so => not found\n"), ["libx.so"]);
  const noLdd = await playwrightBrowserInventory({
    platform: "linux", cwd: "/checkout", lookup: fakeLookup({}), run: async () => { throw new Error("must not run"); }, exists: () => true,
    registry: () => ({ findExecutable: (name) => ({ executablePath: () => name === "chromium" ? "/c/chrome" : undefined }) }),
  });
  assert.equal(noLdd.browsers.find((browser) => browser.id === "chromium")?.status, "found");
  assert.match(noLdd.notes[0] ?? "", /ldd is not on PATH/);
});

test("VF1 the bundled Playwright registry is read in-process, with no launch", async () => {
  const registry = loadPlaywrightRegistry();
  for (const id of ["chrome", "msedge", "chromium"]) assert.ok(registry.findExecutable(id), `${id} is in the registry`);
  const result = await playwrightBrowserInventory({
    platform: process.platform,
    cwd: tmpdir(),
    lookup: fakeLookup({}),
    run: async () => { throw new Error("no command for the browser lookup off Linux"); },
  });
  assert.deepEqual(result.browsers.map((browser) => browser.id), ["chrome", "msedge", "chromium"]);
  for (const browser of result.browsers) assert.ok(browser.status === "found" || browser.status === "missing", JSON.stringify(browser));
});

test("VF1 the event replays, a malformed or non-Runner inventory is refused, and older runs replay unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-vf1-replay-"));
  const path = join(root, "scheduler.sqlite");
  const runId = "run_vf1_replay";
  try {
    let store = new SqliteSchedulerStore(path);
    store.append({ runId, type: "run.initialized", occurredAt: "2026-11-13T00:00:00.000Z", actor: { role: "runner", id: "test" }, idempotencyKey: "init", payload: { objective: "o" } });
    const older = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal("environmentInventory" in older, false, "a run without the event has no inventory");
    const inventory = inventoryFixture();
    const append = (payload: unknown, actor = { role: "runner" as const, id: "build-runtime" }, key = "environment-inventory:0") => store.append({
      runId, type: "environment.inventory_recorded", occurredAt: "2026-11-13T00:00:01.000Z", actor, idempotencyKey: key, payload: payload as Record<string, unknown>,
    });
    assert.throws(() => append({ ...inventory, extra: true }, undefined, "bad-1"), /unknown field extra/);
    assert.throws(() => append({ ...inventory, tools: Array.from({ length: MAX_INVENTORY_TOOLS + 1 }, () => inventory.tools[0]) }, undefined, "bad-2"), /more than 24/);
    assert.throws(() => append({ ...inventory, tools: [{ ...inventory.tools[0]!, version: "v".repeat(MAX_INVENTORY_VERSION_LENGTH + 1) }] }, undefined, "bad-3"), /version is invalid/);
    assert.throws(() => append({ ...inventory, playwrightBrowser: "firefox" }, undefined, "bad-4"), /Playwright browser is invalid/);
    assert.throws(() => append(inventory, { role: "architect" as never, id: "architect" }, "bad-5"), /Only the build runtime/);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(runId)), older, "refused appends leave the run as it was");
    append(inventory);
    const recorded = rebuildSchedulerProjection(store.readRun(runId)).environmentInventory;
    assert.deepEqual(recorded, { ...inventory, sequence: 2, recordedAt: "2026-11-13T00:00:01.000Z" });
    store.close();
    store = new SqliteSchedulerStore(path);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(runId)).environmentInventory, recorded, "the event replays after a reopen");
    // The Architect's lines name every tool, the missing one included, and the CLI browser.
    const text = renderEnvironmentInventory(recorded!);
    assert.match(text, /- git: found at \/usr\/bin\/git; git version 2\.43\.0 \[used by: runner\]/);
    assert.match(text, /- pytest: missing \[used by: tests: pytest\]/);
    assert.match(text, /Browser for the Playwright CLI: --browser=chromium/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class RecordingModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    return { blocks: [], stopReason: "cancelled" };
  }
}

test("VF1 a factory-built run records the inventory of its checks in a disposable checkout before the Architect's first turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-vf1-factory-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const runId = "run_vf1_factory";
  const model = new RecordingModel();
  let factory: InstanceType<typeof NativeBuildFactory> | undefined;
  let handle: Awaited<ReturnType<InstanceType<typeof NativeBuildFactory>["create"]>> | undefined;
  try {
    mkdirSync(project);
    mkdirSync(state);
    writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "vf1-factory", scripts: { build: "node -e 1" } })}\n`);
    writeFileSync(join(project, "aiboard-validation.json"), `${JSON.stringify({ version: 1, tiers: { fast: [{ label: "missing linter", executable: "aiboard-vf1-no-such-linter", args: ["check"] }] } })}\n`);
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
    const projectStatus = async () => (await runGit({ cwd: project, args: ["status", "--porcelain=v1", "--untracked-files=all"] })).stdout;
    const statusBefore = await projectStatus();
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [{
          runtimeId: "fixture:model", providerId: "fixture", modelId: "model", transport: "openai-compatible",
          baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority: 1,
        }],
        save: () => undefined,
        close: () => undefined,
      },
      baselineFor: () => baseline.revision,
      providerModelFactory: () => model,
      environmentInventory: true,
    });
    handle = await factory.create(await factory.prepareSpec({
      version: 2 as const,
      runId,
      projectId: "vf1-project",
      objective: "Record the inventory.",
      architectRuntimeId: "fixture:model",
      workerRuntimeIds: ["fixture:model"],
      verifierRuntimeIds: ["fixture:model"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full" as const,
      runPolicy: "finish" as const,
      budgetLimits: {},
      createdAt: "2026-11-13T00:00:00.000Z",
      idempotencyKey: `vf1:${runId}`,
    }));
    await handle.runtime.step().catch(() => undefined);
    const events = handle.runtime.events();
    const inventoryEvent = events.find((event) => event.type === "environment.inventory_recorded");
    assert.ok(inventoryEvent, events.map((event) => event.type).join(", "));
    const inventory = handle.runtime.projection().environmentInventory!;
    assert.equal(inventory.trigger, "planning");
    assert.equal(inventory.revision, baseline.revision);
    const tool = (name: string) => inventory.tools.find((entry) => entry.name === name);
    assert.equal(tool("git")?.status, "found");
    assert.match(tool("git")?.version ?? "", /^git version /);
    assert.match(tool("node")?.version ?? "", /^v\d+\./);
    // The package build runs npm through the Runner's Node; the declared tier names a tool that is not there.
    const packageTool = inventory.tools.find((entry) => entry.usedBy.includes("build: package build"));
    assert.ok(packageTool && /^np[mx]$/.test(packageTool.name), JSON.stringify(inventory.tools));
    assert.equal(packageTool.status, "found");
    assert.deepEqual(tool("aiboard-vf1-no-such-linter"), { name: "aiboard-vf1-no-such-linter", status: "missing", usedBy: ["tier fast: missing linter"] });
    // Recorded before the Architect's first model call, which sees it.
    const firstModelCall = model.requests[0];
    assert.ok(firstModelCall, "the Architect was called after the inventory");
    const context = String(firstModelCall.messages.find((message) => message.role === "user" && String(message.content).includes("Tool inventory"))?.content ?? "");
    assert.match(context, /- aiboard-vf1-no-such-linter: missing \[used by: tier fast: missing linter\]/);
    assert.equal(await projectStatus(), statusBefore, "no project file was written");
  } finally {
    await handle?.close();
    await factory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
