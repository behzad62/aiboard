/**
 * Model catalogs and model details on the Settings page, against a real Runner and AIBoard home
 * (HM4a, HM4b): provider rows, keys and details are saved in the home through the Runner; keyed
 * provider catalogs go through its model proxy to a stub upstream on loopback; ChatGPT and Copilot
 * go through the launcher's account peer. Stub keys and stub upstreams only.
 */
import { test, expect, type Page } from "@playwright/test";

import { pairContext, readAiboardHomeSync, sendJson, startRunnerHome, startStubServer, type HomeOp, type RunnerHome } from "./runner-home.js";

/** The launcher's account peer, as the pairing link would leave it; page.route answers for it. */
const PEER = { port: 1455, sessionToken: "peer-e2e-session-token" };

type Upstream = Awaited<ReturnType<typeof startStubServer>>;

let cleanups: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** A Runner whose home holds `ops`, paired with `page`'s context; closed after the test. */
async function connect(page: Page, options: { ops?: HomeOp[]; accounts?: boolean } = {}): Promise<RunnerHome> {
  const runner = await startRunnerHome({ ops: options.ops });
  cleanups.push(() => runner.close());
  await pairContext(page.context(), runner, options.accounts ? PEER : undefined);
  return runner;
}

async function upstream(handle: Parameters<typeof startStubServer>[0]): Promise<Upstream> {
  const server = await startStubServer(handle);
  cleanups.push(() => server.close());
  return server;
}

test.beforeEach(async ({ page }) => {
  await page.route("https://models.dev/api.json", (route) => route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {} }));
  await page.route("https://models.dev/models.json", (route) => route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {} }));
});

