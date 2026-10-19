import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getProviderDefinition } from "../lib/providers/provider-registry";
import { initialOpenAIConnectionMode } from "../components/OpenAIProviderSettings";
import { fetchProviderModelCatalog } from "../lib/client/settings-api";

const chatgpt = getProviderDefinition("chatgpt");
const apiFixture = { providerId: "openai", name: "OpenAI", models: [], hasKey: true, enabled: true } as const;
const subscriptionFixture = { providerId: "chatgpt", name: "ChatGPT", models: [], hasKey: true, enabled: false } as const;
assert.equal(initialOpenAIConnectionMode(apiFixture, subscriptionFixture, "subscription"), "subscription");
assert.deepEqual(chatgpt?.modelDiscovery, { source: "runner" });
assert.ok(chatgpt?.modelIdsField, "ChatGPT subscription mode must expose live/model-id browsing controls");

const settingsSource = await readFile(new URL("../app/settings/settings-client.tsx", import.meta.url), "utf8");
const mergedSource = await readFile(new URL("../components/OpenAIProviderSettings.tsx", import.meta.url), "utf8");
assert.match(settingsSource, /OpenAIProviderSettings/);
assert.match(settingsSource, /provider\.providerId !== "chatgpt"/);
assert.match(mergedSource, /API key/);
assert.match(mergedSource, /ChatGPT subscription/);
assert.match(mergedSource, /providerId === "chatgpt"|chatgptProvider/);
const apiKeyFormSource = await readFile(new URL("../components/ApiKeyForm.tsx", import.meta.url), "utf8");
assert.match(apiKeyFormSource, /accountRunner \? "Saved runner token" : "Saved key"/);
const settingsApiSource = await readFile(new URL("../lib/client/settings-api.ts", import.meta.url), "utf8");
assert.match(settingsApiSource, /account runner is too old for ChatGPT live model discovery/);
assert.equal(chatgpt?.accountRunner?.loginLabel, "Continue with ChatGPT");
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
let version = 26;
let connected = true;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.endsWith("/status")) return new Response(JSON.stringify({ runnerVersion: version, connected, accounts: [], message: "Continue with ChatGPT" }));
  assert.equal(url, "http://127.0.0.1:1455/providers/chatgpt/models");
  return new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", capabilities: { supports: { vision: true } } }] }));
}) as typeof fetch;
try {
  const input = { providerId: "chatgpt", apiKey: "local-runner-token", baseURL: "http://127.0.0.1:1455" };
  const models = await fetchProviderModelCatalog(input);
  assert.equal(models[0].id, "gpt-6.1-sol");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new Headers(call.init?.headers).get("x-runner-token"), "local-runner-token");
    assert.equal(new Headers(call.init?.headers).has("authorization"), false);
  }
  assert.equal(calls[1].init?.body, "{}", "no API key is used to discover subscription models");
  calls.length = 0;
  version = 25;
  await assert.rejects(fetchProviderModelCatalog(input), /v26 or newer/);
  assert.equal(calls.length, 1, "old runners must not fabricate missing model metadata");
  calls.length = 0;
  version = 24;
  await assert.rejects(fetchProviderModelCatalog(input), /v25 or newer/);
  assert.equal(calls.length, 1, "do not use the old restricted discovery endpoint");
  calls.length = 0;
  version = 25; connected = false;
  await assert.rejects(fetchProviderModelCatalog(input), /Continue with ChatGPT/);
  assert.equal(calls.length, 1, "require plan consent before loading models");
} finally { globalThis.fetch = realFetch; }
console.log("PASS OpenAI settings merge API and ChatGPT subscription modes while preserving internal provider ids");
