import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  classifyNativeBuildRecoveryError,
  NativeBuildFactory,
  NativeBuildRuntimeInitializationError,
  preflightRecoveredRunnerCapabilities,
} from "../src/native-build-factory.js";
import type { NativeWorkerDriverOptions } from "../src/native-worker-driver.js";
import type { RunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import {
  createRunnerCapabilityContractSnapshot,
  RunnerCapabilityContractError,
  runnerCapabilitySnapshotExtensionDirectories,
  type RunnerCapabilityContract,
} from "../src/runner-capability-contract.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { runWorkerTask } from "../src/worker-runtime.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import {
  toolInvocationFingerprint,
  toolInvocationKey,
} from "../src/tool-ledger.js";

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

test("active recovery rejects matching snapshot evaluation and factory failures before a live runtime root exists", async () => {
  for (const scenario of [
    {
      name: "evaluation",
      source: 'throw new Error("snapshot evaluation failed");\n',
      expected: /snapshot evaluation failed/i,
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

test("NativeBuildFactory reverses every acquired runtime resource after construction faults", async () => {
  const stages = [
    "capabilities",
    "evidence_store",
    "scheduler_store",
    "session_store",
    "tool_ledger",
    "budget_ledger",
    "workspace_manager",
    "integration_workspace",
    "verification_workspace",
    "independent_verifier_workspace",
    "memory_store",
    "managed_process_service",
  ] as const;
  for (const faultAt of stages) {
    const fixture = createFixture(`runtime-construction-${faultAt}`);
    const runId = `runtime_construction_${faultAt}`;
    let factory: NativeBuildFactory | undefined;
    let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
    const acquired: string[] = [];
    const released: string[] = [];
    try {
      const baseline = await captureGitBaseline({
        projectPath: fixture.project,
        stateDirectory: fixture.state,
        runId,
      });
      factory = new NativeBuildFactory({
        projectRoot: fixture.project,
        stateDirectory: fixture.state,
        providerConfigs: {
          load: () => [providerConfig()],
          save: () => undefined,
          close: () => undefined,
        },
        capabilitiesConfig: { extensions: [fixture.extension], languageServers: [] },
        baselineFor: () => baseline.revision,
        runtimeConstructionHooks: {
          afterAcquire: async (stage) => {
            acquired.push(stage);
            if (stage === faultAt) throw new Error(`injected ${faultAt} construction failure`);
          },
          beforeCleanup: async (stage) => { released.push(stage); },
        },
      });
      const prepared = await factory.prepareSpec(buildSpec(runId));

      const createAttempt = factory.create(prepared).then((created) => {
        handle = created;
        return created;
      });
      await assert.rejects(
        createAttempt,
        (error: unknown) => {
          assert.match(String(error), new RegExp(`injected ${faultAt} construction failure`, "i"));
          if (faultAt === "capabilities") {
            assert.equal((error as { code?: unknown }).code, "capability_preflight_failed");
          } else {
            assert.equal(error instanceof NativeBuildRuntimeInitializationError, true);
            assert.equal((error as NativeBuildRuntimeInitializationError).stage, faultAt);
          }
          return true;
        },
      );

      assert.deepEqual(acquired, stages.slice(0, stages.indexOf(faultAt) + 1));
      assert.deepEqual(released, [...acquired].reverse());
      const root = runRoot(fixture.state, runId);
      for (const database of [
        "evidence.sqlite",
        "scheduler.sqlite",
        "sessions.sqlite",
        "tool-ledger.sqlite",
        "budget.sqlite",
      ]) {
        assertReleasedRunnerDatabase(join(root, database));
      }
      const integrationSegment = relative(join(fixture.state, "builds"), root);
      assert.equal(existsSync(join(fixture.state, "integration", integrationSegment)), false);
      const executionRoot = join(root, "extension-executions");
      assert.equal(
        !existsSync(executionRoot) || readdirSync(executionRoot).length === 0,
        true,
        `execution copies must be gone after ${faultAt}`,
      );
    } finally {
      await handle?.close();
      await factory?.close();
      fixture.cleanup();
    }
  }
});

test("NativeBuildFactory handle close releases owned stores while retaining recovery worktrees", async () => {
  const fixture = createFixture("runtime-handle-close-ownership");
  const runId = "runtime_handle_close_ownership";
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  const released: string[] = [];
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    factory = new NativeBuildFactory({
      projectRoot: fixture.project,
      stateDirectory: fixture.state,
      providerConfigs: {
        load: () => [providerConfig()],
        save: () => undefined,
        close: () => undefined,
      },
      capabilitiesConfig: { extensions: [fixture.extension], languageServers: [] },
      baselineFor: () => baseline.revision,
      runtimeConstructionHooks: {
        beforeCleanup: async (stage) => { released.push(stage); },
      },
    });
    handle = await factory.create(await factory.prepareSpec(buildSpec(runId)));
    await handle.close();
    handle = undefined;

    assert.deepEqual(released, [
      "budget_ledger",
      "tool_ledger",
      "session_store",
      "scheduler_store",
      "evidence_store",
      "capabilities",
    ]);
    const root = runRoot(fixture.state, runId);
    for (const database of [
      "evidence.sqlite",
      "scheduler.sqlite",
      "sessions.sqlite",
      "tool-ledger.sqlite",
      "budget.sqlite",
    ]) {
      assertReleasedRunnerDatabase(join(root, database));
    }
    const integrationSegment = relative(join(fixture.state, "builds"), root);
    assert.equal(
      existsSync(join(fixture.state, "integration", integrationSegment)),
      true,
      "normal handle close retains durable integration recovery state",
    );
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory retains the primary construction error while retrying every failed cleanup", async () => {
  const fixture = createFixture("runtime-construction-cleanup-retry");
  const runId = "runtime_construction_cleanup_retry";
  let factory: NativeBuildFactory | undefined;
  let cleanupFaultPending = true;
  const acquired: string[] = [];
  const cleanupAttempts: string[] = [];
  try {
    const baseline = await captureGitBaseline({
      projectPath: fixture.project,
      stateDirectory: fixture.state,
      runId,
    });
    factory = new NativeBuildFactory({
      projectRoot: fixture.project,
      stateDirectory: fixture.state,
      providerConfigs: {
        load: () => [providerConfig()],
        save: () => undefined,
        close: () => undefined,
      },
      capabilitiesConfig: { extensions: [fixture.extension], languageServers: [] },
      baselineFor: () => baseline.revision,
      runtimeConstructionHooks: {
        afterAcquire: async (stage) => {
          acquired.push(stage);
          if (stage === "scheduler_store") {
            throw new Error("injected scheduler construction failure");
          }
        },
        beforeCleanup: async (stage) => {
          cleanupAttempts.push(stage);
          if (stage === "evidence_store" && cleanupFaultPending) {
            cleanupFaultPending = false;
            throw new Error("injected evidence cleanup failure");
          }
        },
      },
    });
    const prepared = await factory.prepareSpec(buildSpec(runId));
    await assert.rejects(factory.create(prepared), (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      const messages = (error as AggregateError).errors.map((item) => String(item));
      assert.equal(messages.some((message) => /scheduler construction failure/i.test(message)), true);
      assert.equal(messages.some((message) => /evidence cleanup failure/i.test(message)), true);
      const primary = (error as AggregateError).errors[0] as Error & { cause?: unknown };
      assert.equal(primary instanceof NativeBuildRuntimeInitializationError, true);
      assert.equal((primary as NativeBuildRuntimeInitializationError).stage, "scheduler_store");
      assert.match(String(primary.cause), /scheduler construction failure/i);
      assert.deepEqual(classifyNativeBuildRecoveryError(error), {
        kind: "runtime",
        stage: "scheduler_store",
      });
      return true;
    });
    assert.deepEqual(acquired, ["capabilities", "evidence_store", "scheduler_store"]);
    assert.deepEqual(
      cleanupAttempts,
      ["scheduler_store", "evidence_store", "capabilities"],
      "a cleanup failure must not stop reverse-order unwinding",
    );

    await factory.close();
    factory = undefined;
    assert.deepEqual(cleanupAttempts, [
      "scheduler_store",
      "evidence_store",
      "capabilities",
      "evidence_store",
    ]);
    assertReleasedRunnerDatabase(join(runRoot(fixture.state, runId), "evidence.sqlite"));
  } finally {
    await factory?.close();
    fixture.cleanup();
  }
});

test("recovery classification preserves a capability primary inside cleanup aggregation", () => {
  const capability = new RunnerCapabilityContractError(
    "capability_preflight_failed",
    "injected capability startup failure",
  );
  const failure = new AggregateError(
    [capability, new Error("injected cleanup failure")],
    "startup and cleanup failed",
  );
  assert.deepEqual(classifyNativeBuildRecoveryError(failure), {
    kind: "capability",
    code: "capability_preflight_failed",
  });
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
    handle = await factory.createHistorical(prepared, "completed");

    assert.equal(handle.runtime.projection().status, "completed");
    assert.equal(handle.usage().scopeId, runId);
    const snapshot = await handle.observability();
    assert.equal(snapshot.runId, runId);
    assert.deepEqual(snapshot.capabilities?.historicalContract, {
      version: prepared.capabilityContract!.version,
      extensionClosureVersion: prepared.capabilityContract!.extensionClosureVersion,
      languageServerExecutableIdentityVersion:
        prepared.capabilityContract!.languageServerExecutableIdentityVersion,
      digest: prepared.capabilityContract!.digest,
      builtin: prepared.capabilityContract!.builtin,
      extensions: prepared.capabilityContract!.extensions,
      languageServers: prepared.capabilityContract!.languageServers,
    });
    assert.deepEqual(await handle.transcript(), {
      turns: [],
      cursor: 0,
      historicalProvenance: "durable",
    });
    assert.deepEqual(await handle.files(), {
      source: "integration",
      revision: "",
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
      historicalProvenance: "unavailable",
    });
    assert.deepEqual(handle.runtime.events(), []);
    await assert.rejects(handle.runtime.step(), /read-only/i);
    assert.throws(() => handle!.compact(), /read-only/i);
    await assert.rejects(handle!.projectHandoff("keep_integration_branch"), /read-only/i);
    assert.throws(() => handle!.cleanup(), /read-only/i);
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

    handle = await factory.createHistorical(prepared, "completed");

    assert.equal(handle.runtime.projection().status, "completed");
    assert.equal(handle.usage().scopeId, runId);
    assert.deepEqual((await handle.observability()).events, []);
    assert.deepEqual(await handle.transcript(), {
      turns: [],
      cursor: 0,
      historicalProvenance: "unavailable",
    });
    assert.deepEqual(await handle.files(), {
      source: "integration",
      revision: "",
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
      historicalProvenance: "unavailable",
    });
    assert.equal(existsSync(root), false);
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory historical readers do not create mutable global stores", async () => {
  const fixture = createFixture("historical-no-global-authority");
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    assert.equal(existsSync(join(fixture.state, "project-memory.sqlite")), false);
    assert.equal(existsSync(join(fixture.state, "managed-processes")), false);

    handle = await factory.createHistorical(buildSpec("historical_no_global_authority"), "stopped");
    await handle.observability();
    await handle.close();
    handle = undefined;

    assert.equal(existsSync(join(fixture.state, "project-memory.sqlite")), false);
    assert.equal(existsSync(join(fixture.state, "managed-processes")), false);
  } finally {
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory retries aggregate historical cleanup after a transient close failure", async () => {
  const fixture = createFixture("historical-close-retry");
  const runId = "capability_historical_close_retry";
  const root = runRoot(fixture.state, runId);
  const existingSnapshots = historicalTemporarySnapshots();
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  const originalClose = DatabaseSync.prototype.close;
  let closeAttempts = 0;
  let faultedDatabase: DatabaseSync | undefined;
  const captureFaultedDatabase = (database: DatabaseSync): void => {
    faultedDatabase ??= database;
  };
  let createdSnapshots: string[] = [];
  try {
    mkdirSync(root, { recursive: true });
    const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    evidence.close();
    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "stopped");
    createdSnapshots = [...historicalTemporarySnapshots()]
      .filter((directory) => !existingSnapshots.has(directory));
    assert.equal(createdSnapshots.length, 1);

    DatabaseSync.prototype.close = function closeWithTransientFault(this: DatabaseSync): void {
      closeAttempts += 1;
      if (closeAttempts === 1) {
        captureFaultedDatabase(this);
        throw new Error("injected historical close failure");
      }
      originalClose.call(this);
    };
    const firstClose = handle.close();
    const duplicateClose = handle.close();
    for (const close of [firstClose, duplicateClose]) {
      await assert.rejects(
        async () => { await close; },
        (error: unknown) => error instanceof AggregateError &&
          error.errors.some((entry) => entry instanceof Error &&
            entry.message === "injected historical close failure"),
      );
    }
    assert.equal(closeAttempts, 1);

    await handle.close();
    handle = undefined;
    assert.equal(closeAttempts, 2);
  } finally {
    DatabaseSync.prototype.close = originalClose;
    // A deliberately faulted old eager-close implementation cannot retry;
    // release the injected handle so the fault proof itself leaves no temp
    // snapshot behind.
    if (faultedDatabase) {
      try { originalClose.call(faultedDatabase); } catch { /* already closed */ }
    }
    await handle?.close();
    for (const directory of createdSnapshots) {
      const path = join(tmpdir(), directory);
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory retains every locked historical snapshot and retries aggregate removal", async () => {
  const fixture = createFixture("historical-snapshot-removal-retry");
  const runId = "capability_historical_snapshot_removal_retry";
  const root = runRoot(fixture.state, runId);
  const existingSnapshots = historicalTemporarySnapshots();
  const lockedSnapshots: DatabaseSync[] = [];
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    mkdirSync(root, { recursive: true });
    const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
    evidence.close();
    ledger.close();
    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "stopped");
    const snapshotDirectories = [...historicalTemporarySnapshots()]
      .filter((directory) => !existingSnapshots.has(directory));
    assert.equal(snapshotDirectories.length, 2);
    for (const directory of snapshotDirectories) {
      const database = readdirSync(join(tmpdir(), directory))
        .find((entry) => entry.endsWith(".sqlite"));
      assert.ok(database);
      lockedSnapshots.push(new DatabaseSync(join(tmpdir(), directory, database), { readOnly: true }));
    }

    await assert.rejects(
      async () => { await handle!.close(); },
      (error: unknown) => error instanceof AggregateError &&
        error.errors.length === snapshotDirectories.length,
    );
    assert.deepEqual(
      snapshotDirectories.map((directory) => existsSync(join(tmpdir(), directory))),
      [true, true],
    );

    for (const database of lockedSnapshots.splice(0)) database.close();
    await handle.close();
    handle = undefined;
    assert.deepEqual(
      snapshotDirectories.map((directory) => existsSync(join(tmpdir(), directory))),
      [false, false],
    );
  } finally {
    for (const database of lockedSnapshots.splice(0)) database.close();
    await handle?.close();
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory preserves opening and cleanup failures while constructing historical readers", async () => {
  const fixture = createFixture("historical-construction-cleanup");
  const runId = "capability_historical_construction_cleanup";
  const root = runRoot(fixture.state, runId);
  const existingSnapshots = historicalTemporarySnapshots();
  const originalClose = DatabaseSync.prototype.close;
  let interceptedDatabase: DatabaseSync | undefined;
  const captureFaultedDatabase = (database: DatabaseSync): void => {
    interceptedDatabase ??= database;
  };
  let factory: NativeBuildFactory | undefined;
  try {
    mkdirSync(root, { recursive: true });
    const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    evidence.close();
    // The last optional store is deliberately invalid, after evidence has
    // opened, so construction must report both failures during unwind.
    mkdirSync(join(fixture.state, "project-memory.sqlite"));
    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    DatabaseSync.prototype.close = function closeWithConstructionFault(this: DatabaseSync): void {
      captureFaultedDatabase(this);
      throw new Error("injected historical construction cleanup failure");
    };

    await assert.rejects(
      factory.createHistorical(buildSpec(runId), "failed"),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((entry) => entry instanceof Error && /must be a regular file/i.test(entry.message)) &&
        error.errors.some((entry) => entry instanceof Error &&
          entry.message === "injected historical construction cleanup failure"),
    );
  } finally {
    DatabaseSync.prototype.close = originalClose;
    // The deliberately faulted close did not release this private snapshot.
    // Release it only after the production path has reported its aggregate.
    if (interceptedDatabase) originalClose.call(interceptedDatabase);
    for (const directory of historicalTemporarySnapshots()) {
      if (!existingSnapshots.has(directory)) {
        rmSync(join(tmpdir(), directory), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
    await factory?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory reconstructs terminal observations only from durable run records", async () => {
  const fixture = createFixture("historical-durable-observations");
  const runId = "capability_historical_durable_observations";
  const root = runRoot(fixture.state, runId);
  const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let sessions: SqliteAgentSessionStore | undefined;
  let budget: SqliteBudgetLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    mkdirSync(root, { recursive: true });
    evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
    sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
    budget = new SqliteBudgetLedger(join(root, "budget.sqlite"), { limitsFor: () => ({}) });
    scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
      evidenceStore: evidence,
      artifacts,
    });
    memory = new SqliteProjectMemoryStore(join(fixture.state, "project-memory.sqlite"));

    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: "2026-08-28T00:00:00.000Z",
      actor: { role: "runner", id: "fixture" },
      idempotencyKey: "initialized",
      payload: { objective: "Recover durable observations." },
    });
    evidence.record({
      runId,
      taskId: "task_1",
      actor: { role: "worker", id: "worker_1" },
      fact: {
        kind: "browser_screenshot",
        label: "Durable evidence",
        capturedAt: "2026-08-28T00:00:01.000Z",
        screenshotArtifactHash: "a".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: "2026-08-28T00:00:01.000Z",
      idempotencyKey: "evidence",
    });
    await sessions.create({
      sessionId: "worker:historical:1",
      runId,
      actor: { role: "worker", id: "worker_1" },
      occurredAt: "2026-08-28T00:00:02.000Z",
    });
    await sessions.checkpoint(
      "worker:historical:1",
      {
        messages: [
          { id: "assistant", role: "assistant", content: "Durable transcript." },
        ],
        turns: 1,
        seenCallIds: [],
      },
      "2026-08-28T00:00:03.000Z",
    );
    const skillCall = {
      type: "tool_call" as const,
      callId: "skills",
      name: "list_skills",
      arguments: {},
    };
    const skillContext = { runId, sessionId: "worker:historical:1" };
    const skillKey = toolInvocationKey(skillContext, skillCall.callId);
    const skillFingerprint = toolInvocationFingerprint(skillCall);
    ledger.begin({
      key: skillKey,
      fingerprint: skillFingerprint,
      callId: skillCall.callId,
      toolName: skillCall.name,
      runId,
      sessionId: skillContext.sessionId,
      replaySafe: true,
      effect: "none",
      access: { capability: "skills" },
      outsideWorkspace: false,
      occurredAt: "2026-08-28T00:00:04.000Z",
    });
    ledger.complete(skillKey, skillFingerprint, {
      callId: skillCall.callId,
      toolName: skillCall.name,
      content: [{
        type: "json",
        value: [{
          id: "project:historical",
          name: "Historical skill",
          description: "Captured skill metadata.",
          relativePath: ".agents/skills/historical/SKILL.md",
          digest: "b".repeat(64),
          byteLength: 42,
          source: "project",
        }],
      }],
      isError: false,
    }, "2026-08-28T00:00:05.000Z");
    budget.reserve({
      scopeId: runId,
      reservationId: "model_historical",
      kind: "model",
      attribution: {
        runtimeId: "historical:model",
        providerId: "historical-provider",
        modelId: "historical-model",
        role: "worker",
        sessionId: skillContext.sessionId,
      },
      estimate: { inputTokens: 10, outputTokens: 3, estimatedCostMicros: 15 },
      costBasis: {
        kind: "api_estimate",
        inputCostMicrosPerMillion: 1,
        outputCostMicrosPerMillion: 1,
        cachedInputCostMicrosPerMillion: 0,
        cacheWriteInputCostMicrosPerMillion: 0,
      },
      occurredAt: "2026-08-28T00:00:06.000Z",
      idempotencyKey: "reserve:model",
    });
    budget.settle({
      scopeId: runId,
      reservationId: "model_historical",
      actual: { inputTokens: 7, outputTokens: 2, estimatedCostMicros: 9 },
      tokenSources: { inputTokens: "reported", outputTokens: "reported" },
      costBasis: {
        kind: "api_estimate",
        inputCostMicrosPerMillion: 1,
        outputCostMicrosPerMillion: 1,
        cachedInputCostMicrosPerMillion: 0,
        cacheWriteInputCostMicrosPerMillion: 0,
      },
      occurredAt: "2026-08-28T00:00:07.000Z",
      idempotencyKey: "settle:model",
    });
    const durableMemory = memory.propose({
      projectId: "fixture-project",
      runId,
      actor: { role: "architect", id: "architect_1" },
      content: "Durable historical memory.",
      concepts: ["history"],
      occurredAt: "2026-08-28T00:00:08.000Z",
      idempotencyKey: "memory",
    });
    const processDirectory = join(fixture.state, "managed-processes", "process_historical");
    mkdirSync(processDirectory, { recursive: true });
    const stdoutPath = join(processDirectory, "stdout.log");
    const stderrPath = join(processDirectory, "stderr.log");
    writeFileSync(stdoutPath, "durable stdout\n");
    writeFileSync(stderrPath, "durable stderr\n");
    writeFileSync(join(fixture.state, "managed-processes", "process_historical.json"), JSON.stringify({
      processId: "process_historical",
      pid: 4242,
      runId,
      sessionId: skillContext.sessionId,
      actor: { role: "worker", id: "worker_1" },
      command: process.execPath,
      args: ["--version"],
      cwd: fixture.project,
      environmentKeys: ["PATH"],
      startedAt: "2026-08-28T00:00:09.000Z",
      updatedAt: "2026-08-28T00:00:10.000Z",
      status: "stopped",
      exitCode: 0,
      signal: null,
      stdoutPath,
      stderrPath,
    }, null, 2));

    memory.close(); memory = undefined;
    scheduler.close(); scheduler = undefined;
    budget.close(); budget = undefined;
    sessions.close(); sessions = undefined;
    ledger.close(); ledger = undefined;
    evidence.close(); evidence = undefined;
    const before = historicalStateSnapshot(fixture.state);

    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "stopped");
    assert.equal(handle.runtime.projection().status, "stopped");
    assert.equal(handle.runtime.events().length, 1);
    const usage = handle.usage();
    assert.equal(usage.historicalProvenance, "durable");
    assert.deepEqual(usage.models.map((model) => ({
      runtimeId: model.runtimeId,
      providerId: model.providerId,
      modelId: model.modelId,
      roles: model.roles,
      status: model.status,
      calls: model.calls,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      estimatedCostMicros: model.estimatedCostMicros,
    })), [{
      runtimeId: "historical:model",
      providerId: "historical-provider",
      modelId: "historical-model",
      roles: ["worker"],
      status: "unavailable",
      calls: 1,
      inputTokens: 7,
      outputTokens: 2,
      estimatedCostMicros: 9,
    }]);
    assert.deepEqual(await handle.transcript(), {
      turns: [{
        id: "worker:historical:1:assistant",
        sessionId: "worker:historical:1",
        actor: { role: "worker", id: "worker_1" },
        sequence: 2,
        ordinal: 0,
        occurredAt: "2026-08-28T00:00:03.000Z",
        text: "Durable transcript.",
      }],
      cursor: 2,
      historicalProvenance: "durable",
    });
    assert.deepEqual(await handle.files(), {
      source: "integration",
      revision: "",
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
      historicalProvenance: "unavailable",
    });
    const snapshot = await handle.observability();
    assert.equal(snapshot.evidence.length, 1);
    assert.deepEqual(snapshot.memories.map((entry) => entry.id), [durableMemory.id]);
    assert.deepEqual(snapshot.skills.map((skill) => skill.id), ["project:historical"]);
    assert.equal(snapshot.processes[0]?.processId, "process_historical");
    assert.equal(snapshot.processes[0]?.status, "stopped");
    assert.deepEqual(snapshot.historical, {
      terminalState: "stopped",
      provenance: {
        usage: "durable",
        transcript: "durable",
        evidence: "durable",
        memories: "durable",
        skills: "durable",
        processes: "durable",
        capabilities: "unavailable",
        events: "durable",
        files: "unavailable",
      },
    });
    await handle.close();
    handle = undefined;
    await factory.close();
    factory = undefined;
    assert.deepEqual(historicalStateSnapshot(fixture.state), before);
  } finally {
    await handle?.close();
    await factory?.close();
    memory?.close();
    scheduler?.close();
    budget?.close();
    sessions?.close();
    ledger?.close();
    evidence?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory replays unmigrated terminal transcript and evidence without writes", async () => {
  const fixture = createFixture("historical-unmigrated-observations");
  const runId = "capability_historical_unmigrated_observations";
  const root = runRoot(fixture.state, runId);
  const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
  let sessions: SqliteAgentSessionStore | undefined;
  let rawEvidence: DatabaseSync | undefined;
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    mkdirSync(root, { recursive: true });
    sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
    await sessions.create({
      sessionId: "architect:unmigrated",
      runId,
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-08-28T00:00:00.000Z",
    });
    await sessions.checkpoint(
      "architect:unmigrated",
      {
        messages: [{ id: "assistant", role: "assistant", content: "Legacy transcript." }],
        turns: 1,
        seenCallIds: [],
      },
      "2026-08-28T00:00:01.000Z",
    );
    sessions.close();
    sessions = undefined;
    const sessionDatabase = new DatabaseSync(join(root, "sessions.sqlite"));
    try {
      sessionDatabase.exec(`
        DROP TABLE agent_transcript_turns;
        DROP TABLE agent_transcript_checkpoints;
      `);
    } finally {
      sessionDatabase.close();
    }
    rawEvidence = new DatabaseSync(join(root, "evidence.sqlite"));
    rawEvidence.exec(`
      CREATE TABLE evidence_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        UNIQUE(run_id, idempotency_key)
      );
    `);
    rawEvidence.prepare(`
      INSERT INTO evidence_records (
        evidence_id, run_id, task_id, actor_json, fact_json, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "evidence_unmigrated",
      runId,
      "task_legacy",
      JSON.stringify({ role: "worker", id: "worker_1" }),
      JSON.stringify({
        kind: "browser_screenshot",
        label: "Unmigrated evidence",
        capturedAt: "2026-08-28T00:00:02.000Z",
        screenshotArtifactHash: "d".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      }),
      "2026-08-28T00:00:02.000Z",
      "unmigrated-evidence",
    );
    rawEvidence.close();
    rawEvidence = undefined;
    const before = historicalStateSnapshot(fixture.state);

    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "failed");
    assert.equal(handle.runtime.projection().status, "failed");
    assert.deepEqual(await handle.transcript(), {
      turns: [{
        id: "architect:unmigrated:assistant",
        sessionId: "architect:unmigrated",
        actor: { role: "architect", id: "architect_1" },
        sequence: 2,
        ordinal: 0,
        occurredAt: "2026-08-28T00:00:01.000Z",
        text: "Legacy transcript.",
      }],
      cursor: 2,
      historicalProvenance: "legacy_replay",
    });
    const snapshot = await handle.observability();
    assert.equal(snapshot.evidence[0]?.id, "evidence_unmigrated");
    assert.equal(snapshot.evidence[0]?.attempt, undefined);
    assert.equal(snapshot.historical?.provenance.transcript, "legacy_replay");
    assert.equal(snapshot.historical?.provenance.evidence, "legacy_replay");
    await handle.close();
    handle = undefined;
    await factory.close();
    factory = undefined;
    assert.deepEqual(historicalStateSnapshot(fixture.state), before);
  } finally {
    await handle?.close();
    await factory?.close();
    sessions?.close();
    rawEvidence?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory replays a present but partial terminal transcript projection without writes", async () => {
  const fixture = createFixture("historical-partial-transcript");
  const runId = "capability_historical_partial_transcript";
  const root = runRoot(fixture.state, runId);
  const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
  let sessions: SqliteAgentSessionStore | undefined;
  let projection: DatabaseSync | undefined;
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    mkdirSync(root, { recursive: true });
    sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
    await sessions.create({
      sessionId: "architect:partial",
      runId,
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-08-28T00:00:00.000Z",
    });
    await sessions.checkpoint(
      "architect:partial",
      {
        messages: [{ id: "first", role: "assistant", content: "First historical turn." }],
        turns: 1,
        seenCallIds: [],
      },
      "2026-08-28T00:00:01.000Z",
    );
    await sessions.checkpoint(
      "architect:partial",
      {
        messages: [
          { id: "first", role: "assistant", content: "First historical turn." },
          { id: "second", role: "assistant", content: "Second historical turn." },
        ],
        turns: 2,
        seenCallIds: [],
      },
      "2026-08-28T00:00:02.000Z",
    );
    sessions.close();
    sessions = undefined;
    projection = new DatabaseSync(join(root, "sessions.sqlite"));
    projection.exec(`
      DELETE FROM agent_transcript_turns WHERE sequence = 2;
      DELETE FROM agent_transcript_checkpoints WHERE sequence = 2;
    `);
    projection.close();
    projection = undefined;
    const before = historicalStateSnapshot(fixture.state);

    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "failed");
    assert.deepEqual(await handle.transcript(), {
      turns: [
        {
          id: "architect:partial:first",
          sessionId: "architect:partial",
          actor: { role: "architect", id: "architect_1" },
          sequence: 2,
          ordinal: 0,
          occurredAt: "2026-08-28T00:00:01.000Z",
          text: "First historical turn.",
        },
        {
          id: "architect:partial:second",
          sessionId: "architect:partial",
          actor: { role: "architect", id: "architect_1" },
          sequence: 3,
          ordinal: 1,
          occurredAt: "2026-08-28T00:00:02.000Z",
          text: "Second historical turn.",
        },
      ],
      cursor: 3,
      historicalProvenance: "legacy_replay",
    });
    assert.deepEqual(await handle.transcript(2), {
      turns: [{
        id: "architect:partial:second",
        sessionId: "architect:partial",
        actor: { role: "architect", id: "architect_1" },
        sequence: 3,
        ordinal: 1,
        occurredAt: "2026-08-28T00:00:02.000Z",
        text: "Second historical turn.",
      }],
      cursor: 3,
      historicalProvenance: "legacy_replay",
    });
    const audit = await handle.observability();
    assert.equal(audit.historical?.provenance.transcript, "legacy_replay");
    await handle.close();
    handle = undefined;
    await factory.close();
    factory = undefined;
    assert.deepEqual(historicalStateSnapshot(fixture.state), before);
  } finally {
    await handle?.close();
    await factory?.close();
    projection?.close();
    sessions?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory historical copies preserve WAL-visible durable observations", async () => {
  const fixture = createFixture("historical-wal-observation");
  const runId = "capability_historical_wal_observation";
  const root = runRoot(fixture.state, runId);
  const databasePath = join(root, "evidence.sqlite");
  let raw: DatabaseSync | undefined;
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
  try {
    mkdirSync(root, { recursive: true });
    raw = new DatabaseSync(databasePath);
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE evidence_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt INTEGER,
        UNIQUE(run_id, idempotency_key)
      );
    `);
    raw.prepare(`
      INSERT INTO evidence_records (
        evidence_id, run_id, task_id, actor_json, fact_json,
        created_at, idempotency_key, attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "evidence_wal",
      runId,
      "task_wal",
      JSON.stringify({ role: "worker", id: "worker_1" }),
      JSON.stringify({
        kind: "browser_screenshot",
        label: "WAL-visible evidence",
        capturedAt: "2026-08-28T00:00:00.000Z",
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      }),
      "2026-08-28T00:00:00.000Z",
      "wal-evidence",
      1,
    );
    assert.equal(existsSync(`${databasePath}-wal`), true);
    const before = historicalStateSnapshot(fixture.state);

    factory = createFactory(fixture.project, fixture.state, "unused", {
      extensions: [],
      languageServers: [],
    });
    handle = await factory.createHistorical(buildSpec(runId), "completed");
    assert.deepEqual((await handle.observability()).evidence.map((record) => record.id), [
      "evidence_wal",
    ]);
    await handle.close();
    handle = undefined;
    await factory.close();
    factory = undefined;
    assert.deepEqual(historicalStateSnapshot(fixture.state), before);
  } finally {
    await handle?.close();
    await factory?.close();
    raw?.close();
    fixture.cleanup();
  }
});

test("NativeBuildFactory preserves the authoritative terminal state when scheduler history is absent", async () => {
  for (const terminalState of ["failed", "stopped"] as const) {
    const fixture = createFixture(`historical-terminal-${terminalState}`);
    let factory: NativeBuildFactory | undefined;
    let handle: Awaited<ReturnType<NativeBuildFactory["createHistorical"]>> | undefined;
    try {
      const runId = `capability_historical_${terminalState}`;
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

      handle = await (factory.createHistorical as unknown as (
        spec: typeof prepared,
        state: typeof terminalState,
      ) => ReturnType<NativeBuildFactory["createHistorical"]>)(prepared, terminalState);

      assert.equal(handle.runtime.projection().status, terminalState);
    } finally {
      await handle?.close();
      await factory?.close();
      fixture.cleanup();
    }
  }
});

function historicalStateSnapshot(root: string): {
  directories: string[];
  files: Array<{
    path: string;
    digest: string;
    byteLength: number;
    mtimeMs: number;
    sqliteSchema?: Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  }>;
} {
  const directories: string[] = [];
  const files: Array<{
    path: string;
    digest: string;
    byteLength: number;
    mtimeMs: number;
    sqliteSchema?: Array<{ type: string; name: string; tableName: string; sql: string | null }>;
  }> = [];
  const visit = (directory: string) => {
    const normalized = relative(root, directory).replace(/\\/g, "/") || ".";
    directories.push(normalized);
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      const relativePath = relative(root, path).replace(/\\/g, "/");
      const detail: (typeof files)[number] = {
        path: relativePath,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mtimeMs: statSync(path).mtimeMs,
      };
      if (path.endsWith(".sqlite")) {
        detail.sqliteSchema = historicalSqliteSchema(path);
      }
      files.push(detail);
    }
  };
  visit(root);
  return { directories: directories.sort(), files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

function historicalTemporarySnapshots(): Set<string> {
  return new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("aiboard-historical-sqlite-"))
      .map((entry) => entry.name),
  );
}

function assertReleasedRunnerDatabase(path: string): void {
  if (!existsSync(path)) return;
  const probe = `${path}.release-probe`;
  renameSync(path, probe);
  renameSync(probe, path);
}

function historicalSqliteSchema(
  source: string,
): Array<{ type: string; name: string; tableName: string; sql: string | null }> {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-historical-schema-"));
  const copy = join(directory, "snapshot.sqlite");
  try {
    copyFileSync(source, copy);
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${source}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).isFile()) {
        copyFileSync(sidecar, `${copy}${suffix}`);
      }
    }
    const database = new DatabaseSync(copy, { readOnly: true });
    try {
      return database.prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master ORDER BY type, name",
      ).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
