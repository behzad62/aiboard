import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  NativeBuildFactory,
  preflightRecoveredRunnerCapabilities,
} from "../src/native-build-factory.js";
import type { NativeWorkerDriverOptions } from "../src/native-worker-driver.js";
import type { RunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import {
  createRunnerCapabilityContractSnapshot,
  runnerCapabilitySnapshotExtensionDirectories,
  type RunnerCapabilityContract,
} from "../src/runner-capability-contract.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { runWorkerTask } from "../src/worker-runtime.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";

test("NativeBuildFactory loads configured capabilities and reports provider audit metadata", async () => {
  const fixture = createFixture("metadata");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_metadata",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [configuredServer("fixture.configured")],
    });

    handle = await factory.create(await factory.prepareSpec(buildSpec("capability_metadata")));
    assert.equal(
      existsSync(join(runRoot(fixture.state, "capability_metadata"), "extensions", "fixture.factory", "started.txt")),
      true,
    );
    const snapshot = await handle.observability();
    assert.deepEqual(
      snapshot.capabilities?.extensions.map((extension) => extension.id),
      ["fixture.factory"],
    );
    assert.deepEqual(
      snapshot.capabilities?.languageProviders.map((provider) => [provider.providerId, provider.source]),
      [
        ["builtin.typescript", "builtin"],
        ["fixture.configured", "configured"],
      ],
    );
    assert.deepEqual(snapshot.capabilities?.languageRoutes, []);

    await handle.close();
    handle = undefined;
    assert.equal(
      readFileSync(join(runRoot(fixture.state, "capability_metadata"), "extensions", "fixture.factory", "lifecycle.log"), "utf8"),
      "closed\n",
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("active recovery preflights matching snapshot extensions atomically and retains startup plus cleanup failures", async () => {
  const fixture = createFixture("recovery-preflight-start-cleanup");
  const lifecycle = join(fixture.state, "snapshot-preflight-lifecycle.log");
  const runId = "recovery_preflight_start_cleanup";
  try {
    writeFileSync(join(fixture.extension, "runner-extension.json"), JSON.stringify({
      apiVersion: 1,
      id: "fixture.factory",
      name: "Factory Fixture",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: [],
    }));
    writeFileSync(join(fixture.extension, "index.mjs"), [
      'import { appendFileSync } from "node:fs";',
      "export function createExtension() {",
      "  return {",
      "    capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),",
      `    start: async () => { appendFileSync(${JSON.stringify(lifecycle)}, "started\\n"); throw new Error("snapshot preflight start failed"); },`,
      `    close: async () => { appendFileSync(${JSON.stringify(lifecycle)}, "closed\\n"); throw new Error("snapshot preflight close failed"); },`,
      "  };",
      "}",
      "",
    ].join("\n"));
    const config = { extensions: [fixture.extension], languageServers: [] };
    const capabilityContract = await createRunnerCapabilityContractSnapshot(config, fixture.state);

    await assert.rejects(
      preflightRecoveredRunnerCapabilities({
        spec: { runId, capabilityContract },
        config,
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        reservedToolNames: [],
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "capability_preflight_failed");
        const cause = (error as Error & { cause?: unknown }).cause;
        assert.equal(cause instanceof AggregateError, true);
        const messages = (cause as AggregateError).errors.map((item) => String(item));
        assert.equal(messages.some((message) => /snapshot preflight start failed/i.test(message)), true);
        assert.equal(messages.some((message) => /snapshot preflight close failed/i.test(message)), true);
        return true;
      },
    );
    assert.equal(readFileSync(lifecycle, "utf8"), "started\nclosed\n");
    assert.equal(existsSync(runRoot(fixture.state, runId)), false);
  } finally {
    fixture.cleanup();
  }
});

test("active recovery rejects matching snapshot syntax and factory failures before a live runtime root exists", async () => {
  for (const scenario of [
    {
      name: "syntax",
      source: "export function createExtension( {\n",
      expected: /unexpected token|unexpected end|syntaxerror/i,
    },
    {
      name: "factory",
      source: 'export function createExtension() { throw new Error("snapshot factory failed"); }\n',
      expected: /snapshot factory failed/i,
    },
  ]) {
    const fixture = createFixture(`recovery-preflight-${scenario.name}`);
    const runId = `recovery_preflight_${scenario.name}`;
    try {
      writeFileSync(join(fixture.extension, "index.mjs"), scenario.source);
      const config = { extensions: [fixture.extension], languageServers: [] };
      const capabilityContract = await createRunnerCapabilityContractSnapshot(config, fixture.state);

      await assert.rejects(
        preflightRecoveredRunnerCapabilities({
          spec: { runId, capabilityContract },
          config,
          projectDirectory: fixture.project,
          stateDirectory: fixture.state,
          reservedToolNames: [],
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "capability_preflight_failed");
          assert.match(String(error), scenario.expected);
          return true;
        },
      );
      assert.equal(existsSync(runRoot(fixture.state, runId)), false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("active recovery validates a missing snapshot before evaluating an extension", async () => {
  const fixture = createFixture("recovery-preflight-missing-snapshot");
  const runId = "recovery_preflight_missing_snapshot";
  try {
    const config = { extensions: [fixture.extension], languageServers: [] };
    const capabilityContract = await createRunnerCapabilityContractSnapshot(config, fixture.state);
    rmSync(join(fixture.state, "capability-snapshots"), { recursive: true, force: true });

    await assert.rejects(
      preflightRecoveredRunnerCapabilities({
        spec: { runId, capabilityContract },
        config,
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        reservedToolNames: [],
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
    assert.equal(existsSync(runRoot(fixture.state, runId)), false);
  } finally {
    fixture.cleanup();
  }
});

test("active recovery validates a corrupt snapshot before evaluating an extension", async () => {
  const fixture = createFixture("recovery-preflight-corrupt-snapshot");
  const runId = "recovery_preflight_corrupt_snapshot";
  try {
    const config = { extensions: [fixture.extension], languageServers: [] };
    const capabilityContract = await createRunnerCapabilityContractSnapshot(config, fixture.state);
    const [snapshotExtension] = runnerCapabilitySnapshotExtensionDirectories(
      capabilityContract,
      fixture.state,
    );
    if (!snapshotExtension) assert.fail("Expected a captured extension snapshot.");
    writeFileSync(join(snapshotExtension, "index.mjs"), "export const corrupt = true;\n");

    await assert.rejects(
      preflightRecoveredRunnerCapabilities({
        spec: { runId, capabilityContract },
        config,
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        reservedToolNames: [],
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
    assert.equal(existsSync(runRoot(fixture.state, runId)), false);
  } finally {
    fixture.cleanup();
  }
});

test("active recovery starts configured language servers before a live runtime is constructed", async () => {
  const fixture = createFixture("recovery-preflight-lsp");
  const runId = "recovery_preflight_lsp";
  const server = join(fixture.state, "lsp-preflight-failure.mjs");
  try {
    writeFileSync(server, "process.exit(23);\n");
    const config: RunnerCapabilitiesConfig = {
      extensions: [],
      languageServers: [{
        descriptor: {
          id: "fixture.preflight.lsp",
          displayName: "Failing preflight LSP",
          extensions: [".fixture"],
          rootMarkers: [],
          priority: 10,
        },
        languageId: "fixture",
        command: process.execPath,
        args: [server],
        requestTimeoutMs: 1_000,
        restartLimit: 0,
      }],
    };
    const capabilityContract = await createRunnerCapabilityContractSnapshot(config, fixture.state);

    await assert.rejects(
      preflightRecoveredRunnerCapabilities({
        spec: { runId, capabilityContract },
        config,
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        reservedToolNames: [],
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "capability_preflight_failed");
        assert.match(String(error), /language server|process exited|preflight/i);
        return true;
      },
    );
    assert.equal(existsSync(runRoot(fixture.state, runId)), false);
  } finally {
    fixture.cleanup();
  }
});

test("NativeBuildFactory persists and validates a capability contract before recovery", async () => {
  const fixture = createFixture("recovery-contract");
  let factory: NativeBuildFactory | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_recovery_contract",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [configuredServer("fixture.contract")],
    });
    const prepared = await factory.prepareSpec(buildSpec("capability_recovery_contract"));
    assert.match(prepared.capabilityContract?.digest ?? "", /^[a-f0-9]{64}$/);

    await factory.validateRecoveryCapabilityContract(prepared);
    const structurallyTampered = structuredClone(prepared);
    structurallyTampered.capabilityContract!.extensions[0]!.version = "0.0.0";
    await assert.rejects(
      factory.validateRecoveryCapabilityContract(structurallyTampered),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_invalid",
    );
    await assert.rejects(
      factory.validateRecoveryCapabilityContract({
        ...prepared,
        capabilityContract: undefined,
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_missing",
    );

    writeFileSync(
      join(fixture.extension, "index.mjs"),
      `${extensionModuleSource(undefined, "fixture.factory.inspect")}\n// changed entry identity\n`,
    );
    await assert.rejects(
      factory.validateRecoveryCapabilityContract(prepared),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
  } finally {
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory rejects an active contract when a local extension helper changes", async () => {
  const fixture = createFixture("helper-dependency-contract");
  let factory: NativeBuildFactory | undefined;
  try {
    writeHelperExtension(fixture.extension, "trusted");
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_helper_dependency_contract",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });
    const prepared = await factory.prepareSpec(
      buildSpec("capability_helper_dependency_contract"),
    );

    writeFileSync(join(fixture.extension, "helper.mjs"), 'export const marker = "changed";\n');

    await assert.rejects(
      factory.validateRecoveryCapabilityContract(prepared),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_mismatch",
    );
  } finally {
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory fails closed when an active legacy capability contract lacks an immutable closure", async () => {
  const fixture = createFixture("legacy-capability-contract");
  let factory: NativeBuildFactory | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_legacy_contract",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });
    const prepared = await factory.prepareSpec(buildSpec("capability_legacy_contract"));
    const legacy = legacyContract(prepared.capabilityContract!);

    await assert.rejects(
      factory.validateRecoveryCapabilityContract({
        ...prepared,
        capabilityContract: legacy,
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "capability_contract_missing",
    );
  } finally {
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory loads an extension snapshot after source replacement following validation", async () => {
  const fixture = createFixture("extension-snapshot-replacement");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    writeHelperExtension(fixture.extension, "trusted");
    const runId = "capability_extension_snapshot_replacement";
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });
    const prepared = await factory.prepareSpec(buildSpec(runId));
    const validate = factory.validateRecoveryCapabilityContract.bind(factory);
    factory.validateRecoveryCapabilityContract = async (spec) => {
      await validate(spec);
      writeFileSync(join(fixture.extension, "helper.mjs"), 'export const marker = "replaced";\n');
    };

    handle = await factory.create(prepared);

    assert.equal(
      readFileSync(
        join(runRoot(fixture.state, runId), "extensions", "fixture.factory", "snapshot-marker.txt"),
        "utf8",
      ),
      "trusted\n",
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory snapshot preserves attribution for a live extension tool call", async () => {
  const fixture = createFixture("extension-tool-observation");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const runId = "capability_extension_tool_observation";
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });
    handle = await factory.create(await factory.prepareSpec(buildSpec(runId)));

    const options = factoryWorkerOptions(handle);
    const workspace = await options.workspaceManager.createTaskWorkspace("extension_audit");
    const result = await runWorkerTask({
      model: new ScriptedModel([
        toolTurn("extension_observation", "fixture.factory.inspect", {}),
        new Error("stop after extension observation"),
      ]),
      runId,
      sessionId: "worker:extension_audit:1",
      taskId: "extension_audit",
      actorId: "worker_extension_audit",
      attempt: 1,
      permissionProfile: "full",
      workspace,
      workspaceManager: options.workspaceManager,
      artifacts: options.artifacts,
      ledger: options.ledger,
      sessions: options.sessions,
      initialMessages: [{ id: "task", role: "user", content: "Inspect the extension." }],
      capabilityRegistry: options.capabilityRegistry,
      language: options.language,
    });
    assert.equal(result.loop.status, "suspended");

    const snapshot = await handle.observability();
    assert.deepEqual(
      snapshot.tools
        .filter((tool) => tool.callId === "extension_observation")
        .map((tool) => ({
          status: tool.status,
          extensionId: tool.extensionId,
        })),
      [{ status: "completed", extensionId: "fixture.factory" }],
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory closes extension language providers before their extension instance", async () => {
  const fixture = createFixture("extension-language-close", "fixture.extension.language");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_extension_language_close",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });

    handle = await factory.create(
      await factory.prepareSpec(buildSpec("capability_extension_language_close")),
    );
    await handle.close();
    await handle.close();
    handle = undefined;

    assert.equal(
      readFileSync(join(
        runRoot(fixture.state, "capability_extension_language_close"),
        "extensions",
        "fixture.factory",
        "lifecycle.log",
      ), "utf8"),
      "language-provider-closed\nclosed\n",
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory closes extension providers before instances when language provider startup validation fails", async () => {
  const fixture = createFixture("atomic", "fixture.duplicate");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_atomic",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [configuredServer("fixture.duplicate")],
    });

    const outcome = await factory.create(
      await factory.prepareSpec(buildSpec("capability_atomic")),
    ).then(
      (created) => ({ created }),
      (error: unknown) => ({ error }),
    );
    if ("created" in outcome) {
      handle = outcome.created;
      assert.fail("Factory should reject duplicate language providers.");
    }
    assert.match(String(outcome.error), /Duplicate language provider fixture\.duplicate/);
    assert.equal(
      readFileSync(join(runRoot(fixture.state, "capability_atomic"), "extensions", "fixture.factory", "lifecycle.log"), "utf8"),
      "language-provider-closed\nclosed\n",
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory reserves built-in tool names before any extension starts", async () => {
  const fixture = createFixture("reserved", undefined, "fs.read");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId: "capability_reserved",
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [],
    });

    const outcome = await factory.create(
      await factory.prepareSpec(buildSpec("capability_reserved")),
    ).then(
      (created) => ({ created }),
      (error: unknown) => ({ error }),
    );
    if ("created" in outcome) {
      handle = outcome.created;
      assert.fail("Factory should reject a built-in extension tool name.");
    }
    assert.match(String(outcome.error), /reserved tool fs\.read/i);
    assert.equal(
      existsSync(join(runRoot(fixture.state, "capability_reserved"), "extensions", "fixture.factory", "started.txt")),
      false,
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory leaves provider configuration cleanup to the CLI when requested", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-capabilities-provider-owner-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  let providerConfigsClosed = 0;
  const options = {
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: {
      load: () => [],
      save: () => undefined,
      close: () => { providerConfigsClosed += 1; },
    },
    baselineFor: () => "unused",
    closeProviderConfigs: false,
  } as unknown as ConstructorParameters<typeof NativeBuildFactory>[0];
  const factory = new NativeBuildFactory(options);
  try {
    await factory.close();
    assert.equal(providerConfigsClosed, 0);
  } finally {
    if (providerConfigsClosed === 0) options.providerConfigs.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("NativeBuildFactory serves a terminal legacy Build from read-only durable stores", async () => {
  const fixture = createFixture("historical-terminal");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    const runId = "capability_historical_terminal";
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    const root = runRoot(fixture.state, runId);
    mkdirSync(root, { recursive: true });
    const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
    const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
    const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
    const budget = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
      limitsFor: () => ({}),
    });
    const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
      evidenceStore: evidence,
      artifacts,
    });
    scheduler.close();
    budget.close();
    sessions.close();
    ledger.close();
    evidence.close();
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [fixture.extension],
      languageServers: [configuredServer("fixture.historical")],
    });

    const prepared = await factory.prepareSpec(buildSpec(runId));
    handle = await factory.createHistorical(prepared);

    assert.equal(handle.runtime.projection().status, "completed");
    assert.equal(handle.usage().scopeId, runId);
    const snapshot = await handle.observability();
    assert.equal(snapshot.runId, runId);
    assert.deepEqual(snapshot.capabilities?.historicalContract, {
      version: prepared.capabilityContract!.version,
      extensionClosureVersion: prepared.capabilityContract!.extensionClosureVersion,
      digest: prepared.capabilityContract!.digest,
      builtin: prepared.capabilityContract!.builtin,
      extensions: prepared.capabilityContract!.extensions,
      languageServers: prepared.capabilityContract!.languageServers,
    });
    assert.deepEqual(await handle.transcript(), { turns: [], cursor: 0 });
    assert.deepEqual(await handle.files(), {
      source: "integration",
      revision: "",
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
    });
    assert.deepEqual(handle.runtime.events(), []);
    await assert.rejects(handle.runtime.step(), /read-only/i);
    assert.equal(
      existsSync(join(root, "extensions", "fixture.factory", "started.txt")),
      false,
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory keeps missing terminal stores absent and projects empty read-only history", async () => {
  const fixture = createFixture("historical-missing-stores");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    const runId = "capability_historical_missing_stores";
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    factory = createFactory(fixture.project, fixture.state, baseline.revision, {
      extensions: [],
      languageServers: [],
    });
    const prepared = await factory.prepareSpec(buildSpec(runId));
    const root = runRoot(fixture.state, runId);
    assert.equal(existsSync(root), false);

    handle = await factory.createHistorical(prepared);

    assert.equal(handle.runtime.projection().status, "completed");
    assert.equal(handle.usage().scopeId, runId);
    assert.deepEqual((await handle.observability()).events, []);
    assert.deepEqual(await handle.transcript(), { turns: [], cursor: 0 });
    assert.deepEqual(await handle.files(), {
      source: "integration",
      revision: "",
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
    });
    assert.equal(existsSync(root), false);
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

function createFactory(
  projectRoot: string,
  stateDirectory: string,
  baselineRevision: string,
  capabilitiesConfig: RunnerCapabilitiesConfig,
): NativeBuildFactory {
  return new NativeBuildFactory({
    projectRoot,
    stateDirectory,
    providerConfigs: {
      load: () => [providerConfig()],
      save: () => undefined,
      close: () => undefined,
    },
    capabilitiesConfig,
    baselineFor: () => baselineRevision,
  });
}

function providerConfig(): RunnerProviderConfig {
  return {
    runtimeId: "fixture:model",
    providerId: "fixture",
    modelId: "model",
    transport: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    secret: "unused",
    capabilities: ["code"],
    priority: 1,
  };
}

function configuredServer(id: string): RunnerCapabilitiesConfig["languageServers"][number] {
  return {
    descriptor: {
      id,
      displayName: "Configured fixture language server",
      extensions: [".fixture"],
      rootMarkers: ["fixture.config.json"],
      priority: 100,
    },
    languageId: "fixture",
    command: process.execPath,
    args: [join(process.cwd(), "runner-v2", "test", "fixtures", "lsp-server.mjs")],
  };
}

function buildSpec(runId: string) {
  return {
    version: 2 as const,
    runId,
    projectId: "fixture-project",
    objective: "Exercise configured Runner capabilities.",
    architectRuntimeId: "fixture:model",
    workerRuntimeIds: ["fixture:model"],
    verifierRuntimeIds: ["fixture:model"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full" as const,
    runPolicy: "finish" as const,
    budgetLimits: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    idempotencyKey: `capability:${runId}`,
  };
}

function createFixture(
  name: string,
  extensionLanguageId?: string,
  extensionToolName = "fixture.factory.inspect",
) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-native-capabilities-${name}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  const extension = join(root, "fixture extension");
  mkdirSync(project);
  mkdirSync(state);
  mkdirSync(extension);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "capability-fixture" }));
  writeFileSync(join(project, "value.fixture"), "value\n");
  writeFileSync(join(project, "fixture.config.json"), "{}\n");
  writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id: "fixture.factory",
    name: "Factory Fixture",
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: extensionLanguageId ? ["language_intelligence"] : ["tools", "context"],
  }, null, 2));
  writeFileSync(
    join(extension, "index.mjs"),
    extensionModuleSource(extensionLanguageId, extensionToolName),
  );
  return {
    project,
    state,
    extension,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

function extensionModuleSource(
  languageId: string | undefined,
  toolName: string,
): string {
  const language = languageId
    ? `[{ descriptor: { id: ${JSON.stringify(languageId)}, displayName: "Duplicate fixture", extensions: [".fixture"], rootMarkers: [], priority: 1 }, workspaceSymbols: async () => ({ status: "ok", results: [], truncated: false }), definition: async () => ({ status: "ok", results: [], truncated: false }), references: async () => ({ status: "ok", results: [], truncated: false }), diagnostics: async () => ({ status: "ok", results: [], truncated: false }), close: async () => { await appendFile(join(stateDirectory, "lifecycle.log"), "language-provider-closed\\n"); } }]`
    : "[]";
  return [
    'import { appendFile, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "let stateDirectory;",
    "export function createExtension() {",
    "  return {",
    "    capabilities: () => ({",
    languageId
      ? "      tools: [], contextContributors: [], languageProviders: " + language + ","
      : `      tools: [{ definition: { name: ${JSON.stringify(toolName)}, description: "Inspect factory fixture", inputSchema: { type: "object" }, readOnly: true, effect: "none" }, validate: () => ({ ok: true, value: {} }), execute: async () => ({ content: [], isError: false }) }], contextContributors: [{ id: "factory-context", kind: "fixture", priority: 500, maxBytes: 1024, contribute: async () => ({ content: "factory context" }) }], languageProviders: [],`,
    "    }),",
    "    start: async (context) => { stateDirectory = context.stateDirectory; await writeFile(join(stateDirectory, \"started.txt\"), \"started\\n\"); },",
    "    close: async () => { if (stateDirectory) await appendFile(join(stateDirectory, \"lifecycle.log\"), \"closed\\n\"); },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function writeHelperExtension(extension: string, marker: string): void {
  writeFileSync(join(extension, "runner-extension.json"), JSON.stringify({
    apiVersion: 1,
    id: "fixture.factory",
    name: "Factory Fixture",
    version: "1.0.0",
    entry: "index.mjs",
    capabilities: [],
  }, null, 2));
  writeFileSync(join(extension, "helper.mjs"), `export const marker = ${JSON.stringify(marker)};\n`);
  writeFileSync(
    join(extension, "index.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import { marker } from "./helper.mjs";',
      "export function createExtension() {",
      "  return {",
      "    capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),",
      "    start: async (context) => {",
      '      await writeFile(join(context.stateDirectory, "snapshot-marker.txt"), `${marker}\\n`);',
      "    },",
      "    close: async () => {},",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
}

function legacyContract(contract: RunnerCapabilityContract): RunnerCapabilityContract {
  const legacy = {
    version: contract.version,
    builtin: { ...contract.builtin },
    extensions: contract.extensions.map(({ closureDigest: _closureDigest, ...extension }) => ({
      ...extension,
      capabilities: [...extension.capabilities],
    })),
    languageServers: contract.languageServers.map((server) => ({ ...server })),
  };
  return {
    ...legacy,
    digest: createHash("sha256").update(stableJson(legacy)).digest("hex"),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  throw new Error("unsupported fixture value");
}

function runRoot(stateDirectory: string, runId: string): string {
  const readable = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return join(stateDirectory, "builds", `${readable}-${createHash("sha256").update(runId).digest("hex").slice(0, 10)}`);
}

function factoryWorkerOptions(
  handle: Awaited<ReturnType<NativeBuildFactory["create"]>>,
): NativeWorkerDriverOptions {
  return (handle.runtime as unknown as {
    scheduler: { driver: { options: NativeWorkerDriverOptions } };
  }).scheduler.driver.options;
}

class ScriptedModel implements AgentModel {
  constructor(private readonly turns: Array<ModelTurn | Error>) {}

  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return turn;
  }
}

function toolTurn(callId: string, name: string, arguments_: unknown): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId, name, arguments: arguments_ }],
    stopReason: "tool_calls",
  };
}