test("catalog models keep optional metadata across saves, refreshes and removal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://openrouter.ai/api/v1/models", (route) => route.fulfill({ json: { data: [
    { id: "vendor/rich", name: "Fresh Rich", context_length: 64000, top_provider: { max_completion_tokens: 4096 },
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0" },
      architecture: { input_modalities: ["text", "image", "file"] }, supported_parameters: ["tools"] },
    { id: "vendor/sparse", name: "Fresh Sparse" },
  ] } }));
  const runner = await connect(page);
  await page.goto("/settings?tab=pricing");
  await expect(page.getByRole("tab", { name: "Pricing", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute("data-state", "active");
  await page.getByRole("tab", { name: "OpenRouter", exact: true }).click();
  await expect(page.getByText("No models added. Browse the provider catalog above to choose models.")).toBeVisible();
  await page.getByLabel("API Key", { exact: true }).fill("fake-test-key");
  await page.getByRole("button", { name: "Browse OpenRouter models", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByText("Model details · 10 unknown", { exact: true }).click();
  for (const [field, value] of Object.entries({ contextWindowTokens: "64000", maxOutputTokens: "2048", inputUsdPer1M: "0", outputUsdPer1M: "1.5" })) {
    await page.locator(`[id="openrouter:vendor/sparse-${field}"]`).fill(value);
  }
  await page.locator('[id="openrouter:vendor/sparse-image"]').click();
  await page.getByRole("option", { name: "Yes (override)", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Enable Fresh Sparse" })).toBeChecked();
  const save = async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/^Saved successfully/)).toBeVisible();
  };
  await save();
  // Saved in the home: the row, the model details, and the key as a credential (never in config.json).
  const saved = readAiboardHomeSync(runner.location);
  expect(saved.config.providers.openrouter?.enabledModelIds).toContain("vendor/sparse");
  expect(saved.secret("credentials.providers.openrouter")).toBe("fake-test-key");
  expect(JSON.stringify(saved.config)).not.toContain("fake-test-key");
  await page.reload();
  await page.getByRole("tab", { name: "OpenRouter", exact: true }).click();
  await page.getByText("Model details · 5 unknown", { exact: true }).click();
  await expect(page.locator('[id="openrouter:vendor/sparse-contextWindowTokens"]')).toHaveValue("64000");
  await expect(page.locator('[id="openrouter:vendor/sparse-inputUsdPer1M"]')).toHaveValue("0");
  await page.locator('[id="openrouter:vendor/sparse-maxOutputTokens"]').fill("3072");
  await page.getByRole("switch").first().click();
  await expect(page.locator('[id="openrouter:vendor/sparse-maxOutputTokens"]')).toHaveValue("3072");
  await page.getByRole("button", { name: "Browse OpenRouter models", exact: true }).click();
  await save();
  await expect(page.locator('[id="openrouter:vendor/sparse-contextWindowTokens"]')).toHaveValue("64000");
  const sparseSettings = page.getByRole("group", { name: "Fresh Sparse settings", exact: true });
  await sparseSettings.getByText("Advanced Build settings", { exact: true }).click();
  await sparseSettings.getByLabel("Build reserve", { exact: true }).fill("1024");
  await sparseSettings.getByLabel("Input ceiling", { exact: true }).fill("60000");
  await sparseSettings.getByLabel("Long-context quality", { exact: true }).click();
  await page.getByRole("option", { name: "Excellent", exact: true }).click();
  await sparseSettings.getByLabel("Prompt caching", { exact: true }).check();
  await sparseSettings.getByRole("button", { name: "Save Build settings", exact: true }).click();
  await expect(sparseSettings.getByText("Build settings saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "OpenRouter", exact: true }).click();
  await sparseSettings.getByText("Advanced Build settings", { exact: true }).click();
  await expect(sparseSettings.getByLabel("Build reserve", { exact: true })).toHaveValue("1024");
  await expect(sparseSettings.getByLabel("Input ceiling", { exact: true })).toHaveValue("60000");
  await expect(sparseSettings.getByLabel("Long-context quality", { exact: true })).toContainText("Excellent");
  await expect(sparseSettings.getByLabel("Prompt caching", { exact: true })).toBeChecked();
  await sparseSettings.getByRole("button", { name: "Reset Build settings", exact: true }).click();
  await expect(sparseSettings.getByText("Build settings reset", { exact: true })).toBeVisible();
  await sparseSettings.getByText("Model details · 5 unknown", { exact: true }).click();
  await expect(page.locator('[id="openrouter:vendor/sparse-contextWindowTokens"]')).toHaveValue("64000");
  await expect(page.locator('[id="openrouter:vendor/sparse-inputUsdPer1M"]')).toHaveValue("0");
  await sparseSettings.getByRole("button", { name: "Reset pricing overrides", exact: true }).click();
  await expect(page.locator('[id="openrouter:vendor/sparse-inputUsdPer1M"]')).toHaveValue("");
  await save();
  await page.reload();
  await page.getByRole("tab", { name: "OpenRouter", exact: true }).click();
  await sparseSettings.getByText("Model details · 7 unknown", { exact: true }).click();
  await expect(page.locator('[id="openrouter:vendor/sparse-contextWindowTokens"]')).toHaveValue("64000");
  await expect(page.locator('[id="openrouter:vendor/sparse-inputUsdPer1M"]')).toHaveValue("");
  await page.getByRole("button", { name: "Remove Fresh Rich", exact: true }).click();
  await save();
  await page.reload();
  await page.getByRole("tab", { name: "OpenRouter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Fresh Sparse", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable Fresh Rich" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("switching OpenAI connection methods preserves enabled state and hydrates old model details", async ({ page }) => {
  let catalogRequests = 0;
  let modelReferenceRequests = 0;
  await page.route("https://models.dev/api.json", (route) => route.fulfill({headers:{"access-control-allow-origin":"*"},json:{openai:{models:{
    "gpt-6.1-sol":{id:"gpt-6.1-sol",cost:{input:2,output:10,cache_read:0.1}},
  }}}}));
  await page.route("https://models.dev/models.json", (route) => {
    modelReferenceRequests++;
    expect(route.request().headers()["authorization"]).toBeUndefined();
    expect(route.request().headers()["x-runner-token"]).toBeUndefined();
    return route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: {
      "openai/gpt-6.1-sol": { id: "openai/gpt-6.1-sol", limit: { context: 1050000, output: 128000 },
        modalities: { input: ["text", "image", "pdf"] }, cost: { input: 99, output: 99 } },
    } });
  });
  await page.route(`http://127.0.0.1:${PEER.port}/providers/chatgpt/**`, (route) => {
    // The account peer is reached with the launcher's peer session token (OD-32), never a saved token.
    expect(route.request().headers()["x-runner-token"]).toBe(PEER.sessionToken);
    if (route.request().url().endsWith("/status")) return route.fulfill({ json: { runnerVersion: 26, connected: true, accounts: [] } });
    if (route.request().url().endsWith("/models")) {
      catalogRequests++;
      return route.fulfill({ json: { data: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", context_window: 500000, max_context_window: 872000, input_modalities: ["text", "image"] }] } });
    }
    return route.fulfill({ json: {} });
  });
  // An existing home: OpenAI with a key, ChatGPT in subscription mode with saved model details.
  const runner = await connect(page, { accounts: true, ops: [
    { path: "providers.openai", op: "set", value: { enabled: true, models: [], enabledModelIds: [], defaultModel: null } },
    { path: "credentials.providers.openai", op: "set", value: { secret: "fake-api-key" } },
    { path: "providers.chatgpt", op: "set", value: { enabled: true, models: ["gpt-6.1-sol"], enabledModelIds: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol" } },
    { path: "openAIConnectionMode", op: "set", value: "subscription" },
    { path: "settings.discoveredModelMetadata.chatgpt:gpt-6.1-sol", op: "set", value: { image: false, document: false, audio: false, video: false, reportedFields: [],
      source: "provider-models", overrides: { inputUsdPer1M: 2, outputUsdPer1M: 10, cachedInputUsdPer1M: 0.1 } } },
  ] });
  await page.goto("/settings");
  const connection = page.getByLabel("Connection method", { exact: true });
  const enabled = page.getByRole("switch", { name: "Enabled", exact: true });
  await expect(connection).toContainText("ChatGPT subscription");
  await expect(page.getByRole("link", { name: /^Download standalone account runner v\d+ \(ZIP\)$/ })).toHaveAttribute("href", "/aiboard-account-provider-runner.zip");
  await expect(enabled).toBeChecked();
  await page.getByText("Model details · 1 unknown", { exact: true }).click();
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-contextWindowTokens"]')).toHaveAttribute("placeholder", "500000");
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-image"]')).toContainText("Catalog: Yes");
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-inputUsdPer1M"]')).toHaveValue("2");
  await page.getByRole("button", { name: "Browse OpenAI — ChatGPT subscription models", exact: true }).click();
  await expect(page.getByText(/Filled 1 missing model specifications/)).toBeVisible();
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-contextWindowTokens"]')).toHaveAttribute("placeholder", "500000");
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-maxOutputTokens"]')).toHaveAttribute("placeholder", "128000");
  await expect(page.getByText(/API-equivalent estimates show what/)).toBeVisible();
  await expect(page.getByText(/API-equivalent reference: openai:gpt-6.1-sol/)).toBeVisible();
  await expect(page.getByText(/These specifications are not confirmed subscription limits/)).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved successfully", { exact: true })).toBeVisible();
  const initialCatalogRequests = catalogRequests;
  expect(initialCatalogRequests).toBeGreaterThan(0);
  const chooseMode = async (name: string) => {
    await connection.click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await chooseMode("API key");
  await expect(enabled).toBeChecked();
  await chooseMode("ChatGPT subscription");
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(page.getByText("Provider disabled", { exact: true })).toBeVisible();
  await chooseMode("API key");
  await expect(enabled).toBeChecked();
  await chooseMode("ChatGPT subscription");
  await expect(enabled).not.toBeChecked();
  await enabled.click();
  await expect(page.getByText("Provider enabled", { exact: true })).toBeVisible();
  expect(readAiboardHomeSync(runner.location).config.providers.chatgpt?.enabled).toBe(true);
  expect(readAiboardHomeSync(runner.location).secret("credentials.providers.chatgpt")).toBeUndefined();
  await page.reload();
  await expect(connection).toContainText("ChatGPT subscription");
  await expect(enabled).toBeChecked();
  await page.getByText("Model details · Complete", { exact: true }).click();
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-contextWindowTokens"]')).toHaveAttribute("placeholder", "500000");
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-maxOutputTokens"]')).toHaveAttribute("placeholder", "128000");
  await expect(page.locator('[id="chatgpt:gpt-6.1-sol-inputUsdPer1M"]')).toHaveValue("2");
  expect(catalogRequests).toBe(initialCatalogRequests);
  expect(modelReferenceRequests).toBe(1);
});

test("custom and Foundry providers keep local pricing controls", async ({ page }) => {
  // Foundry's endpoint is a loopback stub, so the live-capability sync after Save reaches no real host.
  const foundry = await upstream((_request, response) => sendJson(response, { data: [] }));
  const runner = await connect(page);
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Custom", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Local model");
  await page.getByLabel("Model id", { exact: true }).fill("local-test");
  await page.getByLabel("Base URL", { exact: true }).fill("http://localhost:11434/v1");
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.locator("summary").filter({ hasText: /^Pricing$/ }).click();
  await page.getByLabel("Input / 1M", { exact: true }).fill("0");
  await page.getByLabel("Output / 1M", { exact: true }).fill("1.5");
  await page.getByLabel("Cached input / 1M", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save pricing override", exact: true }).click();
  await expect(page.getByText("Pricing override saved", { exact: true })).toBeVisible();
  const custom = readAiboardHomeSync(runner.location).config.customModels.find((model) => model.model === "local-test");
  expect(custom).toBeDefined();
  await page.reload();
  await page.getByRole("tab", { name: "Custom", exact: true }).click();
  await page.locator("summary").filter({ hasText: /^Pricing$/ }).click();
  await expect(page.getByLabel("Input / 1M", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Output / 1M", { exact: true })).toHaveValue("1.5");
  await expect(page.getByLabel("Cached input / 1M", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "Reset pricing override", exact: true }).click();
  await expect(page.getByText("Pricing override reset", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Input / 1M", { exact: true })).toHaveValue("");
  await page.getByRole("tab", { name: "Anthropic (Azure Foundry)", exact: true }).click();
  await page.getByLabel("API Key", { exact: true }).fill("fake-foundry-key");
  await page.getByLabel("Foundry endpoint (base URL)", { exact: true }).fill(`${foundry.base}/anthropic/`);
  await page.getByLabel("Model ids (one per line)", { exact: true }).fill("foundry-test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved successfully", { exact: true })).toBeVisible();
  await page.getByText("Pricing and context settings", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Save pricing override", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save context override", exact: true })).toBeVisible();
});

test("Copilot's catalog goes through the launcher's account peer and its models are saved in the home", async ({ page }) => {
  let accepted = 0;
  await page.route(`http://127.0.0.1:${PEER.port}/providers/github-copilot/**`, (route) => {
    if (!route.request().url().endsWith("/models")) return route.fulfill({ json: {} });
    if (route.request().headers()["x-runner-token"] !== PEER.sessionToken) {
      return route.fulfill({ status: 401, json: { error: "Unauthorized runner token" } });
    }
    accepted++;
    return route.fulfill({ json: { data: [{ id: "auto", name: "Auto", input_modalities: ["text"] }] } });
  });
  const runner = await connect(page, { accounts: true });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "GitHub Copilot", exact: true }).click();
  await expect(page.getByRole("link", { name: /^Download standalone account runner v\d+ \(ZIP\)$/ })).toHaveAttribute("href", "/aiboard-account-provider-runner.zip");
  await page.getByLabel("Model ids", { exact: true }).fill("auto");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved successfully/)).toBeVisible();
  await expect(page.getByText(/^Could not verify saved model details:/)).toHaveCount(0);
  await page.getByRole("button", { name: "Browse GitHub Copilot models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh GitHub Copilot catalog", exact: true })).toBeVisible();
  expect(accepted).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved successfully/)).toBeVisible();
  const home = readAiboardHomeSync(runner.location);
  expect(home.config.providers["github-copilot"]?.models).toContain("auto");
  expect(home.secret("credentials.providers.github-copilot")).toBeUndefined();
  await page.reload();
  await page.getByRole("tab", { name: "GitHub Copilot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Auto", exact: true })).toBeVisible();
  await expect(page.getByText(/^Could not verify saved model details:/)).toHaveCount(0);
});

test("Browse enriches Gemini details in the browser through the model proxy and keeps source labels and edits", async ({ page }) => {
  let referenceRequests = 0;
  // Gemini's catalog goes through the Runner's model proxy, which adds the home's key.
  const google = await upstream((request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1beta/models")) {
      return sendJson(response, { models: [
        { name: "models/gemini-current", displayName: "Gemini Current", inputTokenLimit: 1000000, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
      ] });
    }
    sendJson(response, { error: { message: `unexpected ${request.method} ${request.url}` } }, 404);
  });
  await page.route("https://models.dev/api.json", (route) => {
    referenceRequests++;
    expect(route.request().headers()["authorization"]).toBeUndefined();
    expect(route.request().headers()["x-goog-api-key"]).toBeUndefined();
    return route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { google: { models: {
      "gemini-current": { id: "gemini-current", cost: { input: 1, output: 2, cache_read: 0.2 },
        limit: { context: 256000, output: 4096 }, modalities: { input: ["text", "image", "pdf", "audio", "video"] }, last_updated: "2026-10-19" },
      "reference-only": { id: "reference-only", cost: { input: 1, output: 2 } },
    } } } });
  });
  const runner = await connect(page, { ops: [{ path: "providers.google", op: "set", value: { enabled: true, baseUrl: google.base } }] });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
  await page.getByLabel("API Key", { exact: true }).fill("fake-gemini-key");
  await page.getByRole("button", { name: "Browse Google Gemini models", exact: true }).click();
  await expect(page.getByText(/Filled 8 missing model details from Models.dev/)).toBeVisible();
  await expect(page.getByText("reference-only", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Model details · Complete", { exact: true }).click();
  await expect(page.locator('[id="google:gemini-current-contextWindowTokens"]')).toHaveAttribute("placeholder", "1000000");
  await expect(page.locator('[id="google:gemini-current-maxOutputTokens"]')).toHaveAttribute("placeholder", "65536");
  await expect(page.locator('[id="google:gemini-current-inputUsdPer1M"]')).toHaveAttribute("placeholder", "1");
  await expect(page.getByText("Models.dev reference: 1", { exact: true })).toBeVisible();
  await page.locator('[id="google:gemini-current-inputUsdPer1M"]').fill("1.5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved successfully", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Google Gemini", exact: true }).click();
  await page.getByText("Model details · Complete", { exact: true }).click();
  await expect(page.locator('[id="google:gemini-current-inputUsdPer1M"]')).toHaveValue("1.5");
  await expect(page.getByText("Models.dev reference: 1", { exact: true })).toBeVisible();
  await expect(page.locator('[id="google:gemini-current-image"]')).toContainText("Models.dev: Yes");
  // Saving without browsing refreshes the provider's metadata; references and overrides survive.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved successfully/)).toBeVisible();
  await expect(page.locator('[id="google:gemini-current-inputUsdPer1M"]')).toHaveValue("1.5");
  await expect(page.getByText("Models.dev reference: 1", { exact: true })).toBeVisible();
  expect(referenceRequests).toBe(1);
  // Browse saved the typed key first; every catalog call carried it from the home, through the proxy.
  expect(readAiboardHomeSync(runner.location).secret("credentials.providers.google")).toBe("fake-gemini-key");
  expect(google.requests.length).toBeGreaterThan(0);
  for (const request of google.requests) expect(request.headers["x-goog-api-key"]).toBe("fake-gemini-key");
});
