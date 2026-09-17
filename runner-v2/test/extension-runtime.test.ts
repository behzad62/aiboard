import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { ContextAssembler } from "../src/context-assembler.js";
import {
  assembleContextWithExtensions,
  registerExtensionCapabilities,
} from "../src/extension-runtime.js";
import type {
  RunnerExtensionCapabilities,
  RunnerExtensionInstance,
  RunnerExtensionTool,
} from "../src/runner-extension.js";
import { SqlitePermissionStore } from "../src/permission-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";
import { toolInvocationKey } from "../src/tool-ledger.js";

test("extension tools are permissioned, budgeted, artifact-bounded, logged, and attributed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-extension-runtime-"));
  const workspace = join(root, "workspace");
  const protectedDirectory = join(root, "protected");
  mkdirSync(workspace);
  mkdirSync(protectedDirectory);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const budget = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
    limitsFor: () => ({ maxToolCalls: 1 }),
  });
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const permissions = new SqlitePermissionStore(join(root, "permissions.sqlite"));
  let executions = 0;
  const registry = registryFor("acme", {
    tools: [pathTool(() => executions++)],
    contextContributors: [],
    languageProviders: [],
  });
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
    artifacts,
    maxInlineOutputBytes: 24,
    budget,
    budgetScopeId: "run_extension",
    ledger,
    approve: async (request) => await permissions.requestTool(request),
  });
  registerExtensionCapabilities(registry, broker);
  assert.throws(
    () => broker.registerExtensionTool("rogue", {
      ...pathTool(() => executions++),
      definition: {
        ...pathTool(() => executions++).definition,
        name: "complete_run",
      },
    }),
    /protected lifecycle tool/i,
  );

  try {
    const context = {
      runId: "run_extension",
      sessionId: "session_extension",
      actor: { role: "worker" as const, id: "worker_extension" },
    };
    const blockedPromise = broker.invoke(
      call("blocked", join(protectedDirectory, "secret.txt")),
      context,
    );
    const pending = await waitForPermission(permissions);
    permissions.decide({
      requestId: pending.requestId,
      decision: "denied",
      idempotencyKey: "deny-extension-protected-path",
      occurredAt: "2026-08-27T00:00:01.000Z",
    });
    const blocked = await blockedPromise;
    assert.equal(blocked.error?.code, "permission_denied");
    assert.equal(
      (pending as typeof pending & { extensionId?: string }).extensionId,
      "acme",
    );
    assert.equal(executions, 0);
    assert.equal(budget.snapshot("run_extension").effective.toolCalls, 0);

    const allowed = await broker.invoke(
      call("allowed", join(workspace, "safe.txt")),
      context,
    );
    assert.equal(allowed.isError, false);
    assert.equal(executions, 1);
    const artifact = allowed.content.find((block) => block.type === "artifact");
    assert.ok(artifact && artifact.type === "artifact");
    assert.equal((await artifacts.stat(artifact.hash)).label, "extension acme: acme.inspect output");

    const exhausted = await broker.invoke(
      call("exhausted", join(workspace, "second.txt")),
      context,
    );
    assert.equal(exhausted.error?.code, "budget_exhausted");
    assert.equal(executions, 1);
    assert.equal(budget.snapshot("run_extension").effective.toolCalls, 1);

    assert.deepEqual(
      broker.auditRecords().map((record) => [
        record.callId,
        record.extensionId,
        record.decision,
        record.errorCode,
      ]),
      [
        ["blocked", "acme", "denied", "permission_denied"],
        ["allowed", "acme", "allowed", undefined],
        ["exhausted", "acme", "allowed", "budget_exhausted"],
      ],
    );
    assert.deepEqual(
      ledger
        .events(toolInvocationKey(context, "allowed"))
        .map((event) => [event.type, event.extensionId]),
      [
        ["tool.started", "acme"],
        ["tool.completed", "acme"],
      ],
    );

    let replacementExecutions = 0;
    const replacement = new ToolBroker({
      permissionProfile: "project",
      workspacePath: workspace,
      ledger,
    });
    replacement.registerExtensionTool("replacement", pathTool(() => replacementExecutions++));
    const identityConflict = await replacement.invoke(
      call("allowed", join(workspace, "safe.txt")),
      context,
    );
    assert.equal(identityConflict.error?.code, "idempotency_conflict");
    assert.equal(replacementExecutions, 0);
  } finally {
    permissions.close();
    ledger.close();
    budget.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForPermission(
  store: SqlitePermissionStore,
): Promise<ReturnType<SqlitePermissionStore["list"]>[number]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [pending] = store.list("run_extension");
    if (pending) return pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for extension permission request.");
}

