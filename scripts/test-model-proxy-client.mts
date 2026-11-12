/**
 * The browser side of the model proxy (Simple Build plan §9, packet HM4a).
 * Run: npx tsx scripts/test-model-proxy-client.mts
 *
 * - `resolveProviderConnection` gives the proxy (through the launcher's connection only) for API
 *   providers, NVIDIA and custom models, and the launcher's account peer for ChatGPT and Copilot,
 *   read at call time so it survives a Runner restart.
 * - With no Runner, or one without `capabilities.home`/`modelProxy`, every model action refuses
 *   before any call and names the fix.
 * - The proxy session is renewed before expiry and on a 401 `proxy_token_expired`.
 * - One streamed call per provider SDK reaches the proxy with the proxy token, never a key.
 * - Build, Runner Chat and benchmark pushes carry no secret.
 * - The request cap is one value shared with the Runner, and the composer refuses a larger message.
 *
 * Stub Runner and stub upstreams only: no live provider call, no real key.
 */
import assert from "node:assert/strict";

import type { CustomModel, ProviderKey } from "../lib/db/schema";
import { createDiscussion, sendChatMessage } from "../lib/client/api";
import { runDiscussion } from "../lib/client/engine";
import { storeLauncherSession } from "../lib/client/local-runner-handoff";
import {
  CONNECT_AI_BOARD_MESSAGE,
  ModelConnectionError,
  modelProxyClient,
  PROXY_SESSION_RENEW_BEFORE_MS,
  UPDATE_AI_BOARD_MESSAGE,
} from "../lib/client/model-proxy-client";
import { createNativeProviderConfig } from "../lib/client/native-build-engine";
import {
  resolveProviderConnection,
  streamCustomChat,
  withProviderConnection,
} from "../lib/client/providers";
import { runRunnerChatTurn } from "../lib/client/runner-chat";
import { fetchProviderModelCatalog, testSavedCustomModel, validateProvider } from "../lib/client/settings-api";
import { __resetClientStoreForTests, getDiscussionById } from "../lib/client/store";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import { callCertifiedModel } from "../lib/benchmark/certified/model-call";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MODEL_REQUEST_MAX_BYTES,
  modelRequestBytes,
  modelRequestTooLargeMessage,
} from "../lib/attachments/types";
import { anthropicProvider } from "../lib/providers/anthropic";
import { googleProvider } from "../lib/providers/google";
import { openaiProvider } from "../lib/providers/openai";
import { providerFetch } from "../lib/providers/connection";
import { MODEL_PROXY_MAX_REQUEST_BYTES } from "../runner-v2/src/model-proxy";
import {
  installStubRunner,
  json,
  STUB_ACCOUNTS_URL,
  STUB_CONTROL_PORT,
  STUB_PEER_TOKEN,
  STUB_PROXY_URL,
  type StubRequest,
} from "./model-proxy-test-support.mts";

let checks = 0;
function pass(name: string): void {
  checks += 1;
  console.log(`PASS ${name}`);
}

const now = new Date().toISOString();
// Browser rows still say what is enabled (HM4b moves that to the home); their keys are never sent.
const BROWSER_KEY = "stub-browser-key-never-sent";
const row = (providerId: string, patch: Partial<ProviderKey> = {}): ProviderKey => ({
  providerId, apiKey: BROWSER_KEY, baseURL: null, runnerToken: null, models: [], enabledModelIds: null,
  defaultModel: null, enabled: true, keyHint: "stub", lastValidationSucceeded: null, lastValidatedAt: null, updatedAt: now, ...patch,
});
const custom: CustomModel = {
  id: "local-a", label: "Local A", baseURL: "http://127.0.0.1:11434/v1", model: "gemma-local", apiKey: BROWSER_KEY, hasKey: true,
  capabilities: { image: false, document: false, audio: false, video: false }, createdAt: now,
};
function resetStore(extra: Record<string, unknown> = {}): void {
  __resetClientStoreForTests({
    providerKeys: [
      row("openai", { defaultModel: "gpt-5.5" }),
      row("anthropic"),
      row("google"),
      row("openrouter"),
      row("nvidia", { apiKey: undefined, models: ["z-ai/glm-5.2"], defaultModel: "z-ai/glm-5.2" }),
      // A stale manual peer row: the launcher's peer wins (OD-32).
      row("chatgpt", { apiKey: "stub-stale-peer-token", baseURL: "http://127.0.0.1:1455" }),
    ],
    customModels: [custom],
    ...extra,
  } as never);
}

