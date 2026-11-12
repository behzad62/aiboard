/*
 * NVIDIA NIM behind the model proxy (HM4a, OD-32). Run: npx tsx scripts/test-nvidia-provider-settings.mts
 *
 * NVIDIA used to go through the account peer with its key in each request body; this script pinned that.
 * Since HM4a it is an OpenAI-compatible provider behind the Runner's model proxy, which adds the key
 * from the AIBoard home, so chat, the catalog and validation work with no key in the browser.
 * A stub Runner and a stub upstream answer; no real key or provider is involved.
 */
import type { ProviderKey } from "../lib/db/schema";
import { fetchProviderModelCatalog, validateProvider } from "../lib/client/settings-api";
import {
  getEnabledModels,
  listNvidiaModelInfos,
  normalizeNvidiaModelId,
  NVIDIA_PROVIDER_ID,
  withProviderConnection,
} from "../lib/client/providers";
import { __resetClientStoreForTests } from "../lib/client/store";
import { nvidiaProvider } from "../lib/providers/nvidia";
import { getProviderDefinition } from "../lib/providers/provider-registry";
import { installStubRunner, json, STUB_PROXY_URL, type StubRequest } from "./model-proxy-test-support.mts";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const NVIDIA_PROXY = `${STUB_PROXY_URL}/v2/model-proxy/nvidia`;
const PROXY_TOKEN = "proxy_nvidia-stub-token";

