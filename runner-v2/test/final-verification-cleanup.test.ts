import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureGitBaseline } from "../src/git-baseline.js";
import { IntegrationManager } from "../src/integration-manager.js";
import {
  FinalVerificationDiagnosticsArchive,
  OwnedFinalVerificationCleanup,
  validateOwnedFinalVerificationCleanupReceipt,
} from "../src/final-verification-cleanup.js";
import { VerificationWorkspaceManager } from "../src/verification-workspace.js";

test("failed verification diagnostics archive dirty files before exact cleanup", async () => {
  const fixture = await createFixture("archive");
  try {
    const workspace = await fixture.workspace.create();
    writeFileSync(join(workspace.path, "generated.log"), "token=super-secret\nfailed output\n");
    const calls: string[] = [];
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
      diagnostics: new FinalVerificationDiagnosticsArchive({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        workspaceManager: fixture.workspace,
      }),
    });
    const result = await cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) });
    calls.push("done");
    assert.deepEqual(calls, ["process", "browser", "done"]);
    assert.equal(existsSync(workspace.path), false);
    const archive = JSON.parse(readFileSync(result.diagnosticsPath!, "utf8")) as {
      targetRevision: string; changedPaths: string[]; logs: string[];
    };
    assert.equal(archive.targetRevision, fixture.integration.revision);
    assert.deepEqual(archive.changedPaths, ["generated.log"]);
    assert.equal(JSON.stringify(archive).includes("super-secret"), false);
  } finally { await closeFixture(fixture); }
});

test("diagnostics redact structured keys, argv pairs, bearer values, and URL credentials", async () => {
  const fixture = await createFixture("structured-redaction");
  try {
    await fixture.workspace.create();
    const diagnostics = new FinalVerificationDiagnosticsArchive({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      workspaceManager: fixture.workspace,
    });
    const path = await diagnostics.persist({
      ...diagnosticsInput(fixture),
      checks: [{
        category: "tests",
        command: {
          args: [
            "--token", "argv-secret", "--api-key=url-secret",
            "--access-token", "argv-access-secret", "--client-secret=argv-client-secret",
            "--safe", "visible",
          ],
          env: {
            API_KEY: "object-secret",
            ACCESS_TOKEN: "object-access-secret",
            clientSecret: "object-client-secret",
            SAFE_VALUE: "visible",
          },
          endpoint: "https://user:url-password@example.test/run?access_token=query-access-secret&client_secret=query-client-secret&safe=visible",
        },
      }],
      evidenceReferences: ["Authorization: Bearer evidence-secret"],
      logs: [
        "API_KEY whitespace-secret",
        "Bearer standalone-secret",
        '{"access_token":"json-log-access-secret","nested":{"clientSecret":"json-log-client-secret"}}',
        'diagnostic fragment "refresh_token":"json-fragment-secret" tail',
        'diagnostic "access_token":["json-array-secret",{"value":"json-array-nested-secret"}] tail',
        'diagnostic "clientSecret":{"value":"json-object-secret"} tail',
        `${"{".repeat(65)} diagnostic "private_key":{"value":"json-late-secret"} tail`,
      ],
    });
    const encoded = readFileSync(path, "utf8");
    for (const secret of [
      "argv-secret", "url-secret", "object-secret", "url-password", "query-secret",
      "argv-access-secret", "argv-client-secret", "object-access-secret", "object-client-secret",
      "query-access-secret", "query-client-secret", "evidence-secret", "whitespace-secret", "standalone-secret",
      "json-log-access-secret", "json-log-client-secret", "json-fragment-secret",
      "json-array-secret", "json-array-nested-secret", "json-object-secret", "json-late-secret",
    ]) assert.doesNotMatch(encoded, new RegExp(secret));
    assert.match(encoded, /visible/);
    assert.match(encoded, /\[REDACTED\]/);
  } finally { await closeFixture(fixture); }
});

test("failed cleanup converges after a crash between workspace deletion and receipt persistence", async () => {
  const fixture = await createFixture("crash-after-workspace-delete");
  try {
    const workspace = await fixture.workspace.create();
    writeFileSync(join(workspace.path, "token=changed-path-secret.txt"), "failed\n");
    const diagnostics = new FinalVerificationDiagnosticsArchive({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      workspaceManager: fixture.workspace,
    });
    const archivedPath = await diagnostics.persist(diagnosticsInput(fixture));
    const archived = readFileSync(archivedPath, "utf8");
    assert.doesNotMatch(archived, /changed-path-secret/);
    assert.match(archived, /\[REDACTED\]/);
    await fixture.workspace.cleanup();
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
      diagnostics,
    });
    const result = await cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) });
    assert.equal(result.diagnosticsPath, archivedPath);
    assert.equal(existsSync(fixture.workspace.path), false);
    assert.deepEqual(
      await cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) }),
      result,
    );
  } finally { await closeFixture(fixture); }
});

