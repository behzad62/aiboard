import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  capabilitiesConfigCanonicalTargetIsInsideProject,
  loadRunnerCapabilitiesConfig,
  RunnerCapabilitiesConfigError,
} from "../../../src/runner-capabilities-config.js";
import {
  captureRunnerExtensionClosure,
  createRunnerCapabilityContract,
  createRunnerCapabilityContractSnapshot,
} from "../../../src/runner-capability-contract.js";
import { LocalPluginLoader } from "../../../src/plugin-loader.js";
import { cliRootCaptureArgs } from "../../support/cli-root-capture.js";
import {
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";

const CLI_STARTUP_FIXTURE_BUDGET_MS = process.platform === "win32" ? 90_000 : 30_000;
const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

type Tracked = { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function spawnCli(project: string, state: string, config: string, token: string): Tracked {
  const child = spawn(process.execPath, cliRootCaptureArgs([
    tsxPath, cliPath, "--project", project, "--state-dir", state, "--port", "0", "--token", token,
    "--capabilities-config", config,
  ], undefined, "tsx"), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return {
    child,
    closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
}

async function terminate(runner: Tracked): Promise<void> {
  if (runner.child.exitCode !== null) {
    await runner.closed.catch(() => undefined);
    return;
  }
  runner.child.kill();
  const timed = await Promise.race([
    runner.closed.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!timed) {
    try { runner.child.kill("SIGKILL"); } catch { /* ignore */ }
    await runner.closed.catch(() => undefined);
  }
}

async function awaitReadiness(runner: Tracked): Promise<{ url: string }> {
  const stdout = runner.child.stdout!;
  const stderr = runner.child.stderr!;
  const diagnostics: string[] = [];
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => diagnostics.push(chunk));
  const lines = createInterface({ input: stdout });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(String(line)) as { url: string }),
      runner.closed.then(({ code, signal }) => {
        throw new Error(`Runner exited before readiness (${String(code)}, ${String(signal)}): ${diagnostics.join("")}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Runner readiness timed out.")), CLI_STARTUP_FIXTURE_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    lines.close();
  }
}

async function runCliMalformedConfig(): Promise<void> {
  const root = createQualificationFixtureRoot("cli-malformed");
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  writeFileSync(config, JSON.stringify({
    version: 1, extensions: [], languageServers: [], plaintextEnvironment: { API_KEY: "not-allowed" },
  }));
  let runner: Tracked | undefined;
  try {
    runner = spawnCli(project, state, config, "qual-cli-malformed-token");
    let stdout = ""; let stderr = "";
    runner.child.stdout!.setEncoding("utf8");
    runner.child.stderr!.setEncoding("utf8");
    runner.child.stdout!.on("data", (c: string) => { stdout += c; });
    runner.child.stderr!.on("data", (c: string) => { stderr += c; });
    const { code } = await runner.closed;
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(existsSync(state), false);
    assert.match(stderr, /capabilities configuration contains unknown field plaintextEnvironment/i);
    assert.doesNotMatch(stderr, /git/i);
  } finally {
    if (runner) await terminate(runner);
    deferQualificationFixtureRemoval(root);
  }
}

async function runCliValidConfig(): Promise<void> {
  const root = createQualificationFixtureRoot("cli-valid");
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project); mkdirSync(state);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
    isolationProviders: [{
      id: "oci.configured",
      type: "oci",
      cliPath: join(root, process.platform === "win32" ? "configured-docker.exe" : "configured-docker"),
      image: "configured/image:only",
      allowNetwork: false,
    }],
  }));
  writeFileSync(join(root, process.platform === "win32" ? "configured-docker.exe" : "configured-docker"), "must not execute during CLI readiness");
  let runner: Tracked | undefined;
  try {
    runner = spawnCli(project, state, config, "qual-cli-valid-config");
    const readiness = await awaitReadiness(runner);
    assert.match(readiness.url, /^http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    if (runner) await terminate(runner);
    deferQualificationFixtureRemoval(root);
  }
}

async function runCliStaticExtensionClosure(): Promise<void> {
  const root = createQualificationFixtureRoot("cli-static-extension");
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "invalid extension");
  const config = join(root, "runner-capabilities.json");
  const evaluated = join(root, "extension-evaluated.txt");
  mkdirSync(project); mkdirSync(state); mkdirSync(extension);
  writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id: "fixture.cli.invalid",
    name: "fixture.cli.invalid",
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: ["tools"],
  }));
  writeFileSync(join(extension, "index.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(evaluated)}, "evaluated");
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
  `);
  writeFileSync(config, JSON.stringify({ version: 1, extensions: [extension], languageServers: [] }));
  let runner: Tracked | undefined;
  try {
    runner = spawnCli(project, state, config, "qual-cli-static-extension");
    const readiness = await awaitReadiness(runner);
    assert.match(readiness.url, /^http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(existsSync(evaluated), false, "static extension validation must not evaluate live tool declarations");
  } finally {
    if (runner) await terminate(runner);
    deferQualificationFixtureRemoval(root);
  }
}

async function runCliInProjectConfig(): Promise<void> {
  const root = createQualificationFixtureRoot("cli-in-project");
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project); mkdirSync(state);
  const config = join(project, "runner-capabilities.json");
  writeFileSync(config, JSON.stringify({ version: 1, extensions: [], languageServers: [] }));
  let runner: Tracked | undefined;
  try {
    runner = spawnCli(project, state, config, "qual-cli-in-project-cfg");
    let stderr = "";
    runner.child.stderr!.setEncoding("utf8");
    runner.child.stderr!.on("data", (c: string) => { stderr += c; });
    const { code } = await runner.closed;
    assert.equal(code, 1);
    assert.match(stderr, /capabilities configuration must be outside the project directory/i);
  } finally {
    if (runner) await terminate(runner);
    deferQualificationFixtureRemoval(root);
  }
}

async function runConfigTrustRejects(): Promise<void> {
  const root = createQualificationFixtureRoot("config-trust");
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project); mkdirSync(outside);
  const insideConfig = join(project, "runner-capabilities.json");
  const outsideConfig = join(outside, "runner-capabilities.json");
  writeFileSync(insideConfig, JSON.stringify({ version: 1, extensions: [], languageServers: [] }));
  writeFileSync(outsideConfig, JSON.stringify({ version: 1, extensions: [], languageServers: [] }));
  const aliasRoot = join(outside, "alias");
  try {
    symlinkSync(project, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    throw new Error("config-trust qualification requires directory alias creation on this host.", { cause: error });
  }
  try {
    const lexical = join(aliasRoot, "runner-capabilities.json");
    await assert.rejects(loadRunnerCapabilitiesConfig(lexical), (error: unknown) =>
      error instanceof RunnerCapabilitiesConfigError && error.code === "symbolic_config");
    await assert.rejects(capabilitiesConfigCanonicalTargetIsInsideProject(project, lexical), (error: unknown) =>
      error instanceof RunnerCapabilitiesConfigError && error.code === "symbolic_config");
    assert.equal(await capabilitiesConfigCanonicalTargetIsInsideProject(project, insideConfig), true);
    assert.equal(await capabilitiesConfigCanonicalTargetIsInsideProject(project, outsideConfig), false);

    await assert.rejects(loadRunnerCapabilitiesConfig(join(root, "missing.json")), () => true);
    const bad = join(outside, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, extensions: [], languageServers: [], unknownField: true }));
    await assert.rejects(loadRunnerCapabilitiesConfig(bad), (error: unknown) =>
      error instanceof RunnerCapabilitiesConfigError);
  } finally {
    deferQualificationFixtureRemoval(root);
  }
}

async function runCapabilityContractAlias(): Promise<void> {
  const root = createQualificationFixtureRoot("capability-contract-alias");
  const extension = join(root, "extension");
  const state = join(root, "state");
  const extensionAlias = join(root, "extension-alias");
  const stateAlias = join(root, "state-alias");
  const cliDirectory = join(root, "cli");
  const cliAlias = join(root, "cli-alias");
  const cli = join(cliDirectory, process.platform === "win32" ? "oci.exe" : "oci");
  mkdirSync(extension); mkdirSync(state); mkdirSync(cliDirectory);
  writeFileSync(cli, "fixture executable bytes");
  writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
    apiVersion: 1, id: "fixture.alias-root", name: "fixture.alias-root", version: "1.0.0",
    entry: "index.mjs", capabilities: ["tools"],
  }));
  writeFileSync(join(extension, "index.mjs"), "export default {};\n");
  try {
    symlinkSync(extension, extensionAlias, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(state, stateAlias, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(cliDirectory, cliAlias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    throw new Error("capability-contract-alias qualification requires directory alias creation on this host.", { cause: error });
  }
  try {
    await assert.rejects(captureRunnerExtensionClosure(extensionAlias), /symbolic link/i);
    await assert.rejects(
      createRunnerCapabilityContractSnapshot({ extensions: [extension], languageServers: [] }, stateAlias),
      /symbolic link/i,
    );
    await assert.rejects(createRunnerCapabilityContract({
      extensions: [],
      languageServers: [],
      isolationProviders: [{
        id: "oci.alias",
        type: "oci",
        cliPath: join(cliAlias, process.platform === "win32" ? "oci.exe" : "oci"),
        image: "fixture/image:latest",
        allowNetwork: false,
      }],
    }), /symbolic path/i);
  } finally {
    deferQualificationFixtureRemoval(root);
  }
}

async function runPluginImporterRejects(): Promise<void> {
  const root = createQualificationFixtureRoot("plugin-importer");
  const project = join(root, "project");
  const state = join(root, "state");
  const plugin = join(root, "plugin");
  const marker = join(root, "outside-evaluated.txt");
  mkdirSync(project); mkdirSync(state); mkdirSync(plugin);
  writeFileSync(join(root, "outside.mjs"), `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "outside evaluated\\n");
  `);
  writeFileSync(join(plugin, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id: "bad.plugin",
    name: "bad.plugin",
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: [],
  }));
  writeFileSync(join(plugin, "index.mjs"), `
    import "../outside.mjs";
    export function createExtension() {
      return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
    }
  `);
  try {
    await assert.rejects(new LocalPluginLoader({
      pluginDirectories: [plugin],
      projectDirectory: project,
      stateDirectory: state,
      reservedToolNames: [],
    }).load(), /escap|outside|resolv|path|entry|import/i);
    assert.equal(existsSync(marker), false, "escaped module must not be evaluated");
  } finally {
    deferQualificationFixtureRemoval(root);
  }
}

if (isQualificationScenarioEntry(import.meta.url)) {
  const name = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "";
  const runners: Record<string, () => Promise<void>> = {
    "cli-malformed-config": runCliMalformedConfig,
    "cli-valid-config": runCliValidConfig,
    "cli-static-extension-closure": runCliStaticExtensionClosure,
    "cli-in-project-config": runCliInProjectConfig,
    "config-trust-rejects": runConfigTrustRejects,
    "capability-contract-alias": runCapabilityContractAlias,
    "plugin-importer-rejects": runPluginImporterRejects,
  };
  await exitScenarioMain(async () => {
    const run = runners[name];
    if (!run) throw new Error(`Unknown cli scenario: ${name}`);
    await run();
  });
}