function sseChat(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** Every model action, each expected to refuse with `message` before any provider call. */
async function everyModelActionRefuses(message: string, label: string): Promise<void> {
  const expectRefusal = async (name: string, action: () => Promise<unknown>) => {
    await assert.rejects(action, (error: unknown) => error instanceof ModelConnectionError && error.message === message, `${label}: ${name}`);
  };
  for (const id of ["openai", "anthropic", "google", "nvidia", "custom:local-a", "chatgpt"]) {
    await expectRefusal(`resolveProviderConnection(${id})`, () => resolveProviderConnection(id));
  }
  await expectRefusal("streamCustomChat", async () => {
    for await (const chunk of streamCustomChat(custom, { model: "gemma-local", messages: [{ role: "user", content: "hi" }] })) void chunk;
  });
  await expectRefusal("fetchProviderModelCatalog", () => fetchProviderModelCatalog({ providerId: "openai" }));
  const validation = await validateProvider({ providerId: "openai" });
  assert.equal(validation.valid, false);
  assert.equal(validation.error, message, `${label}: validateProvider names the fix`);
  const customTest = await testSavedCustomModel("local-a");
  assert.equal(customTest.error, message, `${label}: a custom model test names the fix`);

  __resetBenchmarkStoreForTests();
  const context = createCertifiedRunContext({
    runId: `run-${label.replace(/\W+/g, "-")}`, suiteId: "suite-proxy", track: "toolreliability", harnessProfile: "raw-single-model",
    startedAt: new Date().toISOString(), caseIds: ["case-1"], teamCompositionIds: ["team-1"],
  });
  await assert.rejects(
    callCertifiedModel({
      model: { modelId: "openai:gpt-5.5", providerId: "openai", displayName: "GPT" }, system: "s", user: "u", maxTokens: 16, temperature: 0,
      context, caseId: "case-1", attemptId: "attempt-1", participantId: "p", retryDelaysMs: [],
    }),
    (error: unknown) => error instanceof Error && error.message.includes(message),
    `${label}: a certified benchmark call`,
  );

  const { id } = createDiscussion({ topic: "Say hello.", mode: "chat", effort: "low", modelIds: ["openai:gpt-5.5"] });
  const events: Array<{ type: string; message?: string }> = [];
  await runDiscussion(id, (event) => events.push(event as { type: string; message?: string }));
  assert.ok(events.some((event) => event.type === "error" && event.message === message), `${label}: the chat composer's run names the fix`);
  assert.equal(getDiscussionById(id)?.status, "failed");
}

// ---------------------------------------------------------------- the size cap

assert.equal(MODEL_REQUEST_MAX_BYTES, MODEL_PROXY_MAX_REQUEST_BYTES, "the composer and the proxy share one request cap");
assert.equal(MODEL_REQUEST_MAX_BYTES, Math.ceil((MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4) / 3) + 8 * 1024 * 1024);
pass(`one request cap (${MODEL_REQUEST_MAX_BYTES} bytes) in lib/attachments/types.ts and runner-v2/src/model-proxy.ts`);
{
  const full = Array.from({ length: MAX_ATTACHMENTS }, () => MAX_ATTACHMENT_BYTES);
  assert.equal(modelRequestTooLargeMessage(modelRequestBytes("hi", full)), null, "eight full attachments fit");
  const attachments = full.map((size, index) => ({
    id: `att-${index}`, filename: `f${index}.bin`, mimeType: "application/octet-stream", category: "document", size, base64Data: "", createdAt: now,
  }));
  resetStore({ attachments });
  const oversized = "x".repeat(8 * 1024 * 1024 + 1);
  assert.throws(
    () => createDiscussion({ topic: oversized, mode: "chat", effort: "low", modelIds: ["openai:gpt-5.5"], attachmentIds: attachments.map((a) => a.id) }),
    /AI Board sends at most 168\.0 MiB to a model/,
  );
  const { id } = createDiscussion({ topic: "Short.", mode: "chat", effort: "low", modelIds: ["openai:gpt-5.5"], attachmentIds: attachments.map((a) => a.id) });
  assert.throws(() => sendChatMessage(id, oversized), /Remove an attachment or shorten the message/);
  pass("the composer refuses a message past the cap before sending, for a new chat and a follow-up");
}

// ---------------------------------------------------------------- not connected, and old Runners

{
  resetStore();
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return json({ error: "no network in this test" }, 500);
  }) as typeof fetch;
  try {
    modelProxyClient.reset();
    await everyModelActionRefuses(CONNECT_AI_BOARD_MESSAGE, "no Runner");
    assert.deepEqual(calls, [], "no request at all is sent without a Runner");
  } finally {
    globalThis.fetch = original;
  }
  pass("with no Runner, every model action refuses before a call: \"Connect AI Board: run `aiboard` in a project folder (not your home folder)\"");
}
for (const [label, capabilities] of [
  ["a Runner without capabilities.home", { soloToolBench: true, extensions: true, chatSessions: true }],
  ["a Runner without capabilities.modelProxy", { home: true, modelProxy: false, secretlessProviderConfigs: true }],
] as const) {
  resetStore();
  const stub = installStubRunner({ capabilities, withAccountPeer: true, upstream: () => json({ error: "must not be called" }, 500) });
  try {
    await everyModelActionRefuses(UPDATE_AI_BOARD_MESSAGE, label);
    assert.deepEqual(stub.requests, [], `${label}: no provider or peer request`);
    assert.ok(stub.controlCalls.every((call) => call === "GET /v2/health"), `${label}: only health is asked`);
  } finally {
    stub.restore();
  }
  pass(`${label}: every model action refuses before a call: "Update AI Board: run \`aiboard update\`"`);
}

