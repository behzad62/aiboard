import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { FinalVerificationProfileAuthority } from "../src/final-verification-profile.js";
import { NativeBuildFactory } from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("NativeBuildFactory executes all four bound categories from clean integration state while user checkout is dirty", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard native final verification factory "));
  const project = join(root, "user project");
  const state = join(root, "runner state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    scripts: {
      build: "node build.mjs",
      test: "node --test fixture.test.mjs",
      preview: "node server.mjs",
    },
    devDependencies: { vite: "latest" },
  }, null, 2));
  writeFileSync(join(project, "build.mjs"), "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', '<main id=app>Verified UI</main>');\n");
  writeFileSync(join(project, "fixture.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; test('built', () => assert.equal(existsSync('dist/index.html'), true));\n");
  writeFileSync(join(project, "server.mjs"), "import http from 'node:http'; const server=http.createServer((_q,r)=>{r.setHeader('content-type','text/html');r.end('<main id=app>Verified UI</main>')}); server.listen(4173,'127.0.0.1');\n");
  writeFileSync(join(project, "index.html"), "<main id=app>source</main>\n");

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
  const factory = new NativeBuildFactory({
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: { load: () => [config], save: () => undefined, close: () => undefined },
    baselineFor: () => baseline.revision,
  });
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  try {
    handle = await factory.create({
      version: 1,
      runId,
      projectId: "fixture-project",
      objective: "Verify a real application.",
      architectRuntimeId: config.runtimeId,
      workerRuntimeIds: [config.runtimeId],
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      budgetLimits: {},
      createdAt: "2026-08-26T00:00:00.000Z",
      idempotencyKey: "native-factory-verification",
    });
    const runRoot = join(state, "builds", safeSegment(runId));
    const authority = new FinalVerificationProfileAuthority({ stateDirectory: state, runId });
    scheduler = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
      validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
    });
    const integration = baseline.revision;
    const integrationPath = join(state, "integration", safeName(runId));
    const profile = await authority.inspectAndPersist({ repositoryRoot: integrationPath, targetRevision: integration });
    seedGeneration(scheduler, runId, integration, profile);

    writeFileSync(join(project, "uncommitted-user-note.txt"), "must remain untouched\n");
    const actions: string[] = [];
    for (let index = 0; index < 4; index += 1) actions.push((await handle.runtime.step()).action ?? "");
    assert.deepEqual(actions, [
      "final_verification_check_completed",
      "final_verification_check_completed",
      "final_verification_check_completed",
      "final_verification_check_completed",
    ]);
    const current = handle.runtime.projection().finalVerification?.current;
    assert.deepEqual(current?.completedChecks?.map((check) => [check.category, check.green]), [
      ["build", true], ["tests", true], ["runtime_smoke", true], ["browser", true],
    ]);
    assert.equal(existsSync(join(project, "dist", "index.html")), false);
    assert.equal(existsSync(join(project, "uncommitted-user-note.txt")), true);
    await assert.rejects(fetch("http://127.0.0.1:4173/"));
  } finally {
    scheduler?.close();
    await handle?.close();
    await factory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedGeneration(store: SqliteSchedulerStore, runId: string, revision: string, executionProfile: unknown): void {
  store.append({ runId, type: "plan.created", occurredAt: "2026-08-26T00:00:01.000Z", actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: { revision: 1, tasks: [] } });
  store.append({ runId, type: "integration.revision_advanced", occurredAt: "2026-08-26T00:00:02.000Z", actor: { role: "runner", id: "integration" }, idempotencyKey: "revision", payload: { integrationRevision: revision } });
  store.append({ runId, type: "final_verification.generation_created", occurredAt: "2026-08-26T00:00:03.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "verification", payload: {
    taskId: "final-verification-native", generationId: "generation-native", targetRevision: revision, planVersion: 1,
    plan: { checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({ category, status: "required" })) },
    executionProfile,
  } });
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}
function safeName(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}