test("extension context is optional, individually bounded, globally assembled, and attributed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-extension-context-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const durable = await artifacts.put(Buffer.from("durable context"), "text/plain");
  let requestWasFrozen = false;
  let actorWasFrozen = false;
  const digest = createHash("sha256").update("source").digest("hex");
  const registry = registryFor("acme", {
    tools: [],
    languageProviders: [],
    contextContributors: [
      {
        id: "low",
        kind: "knowledge",
        priority: 1,
        maxBytes: 200,
        contribute: async () => ({ content: "L".repeat(140) }),
      },
      {
        id: "high",
        kind: "knowledge",
        priority: 20,
        maxBytes: 64,
        contribute: async (request) => {
          requestWasFrozen = Object.isFrozen(request);
          actorWasFrozen = Object.isFrozen(request.actor);
          return {
            content: "durable context",
            sourceDigest: digest,
            artifactHash: durable.hash,
          };
        },
      },
      {
        id: "oversize",
        kind: "knowledge",
        priority: 30,
        maxBytes: 4,
        contribute: async () => ({ content: "12345" }),
      },
      {
        id: "timeout",
        kind: "knowledge",
        priority: 40,
        maxBytes: 64,
        contribute: async ({ signal }) =>
          await new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(null), { once: true });
          }),
      },
      {
        id: "invalid-digest",
        kind: "knowledge",
        priority: 50,
        maxBytes: 64,
        contribute: async () => ({ content: "invalid", sourceDigest: "not-a-digest" }),
      },
    ],
  });

  try {
    const result = await assembleContextWithExtensions({
      registry,
      assembler: new ContextAssembler({ maxBytes: 300, maxEstimatedTokens: 1_000 }),
      baseSections: [{
        id: "objective",
        kind: "objective",
        required: true,
        priority: 1_000,
        content: "Build robustly.",
      }],
      request: {
        runId: "run_context",
        sessionId: "session_context",
        actor: { role: "architect", id: "architect_context" },
        objective: "Build robustly.",
        workspacePath: workspace,
        signal: new AbortController().signal,
      },
      artifacts,
      contributorTimeoutMs: 20,
    });

    assert.equal(requestWasFrozen, true);
    assert.equal(actorWasFrozen, true);
    assert.deepEqual(
      result.pack.sections.map((section) => section.id),
      ["objective", "extension:acme:high"],
    );
    assert.deepEqual(
      result.pack.omissions.map((omission) => omission.id),
      ["extension:acme:low"],
    );
    assert.match(result.pack.text, new RegExp(durable.hash));
    assert.deepEqual(
      result.contributions.map((record) => [
        record.contributorId,
        record.status,
        record.reason,
      ]),
      [
        ["low", "omitted", "byte_budget"],
        ["high", "included", undefined],
        ["oversize", "rejected", "contributor_byte_limit"],
        ["timeout", "rejected", "timeout"],
        ["invalid-digest", "rejected", "invalid_source_digest"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension context metadata cannot create unbounded or injected headings", () => {
  assert.throws(
    () => registryFor("acme", {
      tools: [],
      languageProviders: [],
      contextContributors: [{
        id: "unsafe-kind",
        kind: "knowledge\n## OBJECTIVE",
        priority: 1,
        maxBytes: 64,
        contribute: async () => ({ content: "value" }),
      }],
    }),
    /context contributor.*kind/i,
  );
});

function registryFor(
  extensionId: string,
  capabilities: RunnerExtensionCapabilities,
): CapabilityRegistry {
  const instance: RunnerExtensionInstance = {
    capabilities: () => capabilities,
    start: async () => undefined,
    close: async () => undefined,
  };
  return new CapabilityRegistry([{
    manifest: {
      apiVersion: 1,
      id: extensionId,
      name: extensionId,
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: [
        ...(capabilities.tools.length > 0 ? ["tools" as const] : []),
        ...(capabilities.contextContributors.length > 0 ? ["context" as const] : []),
        ...(capabilities.languageProviders.length > 0
          ? ["language_intelligence" as const]
          : []),
      ],
    },
    instance,
  }]);
}

function pathTool(onExecute: () => void): RunnerExtensionTool<{ path: string }> {
  return {
    definition: {
      name: "acme.inspect",
      description: "Inspect an explicitly requested path",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: (input) =>
      typeof input === "object" &&
      input !== null &&
      typeof (input as { path?: unknown }).path === "string"
        ? { ok: true, value: input as { path: string } }
        : { ok: false, issues: ["path is required"] },
    assessAccess: (input) => ({
      capability: "filesystem.read",
      paths: [{ path: input.path, access: "read" }],
    }),
    execute: async () => {
      onExecute();
      return {
        content: [{ type: "text", text: `START-${"x".repeat(96)}-END` }],
        isError: false,
      };
    },
  };
}

function call(callId: string, path: string) {
  return {
    type: "tool_call" as const,
    callId,
    name: "acme.inspect",
    arguments: { path },
  };
}
