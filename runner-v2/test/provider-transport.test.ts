import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { AccountRunnerModel, ProviderTransportError } from "../src/account-runner-model.js";
import { AnthropicModel } from "../src/anthropic-model.js";
import { EncryptedProviderConfigStore } from "../src/encrypted-provider-config-store.js";
import { GoogleModel } from "../src/google-model.js";
import {
  assertEnforceableBuildBudget,
  createProviderModel,
  providerCostEstimator,
  providerModelCostBasis,
} from "../src/native-build-factory.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { OpenAICompatibleModel } from "../src/openai-compatible-model.js";
import {
  resolvedProviderBillingBasis,
  validateProviderConfigs,
} from "../src/provider-config-store.js";
import { serializedInputUsage } from "../src/provider-model-utils.js";

test("provider configuration is encrypted at rest and rejects the wrong runner token", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-provider-config-"));
  const path = join(root, "providers.enc");
  try {
    let store = new EncryptedProviderConfigStore(path, "runner-token-secret");
    store.save([
      {
        runtimeId: "chatgpt:gpt-5.5",
        providerId: "chatgpt",
        modelId: "gpt-5.5",
        billingBasis: "account_not_metered",
        transport: "account-runner",
        baseUrl: "http://127.0.0.1:1455",
        secret: "account-runner-secret",
        capabilities: ["code"],
        priority: 1,
      },
    ]);
    store.close();
    const bytes = readFileSync(path);
    assert.equal(bytes.includes(Buffer.from("account-runner-secret")), false);
    assert.equal(bytes.includes(Buffer.from("gpt-5.5")), false);

    store = new EncryptedProviderConfigStore(path, "runner-token-secret");
    assert.equal(store.load()[0].secret, "account-runner-secret");
    assert.equal(store.load()[0].billingBasis, "account_not_metered");
    store.close();
    assert.throws(
      () => new EncryptedProviderConfigStore(path, "wrong-runner-token-secret").load(),
      /decrypt provider configuration/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider configuration rejects unknown transports and protocols before persistence", () => {
  const base = {
    runtimeId: "provider:model",
    providerId: "provider",
    modelId: "model",
    secret: "secret",
    capabilities: ["*"],
    priority: 1,
  };
  assert.throws(
    () => validateProviderConfigs([{ ...base, transport: "mystery" as "google" }]),
    /invalid transport/i
  );
  assert.throws(
    () => validateProviderConfigs([{
      ...base,
      transport: "openai-compatible",
      protocol: "legacy" as "responses",
    }]),
    /invalid protocol/i
  );
  assert.throws(
    () => validateProviderConfigs([{
      ...base,
      transport: "openai-compatible",
      inputCostMicrosPerMillion: -1,
    }]),
    /invalid pricing/i
  );
});

test("provider pricing converts token classes to integer microdollars", () => {
  const estimate = providerCostEstimator({
    runtimeId: "provider:model",
    providerId: "provider",
    modelId: "model",
    transport: "openai-compatible",
    baseUrl: "https://example.test/v1",
    secret: "secret",
    capabilities: ["*"],
    priority: 1,
    inputCostMicrosPerMillion: 2_500_000,
    cachedInputCostMicrosPerMillion: 250_000,
    cacheWriteInputCostMicrosPerMillion: 2_500_000,
    outputCostMicrosPerMillion: 15_000_000,
  });
  assert.equal(estimate!(1_000_000, 100_000, 600_000, 100_000), 2_650_000);
});

test("legacy provider configs infer billing conservatively", () => {
  assert.equal(resolvedProviderBillingBasis({
    transport: "account-runner",
    inputCostMicrosPerMillion: 1,
    outputCostMicrosPerMillion: 1,
  }), "api_priced");
  assert.equal(resolvedProviderBillingBasis({
    transport: "account-runner",
  }), "account_not_metered");
  assert.equal(resolvedProviderBillingBasis({
    transport: "anthropic",
  }), "unknown");
  assert.equal(resolvedProviderBillingBasis({
    billingBasis: "account_not_metered",
    transport: "account-runner",
    inputCostMicrosPerMillion: 1,
    outputCostMicrosPerMillion: 1,
  }), "account_not_metered");
});

test("explicit API billing fails closed without usable normal pricing", () => {
  const spec: NativeBuildSpec = {
    version: 1,
    runId: "run_spoofed_pricing",
    projectId: "project_spoofed_pricing",
    objective: "Reject spoofed pricing",
    architectRuntimeId: "proxy:model",
    workerRuntimeIds: ["proxy:model"],
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "budgeted",
    budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
    createdAt: "2026-07-13T00:00:00.000Z",
    idempotencyKey: "spec:spoofed-pricing",
  };
  const base = {
    runtimeId: "proxy:model",
    providerId: "proxy",
    modelId: "model",
    billingBasis: "api_priced" as const,
    transport: "account-runner" as const,
    baseUrl: "http://127.0.0.1:1455",
    secret: "secret",
    capabilities: ["*"],
    priority: 1,
  };
  const malformed = [
    base,
    { ...base, inputCostMicrosPerMillion: 1 },
    { ...base, outputCostMicrosPerMillion: 1 },
    { ...base, inputCostMicrosPerMillion: Number.NaN, outputCostMicrosPerMillion: 1 },
    { ...base, inputCostMicrosPerMillion: 1, outputCostMicrosPerMillion: Number.POSITIVE_INFINITY },
    { ...base, inputCostMicrosPerMillion: -1, outputCostMicrosPerMillion: 1 },
  ];
  for (const config of malformed) {
    assert.equal(resolvedProviderBillingBasis(config), "unknown");
    assert.equal(providerCostEstimator(config), undefined);
    assert.deepEqual(providerModelCostBasis(config), {
      kind: "unknown",
      billingBasis: "unknown",
    });
    assert.throws(
      () => assertEnforceableBuildBudget(spec, [config]),
      /proxy:model.*pricing.*time limit/i,
    );
    assert.throws(
      () => validateProviderConfigs([config]),
      /api-priced billing requires valid input and output pricing/i,
    );
  }
});

test("serialized input usage accepts only safe non-negative provider integers", () => {
  const body = JSON.stringify({ expanded: "delivered provider body" });
  const estimated = Math.ceil(Buffer.byteLength(body) / 4);
  for (const malformed of [null, "12", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(serializedInputUsage(body, malformed), {
      inputTokens: estimated,
      inputTokenSource: "estimated",
    });
  }
  assert.deepEqual(serializedInputUsage(body, 0), {
    inputTokens: 0,
    inputTokenSource: "reported",
  });
});

test("every native transport estimates malformed provider input from its delivered body", async () => {
  const request = { sessionId: "malformed", messages: [], tools: [] };
  const cases: Array<{
    name: string;
    body: () => string;
    complete: () => Promise<Awaited<ReturnType<OpenAICompatibleModel["complete"]>>>;
  }> = [];
  let accountBody = "";
  cases.push({
    name: "account",
    body: () => accountBody,
    complete: () => new AccountRunnerModel({
      baseUrl: "http://runner.test",
      runnerPath: "nvidia",
      runnerToken: "token",
      modelId: "model",
      fetch: async (_input, init) => {
        accountBody = String(init?.body);
        return new Response(
          `data: ${JSON.stringify({ type: "usage", usage: { inputTokens: "12" } })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    }).complete(request),
  });
  let openAiBody = "";
  cases.push({
    name: "openai",
    body: () => openAiBody,
    complete: () => new OpenAICompatibleModel({
      baseUrl: "https://api.test/v1",
      apiKey: "secret",
      modelId: "model",
      fetch: async (_input, init) => {
        openAiBody = String(init?.body);
        return Response.json({ choices: [{ message: {} }], usage: { prompt_tokens: null } });
      },
    }).complete(request),
  });
  let anthropicBody = "";
  cases.push({
    name: "anthropic",
    body: () => anthropicBody,
    complete: () => new AnthropicModel({
      apiKey: "secret",
      modelId: "model",
      fetch: async (_input, init) => {
        anthropicBody = String(init?.body);
        return Response.json({ content: [], usage: { input_tokens: -1 } });
      },
    }).complete(request),
  });
  let googleBody = "";
  cases.push({
    name: "google",
    body: () => googleBody,
    complete: () => new GoogleModel({
      apiKey: "secret",
      modelId: "model",
      fetch: async (_input, init) => {
        googleBody = String(init?.body);
        return Response.json({ candidates: [], usageMetadata: { promptTokenCount: 1.5 } });
      },
    }).complete(request),
  });

  for (const item of cases) {
    const turn = await item.complete();
    assert.deepEqual(turn.usage, {
      inputTokens: Math.ceil(Buffer.byteLength(item.body()) / 4),
      inputTokenSource: "estimated",
    }, item.name);
  }
});

test("metered account-runner proxy keeps API billing and immutable pricing", () => {
  const proxy = {
    runtimeId: "nvidia:model",
    providerId: "nvidia",
    modelId: "model",
    transport: "account-runner" as const,
    billingBasis: "api_priced" as const,
    baseUrl: "http://127.0.0.1:1455",
    secret: "api-key",
    runnerToken: "runner-token",
    capabilities: ["*"],
    priority: 1,
    inputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 8_000_000,
  };
  assert.equal(providerCostEstimator(proxy)!(1_000_000, 1_000_000), 10_000_000);
  assert.deepEqual(providerModelCostBasis(proxy), {
    kind: "api_estimate",
    billingBasis: "api_priced",
    inputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 8_000_000,
    cachedInputCostMicrosPerMillion: 2_000_000,
    cacheWriteInputCostMicrosPerMillion: 2_000_000,
  });
});

test("Runner rejects USD-only runs with any unpriced selectable runtime", () => {
  const spec: NativeBuildSpec = {
    version: 1,
    runId: "run_usd",
    projectId: "project",
    objective: "Enforce the configured budget.",
    architectRuntimeId: "api:priced",
    workerRuntimeIds: ["api:priced"],
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "budgeted",
    budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
    createdAt: "2026-07-13T00:00:00.000Z",
    idempotencyKey: "spec:usd",
  };
  const base = {
    providerId: "provider",
    modelId: "model",
    secret: "secret",
    capabilities: ["*"],
    priority: 1,
  };
  const priced = {
    ...base,
    runtimeId: "api:priced",
    transport: "openai-compatible" as const,
    baseUrl: "https://example.test/v1",
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
  };
  const account = {
    ...base,
    runtimeId: "account:model",
    transport: "account-runner" as const,
    baseUrl: "http://127.0.0.1:1455",
  };
  const meteredProxy = {
    ...account,
    runtimeId: "nvidia:priced",
    billingBasis: "api_priced" as const,
    inputCostMicrosPerMillion: 1,
    outputCostMicrosPerMillion: 1,
  };
  const unknown = {
    ...base,
    runtimeId: "api:unknown",
    transport: "anthropic" as const,
  };
  assert.doesNotThrow(() => assertEnforceableBuildBudget(spec, [priced]));
  assert.doesNotThrow(() => assertEnforceableBuildBudget(spec, [meteredProxy]));
  assert.throws(() => assertEnforceableBuildBudget(spec, [account]), /account:model.*time limit/i);
  assert.throws(() => assertEnforceableBuildBudget(spec, [unknown]), /api:unknown.*pricing.*time limit/i);
  assert.throws(() => assertEnforceableBuildBudget(spec, [priced, account]), /account:model/i);
  assert.doesNotThrow(() => assertEnforceableBuildBudget({
    ...spec,
    budgetLimits: { maxActiveMs: 60_000 },
  }, [account, unknown]));
  assert.doesNotThrow(() => assertEnforceableBuildBudget({
    ...spec,
    budgetLimits: { maxEstimatedCostMicros: 1_000_000, maxActiveMs: 60_000 },
  }, [account, unknown]));
});

test("account runner transport maps native tool calls, usage, and tool results", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "tool_call",
      toolCall: { id: "call_1", name: "fs_read", arguments: { path: "a.txt" } },
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 3 },
    })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.5",
    });
    const turn = await model.complete({
      sessionId: "session_1",
      messages: [
        { id: "system", role: "system", content: "Use tools." },
        {
          id: "tool",
          role: "tool",
          content: {
            callId: "prior",
            toolName: "fs.read",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        },
      ],
      tools: [
        {
          name: "fs.read",
          description: "Read",
          inputSchema: { type: "object" },
          readOnly: true,
          effect: "none",
        },
      ],
    });
    assert.equal(turn.stopReason, "tool_calls");
    assert.deepEqual(turn.blocks[0], {
      type: "tool_call",
      callId: "call_1",
      name: "fs.read",
      arguments: { path: "a.txt" },
    });
    assert.deepEqual(turn.usage, {
      inputTokens: 12,
      inputTokenSource: "reported",
      outputTokens: 3,
    });
    assert.match(JSON.stringify(requests[0]), /TOOL_RESULT/);
    assert.equal((requests[0].nativeTools as unknown[]).length, 1);
    assert.equal(
      (requests[0].nativeTools as Array<{ name: string }>)[0].name,
      "fs_read"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("account runner normalizes strict textual tool-call records from streamed tokens", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "token",
      content: "Inspecting the renderer.\nTOOL_CALL {\"id\":\"call_",
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "token",
      content: "text_1\",\"name\":\"fs.read\",\"arguments\":{\"path\":\"src/game.js\"}}\nTOOL_CALL {\"id\":\"call_text_2\",\"name\":\"fs_search\",\"arguments\":{\"query\":\"projectile\"}}\n",
    })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.4",
    });
    const turn = await model.complete({
      sessionId: "session_textual_tools",
      messages: [],
      tools: [
        {
          name: "fs.read",
          description: "Read",
          inputSchema: { type: "object" },
          readOnly: true,
          effect: "none",
        },
        {
          name: "fs.search",
          description: "Search",
          inputSchema: { type: "object" },
          readOnly: true,
          effect: "none",
        },
      ],
    });

    assert.equal(turn.stopReason, "tool_calls");
    assert.deepEqual(turn.blocks, [
      { type: "text", text: "Inspecting the renderer." },
      {
        type: "tool_call",
        callId: "call_text_1",
        name: "fs.read",
        arguments: { path: "src/game.js" },
      },
      {
        type: "tool_call",
        callId: "call_text_2",
        name: "fs.search",
        arguments: { query: "projectile" },
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("account runner normalizes strict textual tool calls from non-stream responses", async () => {
  const model = new AccountRunnerModel({
    baseUrl: "http://runner.example",
    runnerPath: "chatgpt",
    runnerToken: "local-token",
    modelId: "gpt-5.4",
    fetch: async () => Response.json({
      content: 'TOOL_CALL {"id":"call_json","name":"fs_read","arguments":{"path":"README.md"}}',
    }),
  });
  const turn = await model.complete({
    sessionId: "session_non_stream_textual_tool",
    messages: [],
    tools: [{
      name: "fs.read",
      description: "Read",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    }],
  });

  assert.equal(turn.stopReason, "tool_calls");
  assert.deepEqual(turn.blocks, [{
    type: "tool_call",
    callId: "call_json",
    name: "fs.read",
    arguments: { path: "README.md" },
  }]);
});

test("account runner prefers native tool events over duplicate textual records", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "token",
      content: 'TOOL_CALL {"id":"call_duplicate","name":"fs_read","arguments":{"path":"README.md"}}',
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "tool_call",
      toolCall: {
        id: "call_duplicate",
        name: "fs_read",
        arguments: { path: "README.md" },
      },
    })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.4",
    });
    const turn = await model.complete({
      sessionId: "session_native_wins",
      messages: [],
      tools: [{
        name: "fs.read",
        description: "Read",
        inputSchema: { type: "object" },
        readOnly: true,
        effect: "none",
      }],
    });

    assert.equal(
      turn.blocks.filter((block) => block.type === "tool_call").length,
      1
    );
    assert.deepEqual(turn.blocks.at(-1), {
      type: "tool_call",
      callId: "call_duplicate",
      name: "fs.read",
      arguments: { path: "README.md" },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("account runner leaves malformed or unknown textual tool-call records as text", async () => {
  const content = [
    "TOOL_CALL not-json",
    'TOOL_CALL {"id":"unknown","name":"shell_exec","arguments":{"command":"oops"}}',
  ].join("\n");
  const model = new AccountRunnerModel({
    baseUrl: "http://runner.example",
    runnerPath: "chatgpt",
    runnerToken: "local-token",
    modelId: "gpt-5.4",
    fetch: async () => Response.json({ content }),
  });

  const turn = await model.complete({
    sessionId: "session_untrusted_text",
    messages: [],
    tools: [{
      name: "fs.read",
      description: "Read",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    }],
  });

  assert.equal(turn.stopReason, "end_turn");
  assert.deepEqual(turn.blocks, [{ type: "text", text: content }]);
});

test("account runner sends only current-round image artifacts to image-capable models", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const recentHash = "b".repeat(64);
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.3-codex-spark",
      inputCapabilities: { image: true, document: true, audio: false, video: false },
      readArtifact: async (hash) => {
        assert.equal(hash, recentHash);
        return Buffer.from("recent-png");
      },
    });
    const imageTurn = await model.complete({
      sessionId: "session_image",
      messages: [
        {
          id: "old_tool",
          role: "tool",
          content: toolResult("old", "a".repeat(64)),
        },
        { id: "assistant", role: "assistant", content: "Capture a fresh screenshot." },
        {
          id: "recent_tool",
          role: "tool",
          content: toolResult("recent", recentHash),
        },
      ],
      tools: [],
    });

    assert.deepEqual(requests[0].attachments, [
      {
        category: "image",
        filename: "recent screenshot.png",
        mimeType: "image/png",
        base64Data: Buffer.from("recent-png").toString("base64"),
      },
    ]);
    assert.deepEqual(imageTurn.usage, {
      inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(requests[0])) / 4),
      inputTokenSource: "estimated",
    });

    const textOnly = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "text-only",
      inputCapabilities: { image: false, document: true, audio: false, video: false },
      readArtifact: async () => {
        throw new Error("text-only models must not resolve image bytes");
      },
    });
    await textOnly.complete({
      sessionId: "session_text",
      messages: [
        { id: "assistant_2", role: "assistant", content: "Capture." },
        { id: "tool_2", role: "tool", content: toolResult("recent", recentHash) },
      ],
      tools: [],
    });
    assert.deepEqual(requests[1].attachments, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("account runner HTTP failures preserve status for provider routing", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    response.end(JSON.stringify({ error: "The usage limit has been reached" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.5",
    });
    await assert.rejects(
      () => model.complete({ sessionId: "s", messages: [], tools: [] }),
      (error: unknown) =>
        error instanceof ProviderTransportError &&
        error.status === 429 &&
        error.retryAfterMs === 60_000
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI-compatible transport preserves native tool conversations and usage", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const model = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1/",
    apiKey: "secret",
    modelId: "coding-model",
    fetch: async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({
        id: "req_openai",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "I will inspect it.",
            tool_calls: [{
              id: "call_2",
              type: "function",
              function: { name: "fs_read", arguments: '{"path":"src/a.ts"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 0, completion_tokens: 7 },
      });
    },
  });
  const turn = await model.complete({
    sessionId: "session_openai",
    messages: [
      { id: "s", role: "system", content: "Use tools." },
      {
        id: "a",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "prior_call",
          name: "fs.read",
          arguments: { path: "README.md" },
        }],
      },
      {
        id: "t",
        role: "tool",
        content: {
          callId: "prior_call",
          toolName: "fs.read",
          isError: false,
          content: [{ type: "text", text: "contents" }],
        },
      },
    ],
    tools: [{
      name: "fs.read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      readOnly: true,
      effect: "none",
    }],
  });
  assert.equal(captured?.url, "https://gateway.example/v1/chat/completions");
  assert.equal(new Headers(captured?.init?.headers).get("authorization"), "Bearer secret");
  const body = JSON.parse(String(captured?.init?.body)) as {
    messages: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown[] }>;
    tools: Array<{ function: { name: string } }>;
  };
  assert.equal(body.messages.some((message) => message.role === "tool" && message.tool_call_id === "prior_call"), true);
  assert.equal(body.messages.some((message) => message.role === "assistant" && message.tool_calls?.length === 1), true);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, "fs_read");
  assert.equal(turn.providerRequestId, "req_openai");
  assert.deepEqual(turn.usage, {
    inputTokens: 0,
    inputTokenSource: "reported",
    outputTokens: 7,
  });
  assert.deepEqual(turn.blocks.at(-1), {
    type: "tool_call",
    callId: "call_2",
    name: "fs.read",
    arguments: { path: "src/a.ts" },
  });
});

test("OpenAI Responses transport preserves function-call history for Codex models", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const model = new OpenAICompatibleModel({
    baseUrl: "https://api.openai.example/v1",
    apiKey: "secret",
    modelId: "gpt-codex",
    protocol: "responses",
    promptCaching: true,
    fetch: async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "Done." }] },
          {
            type: "function_call",
            call_id: "call_responses",
            name: "fs_read",
            arguments: '{"path":"tsconfig.json"}',
          },
        ],
        usage: {
          input_tokens: 51,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 13,
        },
      });
    },
  });
  const turn = await model.complete({
    sessionId: "responses_session",
    messages: [
      { id: "s", role: "system", content: "Use tools." },
      {
        id: "a",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "prior_responses",
          name: "fs.read",
          arguments: { path: "package.json" },
        }],
      },
      {
        id: "t",
        role: "tool",
        content: {
          callId: "prior_responses",
          toolName: "fs.read",
          isError: false,
          content: [{ type: "text", text: "{}" }],
        },
      },
    ],
    tools: [{
      name: "fs.read",
      description: "Read",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    }],
  });
  assert.equal(captured?.url, "https://api.openai.example/v1/responses");
  const body = JSON.parse(String(captured?.init?.body)) as {
    input: Array<{ type?: string; call_id?: string; name?: string }>;
    tools: Array<{ name: string }>;
    prompt_cache_key: string;
    prompt_cache_retention: string;
  };
  assert.equal(body.input.some((item) => item.type === "function_call" && item.name === "fs_read"), true);
  assert.equal(body.input.some((item) => item.type === "function_call_output" && item.call_id === "prior_responses"), true);
  assert.equal(body.tools[0].name, "fs_read");
  assert.equal(body.prompt_cache_key, "responses_session");
  assert.equal(body.prompt_cache_retention, "24h");
  assert.equal(turn.providerRequestId, "resp_1");
  assert.deepEqual(turn.usage, {
    inputTokens: 51,
    inputTokenSource: "reported",
    cachedInputTokens: 40,
    outputTokens: 13,
  });
  assert.deepEqual(turn.blocks.at(-1), {
    type: "tool_call",
    callId: "call_responses",
    name: "fs.read",
    arguments: { path: "tsconfig.json" },
  });
});

test("Anthropic transport maps system context, tool results, tool use, and usage", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const model = new AnthropicModel({
    baseUrl: "https://anthropic.example",
    apiKey: "anthropic-secret",
    modelId: "claude-code",
    fetch: async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({
        id: "req_anthropic",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_3", name: "shell_run", input: { command: "npm test" } },
        ],
        usage: {
          input_tokens: 31,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 9,
        },
      });
    },
  });
  const turn = await model.complete({
    sessionId: "session_anthropic",
    messages: [
      { id: "s", role: "system", content: "Architect instructions." },
      { id: "u", role: "user", content: "Verify it." },
      {
        id: "t",
        role: "tool",
        content: {
          callId: "prior",
          toolName: "shell.run",
          isError: true,
          error: { code: "exit_1", message: "failed" },
          content: [{ type: "text", text: "test failed" }],
        },
      },
    ],
    tools: [{
      name: "shell.run",
      description: "Run a command",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
    }],
  });
  assert.equal(captured?.url, "https://anthropic.example/v1/messages");
  const headers = new Headers(captured?.init?.headers);
  assert.equal(headers.get("x-api-key"), "anthropic-secret");
  const body = JSON.parse(String(captured?.init?.body)) as {
    system: string;
    cache_control: { type: string };
    messages: Array<{ role: string; content: string | Array<{ type: string; tool_use_id?: string }> }>;
    tools: Array<{ name: string }>;
  };
  assert.equal(body.system, "Architect instructions.");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "tool_result" && part.tool_use_id === "prior")
  ), true);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, "shell_run");
  assert.equal(turn.providerRequestId, "req_anthropic");
  assert.equal(turn.stopReason, "tool_calls");
  assert.deepEqual(turn.blocks.at(-1), {
    type: "tool_call",
    callId: "call_3",
    name: "shell.run",
    arguments: { command: "npm test" },
  });
  assert.deepEqual(turn.usage, {
    inputTokens: 61,
    inputTokenSource: "reported",
    cachedInputTokens: 20,
    cacheWriteInputTokens: 10,
    outputTokens: 9,
  });
});

test("Google transport maps function declarations, function responses, calls, and usage", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const model = new GoogleModel({
    baseUrl: "https://generativelanguage.example/v1beta",
    apiKey: "google-secret",
    modelId: "gemini-code",
    fetch: async (input, init) => {
      captured = { url: String(input), init };
      return Response.json({
        responseId: "req_google",
        candidates: [{
          finishReason: "STOP",
          content: { role: "model", parts: [
            { text: "Inspecting." },
            { functionCall: { name: "fs_read", args: { path: "package.json" }, id: "call_4" } },
          ] },
        }],
        usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 11 },
      });
    },
  });
  const turn = await model.complete({
    sessionId: "session_google",
    messages: [
      { id: "s", role: "system", content: "Use the repository." },
      {
        id: "t",
        role: "tool",
        content: {
          callId: "prior_google",
          toolName: "fs.read",
          isError: false,
          content: [{ type: "json", value: { ok: true } }],
        },
      },
    ],
    tools: [{
      name: "fs.read",
      description: "Read a file",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    }],
  });
  assert.equal(captured?.url, "https://generativelanguage.example/v1beta/models/gemini-code:generateContent?key=google-secret");
  const body = JSON.parse(String(captured?.init?.body)) as {
    systemInstruction: { parts: Array<{ text: string }> };
    contents: Array<{ parts: Array<{ functionResponse?: unknown }> }>;
    tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
  };
  assert.equal(body.systemInstruction.parts[0].text, "Use the repository.");
  assert.equal(body.contents.some((content) => content.parts.some((part) => part.functionResponse)), true);
  assert.equal(body.tools[0].functionDeclarations.length, 1);
  assert.equal(body.tools[0].functionDeclarations[0].name, "fs_read");
  assert.equal(turn.providerRequestId, "req_google");
  assert.equal(turn.stopReason, "tool_calls", "a function call controls the stop reason even if Gemini says STOP");
  assert.deepEqual(turn.blocks.at(-1), {
    type: "tool_call",
    callId: "call_4",
    name: "fs.read",
    arguments: { path: "package.json" },
  });
  assert.deepEqual(turn.usage, {
    inputTokens: 41,
    inputTokenSource: "reported",
    outputTokens: 11,
  });
});

test("native HTTP provider failures preserve routing metadata without leaking secrets", async () => {
  const model = new OpenAICompatibleModel({
    baseUrl: "https://gateway.example/v1",
    apiKey: "do-not-leak",
    modelId: "coding-model",
    fetch: async () => new Response(JSON.stringify({
      error: { message: "rate limited", code: "rate_limit_exceeded" },
    }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "12" },
    }),
  });
  await assert.rejects(
    () => model.complete({ sessionId: "s", messages: [], tools: [] }),
    (error: unknown) =>
      error instanceof ProviderTransportError &&
      error.status === 429 &&
      error.code === "rate_limit_exceeded" &&
      error.retryAfterMs === 12_000 &&
      !error.message.includes("do-not-leak")
  );
});

test("native Build factory instantiates every provider-neutral transport", () => {
  const common = {
    runtimeId: "provider:model",
    providerId: "provider",
    modelId: "model",
    secret: "secret",
    capabilities: ["*"],
    priority: 1,
  };
  assert.ok(createProviderModel({
    ...common,
    transport: "account-runner",
    baseUrl: "http://127.0.0.1:1455",
  }) instanceof AccountRunnerModel);
  assert.ok(createProviderModel({
    ...common,
    transport: "openai-compatible",
    baseUrl: "https://gateway.example/v1",
  }) instanceof OpenAICompatibleModel);
  assert.ok(createProviderModel({
    ...common,
    transport: "anthropic",
  }) instanceof AnthropicModel);
  assert.ok(createProviderModel({
    ...common,
    transport: "google",
  }) instanceof GoogleModel);
});

function toolResult(callId: string, hash: string): ToolResult {
  return {
    callId,
    toolName: "browser.screenshot",
    content: [
      {
        type: "artifact",
        hash,
        mediaType: "image/png",
        label: `${callId} screenshot`,
      },
    ],
    isError: false,
  };
}
