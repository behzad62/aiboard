/* Provider model-discovery + Meta/Gemini registry checks (run: npx tsx scripts/test-provider-model-discovery.mts) */
import { getAllProviders } from "../lib/client/providers";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { googleSamplingConfig } from "../lib/providers/google";
import { collectGoogleModelCatalog } from "../lib/client/settings-api";
import { readFile } from "node:fs/promises";
import {
  getProviderDefinition,
  PROVIDER_IDS,
} from "../lib/providers/provider-registry";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const providers = getAllProviders();
check(
  "Meta provider is registered in the live client registry",
  PROVIDER_IDS.includes("meta" as never) && providers.some((provider) => provider.id === "meta"),
  { providerIds: PROVIDER_IDS, providers: providers.map((provider) => provider.id) }
);

const gemini38 = MODEL_CATALOG.find(
  (model) => model.providerId === "google" && model.id === "gemini-3.8-flash"
);
check(
  "Google catalog contains Gemini 3.8 Flash as the validation candidate",
  !!gemini38 && gemini38.validationCandidate === true &&
    gemini38.capabilities.image && gemini38.capabilities.document &&
    gemini38.capabilities.audio && gemini38.capabilities.video,
  gemini38
);
check(
  "Gemini 3.8 Flash strips deprecated sampling parameters",
  Object.keys(googleSamplingConfig("gemini-3.8-flash", 0.2)).length === 0,
  googleSamplingConfig("gemini-3.8-flash", 0.2)
);


const googlePager = {
  async *[Symbol.asyncIterator]() {
    yield { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", thinking: true, supportedActions: ["generateContent"] };
    yield { name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", supportedActions: ["generateContent"] };
    yield { name: "models/text-embedding-004", displayName: "Embedding", supportedActions: ["embedContent"] };
  },
};
const nativeGoogleCatalog = await collectGoogleModelCatalog(googlePager);
check(
  "Google native model discovery normalizes base-model resources and filters non-generative models",
  nativeGoogleCatalog.map((model) => model.id).join(",") === "gemini-3.6-flash,gemini-3.8-flash" &&
    nativeGoogleCatalog.find((model) => model.id === "gemini-3.8-flash")?.name === "Gemini 3.8 Flash" &&
    nativeGoogleCatalog.find((model) => model.id === "gemini-3.8-flash")?.supportsReasoning === true,
  nativeGoogleCatalog,
);
const settingsApiSource = await readFile(new URL("../lib/client/settings-api.ts", import.meta.url), "utf8");
const googleDispatch = settingsApiSource.match(
  /if \(input\.providerId === "google"\) \{([\s\S]*?)\n  \}/,
)?.[1] ?? "";
check(
  "Google live discovery uses the native Gemini model-list path instead of the OpenAI compatibility endpoint",
  googleDispatch.includes("fetchGoogleModelCatalog(apiKey)") &&
    !googleDispatch.includes("fetchOpenAICompatibleModelCatalog"),
  googleDispatch,
);
const discoverable = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "xai",
  "meta",
  "github-copilot",
  "nvidia",
] as const;
for (const providerId of discoverable) {
  const definition = getProviderDefinition(providerId);
  check(
    `${providerId} exposes live model discovery and user-added model ids`,
    definition?.modelDiscovery != null && definition.modelIdsField != null,
    definition
  );
}
const chatgptDefinition = getProviderDefinition("chatgpt");
check(
  "chatgpt exposes live account model discovery through the runner",
  chatgptDefinition?.modelDiscovery?.source === "runner" && chatgptDefinition.modelIdsField != null,
  chatgptDefinition?.modelDiscovery,
);
const foundryDefinition = getProviderDefinition("foundry");
check(
  "foundry does not claim live model discovery",
  foundryDefinition?.modelDiscovery == null,
  foundryDefinition?.modelDiscovery,
);

const metaCatalog = MODEL_CATALOG.filter((model) => model.providerId === "meta");
check(
  "Meta ships Muse Spark fallback while allowing live additions",
  metaCatalog.some((model) => model.id === "muse-spark-1.3"),
  metaCatalog.map((model) => model.id)
);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
