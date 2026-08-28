import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RunSupervisor } from "../src/run-supervisor.js";
import {
  createRunnerCapabilityContract,
  createRunnerCapabilityContractSnapshot,
} from "../src/runner-capability-contract.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TrackedCliChild {
  child: ChildProcess;
  closed: Promise<ChildClose>;
}

test("CLI successful shutdown guard rejects a nonzero child close result", async () => {
  const runner = trackCliChild(spawn(
    process.execPath,
    ["-e", "process.exit(1)"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ));
  const close = await runner.closed;

  assert.deepEqual(close, { code: 1, signal: null });
  assert.throws(
    () => assertSuccessfulCliShutdown(close),
    /Runner exited after successful readiness with code 1/i,
  );
});

test("CLI rejects malformed capability configuration before Git preflight or readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
    plaintextEnvironment: { API_KEY: "not-allowed" },
  }));
  let runner: TrackedCliChild | undefined;
  try {
    runner = spawnCli(
      project,
      state,
      config,
      "cli-capabilities-test-token",
    );
    const { child } = runner;
    const streams = runnerStreams(child);
    let stdout = "";
    let stderr = "";
    streams.stdout.setEncoding("utf8");
    streams.stderr.setEncoding("utf8");
    streams.stdout.on("data", (chunk: string) => { stdout += chunk; });
    streams.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const { code } = await runner.closed;

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(existsSync(state), false);
    assert.match(stderr, /capabilities configuration contains unknown field plaintextEnvironment/i);
    assert.doesNotMatch(stderr, /git/i);
  } finally {
    if (runner) await terminateCliChild(runner);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI rejects an invalid extension package before listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-invalid-extension-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "invalid extension");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeExtension(extension, {
    id: "fixture.cli.invalid",
    module: `
      export function createExtension() {
        return {
          capabilities: () => ({
            tools: [{
              definition: { name: "fs.read", description: "Reserved", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
              validate: () => ({ ok: true, value: {} }),
              execute: async () => ({ content: [], isError: false }),
            }],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async () => undefined,
          close: async () => undefined,
        };
      }
    `,
  });
  writeCapabilitiesConfig(config, [extension]);
  try {
    const outcome = await runCliToExit(project, state, config, "cli-invalid-extension-token");
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /reserved tool fs\.read/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI closes a failed extension startup before listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-start-failure-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "start failure extension");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeExtension(extension, {
    id: "fixture.cli.start-failure",
    module: `
      import { appendFile } from "node:fs/promises";
      import { join } from "node:path";
      let stateDirectory;
      export function createExtension() {
        return {
          capabilities: () => ({
            tools: [{
              definition: { name: "fixture.cli.inspect", description: "Fixture", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
              validate: () => ({ ok: true, value: {} }),
              execute: async () => ({ content: [], isError: false }),
            }],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async (context) => {
            stateDirectory = context.stateDirectory;
            await appendFile(join(stateDirectory, "lifecycle.log"), "started\\n");
            throw new Error("fixture start failed");
          },
          close: async () => {
            if (stateDirectory) await appendFile(join(stateDirectory, "lifecycle.log"), "closed\\n");
          },
        };
      }
    `,
  });
  writeCapabilitiesConfig(config, [extension]);
  try {
    const outcome = await runCliToExit(project, state, config, "cli-start-failure-token");
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /fixture start failed/i);
    assert.equal(
      readFileSync(join(
        state,
        "capability-preflight",
        "extensions",
        "fixture.cli.start-failure",
        "lifecycle.log",
      ), "utf8"),
      "started\nclosed\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI accepts a valid external capability configuration before listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-valid-Ω-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
  }));
  let runner: TrackedCliChild | undefined;
  let readinessSucceeded = false;
  try {
    runner = spawnCli(project, state, config, "cli-capabilities-valid-token");
    const { child } = runner;
    const diagnostics: string[] = [];
    const streams = runnerStreams(child);
    streams.stderr.setEncoding("utf8");
    streams.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
    const lines = createInterface({ input: streams.stdout });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const readiness = await Promise.race([
        once(lines, "line").then(([line]) => JSON.parse(String(line)) as {
          protocolVersion: number;
          projectPath: string;
          stateDirectory: string;
        }),
        runner.closed.then(({ code }) => {
          throw new Error(`Runner exited before readiness (${String(code)}): ${diagnostics.join("")}`);
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Runner readiness timed out.")), 10_000);
        }),
      ]);
      assert.equal(readiness.protocolVersion, 2);
      assert.equal(readiness.projectPath, project);
      assert.equal(readiness.stateDirectory, state);
      readinessSucceeded = true;
    } finally {
      if (timeout) clearTimeout(timeout);
      lines.close();
    }
  } finally {
    try {
      if (runner) {
        const close = await terminateCliChild(runner);
        if (readinessSucceeded) assertSuccessfulCliShutdown(close);
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("CLI rejects an active legacy Build without a capability contract before listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capability-recovery-missing-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  const runId = "legacy_missing_capability_contract";
  const token = "cli-capability-recovery-token";
  mkdirSync(project);
  mkdirSync(state);
  writeCapabilitiesConfig(config, []);
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
  const specs = new SqliteBuildSpecStore(join(state, "build-specs.sqlite"));
  supervisor.createRun({
    runId,
    projectPath: project,
    permissionProfile: "project",
    idempotencyKey: `create:${runId}`,
  });
  specs.save({
    version: 2,
    runId,
    projectId: "project_1",
    objective: "Do not recover this unbound legacy Build.",
    architectRuntimeId: "fixture:architect",
    workerRuntimeIds: ["fixture:worker"],
    verifierRuntimeIds: ["fixture:worker"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "project",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    idempotencyKey: `build:${runId}`,
  });
  specs.close();
  supervisor.close();

  try {
    const outcome = await runCliToExit(project, state, config, token);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /active Build recovery requires a persisted Runner capability contract/i);
    const recovered = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
    try {
      const run = recovered.getRun(runId);
      assert.equal(run.state, "failed");
      assert.equal(run.stopReason, "capability-contract:capability_contract_missing");
    } finally {
      recovered.close();
    }
    assert.equal(existsSync(join(state, "builds", runId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI keeps a terminal legacy Build readable without recovering it against current capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capability-recovery-terminal-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  const runId = "terminal_legacy_capability_contract";
  const token = "cli-capability-terminal-token";
  mkdirSync(project);
  mkdirSync(state);
  writeCapabilitiesConfig(config, []);
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
  const specs = new SqliteBuildSpecStore(join(state, "build-specs.sqlite"));
  supervisor.createRun({
    runId,
    projectPath: project,
    permissionProfile: "project",
    idempotencyKey: `create:${runId}`,
  });
  supervisor.fail(runId, `fail:${runId}`, "previous terminal outcome");
  specs.save({
    version: 2,
    runId,
    projectId: "project_1",
    objective: "A terminal legacy Build remains inspectable.",
    architectRuntimeId: "fixture:architect",
    workerRuntimeIds: ["fixture:worker"],
    verifierRuntimeIds: ["fixture:worker"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "project",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    idempotencyKey: `build:${runId}`,
  });
  specs.close();
  supervisor.close();

  let runner: TrackedCliChild | undefined;
  try {
    runner = spawnCli(project, state, config, token);
    const readiness = await awaitCliReadiness(runner);
    const response = await fetch(`${readiness.url}/v2/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json() as { state?: unknown; stopReason?: unknown };

    assert.equal(response.status, 200);
    assert.equal(body.state, "failed");
    assert.equal(body.stopReason, "previous terminal outcome");
    assert.equal(existsSync(join(state, "builds", runId)), false);
  } finally {
    try {
      if (runner) assertSuccessfulCliShutdown(await terminateCliChild(runner));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("CLI rejects a changed active extension before evaluating or starting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capability-recovery-mutated-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "extension");
  const config = join(root, "runner-capabilities.json");
  const runId = "mutated_capability_contract";
  const token = "cli-capability-mutated-token";
  const sideEffectLog = join(root, "extension-side-effects.log");
  mkdirSync(project);
  mkdirSync(state);
  writeExtension(extension, {
    id: "fixture.cli.contract",
    module: `
      export function createExtension() {
        return {
          capabilities: () => ({
            tools: [{
              definition: { name: "fixture.cli.contract.inspect", description: "Inspect", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
              validate: () => ({ ok: true, value: {} }),
              execute: async () => ({ content: [], isError: false }),
            }],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async () => undefined,
          close: async () => undefined,
        };
      }
    `,
  });
  writeCapabilitiesConfig(config, [extension]);
  const capabilityContract = await createRunnerCapabilityContract({
    extensions: [extension],
    languageServers: [],
  });
  writeFileSync(join(extension, "index.mjs"), `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(sideEffectLog)}, "evaluated\\n");
    export function createExtension() {
      return {
        capabilities: () => ({
          tools: [{
            definition: { name: "fixture.cli.contract.inspect", description: "Inspect", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
            validate: () => ({ ok: true, value: {} }),
            execute: async () => ({ content: [], isError: false }),
          }],
          contextContributors: [],
          languageProviders: [],
        }),
        start: async () => {
          appendFileSync(${JSON.stringify(sideEffectLog)}, "started\\n");
          throw new Error("changed extension start should not run");
        },
        close: async () => appendFileSync(${JSON.stringify(sideEffectLog)}, "closed\\n"),
      };
    }
  `);
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
  const specs = new SqliteBuildSpecStore(join(state, "build-specs.sqlite"));
  supervisor.createRun({
    runId,
    projectPath: project,
    permissionProfile: "project",
    idempotencyKey: `create:${runId}`,
  });
  specs.save({
    version: 2,
    runId,
    projectId: "project_1",
    objective: "Do not recover this mutated Build.",
    architectRuntimeId: "fixture:architect",
    workerRuntimeIds: ["fixture:worker"],
    verifierRuntimeIds: ["fixture:worker"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "project",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    idempotencyKey: `build:${runId}`,
    capabilityContract,
  });
  specs.close();
  supervisor.close();

  try {
    const outcome = await runCliToExit(project, state, config, token);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /capability.*configuration differs/i);
    assert.doesNotMatch(outcome.stderr, /changed extension start should not run/i);
    assert.equal(existsSync(sideEffectLog), false);
    const recovered = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
    try {
      const run = recovered.getRun(runId);
      assert.equal(run.state, "failed");
      assert.equal(run.stopReason, "capability-contract:capability_contract_mismatch");
    } finally {
      recovered.close();
    }
    assert.equal(existsSync(join(state, "builds", runId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI rejects a syntactically invalid changed active extension before preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capability-recovery-syntax-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "extension");
  const config = join(root, "runner-capabilities.json");
  const runId = "syntax_mutated_capability_contract";
  const token = "cli-capability-syntax-token";
  mkdirSync(project);
  mkdirSync(state);
  writeExtension(extension, {
    id: "fixture.cli.syntax",
    module: `
      export function createExtension() {
        return {
          capabilities: () => ({
            tools: [{
              definition: { name: "fixture.cli.syntax.inspect", description: "Inspect", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
              validate: () => ({ ok: true, value: {} }),
              execute: async () => ({ content: [], isError: false }),
            }],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async () => undefined,
          close: async () => undefined,
        };
      }
    `,
  });
  writeCapabilitiesConfig(config, [extension]);
  const capabilityContract = await createRunnerCapabilityContract({
    extensions: [extension],
    languageServers: [],
  });
  writeFileSync(join(extension, "index.mjs"), "export function createExtension( {\n");
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
  const specs = new SqliteBuildSpecStore(join(state, "build-specs.sqlite"));
  supervisor.createRun({
    runId,
    projectPath: project,
    permissionProfile: "project",
    idempotencyKey: `create:${runId}`,
  });
  specs.save({
    version: 2,
    runId,
    projectId: "project_1",
    objective: "Do not parse a mismatched extension during recovery.",
    architectRuntimeId: "fixture:architect",
    workerRuntimeIds: ["fixture:worker"],
    verifierRuntimeIds: ["fixture:worker"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "project",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    idempotencyKey: `build:${runId}`,
    capabilityContract,
  });
  specs.close();
  supervisor.close();

  try {
    const outcome = await runCliToExit(project, state, config, token);
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /capability.*configuration differs/i);
    assert.doesNotMatch(outcome.stderr, /syntaxerror|unexpected token/i);
    const recovered = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
    try {
      const run = recovered.getRun(runId);
      assert.equal(run.state, "failed");
      assert.equal(run.stopReason, "capability-contract:capability_contract_mismatch");
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI fails an active Build when its matching snapshot extension cannot start before MCP or live runtime startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capability-recovery-snapshot-start-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "extension");
  const config = join(root, "runner-capabilities.json");
  const runId = "snapshot_start_capability_contract";
  const token = "cli-capability-snapshot-start-token";
  const lifecycleLog = join(root, "snapshot-extension-lifecycle.log");
  const mcpMarker = join(root, "mcp-started.log");
  const mcpFixture = join(root, "mcp-fixture.mjs");
  mkdirSync(project);
  mkdirSync(state);
  writeExtension(extension, {
    id: "fixture.cli.snapshot-start",
    module: `
      import { appendFileSync } from "node:fs";
      export function createExtension() {
        return {
          capabilities: () => ({
            tools: [{
              definition: { name: "fixture.cli.snapshot-start.inspect", description: "Inspect", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
              validate: () => ({ ok: true, value: {} }),
              execute: async () => ({ content: [], isError: false }),
            }],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async () => {
            appendFileSync(${JSON.stringify(lifecycleLog)}, "started\\n");
            throw new Error("fixture snapshot start failed");
          },
          close: async () => appendFileSync(${JSON.stringify(lifecycleLog)}, "closed\\n"),
        };
      }
    `,
  });
  writeCapabilitiesConfig(config, [extension]);
  const capabilityContract = await createRunnerCapabilityContractSnapshot({
    extensions: [extension],
    languageServers: [],
  }, state);
  saveActiveBuild(state, project, runId, capabilityContract);
  writeFileSync(mcpFixture, `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    appendFileSync(${JSON.stringify(mcpMarker)}, "started\\n");
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === "tools/list" ? { tools: [] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    });
  `);

  try {
    const outcome = await runCliToExit(
      project,
      state,
      config,
      token,
      [`--mcp`, `fixture=${quoteShellArgument(process.execPath)} ${quoteShellArgument(mcpFixture)}`],
    );

    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /fixture snapshot start failed/i);
    assert.equal(existsSync(mcpMarker), false);
    assert.equal(existsSync(join(state, "builds", runId)), false);
    assert.equal(readFileSync(lifecycleLog, "utf8"), "started\nclosed\n");
    const recovered = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
    try {
      const run = recovered.getRun(runId);
      assert.equal(run.state, "failed");
      assert.equal(run.stopReason, "capability-contract:capability_preflight_failed");
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI rejects a capability configuration placed inside the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-contained-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(project, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
  }));
  let runner: TrackedCliChild | undefined;
  try {
    runner = spawnCli(project, state, config, "cli-capabilities-contained-token");
    const { child } = runner;
    let stdout = "";
    let stderr = "";
    const streams = runnerStreams(child);
    streams.stdout.setEncoding("utf8");
    streams.stderr.setEncoding("utf8");
    streams.stdout.on("data", (chunk: string) => { stdout += chunk; });
    streams.stderr.on("data", (chunk: string) => { stderr += chunk; });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      runner.closed.then(({ code }) => ({ type: "exit" as const, code })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ type: "timeout" }), 3_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.type === "timeout") {
      assert.fail("Runner should reject an in-project capabilities configuration before listening.");
    }

    assert.equal(outcome.code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /capabilities configuration must be outside the project directory/i);
  } finally {
    if (runner) await terminateCliChild(runner);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function spawnCli(
  project: string,
  state: string,
  config: string,
  token: string,
  extraArgs: readonly string[] = [],
): TrackedCliChild {
  return trackCliChild(spawn(
    process.execPath,
    [
      tsxPath,
      cliPath,
      "--project",
      project,
      "--state-dir",
      state,
      "--port",
      "0",
      "--token",
      token,
      "--capabilities-config",
      config,
      ...extraArgs,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  ));
}

async function awaitCliReadiness(
  runner: TrackedCliChild,
): Promise<{ url: string }> {
  const streams = runnerStreams(runner.child);
  const diagnostics: string[] = [];
  streams.stderr.setEncoding("utf8");
  streams.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
  const lines = createInterface({ input: streams.stdout });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(String(line)) as { url: string }),
      runner.closed.then(({ code, signal }) => {
        throw new Error(
          `Runner exited before readiness (${String(code)}, ${String(signal)}): ${diagnostics.join("")}`,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Runner readiness timed out.")), 10_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    lines.close();
  }
}

function trackCliChild(child: ChildProcess): TrackedCliChild {
  return {
    child,
    closed: new Promise<ChildClose>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function terminateCliChild(runner: TrackedCliChild): Promise<ChildClose> {
  const { child } = runner;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  return await runner.closed;
}

function assertSuccessfulCliShutdown(close: ChildClose): void {
  const gracefulExit = close.code === 0 && close.signal === null;
  const expectedSigtermExit = close.code === null && close.signal === "SIGTERM";
  if (!gracefulExit && !expectedSigtermExit) {
    throw new Error(
      `Runner exited after successful readiness with code ${String(close.code)} and signal ${String(close.signal)}.`,
    );
  }
}

function runnerStreams(child: ChildProcess) {
  const { stdout, stderr } = child;
  if (!stdout || !stderr) {
    throw new Error("Runner CLI test requires stdout and stderr pipes.");
  }
  return { stdout, stderr };
}

function writeCapabilitiesConfig(config: string, extensions: readonly string[]): void {
  writeFileSync(config, JSON.stringify({ version: 1, extensions, languageServers: [] }));
}

function writeExtension(
  directory: string,
  input: { id: string; module: string },
): void {
  mkdirSync(directory);
  writeFileSync(join(directory, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id: input.id,
    name: input.id,
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: ["tools"],
  }));
  writeFileSync(join(directory, "index.mjs"), input.module);
}

async function runCliToExit(
  project: string,
  state: string,
  config: string,
  token: string,
  extraArgs: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const runner = spawnCli(project, state, config, token, extraArgs);
  const { child } = runner;
  const streams = runnerStreams(child);
  let stdout = "";
  let stderr = "";
  streams.stdout.setEncoding("utf8");
  streams.stderr.setEncoding("utf8");
  streams.stdout.on("data", (chunk: string) => { stdout += chunk; });
  streams.stderr.on("data", (chunk: string) => { stderr += chunk; });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      runner.closed.then(({ code }) => ({ exited: true as const, code })),
      new Promise<{ exited: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ exited: false }), 4_000);
      }),
    ]);
    if (!outcome.exited) {
      await terminateCliChild(runner);
      assert.fail(`Runner reached a live state instead of rejecting startup: ${stdout}`);
    }
    return { code: outcome.code, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
    await terminateCliChild(runner);
  }
}

function saveActiveBuild(
  state: string,
  project: string,
  runId: string,
  capabilityContract: Awaited<ReturnType<typeof createRunnerCapabilityContractSnapshot>>,
): void {
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")));
  const specs = new SqliteBuildSpecStore(join(state, "build-specs.sqlite"));
  try {
    supervisor.createRun({
      runId,
      projectPath: project,
      permissionProfile: "project",
      idempotencyKey: `create:${runId}`,
    });
    specs.save({
      version: 2,
      runId,
      projectId: "project_1",
      objective: "Preflight this active Build before runtime startup.",
      architectRuntimeId: "fixture:architect",
      workerRuntimeIds: ["fixture:worker"],
      verifierRuntimeIds: ["fixture:worker"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "project",
      runPolicy: "finish",
      budgetLimits: {},
      createdAt: "2026-08-28T00:00:00.000Z",
      idempotencyKey: `build:${runId}`,
      capabilityContract,
    });
  } finally {
    specs.close();
    supervisor.close();
  }
}

function quoteShellArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
