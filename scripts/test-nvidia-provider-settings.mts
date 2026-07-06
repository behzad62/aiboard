/* NVIDIA provider settings regression (run: npx tsx scripts/test-nvidia-provider-settings.mts) */
import { createRequire } from "node:module";
import type { ProviderKey } from "../lib/db/schema";
import {
  type loadProviders,
  type saveProviderKey,
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
const { loadProviders, saveProviderKey } = settingsApi;
const { __resetClientStoreForTests, getProviderKey } = storeApi;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
