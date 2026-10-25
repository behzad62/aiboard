import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { ACCOUNT_RUNNER_VERSION, getProviderDefinition } from "../lib/providers/provider-registry";

const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
const sourceRunner = normalize(await readFile("lib/account-provider-runner.mjs", "utf8"));
const sourceSdk = normalize(await readFile("lib/account-provider-copilot-sdk.mjs", "utf8"));
const publicRunner = normalize(await readFile("public/account-provider-runner.mjs", "utf8"));
const archive = await JSZip.loadAsync(await readFile("public/aiboard-account-provider-runner.zip"));
const archivedRunner = normalize(await archive.file("account-provider-runner.mjs")!.async("string"));
const archivedSdk = normalize(await archive.file("account-provider-copilot-sdk.mjs")!.async("string"));
assert.equal(Number(/const VERSION = (\d+);/.exec(sourceRunner)?.[1]), ACCOUNT_RUNNER_VERSION,
  "download button version must match the actual runner version");
for (const id of ["chatgpt", "github-copilot", "nvidia"] as const) {
  const provider = getProviderDefinition(id)!;
  const setup = provider.accountRunner ?? provider.runnerDownload;
  assert.equal(setup?.downloadHref, "/aiboard-account-provider-runner.zip", `${id} must use the shared package`);
  assert.equal(setup?.command, "npm install\nnpm start", `${id} must use the same startup instructions`);
}

assert.equal(publicRunner, sourceRunner, "published account runner must exactly match current source");
assert.equal(archivedRunner, sourceRunner, "ZIP account runner must exactly match current source");
assert.equal(archivedSdk, sourceSdk, "ZIP Copilot SDK adapter must exactly match current source");

for (const [label, text] of [
  ["public runner", publicRunner],
  ["ZIP runner", archivedRunner],
] as const) {
  assert.match(text, /const VERSION = 29;/, `${label} must publish current runner version`);
  assert.match(text, /const RUNNER_CAPABILITY_SCHEMA_VERSION = 1;/, `${label} must publish capability schema v1`);
  assert.match(text, /providerCapabilities\(provider, body = \{\}\)/, `${label} must publish capability handshake producer`);
  assert.match(text, /action === "capabilities"/, `${label} must expose provider capability endpoint`);
  assert.match(text, /chatGptRunnerCapabilities\(\)/, `${label} must publish ChatGPT capability handler`);
  assert.match(text, /listChatGptModels/, `${label} must publish ChatGPT live model discovery`);
  assert.match(text, /dynamic_agent_client/, `${label} must publish ChatGPT plan registration`);
  assert.match(text, /chatgpt\.tokens\.use\.direct/, `${label} must request plan permission`);
  assert.match(text, /https:\/\/api\.openai\.com\/v1/, `${label} must target the public API`);
  assert.doesNotMatch(text, /backend-api\/codex/, `${label} must not use the retired Codex account endpoint`);
  assert.match(text, /nvidiaRunnerCapabilities\(body\)/, `${label} must publish NVIDIA capability handler`);
  assert.match(text, /buildCopilotSdkRunnerCapabilities/, `${label} must publish Copilot capability integration`);
}
assert.match(archivedSdk, /export function buildCopilotSdkRunnerCapabilities/, "ZIP must contain Copilot capability helper");
assert.match(archivedSdk, /tool\.execution_start/, "ZIP Copilot adapter must observe tool start events");
assert.match(archivedSdk, /tool\.execution_complete/, "ZIP Copilot adapter must observe tool completion events");
assert.match(archivedRunner, /provider_tool_event/, "ZIP runner must forward provider tool events");
const manifest = JSON.parse(await archive.file("package.json")!.async("string"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
assert.equal(manifest.dependencies["@github/copilot"], lock.packages["node_modules/@github/copilot"].version,
  "downloads must pin the CLI tested with the SDK, not resolve its drifting dependency range");
assert.equal(manifest.overrides["@github/copilot"], manifest.dependencies["@github/copilot"]);

console.log("PASS account-provider runner public artifacts match capability-aware source");