test("restart repairs a legacy unsafe diagnostics archive after its cleanup receipt was rejected", async () => {
  const fixture = await createFixture("legacy-archive-repair");
  try {
    await fixture.workspace.create();
    const diagnostics = new FinalVerificationDiagnosticsArchive({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      workspaceManager: fixture.workspace,
    });
    const archivedPath = await diagnostics.persist(diagnosticsInput(fixture));
    const legacyArchive = JSON.parse(readFileSync(archivedPath, "utf8")) as Record<string, unknown>;
    writeFileSync(archivedPath, `${JSON.stringify({
      ...legacyArchive,
      changedPaths: [
        "access_token=legacy-access-token-secret.txt",
        "client_secret=legacy-client-secret.txt",
        ...Array.from({ length: 205 }, (_, index) => `generated-${index}.txt`),
      ],
      logs: [
        '{"access_token":"legacy-json-access-secret","clientSecret":"legacy-json-client-secret"}',
        'legacy fragment "private_key":"legacy-json-private-secret"',
        'legacy fragment "access_token":["legacy-json-array-secret"]',
        `${"{".repeat(65)} legacy fragment "clientSecret":{"value":"legacy-json-late-secret"}`,
      ],
    }, null, 2)}\n`);

    await fixture.workspace.cleanup();
    const receiptDirectory = join(
      fixture.state,
      "builds",
      safeSegment(fixture.runId),
      "audit",
      "final-verification-cleanup",
    );
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(join(receiptDirectory, `${safeSegment("generation-1")}.json`), JSON.stringify({
      version: 1,
      kind: "final-verification-cleanup-receipt",
      runId: fixture.runId,
      generationId: "generation-1",
      taskId: "final-verification-1",
      targetRevision: fixture.integration.revision,
      diagnosticsPath: archivedPath,
    }));
    const receiptIdentity = {
      runId: fixture.runId,
      ...cleanupIdentity(fixture),
      diagnosticsPath: archivedPath,
      requiresDiagnostics: true,
    };
    assert.throws(
      () => validateOwnedFinalVerificationCleanupReceipt(fixture.state, receiptIdentity),
      /unsafe|unbounded/i,
    );

    const restartedCleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { throw new Error("receipt recovery must not quiesce twice"); },
      closeBrowserRun: async () => { throw new Error("receipt recovery must not quiesce twice"); },
      workspaceManager: fixture.workspace,
      diagnostics: new FinalVerificationDiagnosticsArchive({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        workspaceManager: fixture.workspace,
      }),
    });
    const cleanupInput = { ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) };
    const recovered = await restartedCleanup.cleanup(cleanupInput);
    assert.deepEqual(recovered, { diagnosticsPath: archivedPath });
    assert.equal(existsSync(fixture.workspace.path), false);
    const repairedText = readFileSync(archivedPath, "utf8");
    assert.doesNotMatch(
      repairedText,
      /legacy-access-token-secret|legacy-client-secret|legacy-json-access-secret|legacy-json-client-secret|legacy-json-private-secret|legacy-json-array-secret|legacy-json-late-secret/,
    );
    assert.match(repairedText, /\[REDACTED\]/);
    const repaired = JSON.parse(repairedText) as { changedPaths: string[] };
    assert.equal(repaired.changedPaths.length, 200);
    assert.doesNotThrow(
      () => validateOwnedFinalVerificationCleanupReceipt(fixture.state, receiptIdentity),
    );
    assert.deepEqual(await restartedCleanup.cleanup(cleanupInput), recovered);
  } finally { await closeFixture(fixture); }
});

test("an existing diagnostics archive cannot be rebound to different failure facts", async () => {
  const fixture = await createFixture("archive-rebind");
  try {
    await fixture.workspace.create();
    const diagnostics = new FinalVerificationDiagnosticsArchive({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      workspaceManager: fixture.workspace,
    });
    await diagnostics.persist(diagnosticsInput(fixture));
    await fixture.workspace.cleanup();
    await assert.rejects(
      diagnostics.persist({ ...diagnosticsInput(fixture), logs: ["different failure"] }),
      /archive.*conflict|failure facts/i,
    );
  } finally { await closeFixture(fixture); }
});

test("a forged cleanup receipt cannot inject an unowned diagnostics path", async () => {
  const fixture = await createFixture("forged-receipt");
  try {
    await fixture.workspace.create();
    const receiptDirectory = join(
      fixture.state,
      "builds",
      safeSegment(fixture.runId),
      "audit",
      "final-verification-cleanup",
    );
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(join(receiptDirectory, `${safeSegment("generation-1")}.json`), JSON.stringify({
      version: 1,
      kind: "final-verification-cleanup-receipt",
      runId: fixture.runId,
      generationId: "generation-1",
      taskId: "final-verification-1",
      targetRevision: fixture.integration.revision,
      diagnosticsPath: join(fixture.root, "attacker-controlled.json"),
    }));
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
      diagnostics: new FinalVerificationDiagnosticsArchive({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        workspaceManager: fixture.workspace,
      }),
    });
    await assert.rejects(
      cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) }),
      /diagnostics.*owned|receipt.*diagnostics/i,
    );
    assert.equal(existsSync(fixture.workspace.path), true);
  } finally { await closeFixture(fixture); }
});