function sse(chunks: string[]): Response {
  const body = [
    ...chunks.map((content) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`),
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const now = new Date().toISOString();
// An enabled NVIDIA row with no key: the key lives in the AIBoard home.
const nvidiaRow: ProviderKey = {
  providerId: NVIDIA_PROVIDER_ID, baseURL: null, runnerToken: null, models: ["nvidia:z-ai/glm-5.2", "deepseek-ai/deepseek-v4-flash"],
  enabledModelIds: null, defaultModel: "z-ai/glm-5.2", enabled: true, keyHint: null, lastValidationSucceeded: null, lastValidatedAt: null, updatedAt: now,
};
__resetClientStoreForTests({ providerKeys: [nvidiaRow] } as never);

check("raw NVIDIA model id is preserved", normalizeNvidiaModelId("z-ai/glm-5.2") === "z-ai/glm-5.2");
check("full NVIDIA model id is normalized to provider-local id", normalizeNvidiaModelId("nvidia:z-ai/glm-5.2") === "z-ai/glm-5.2");
check(
  "NVIDIA user-defined models are listed and enabled with no key in the browser",
  listNvidiaModelInfos().map((model) => model.id).join(",") === "z-ai/glm-5.2,deepseek-ai/deepseek-v4-flash" &&
    getEnabledModels().filter((model) => model.providerId === NVIDIA_PROVIDER_ID).length === 2,
  { listed: listNvidiaModelInfos().map((model) => model.id), enabled: getEnabledModels().map((model) => model.id) },
);
const definition = getProviderDefinition(NVIDIA_PROVIDER_ID);
check(
  "NVIDIA has no account-peer URL, runner token or runner download in Settings (OD-32)",
  !definition?.baseURLField && !definition?.runnerTokenField && !definition?.runnerDownload && !definition?.accountRunner &&
    definition?.connection?.transport === "openai-compatible" && definition.modelDiscovery?.source === "provider-api",
  definition,
);

function noKeyLeaves(requests: StubRequest[]): boolean {
  return requests.every((request) =>
    request.url.startsWith(`${NVIDIA_PROXY}/`) &&
    request.headers.get("authorization") === `Bearer ${PROXY_TOKEN}` &&
    !/nvapi-|"apiKey"/.test(request.body) &&
    !request.headers.has("x-runner-token"));
}

// Chat: the same resolver path the discussion engine takes.
{
  const stub = installStubRunner({ proxyTokens: [PROXY_TOKEN], upstream: () => sse(["NVIDIA ", "reply"]) });
  try {
    const params = await withProviderConnection(NVIDIA_PROVIDER_ID, {
      model: "z-ai/glm-5.2",
      messages: [{ role: "user" as const, content: "Say hello." }],
      maxTokens: 32,
    });
    let text = "";
    for await (const chunk of nvidiaProvider.streamChat(params)) if (chunk.type === "token") text += chunk.content ?? "";
    const request = stub.requests[0];
    const body = request ? JSON.parse(request.body) as { model?: string; max_tokens?: number; stream?: boolean } : {};
    check(
      "NVIDIA chat streams through the proxy's chat/completions with the proxy token and no key",
      text === "NVIDIA reply" && request?.url === `${NVIDIA_PROXY}/chat/completions` && request.method === "POST" &&
        body.model === "z-ai/glm-5.2" && body.max_tokens === 32 && body.stream === true && noKeyLeaves(stub.requests),
      { text, requests: stub.requests.map((entry) => entry.url), body },
    );
  } finally {
    stub.restore();
  }
}

// Catalog: GET models through the proxy.
{
  const stub = installStubRunner({
    proxyTokens: [PROXY_TOKEN],
    upstream: () => json({ object: "list", data: [{ id: "z-ai/glm-5.2", object: "model", created: 1_700_000_000, owned_by: "z-ai" }, { id: "minimaxai/minimax-m3", object: "model", created: 1_700_000_100, owned_by: "minimaxai" }] }),
  });
  try {
    const catalog = await fetchProviderModelCatalog({ providerId: NVIDIA_PROVIDER_ID });
    check(
      "NVIDIA catalog comes from the proxy's models with no key in the browser",
      catalog.map((model) => model.id).join(",") === "minimaxai/minimax-m3,z-ai/glm-5.2" &&
        stub.requests.length === 1 && stub.requests[0]!.method === "GET" && stub.requests[0]!.url === `${NVIDIA_PROXY}/models` &&
        noKeyLeaves(stub.requests),
      { catalog: catalog.map((model) => model.id), requests: stub.requests.map((entry) => `${entry.method} ${entry.url}`) },
    );
  } finally {
    stub.restore();
  }
}

// Validation: a model test through the proxy; a text-only model gets no image probe.
{
  const stub = installStubRunner({ proxyTokens: [PROXY_TOKEN], upstream: () => sse(["AIBOARD_TEXT_OK"]) });
  try {
    const result = await validateProvider({ providerId: NVIDIA_PROVIDER_ID });
    const body = stub.requests[0] ? JSON.parse(stub.requests[0].body) as { model?: string; messages?: Array<{ content?: unknown }> } : {};
    const sentImage = JSON.stringify(body.messages ?? []).includes("image_url");
    check(
      "NVIDIA validation tests through the proxy, skips the image probe for a text-only model, and holds no key",
      result.valid && result.usedImage === false && body.model === "z-ai/glm-5.2" && !sentImage && stub.requests.length === 1 && noKeyLeaves(stub.requests),
      { result, requests: stub.requests.map((entry) => entry.url) },
    );
  } finally {
    stub.restore();
  }
}

// A stalled stream: the test times out and aborts the request.
{
  let sawAbort = false;
  const stub = installStubRunner({
    proxyTokens: [PROXY_TOKEN],
    upstream: (request) => {
      request.signal?.addEventListener("abort", () => { sawAbort = true; }, { once: true });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const timed = await Promise.race([
      validateProvider({ providerId: NVIDIA_PROVIDER_ID }, { timeoutMs: 50 }),
      new Promise<{ valid: false; error: string }>((resolve) => setTimeout(() => resolve({ valid: false, error: "test timed out" }), 2_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      "NVIDIA validation times out and aborts a stalled stream",
      timed.valid === false && /timed out/i.test(timed.error ?? "") && timed.error !== "test timed out" && sawAbort,
      { timed, sawAbort },
    );
  } finally {
    stub.restore();
  }
}

console.log(failures === 0 ? "PASS" : `FAIL ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
