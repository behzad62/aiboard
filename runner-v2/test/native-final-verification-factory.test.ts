import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { captureGitBaseline } from "./support/git-fixture.js";
import { FinalVerificationProfileAuthority } from "./support/git-fixture.js";
import type { FinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import { FinalVerificationPortAuthority } from "../src/final-verification-port-authority.js";
import { NativeBuildFactory } from "./support/git-fixture.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("NativeBuildFactory executes all four bound categories from clean integration state while user checkout is dirty", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard native final verification factory "));
  const project = join(root, "user project");
  const state = join(root, "runner state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "native-factory-fixture",
    packageManager: "npm@11.0.0",
    scripts: {
      build: "node build.mjs",
      test: "node --test fixture.test.mjs",
      preview: "node server.mjs",
    },
    dependencies: { "fixture-local": "file:./fixture-local" },
    devDependencies: { vite: "file:./fixture-vite" },
  }, null, 2));
  mkdirSync(join(project, "fixture-local"), { recursive: true });
  writeFileSync(join(project, "fixture-local", "package.json"), JSON.stringify({ name: "fixture-local", version: "1.0.0", type: "module", exports: "./index.mjs" }));
  writeFileSync(join(project, "fixture-local", "index.mjs"), "export const message = 'Installed local dependency';\n");
  mkdirSync(join(project, "fixture-vite"), { recursive: true });
  writeFileSync(join(project, "fixture-vite", "package.json"), JSON.stringify({ name: "vite", version: "1.0.0" }));
  writeFileSync(join(project, "build.mjs"), "import { message } from 'fixture-local'; import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', `<main id=app>${message}</main>`);\n");
  writeFileSync(join(project, "fixture.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { message } from 'fixture-local'; import { existsSync } from 'node:fs'; test('built', () => { assert.equal(message, 'Installed local dependency'); assert.equal(existsSync('dist/index.html'), true); });\n");
  writeFileSync(join(project, "server.mjs"), "import http from 'node:http'; import { message } from 'fixture-local'; const args=process.argv.slice(2); const port=Number(args[args.indexOf('--port')+1]); const server=http.createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end(`<main id=app>${message}</main>`)}); server.listen(port,'127.0.0.1');\n");
  writeFileSync(join(project, "index.html"), "<main id=app>source</main>\n");
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const lock = spawnSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(lock.status, 0, lock.stderr);
  assert.equal(existsSync(join(project, "node_modules", "fixture-local")), false);
  assert.notEqual(spawnSync(process.execPath, ["build.mjs"], { cwd: project }).status, 0);

  const runId = "native-factory-verification";
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const config: RunnerProviderConfig = {
    runtimeId: "fixture:model",
    providerId: "fixture",
    modelId: "model",
    transport: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    secret: "unused",
    capabilities: ["code"],
    priority: 1,
  };
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment,
  });
  const factory = new NativeBuildFactory({
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: { load: () => [config], save: () => undefined, close: () => undefined },
    executionHost,
    baselineFor: () => baseline.revision,
  });
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  try {
    handle = await factory.create(await factory.prepareSpec({
      version: 2,
      runId,
      projectId: "fixture-project",
      objective: "Verify a real application.",
      architectRuntimeId: config.runtimeId,
      workerRuntimeIds: [config.runtimeId],
      verifierRuntimeIds: [config.runtimeId],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      budgetLimits: {},
      createdAt: "2026-08-26T00:00:00.000Z",
      idempotencyKey: "native-factory-verification",
    }));
    assert.ok(handle.processRecovery, "live Native Build handle must expose bounded exceptional recovery");
    const initialObservability = await handle.observability();
    assert.equal(initialObservability.executionSafety?.availability, "live");
    if (initialObservability.executionSafety?.availability === "live") {
      assert.equal(initialObservability.executionSafety.isolation.securityBoundary, "provider_specific_not_universal_security_boundary");
    }
    const runRoot = join(state, "builds", safeSegment(runId));
    const ports = new FinalVerificationPortAuthority(state);
    const authority = new FinalVerificationProfileAuthority({
      stateDirectory: state,
      runId,
      portAuthority: ports,
      ambientEnvironment: executionHost.filteredEnvironmentSource(),
    });
    scheduler = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
      validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
    });
    const integration = baseline.revision;
    seedPlanningState(scheduler, runId, integration);
    const runtimeProfileFor = (handle.runtime as unknown as {
      finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
    }).finalVerificationProfileFor;
    assert.ok(runtimeProfileFor, "production runtime must retain its owned final-verification profile callback");
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({
      store: scheduler,
      finalVerificationPlanAvailable: true,
      finalVerificationProfileFor: runtimeProfileFor,
    })) tools.register(tool);
    const planned = await tools.invoke({
      type: "tool_call",
      callId: "plan-native-verification",
      name: "plan_final_verification",
      arguments: { plan: { checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({ category, status: "required" })) } },
    }, {
      runId,
      sessionId: "architect:native-verification",
      actor: { role: "architect", id: "architect-fixture" },
    });
    assert.equal(planned.isError, false, planned.error?.message ?? "native final-verification plan failed");
    const profile = handle.runtime.projection().finalVerification?.current?.executionProfile;
    assert.ok(profile?.provisioning);
    assert.ok(profile.portLease);

    writeFileSync(join(project, "uncommitted-user-note.txt"), "must remain untouched\n");
    const actions: string[] = [];
    for (let index = 0; index < 6; index += 1) actions.push((await handle.runtime.step()).action ?? "");
    assert.deepEqual(actions, [
      "final_verification_check_completed",
      "final_verification_check_completed",
      "final_verification_check_completed",
      "final_verification_check_completed",
      "final_verification_submitted",
      "final_verification_cleanup_succeeded",
    ], JSON.stringify(handle.runtime.projection().finalVerification?.current?.cleanup));
    const current = handle.runtime.projection().finalVerification?.current;
    assert.deepEqual(current?.completedChecks?.map((check) => [check.category, check.green]), [
      ["build", true], ["tests", true], ["runtime_smoke", true], ["browser", true],
    ]);
    assert.equal(existsSync(join(project, "dist", "index.html")), false);
    assert.equal(existsSync(join(project, "uncommitted-user-note.txt")), true);
    await assert.rejects(fetch(profile.runtimeSmoke!.endpoint!));
    await assert.rejects(() => ports.validate(profile.portLease!, runId, integration), /lease is missing|invalid/i);
    ports.validateDurable(profile.portLease, runId, integration);
  } finally {
    scheduler?.close();
    await handle?.close();
    await factory.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedPlanningState(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "plan.created", occurredAt: "2026-08-26T00:00:01.000Z", actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: { revision: 1, tasks: [] } });
  store.append({ runId, type: "integration.revision_advanced", occurredAt: "2026-08-26T00:00:02.000Z", actor: { role: "runner", id: "integration" }, idempotencyKey: "revision", payload: { integrationRevision: revision } });
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}
