import { test, expect } from "@playwright/test";

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
  await page.route("http://127.0.0.1:1455/providers/chatgpt/**", (route) => {
    if (route.request().url().endsWith("/status")) return route.fulfill({ json: { runnerVersion: 26, connected: true, accounts: [] } });
    if (route.request().url().endsWith("/models")) {
      catalogRequests++;
      return route.fulfill({ json: { data: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", context_window: 500000, max_context_window: 872000, input_modalities: ["text", "image"] }] } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/settings");
  await expect(page.getByLabel("Connection method", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ai-discussion-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const seeded = { providerKeys: [
      { providerId: "openai", apiKey: "fake-api-key", enabled: true, models: [], enabledModelIds: [], defaultModel: null },
      { providerId: "chatgpt", apiKey: "fake-runner-token", keyHint: "fake", baseURL: "http://127.0.0.1:1455", enabled: true,
        models: ["gpt-6.1-sol"], enabledModelIds: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol" },
    ], userSettings: { id: "default", defaultEffort: "medium", defaultMode: "chat", chatDefaultApplied: true,
      judgeModelId: null, modelContextOverrides: {}, openAIConnectionMode: "subscription", discoveredModelMetadata: {
      "chatgpt:gpt-6.1-sol": { image: false, document: false, audio: false, video: false, reportedFields: [],
        source: "provider-models", overrides: { inputUsdPer1M: 2, outputUsdPer1M: 10, cachedInputUsdPer1M: 0.1 } },
    } } };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("kv", "readwrite");
      transaction.objectStore("kv").put(JSON.stringify(seeded), "store");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  await page.reload();
  const connection = page.getByLabel("Connection method", { exact: true });
  const enabled = page.getByRole("switch", { name: "Enabled", exact: true });
  await expect(connection).toContainText("ChatGPT subscription");
  await expect(page.getByRole("link", { name: "Download account runner v28 (ZIP)", exact: true })).toHaveAttribute("href", "/aiboard-account-provider-runner.zip");
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
  await page.getByLabel("Foundry endpoint (base URL)", { exact: true }).fill("https://example.services.ai.azure.com/anthropic/");
  await page.getByLabel("Model ids (one per line)", { exact: true }).fill("foundry-test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved successfully", { exact: true })).toBeVisible();
  await page.getByText("Pricing and context settings", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Save pricing override", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save context override", exact: true })).toBeVisible();
});

test("Copilot catalog recovery uses the entered runner token and clears stale saved-token errors", async ({ page }) => {
  let accepted = 0;
  await page.route("http://127.0.0.1:1455/providers/github-copilot/**", (route) => {
    if (!route.request().url().endsWith("/models")) return route.fulfill({ json: {} });
    if (route.request().headers()["x-runner-token"] !== "current-test-token") {
      return route.fulfill({ status: 401, json: { error: "Unauthorized runner token" } });
    }
    accepted++;
    return route.fulfill({ json: { data: [{ id: "auto", name: "Auto", input_modalities: ["text"] }] } });
  });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "GitHub Copilot", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download account runner v28 (ZIP)", exact: true })).toHaveAttribute("href", "/aiboard-account-provider-runner.zip");
  await page.getByLabel("Account runner URL", { exact: true }).fill("http://127.0.0.1:1455");
  await page.getByLabel("Runner session token", { exact: true }).fill("expired-test-token");
  await page.getByLabel("Model ids", { exact: true }).fill("auto");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Could not verify saved model details:.*Runner session token was rejected/)).toBeVisible();
  await page.getByLabel("Runner session token", { exact: true }).fill("current-test-token");
  await expect(page.getByText(/^Could not verify saved model details:/)).toHaveCount(0);
  await page.getByRole("button", { name: "Browse GitHub Copilot models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh GitHub Copilot catalog", exact: true })).toBeVisible();
  await expect(page.getByText(/Runner session token was rejected/)).toHaveCount(0);
  expect(accepted).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved successfully", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "GitHub Copilot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Auto", exact: true })).toBeVisible();
  await expect(page.getByText(/^Could not verify saved model details:/)).toHaveCount(0);
});

test("Browse enriches Gemini details directly in the browser and keeps source labels and edits", async ({ page }) => {
  let referenceRequests = 0;
  await page.route("https://generativelanguage.googleapis.com/**", (route) => route.fulfill({ json: { models: [
    { name: "models/gemini-current", displayName: "Gemini Current", inputTokenLimit: 1000000, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] },
  ] } }));
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
});