test("diagnostics failure retains verification workspace", async () => {
  const fixture = await createFixture("diagnostic-failure");
  try {
    const workspace = await fixture.workspace.create();
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
      diagnostics: { persist: async () => { throw new Error("audit disk unavailable"); } },
    });
    await assert.rejects(cleanup.cleanup({ ...cleanupIdentity(fixture), failed: diagnosticsInput(fixture) }), /audit disk unavailable/);
    assert.equal(existsSync(workspace.path), true);
  } finally { await closeFixture(fixture); }
});

test("process stop failure never falls through to workspace removal", async () => {
  const fixture = await createFixture("process-failure");
  try {
    const workspace = await fixture.workspace.create();
    let browserClosed = false;
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { throw new Error("authenticated stop failed"); },
      closeBrowserRun: async () => { browserClosed = true; },
      workspaceManager: fixture.workspace,
    });
    await assert.rejects(cleanup.cleanup(cleanupIdentity(fixture)), /authenticated stop failed/);
    assert.equal(browserClosed, true);
    assert.equal(existsSync(workspace.path), true);
  } finally { await closeFixture(fixture); }
});

test("wrong workspace ownership refuses deletion and successful cleanup is idempotent", async () => {
  const fixture = await createFixture("owner-idempotent");
  try {
    const workspace = await fixture.workspace.create();
    const metadata = JSON.parse(readFileSync(workspace.metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(workspace.metadataPath, JSON.stringify({ ...metadata, runId: "foreign-run" }));
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => undefined,
      closeBrowserRun: async () => undefined,
      workspaceManager: fixture.workspace,
    });
    await assert.rejects(cleanup.cleanup(cleanupIdentity(fixture)), /ownership|does not match/i);
    assert.equal(existsSync(workspace.path), true);
    writeFileSync(workspace.metadataPath, JSON.stringify(metadata));
    await cleanup.cleanup(cleanupIdentity(fixture));
    await cleanup.cleanup(cleanupIdentity(fixture));
    assert.equal(existsSync(workspace.path), false);
  } finally { await closeFixture(fixture); }
});

test("later generation cleanup is not skipped and quiesce preserves its workspace", async () => {
  const fixture = await createFixture("multiple-generations");
  try {
    const first = await fixture.workspace.create();
    const calls: string[] = [];
    const cleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state,
      runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
    });
    await cleanup.cleanup(cleanupIdentity(fixture));
    assert.equal(existsSync(first.path), false);
    const reopened = new OwnedFinalVerificationCleanup({
      stateDirectory: fixture.state, runId: fixture.runId,
      stopRun: async () => { calls.push("process"); },
      closeBrowserRun: async () => { calls.push("browser"); },
      workspaceManager: fixture.workspace,
    });
    await reopened.cleanup(cleanupIdentity(fixture));
    assert.deepEqual(calls, ["process", "browser"]);
    const second = await fixture.workspace.create();
    await cleanup.quiesceRun();
    assert.equal(existsSync(second.path), true);
    await cleanup.cleanup({ ...cleanupIdentity(fixture), generationId: "generation-2", taskId: "verification-2" });
    assert.equal(existsSync(second.path), false);
    assert.deepEqual(calls, ["process", "browser", "process", "browser", "process", "browser"]);
  } finally { await closeFixture(fixture); }
});

function diagnosticsInput(fixture: Fixture) {
  return {
    generationId: "generation-1",
    taskId: "final-verification-1",
    targetRevision: fixture.integration.revision,
    checks: [{ category: "tests", green: false, evidenceReferences: ["evidence-1"] }],
    evidenceReferences: ["evidence-1"],
    logs: ["token=super-secret", "test failed"],
  };
}
function cleanupIdentity(fixture: Fixture) {
  return { generationId: "generation-1", taskId: "final-verification-1", targetRevision: fixture.integration.revision };
}
function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

interface Fixture { root: string; project: string; state: string; runId: string; integration: IntegrationManager; workspace: VerificationWorkspaceManager }
async function createFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-fv-cleanup-${name}-`));
  const project = join(root, "project");
  const state = join(root, "runner-state");
  mkdirSync(project, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run-${name}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  const workspace = new VerificationWorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId, integrationManager: integration });
  return { root, project, state, runId, integration, workspace };
}
async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.workspace.cleanup().catch(() => undefined);
  await fixture.integration.cleanup().catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}
