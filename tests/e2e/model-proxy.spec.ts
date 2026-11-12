/**
 * Browser model calls through the Runner's model proxy (Simple Build plan §9, packet HM4a).
 *
 * A real browser on the dev origin, a real Runner (ControlServer + ModelProxy + an AIBoard home in a
 * temp folder) and a stub upstream that stands in for OpenAI, Anthropic and Google:
 * - one streamed call per provider SDK completes through the proxy, with the home's key added there;
 * - with two tabs and four parallel run streams holding six proxy streams open, an approval and a cancel
 *   on the control port still go through at once, and the page's own Stop reaches the upstream.
 *
 * Stub keys and a stub upstream only; no live provider call.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAiboardHome } from "../../runner-v2/src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHomeSync } from "../../runner-v2/src/aiboard-home-store.js";
import { ControlServer } from "../../runner-v2/src/control-server.js";
import { HomeBackedProviderConfigStore } from "../../runner-v2/src/home-provider-configs.js";
import { createLocalPairTicket, LocalPairing } from "../../runner-v2/src/local-pairing.js";
import { ModelProxy } from "../../runner-v2/src/model-proxy.js";
import { SqlitePermissionStore } from "../../runner-v2/src/permission-store.js";
import { validateProviderConfigs, type ProviderConfigStore, type RunnerProviderConfig } from "../../runner-v2/src/provider-config-store.js";
import { RunSupervisor } from "../../runner-v2/src/run-supervisor.js";
import { SqliteEventStore } from "../../runner-v2/src/sqlite-event-store.js";

const OPENAI_KEY = "sk-e2e-stub-openai-0123456789abcdef";
const ANTHROPIC_KEY = "sk-ant-e2e-stub-0123456789abcdef";
const GOOGLE_KEY = "AIzaE2EStub0123456789abcdefghijk";
const CONTROL_TOKEN = "model-proxy-e2e-control-token";
const INSTANCE = "model-proxy-e2e";
const NOW = "2026-11-12T00:00:00.000Z";

interface UpstreamRequest { method: string; url: string; headers: IncomingMessage["headers"]; body: string; closed: boolean }

/** OpenAI (Responses API), Anthropic (Messages) and Google (Interactions API, which Gemini chat uses), streamed as SSE. */
class StubUpstream {
  readonly requests: UpstreamRequest[] = [];
  private readonly held: Array<() => void> = [];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  get base(): string { return `http://127.0.0.1:${this.port}`; }
  holding(): number { return this.held.length; }
  releaseAll(): void { for (const release of this.held.splice(0)) release(); }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of request) body += chunk;
    const record: UpstreamRequest = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body, closed: false };
    this.requests.push(record);
    response.on("close", () => { record.closed = true; });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: string | null, data: unknown) => response.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    const model = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? /models\/([^:]+):/.exec(record.url)?.[1] ?? "";
    const hold = model.includes("hold");
    const text = hold ? `${model} finished` : `${model} streamed ok`;
    if (record.url.startsWith("/v1/responses")) {
      send("response.created", { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } });
      if (hold) await new Promise<void>((resolve) => this.held.push(resolve));
      if (response.writableEnded || record.closed) return;
      send("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: text });
      send("response.completed", { type: "response.completed", response: { id: "resp", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
    } else if (record.url.startsWith("/v1/messages")) {
      send("message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
      send("message_stop", { type: "message_stop" });
    } else if (record.url.startsWith("/v1beta/interactions")) {
      send(null, { event_type: "step.delta", delta: { type: "text", text } });
      send(null, { event_type: "interaction.completed", interaction: { usage: { total_input_tokens: 5, total_output_tokens: 3 } } });
    } else if (record.url.includes(":streamGenerateContent")) {
      send(null, { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } });
    } else {
      send(null, { error: `unexpected ${record.method} ${record.url}` });
    }
    response.end();
  }

  async close(): Promise<void> {
    this.releaseAll();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function providerRow(providerId: string, enabledModelIds: string[]) {
  return {
    providerId, baseURL: null, runnerToken: null, models: [], enabledModelIds, defaultModel: enabledModelIds[0] ?? null,
    enabled: true, keyHint: null, lastValidationSucceeded: null, lastValidatedAt: null, updatedAt: NOW,
  };
}

function discussion(id: string, mode: "chat", topic: string, modelIds: string[]) {
  return {
    id, topic, mode, effort: "low", status: "pending", modelIds: JSON.stringify(modelIds), judgeModelId: null, reviewerModelId: null,
    attachmentIds: null, projectFolderName: null, runnerUrl: null, runnerToken: null, runnerAccess: null, currentRound: 0,
    maxRounds: 0, convergenceScore: null, verbosity: "balanced", styleNote: "", reasoningEffort: "default",
    createdAt: NOW, updatedAt: NOW,
  };
}

// Two tabs, plus four streams in flight at once: the load a four-model certified run puts on the page.
// (The Models preset now runs ToolBench in Runner processes, and a panel round streams one model at a
// time, so four further chat tabs stand in for the run's four parallel streams.)
const RUN_HOLD_MODELS = ["gpt-hold-run-1", "gpt-hold-run-2", "gpt-hold-run-3", "gpt-hold-run-4"];
const HOLD_MODELS = ["gpt-hold-tab-a", "gpt-hold-tab-b", ...RUN_HOLD_MODELS];

/** The browser store: provider rows (no keys; the keys live in the home) and the discussions. */
async function seedStore(page: Page): Promise<void> {
  const store = {
    discussions: [
      discussion("chat-openai", "chat", "Say hello from OpenAI.", ["openai:gpt-5.5"]),
      discussion("chat-anthropic", "chat", "Say hello from Anthropic.", ["anthropic:claude-sonnet-4-6"]),
      discussion("chat-google", "chat", "Say hello from Google.", ["google:gemini-2.5-flash"]),
      discussion("chat-hold-a", "chat", "Hold this stream in tab A.", ["openai:gpt-hold-tab-a"]),
      discussion("chat-hold-b", "chat", "Hold this stream in tab B.", ["openai:gpt-hold-tab-b"]),
      ...RUN_HOLD_MODELS.map((model) => discussion(`chat-${model}`, "chat", `Hold the ${model} stream.`, [`openai:${model}`])),
    ],
    messages: [], finalResults: [], attachments: [], buildFiles: [], buildCheckpoints: [], contextBlobs: [], buildMemories: [],
    providerKeys: [
      providerRow("openai", ["gpt-5.5", ...HOLD_MODELS]),
      providerRow("anthropic", ["claude-sonnet-4-6"]),
      providerRow("google", ["gemini-2.5-flash"]),
    ],
    customModels: [], modelStats: [],
  };
  await page.evaluate(async (seed) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ai-discussion-board", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("kv")) request.result.createObjectStore("kv");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("kv", "readwrite");
        transaction.objectStore("kv").put(JSON.stringify({ v: 1, encrypted: false, data: JSON.stringify(seed) }), "store");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
  }, store);
}

/** Every tab gets the launcher's session in its own sessionStorage, as the pairing link would leave it. */
async function launcherSession(context: BrowserContext, port: number, sessionToken: string): Promise<void> {
  await context.addInitScript((session) => {
    sessionStorage.setItem("aiboard:local-runner-session:v1", JSON.stringify(session));
  }, { port, instanceId: INSTANCE, kind: "runner", sessionToken });
}

test.describe("HM4a: browser model calls through the model proxy", () => {
  test.setTimeout(240_000);

  test("each provider SDK streams through the proxy; an approval and a cancel go through while six streams are held", async ({ browser }) => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-model-proxy-e2e-"));
    const userHome = join(root, "user");
    mkdirSync(userHome, { recursive: true });
    const location = resolveAiboardHome({
      platform: process.platform,
      environment: { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") },
      home: userHome,
    });
    const upstream = new StubUpstream();
    await upstream.start();
    await applyHomeBatch(location, {
      baseRevision: 0,
      ops: [
        { path: "providers.openai", op: "set", value: { enabled: true, baseUrl: `${upstream.base}/v1` } },
        { path: "credentials.providers.openai", op: "set", value: { secret: OPENAI_KEY } },
        { path: "providers.anthropic", op: "set", value: { enabled: true, baseUrl: upstream.base } },
        { path: "credentials.providers.anthropic", op: "set", value: { secret: ANTHROPIC_KEY } },
        { path: "providers.google", op: "set", value: { enabled: true, baseUrl: upstream.base } },
        { path: "credentials.providers.google", op: "set", value: { secret: GOOGLE_KEY } },
      ],
    });
    const proxy = new ModelProxy({ home: location });
    await proxy.start(0);
    const pairing = new LocalPairing(INSTANCE);
    const permissions = new SqlitePermissionStore(join(root, "permissions.sqlite"));
    const stopped: string[] = [];
    const configs = { current: [] as RunnerProviderConfig[] };
    const inner: ProviderConfigStore = {
      load: () => configs.current.map((config) => ({ ...config })),
      save: (next) => { validateProviderConfigs(next); configs.current = next.map((config) => ({ ...config })); },
      close: () => undefined,
    };
    const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
    const server = new ControlServer({
      supervisor,
      token: CONTROL_TOKEN,
      bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/e2e" }),
      runnerInfo: { projectPath: root, nodeVersion: process.versions.node },
      providerConfigs: new HomeBackedProviderConfigStore(inner, () => readAiboardHomeSync(location)),
      localPairing: pairing,
      home: location,
      modelProxy: proxy,
      permissions,
      // The cancel this test sends: a ToolBench stop on the control port.
      toolBench: {
        start: async () => { throw new Error("unused"); },
        get: async () => { throw new Error("unused"); },
        stop: async (sessionId: string) => { stopped.push(sessionId); return { sessionId, status: "cancelled" }; },
        close: async () => {},
      } as unknown as ConstructorParameters<typeof ControlServer>[0]["toolBench"],
    });
    const address = await server.start(0);
    const ticket = createLocalPairTicket(INSTANCE);
    pairing.register(ticket.digest);
    const sessionToken = pairing.consume(ticket.code)!;

    const context = await browser.newContext();
    try {
      await launcherSession(context, address.port, sessionToken);
      const tabA = await context.newPage();
      await tabA.goto("/");
      await seedStore(tabA);

      // ---- one streamed call per provider SDK (OpenAI, Anthropic, Google)
      for (const [id, text] of [
        ["chat-openai", "gpt-5.5 streamed ok"],
        ["chat-anthropic", "claude-sonnet-4-6 streamed ok"],
        ["chat-google", "gemini-2.5-flash streamed ok"],
      ] as const) {
        await tabA.goto(`/discussion?id=${id}`);
        await expect(tabA.getByText(text).first()).toBeVisible({ timeout: 60_000 });
      }
      const sdkCalls = upstream.requests.slice(0, 3);
      expect(sdkCalls.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST /v1/responses",
        "POST /v1/messages",
        "POST /v1beta/interactions",
      ]);
      expect(sdkCalls[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
      expect(sdkCalls[1]!.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
      expect(sdkCalls[2]!.headers["x-goog-api-key"]).toBe(GOOGLE_KEY);
      for (const request of sdkCalls) {
        const sent = JSON.stringify(request.headers);
        expect(sent).not.toContain("proxy_");
        expect(sent).not.toContain(sessionToken);
        expect(request.headers.origin).toBeUndefined();
      }

      // ---- two tabs and four parallel run streams hold six proxy streams open
      const tabB = await context.newPage();
      await tabA.goto("/discussion?id=chat-hold-a");
      await tabB.goto("/discussion?id=chat-hold-b");
      const runTabs: Page[] = [];
      for (const model of RUN_HOLD_MODELS) {
        const tab = await context.newPage();
        await tab.goto(`/discussion?id=chat-${model}`);
        runTabs.push(tab);
      }
      await expect.poll(() => upstream.holding(), { timeout: 60_000 }).toBe(6);

      // An approval and a cancel on the control port go through at once: the proxy has its own port,
      // so the six held streams take none of the control port's connections.
      const pending = permissions.request({
        requestId: "perm-e2e", runId: "run-e2e", sessionId: "session-e2e", callId: "call-e2e", toolName: "shell",
        actor: { role: "worker", id: "worker-e2e" }, permissionProfile: "ask",
        access: { capability: "process.run", command: "npm test" } as never, outsideWorkspace: false, occurredAt: NOW,
      });
      const controlCalls = await tabA.evaluate(async ({ url, token }) => {
        const started = performance.now();
        const approval = await fetch(`${url}/v2/permissions/perm-e2e`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approved", idempotencyKey: "approve:perm-e2e" }),
        });
        const cancel = await fetch(`${url}/v2/toolbench-sessions/bench-e2e/stop`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        return { approval: approval.status, cancel: cancel.status, elapsedMs: performance.now() - started };
      }, { url: address.url, token: sessionToken });
      expect(controlCalls.approval).toBe(200);
      expect(controlCalls.cancel).toBe(200);
      expect(controlCalls.elapsedMs).toBeLessThan(5_000);
      await expect(Promise.resolve(pending)).resolves.toBe(true);
      expect(stopped).toEqual(["bench-e2e"]);
      expect(upstream.holding()).toBe(6);

      // The page's own Stop cancels one stream, and the abort reaches the upstream through the proxy.
      const stoppedModel = RUN_HOLD_MODELS[3]!;
      await runTabs[3]!.getByRole("button", { name: /stop/i }).first().click();
      const stoppedRequest = upstream.requests.find((request) => request.body.includes(stoppedModel));
      expect(stoppedRequest).toBeDefined();
      await expect.poll(() => stoppedRequest!.closed, { timeout: 30_000 }).toBe(true);

      // Released, the other five streams finish.
      upstream.releaseAll();
      await expect(tabA.getByText("gpt-hold-tab-a finished").first()).toBeVisible({ timeout: 30_000 });
      await expect(tabB.getByText("gpt-hold-tab-b finished").first()).toBeVisible({ timeout: 30_000 });
      for (const [index, model] of RUN_HOLD_MODELS.slice(0, 3).entries()) {
        await expect(runTabs[index]!.getByText(`${model} finished`).first()).toBeVisible({ timeout: 30_000 });
      }
      for (const request of upstream.requests) {
        expect(request.headers.authorization ?? request.headers["x-api-key"] ?? request.headers["x-goog-api-key"]).toBeDefined();
        expect(JSON.stringify(request.headers)).not.toContain("proxy_");
      }
    } finally {
      await context.close();
      await server.close();
      await upstream.close();
      permissions.close();
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
