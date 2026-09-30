import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getProviderDefinition } from "../lib/providers/provider-registry";
import { initialOpenAIConnectionMode } from "../components/OpenAIProviderSettings";

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
console.log("PASS OpenAI settings merge API and ChatGPT subscription modes while preserving internal provider ids");
