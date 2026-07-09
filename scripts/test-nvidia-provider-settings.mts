/* NVIDIA provider settings regression (run: npx tsx scripts/test-nvidia-provider-settings.mts) */
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { ProviderKey } from "../lib/db/schema";
import {
  type loadProviders,
  type saveProviderKey,
  type validateProvider,
} from "../lib/client/settings-api";
import {
  type listNvidiaModelInfos,
  type normalizeNvidiaModelId,
} from "../lib/client/providers";

let failures = 0;

const require = createRequire(import.meta.url);
const settingsApi = require("../lib/client/settings-api") as {
  loadProviders: typeof loadProviders;
  saveProviderKey: typeof saveProviderKey;
  validateProvider: typeof validateProvider;
};
const providerApi = require("../lib/client/providers") as {
  NVIDIA_PROVIDER_ID: string;
  listNvidiaModelInfos: typeof listNvidiaModelInfos;
  normalizeNvidiaModelId: typeof normalizeNvidiaModelId;
};
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: () => void;
  getProviderKey: (providerId: string) => ProviderKey | undefined;
};

const {
  NVIDIA_PROVIDER_ID,
  listNvidiaModelInfos,
  normalizeNvidiaModelId,
} = providerApi;
const { loadProviders, saveProviderKey, validateProvider } = settingsApi;
const { __resetClientStoreForTests, getProviderKey } = storeApi;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw) as Record<string, unknown>;
}

async function withRunnerStub(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

__resetClientStoreForTests();

check(
  "raw NVIDIA model id is preserved",
  normalizeNvidiaModelId("z-ai/glm-5.2") === "z-ai/glm-5.2",
  normalizeNvidiaModelId("z-ai/glm-5.2")
);

check(
  "full NVIDIA model id is normalized to provider-local id",
  normalizeNvidiaModelId("nvidia:z-ai/glm-5.2") === "z-ai/glm-5.2",
  normalizeNvidiaModelId("nvidia:z-ai/glm-5.2")
);

saveProviderKey({
  providerId: NVIDIA_PROVIDER_ID,
  apiKey: "nvapi-test-provider-key",
  runnerToken: "local-runner-token",
  baseURL: " http://127.0.0.1:1455 ",
  models: [" nvidia:z-ai/glm-5.2 ", "deepseek-ai/deepseek-v4-flash"],
  defaultModel: "z-ai/glm-5.2",
  enabled: true,
});

const saved = getProviderKey(NVIDIA_PROVIDER_ID);
const loaded = loadProviders().providers.find(
  (provider) => provider.providerId === NVIDIA_PROVIDER_ID
);
const modelInfos = listNvidiaModelInfos();

check(
  "NVIDIA provider stores API key separately from local runner token",
  saved?.apiKey === "nvapi-test-provider-key" &&
    saved?.runnerToken === "local-runner-token" &&
    saved.keyHint !== saved.runnerTokenHint,
  saved
);

check(
  "NVIDIA provider persists runner URL and runner token hint for Settings",
  loaded?.baseURL === "http://127.0.0.1:1455" &&
    loaded.runnerTokenHint === saved?.runnerTokenHint,
  loaded
);

check(
  "NVIDIA user-defined models are normalized and shown in Settings",
  modelInfos.length === 2 &&
    modelInfos[0].id === "z-ai/glm-5.2" &&
    modelInfos[1].id === "deepseek-ai/deepseek-v4-flash" &&
    loaded?.models.some((model) => model.id === "z-ai/glm-5.2"),
  { modelInfos, loadedModels: loaded?.models }
);

let validationRequestBody: Record<string, unknown> | undefined;
const validationRunner = await withRunnerStub(async (req, res) => {
  validationRequestBody = await readBody(req);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  res.write(sseEvent({ type: "token", content: "AIBOARD_TEXT_OK" }));
  res.write(sseEvent({ type: "done" }));
  res.end();
});

try {
  saveProviderKey({
    providerId: NVIDIA_PROVIDER_ID,
    apiKey: "nvapi-test-provider-key",
    runnerToken: "local-runner-token",
    baseURL: validationRunner.url,
    models: ["z-ai/glm-5.2"],
    defaultModel: "z-ai/glm-5.2",
    enabled: true,
  });

  const result = await validateProvider({ providerId: NVIDIA_PROVIDER_ID });
  const validationAttachments = validationRequestBody?.attachments as unknown[] | undefined;

  check(
    "NVIDIA Settings test skips image probe for text-only models",
    result.valid &&
      result.usedImage === false &&
      validationRequestBody?.model === "z-ai/glm-5.2" &&
      Array.isArray(validationAttachments) &&
      validationAttachments.length === 0,
    { result, validationRequestBody }
  );
} finally {
  await validationRunner.close();
}

let stalledRunnerSawClose = false;
const stalledRunner = await withRunnerStub(async (req, res) => {
  await readBody(req);
  res.on("close", () => {
    stalledRunnerSawClose = true;
  });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  res.write(sseEvent({ type: "token", content: "" }));
});

try {
  saveProviderKey({
    providerId: NVIDIA_PROVIDER_ID,
    apiKey: "nvapi-test-provider-key",
    runnerToken: "local-runner-token",
    baseURL: stalledRunner.url,
    models: ["z-ai/glm-5.2"],
    defaultModel: "z-ai/glm-5.2",
    enabled: true,
  });

  const timedResult = await Promise.race([
    (validateProvider as (...args: unknown[]) => Promise<{ valid: boolean; error?: string }>)(
      { providerId: NVIDIA_PROVIDER_ID },
      { timeoutMs: 50 }
    ),
    new Promise<{ valid: false; error: string }>((resolve) =>
      setTimeout(() => resolve({ valid: false, error: "test timed out" }), 500)
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));

  check(
    "NVIDIA Settings test times out and aborts stalled streams",
    timedResult.valid === false &&
      /timed out/i.test(timedResult.error ?? "") &&
      stalledRunnerSawClose,
    { timedResult, stalledRunnerSawClose }
  );
} finally {
  await stalledRunner.close();
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
