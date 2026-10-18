import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { BuildRuntimeRegistry } from "../src/build-runtime-registry.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";

test("visual user-message HTTP endpoint authenticates, routes real media, persists evidence, and does not mutate on ask", async () => {
  const directory = mkdtempSync(join(tmpdir(), "visual-http-route-"));
  const token = "visual-test-token";
  const runId = "visual-run";
  const mockBodies: Array<Record<string, unknown>> = [];
  const modelService = createServer((req, res) => {
    void (async () => {
      let text = "";
      for await (const chunk of req) text += chunk.toString();
      const body = JSON.parse(text) as Record<string, unknown>;
      mockBodies.push(body);
      const system = String(body.system ?? "");
      const last = (body.messages as Array<Record<string, unknown>>).at(-1)!;
      const payload = JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: system.includes("Categorize a message")
          ? JSON.stringify({ intent: JSON.stringify(last.content).includes("Fix") ? "change" : "ask" })
          : system.includes("Describe user-supplied") ? "HTTP 500 is visible in the screenshot." : "The attached document contains test evidence." }],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    })().catch((error: unknown) => { res.statusCode = 500; res.end(String(error)); });
  });
  await new Promise<void>((resolve) => modelService.listen(0, "127.0.0.1", resolve));
  const mockAddress = modelService.address();
  assert.ok(mockAddress && typeof mockAddress === "object");
  const provider: RunnerProviderConfig = {
    runtimeId: "vision-architect",
    providerId: "anthropic",
    modelId: "claude-vision-test",
    transport: "anthropic",
    baseUrl: `http://127.0.0.1:${mockAddress.port}`,
    secret: "not-real",
    capabilities: ["*"],
    inputCapabilities: { image: true, document: true, audio: false, video: false },
    priority: 0,
  };
  const textOnly = { ...provider, runtimeId: "text-only-architect", inputCapabilities: { image: false, document: false, audio: false, video: false }, priority: 0 };
  const visionFallback = { ...provider, priority: 1 };
  let availableProviders: RunnerProviderConfig[] = [textOnly, visionFallback];
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  const scheduler = new SqliteSchedulerStore(join(directory, "scheduler.sqlite"));
  const runtime = new BuildRuntime({
    runId, initialObjective: "Build an auth screen", store: scheduler,
    workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
    architectDriver: { run: async () => undefined },
    integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }) },
    maxConcurrency: 1, workspaceFor: async () => directory,
  });
  const registry = new BuildRuntimeRegistry();
  registry.register(runtime);
  const spec = { runId, projectId: "fixture", objective: "Build an auth screen", architectRuntimeId: textOnly.runtimeId } as NativeBuildSpec;
  const server = new ControlServer({
    token, supervisor, builds: registry,
    buildProvisioner: { create: async () => ({}), listSpecs: () => [spec] },
    providerConfigs: { load: () => availableProviders, save: () => {}, close: () => {} },
    userMediaDirectory: join(directory, "user-input-media"),
    runnerInfo: { projectPath: directory, nodeVersion: process.versions.node },
    bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/baseline" }),
  });
  const image = {
    filename: "error.png", mimeType: "image/png",
    base64Data: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString("base64"),
  };
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const address = await server.start(0);
    const url = `${address.url}/v2/runs/${runId}/build/user-message`;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    const submit = async (value: object) => {
      const reply = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify(value) });
      return { status: reply.status, payload: (await reply.json()) as Record<string, unknown> };
    };
    const bad = await submit({ text: "Inspect this", messageId: "invalid", attachments: [{ ...image, mimeType: "application/pdf" }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.payload.code, "invalid_attachment");
    const before = scheduler.readRun(runId).length;
    const answer = await submit({ text: "What is this?", messageId: "ask1", attachments: [image] });
    assert.equal(answer.status, 200, JSON.stringify(answer.payload));
    assert.equal(answer.payload.intent, "ask");
    assert.match(String(answer.payload.reply), /document contains test evidence/);
    assert.equal(scheduler.readRun(runId).length, before, "Ask must not alter scheduler");
    const pdf = { filename: "requirements.pdf", mimeType: "application/pdf", base64Data: Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n").toString("base64") };
    const documentReply = await submit({ text: "What does this PDF describe?", messageId: "ask-pdf", attachments: [pdf] });
    assert.equal(documentReply.status, 200, JSON.stringify(documentReply.payload));
    assert.equal(documentReply.payload.intent, "ask");
    const lastPdfRequest = mockBodies.at(-1)!;
    const lastPdfBlocks = (lastPdfRequest.messages as Array<Record<string, unknown>>).at(-1)!.content as Array<Record<string, unknown>>;
    assert.ok(lastPdfBlocks.some((block) => block.type === "document"), "PDF must be delivered to the model");
    const change = await submit({ text: "Fix the screenshot error", messageId: "change1", attachments: [image] });
    assert.equal(change.status, 200, JSON.stringify(change.payload));
    assert.equal(change.payload.intent, "change");
    assert.match(String(change.payload.visualEvidence), /HTTP 500/);
    assert.match(String(change.payload.visualEvidence), /sha256:/);
    assert.match(String(change.payload.visualEvidence), /AIBOARD_USER_MEDIA:[a-f0-9]{64}:[a-f0-9]{64}/);
    assert.equal((change.payload.attachments as unknown[]).length, 1);
    assert.equal(scheduler.readRun(runId).length, before, "Routing itself must not submit guidance");
    assert.equal(mockBodies.length, 6, "Image Ask + PDF Ask + image Change each use classification and a response call");
    availableProviders = [textOnly];
    const unsupported = await submit({ text: "Inspect screenshot", messageId: "no-compatible-model", attachments: [image] });
    assert.equal(unsupported.status, 422);
    assert.equal(unsupported.payload.code, "model_media_unsupported");
    for (const body of mockBodies) {
      const last = (body.messages as Array<Record<string, unknown>>).at(-1)!;
      const blocks = last.content as Array<Record<string, unknown>>;
      assert.ok(blocks.some((block) => block.type === "image" || block.type === "document"), "Every model call receives original visual input");
    }
  } finally {
    await server.close();
    supervisor.close();
    scheduler.close();
    await new Promise<void>((resolve) => modelService.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