// ---------------------------------------------------------------- the resolver

{
  resetStore();
  const stub = installStubRunner({ withAccountPeer: true, proxyTokens: ["proxy_one"] });
  try {
    const openai = await resolveProviderConnection("openai");
    assert.equal(openai.baseURL, `${STUB_PROXY_URL}/v2/model-proxy/openai`);
    assert.equal(openai.apiKey, "proxy_one");
    assert.equal(typeof openai.fetch, "function");
    assert.equal((await resolveProviderConnection("openai:gpt-5.5")).baseURL, openai.baseURL, "a full model id resolves by its provider");
    assert.equal((await resolveProviderConnection("google")).baseURL, `${STUB_PROXY_URL}/v2/model-proxy/google`);
    assert.equal((await resolveProviderConnection("nvidia")).baseURL, `${STUB_PROXY_URL}/v2/model-proxy/nvidia`);
    assert.equal((await resolveProviderConnection("custom:local-a")).baseURL, `${STUB_PROXY_URL}/v2/model-proxy/custom/local-a`);
    assert.deepEqual((await resolveProviderConnection("openrouter")).headers, { "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000", "X-Title": "AI Board" });
    const chatgpt = await resolveProviderConnection("chatgpt");
    assert.deepEqual({ baseURL: chatgpt.baseURL, apiKey: chatgpt.apiKey, fetch: chatgpt.fetch }, { baseURL: STUB_ACCOUNTS_URL, apiKey: STUB_PEER_TOKEN, fetch: undefined }, "ChatGPT takes the launcher's peer, not the saved row");
    assert.equal((await resolveProviderConnection("github-copilot")).baseURL, STUB_ACCOUNTS_URL);
    await assert.rejects(resolveProviderConnection("not-a-provider"), /Unknown provider/);
    assert.equal(stub.controlCalls.filter((call) => call === "POST /v2/home/proxy-session").length, 1, "one proxy session serves every provider");
    assert.ok(stub.controlCalls.every((call) => call.startsWith("GET /v2/health") || call.startsWith("POST /v2/home/proxy-session")));
    pass("resolveProviderConnection: the proxy for API providers, NVIDIA and custom models, the launcher's peer for ChatGPT and Copilot");

    // A Runner restart: the launcher hands the page new sessions; the peer and proxy follow at call time.
    storeLauncherSession({ port: STUB_CONTROL_PORT, instanceId: "stub-runner-2", kind: "runner", sessionToken: "stub-restarted-session" }, null);
    storeLauncherSession({ port: 47_900, instanceId: "stub-accounts-2", kind: "accounts", sessionToken: "stub-restarted-peer" }, null);
    const restarted = await resolveProviderConnection("chatgpt");
    assert.deepEqual({ baseURL: restarted.baseURL, apiKey: restarted.apiKey }, { baseURL: "http://127.0.0.1:47900", apiKey: "stub-restarted-peer" });
    assert.equal((await resolveProviderConnection("github-copilot")).apiKey, "stub-restarted-peer");
    await resolveProviderConnection("openai");
    assert.equal(stub.controlCalls.filter((call) => call === "POST /v2/home/proxy-session").length, 2, "a new launcher session gets a new proxy session");
    pass("ChatGPT and Copilot work after a Runner restart: the peer's address and token are read from the launcher at call time");
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------- token renewal

{
  resetStore();
  const stub = installStubRunner({
    proxyTokens: ["proxy_old", "proxy_new"],
    upstream: (request) => request.headers.get("authorization") === "Bearer proxy_old" || request.headers.get("x-api-key") === "proxy_old"
      ? json({ error: "The proxy token expired.", code: "proxy_token_expired" }, 401)
      : json({ data: [] }),
  });
  try {
    const connection = await resolveProviderConnection("meta");
    assert.equal(connection.apiKey, "proxy_old");
    const [first, second] = await Promise.all([
      providerFetch({ apiKey: connection.apiKey, baseURL: connection.baseURL, providerFetch: connection.fetch }, "Meta", "models"),
      providerFetch({ apiKey: connection.apiKey, baseURL: connection.baseURL, providerFetch: connection.fetch }, "Meta", "models"),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(stub.requests.map((request) => request.headers.get("authorization")), ["Bearer proxy_old", "Bearer proxy_old", "Bearer proxy_new", "Bearer proxy_new"]);
    assert.equal(stub.controlCalls.filter((call) => call === "POST /v2/home/proxy-session").length, 2, "two refused requests renew once");
    // The Anthropic SDK's header is rewritten too.
    const anthropic = await modelProxyClient.fetch(`${STUB_PROXY_URL}/v2/model-proxy/anthropic/v1/models`, { headers: { "x-api-key": "proxy_old" } });
    assert.equal(anthropic.status, 200);
    assert.equal(stub.requests.at(-1)?.headers.get("x-api-key"), "proxy_new");
    pass("a 401 proxy_token_expired asks for a new token once and retries with it, in whichever key header the SDK uses");
  } finally {
    stub.restore();
  }
}
{
  resetStore();
  const stub = installStubRunner({ proxyTokens: ["proxy_a"], upstream: () => json({ error: "Invalid API key", code: "invalid_api_key" }, 401) });
  try {
    const connection = await resolveProviderConnection("openai");
    const response = await providerFetch({ apiKey: connection.apiKey, baseURL: connection.baseURL, providerFetch: connection.fetch }, "OpenAI", "models");
    assert.equal(response.status, 401);
    assert.equal(stub.requests.length, 1, "a provider's own 401 is not retried");
    assert.equal(stub.controlCalls.filter((call) => call === "POST /v2/home/proxy-session").length, 1);
  } finally {
    stub.restore();
  }
  const soon = installStubRunner({ proxyTokens: ["proxy_1", "proxy_2"], expiresInMs: PROXY_SESSION_RENEW_BEFORE_MS - 1_000 });
  try {
    assert.equal((await resolveProviderConnection("google")).apiKey, "proxy_1");
    assert.equal((await resolveProviderConnection("google")).apiKey, "proxy_2", "a session near expiry is renewed before use (Google's SDK takes no custom fetch)");
  } finally {
    soon.restore();
  }
  pass("a provider's own 401 passes through; a session near expiry is renewed before it is handed out");
}

// ---------------------------------------------------------------- the token goes only to the proxy

{
  resetStore();
  const stub = installStubRunner({ proxyTokens: ["proxy_guarded"], upstream: () => json({ data: [] }) });
  try {
    const foreign = [
      "https://api.openai.com/v1/models",
      `${STUB_PROXY_URL}/v2/health`,
      `${STUB_PROXY_URL}/v2/model-proxy/../home/proxy-session`,
      `${STUB_PROXY_URL.replace("127.0.0.1", "localhost")}/v2/model-proxy/openai/models`,
      `${STUB_PROXY_URL.replace("http://", "http://user:pw@")}/v2/model-proxy/openai/models`,
      "not a url",
    ];
    for (const url of foreign) {
      const error = await modelProxyClient
        .fetch(url, { headers: { authorization: "Bearer placeholder", "x-api-key": "placeholder" } })
        .then(() => null, (caught: unknown) => caught);
      assert.ok(error instanceof ModelConnectionError && error.code === "not_proxy_url", `${url} is refused`);
      assert.ok(!error.message.includes("proxy_guarded"), "the refusal never names the token");
    }
    assert.equal(stub.requests.length, 0, "no request leaves for a foreign URL");
    const ok = await modelProxyClient.fetch(`${STUB_PROXY_URL}/v2/model-proxy/openai/models`, { headers: { authorization: "Bearer placeholder" } });
    assert.equal(ok.status, 200);
    assert.equal(stub.requests.length, 1);
  } finally {
    stub.restore();
  }
  pass("the proxy fetch refuses, with no request made, any URL outside the session's /v2/model-proxy/");
}

// ---------------------------------------------------------------- one streamed call per SDK

{
  resetStore();
  const stub = installStubRunner({
    proxyTokens: ["proxy_sdk"],
    upstream: (request) => {
      if (request.url.includes("/model-proxy/anthropic/")) {
        const events = [
          { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic ok" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (request.url.includes("/model-proxy/google/")) {
        return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "google ok" }] }, finishReason: "STOP" }] })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (request.url.endsWith("/responses")) {
        const events = [
          { type: "response.output_text.delta", delta: "openai ok" },
          { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseChat("openai ok");
    },
  });
  try {
    const cases = [
      { provider: openaiProvider, id: "openai", model: "gpt-5.5", text: "openai ok", keyHeader: "authorization", key: "Bearer proxy_sdk" },
      { provider: anthropicProvider, id: "anthropic", model: "claude-sonnet-4-6", text: "anthropic ok", keyHeader: "x-api-key", key: "proxy_sdk" },
      { provider: googleProvider, id: "google", model: "gemini-2.5-flash", text: "google ok", keyHeader: "x-goog-api-key", key: "proxy_sdk" },
    ];
    for (const item of cases) {
      const before = stub.requests.length;
      const params = await withProviderConnection(item.id, { model: item.model, messages: [{ role: "user" as const, content: "hi" }], maxTokens: 16 });
      let text = "";
      for await (const chunk of item.provider.streamChat(params)) {
        if (chunk.type === "token") text += chunk.content ?? "";
        if (chunk.type === "error") throw new Error(chunk.error);
      }
      const sent = stub.requests.slice(before) as StubRequest[];
      assert.equal(text, item.text, `${item.id} streams`);
      assert.ok(sent.length >= 1 && sent.every((request) => request.url.startsWith(`${STUB_PROXY_URL}/v2/model-proxy/${item.id}/`)), `${item.id} calls only the proxy: ${sent.map((r) => r.url).join(", ")}`);
      assert.ok(sent.every((request) => request.headers.get(item.keyHeader) === item.key), `${item.id} sends the proxy token in ${item.keyHeader}`);
      assert.ok(sent.every((request) => !JSON.stringify([...request.headers]).includes(BROWSER_KEY) && !request.body.includes(BROWSER_KEY)), `${item.id} never sends the browser key`);
    }
    const googleUrl = stub.requests.find((request) => request.url.includes("/model-proxy/google/"))!.url;
    assert.match(googleUrl, /\/v2\/model-proxy\/google\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
    pass("one streamed call per provider SDK (OpenAI, Anthropic, Google) reaches only the proxy, with the proxy token in the SDK's key header");
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------- pushes carry no secret

{
  resetStore();
  const stub = installStubRunner({ withAccountPeer: true });
  try {
    for (const runtimeId of ["openai:gpt-5.5", "anthropic:claude-sonnet-4-6", "nvidia:z-ai/glm-5.2", "custom:local-a", "openai:gpt-5.5#high"]) {
      const config = createNativeProviderConfig(runtimeId, 0);
      assert.equal(config.secret, undefined, `${runtimeId}: no secret`);
      assert.equal(config.runnerToken, undefined, `${runtimeId}: no runner token`);
      assert.equal(config.baseUrl, undefined, `${runtimeId}: the home decides the base URL`);
      assert.equal(config.secretSource, "home", runtimeId);
      assert.ok(!JSON.stringify(config).includes(BROWSER_KEY), `${runtimeId}: the browser key is not pushed`);
    }
    const account = createNativeProviderConfig("chatgpt:gpt-5.5", 0);
    assert.equal(account.transport, "account-runner");
    assert.equal(account.baseUrl, STUB_ACCOUNTS_URL, "the launcher's peer, not the stale saved row");
    assert.equal(account.secret, STUB_PEER_TOKEN);
    assert.ok(!JSON.stringify(account).includes("stub-stale-peer-token"));
    pass("Build and benchmark configs (createNativeProviderConfig) carry no secret; account-backed ones carry only the launcher peer");
  } finally {
    stub.restore();
  }
}
{
  resetStore();
  const pushes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v2/health")) return json({ ok: true, protocolVersion: 2, projectPath: "C:/p", nodeVersion: "v24", capabilities: { home: true, modelProxy: true, secretlessProviderConfigs: true } });
    if (url.endsWith("/v2/provider-configs")) {
      pushes.push(String(init?.body));
      return json({ configs: [] });
    }
    return json({ error: "stop here", code: "stub_stop" }, 500);
  }) as typeof fetch;
  try {
    await assert.rejects(runRunnerChatTurn({
      connection: { url: "http://127.0.0.1:47811", token: "stub-runner-token" }, discussionId: "d1", modelId: "openai:gpt-5.5",
      round: 1, text: "hi", history: [], signal: new AbortController().signal,
    }), /stop here/);
    assert.equal(pushes.length, 1);
    const pushed = JSON.parse(pushes[0]!) as { configs: Array<Record<string, unknown>> };
    assert.equal(pushed.configs[0]?.secretSource, "home");
    assert.equal("secret" in pushed.configs[0]!, false);
    assert.ok(!pushes[0]!.includes(BROWSER_KEY));
  } finally {
    globalThis.fetch = original;
  }
  pass("a Runner Chat turn pushes its config with no secret");
}

console.log(`PASS model proxy client (${checks} checks)`);
process.exit(0);
