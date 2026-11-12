/*
 * Capability Lab probes NVIDIA NIM through the Runner's model proxy (HM4a, OD-32).
 * Run: npx tsx scripts/test-nvidia-capability-lab.mts
 *
 * NVIDIA used to be probed through the account peer with its key in the body; this script pinned that.
 * Since HM4a the probe is an OpenAI-compatible call to the proxy, which adds the key from the AIBoard
 * home, so the browser holds no NVIDIA key. A stub Runner and a stub upstream answer.
 */
import type { ProviderKey } from "../lib/db/schema";
import { runCapabilityProbes } from "../lib/client/capability-api";
import { NVIDIA_PROVIDER_ID } from "../lib/client/providers";
import { __resetClientStoreForTests } from "../lib/client/store";
import { installStubRunner, STUB_PROXY_URL } from "./model-proxy-test-support.mts";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = new Date().toISOString();
const row: ProviderKey = {
  providerId: NVIDIA_PROVIDER_ID, baseURL: null, runnerToken: null, models: ["nvidia:z-ai/glm-5.2"], enabledModelIds: null,
  defaultModel: "z-ai/glm-5.2", enabled: true, keyHint: null, lastValidationSucceeded: null, lastValidatedAt: null, updatedAt: now,
};
__resetClientStoreForTests({ providerKeys: [row] } as never);
const stub = installStubRunner({
  proxyTokens: ["proxy_lab-stub"],
  upstream: () => new Response(
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "AIBOARD_TEXT_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ),
});
try {
  const profile = await runCapabilityProbes({ fullModelId: "nvidia:z-ai/glm-5.2", probeIds: ["text"] });
  check(
    "Capability Lab resolves user-defined NVIDIA models",
    profile.fullModelId === "nvidia:z-ai/glm-5.2" && profile.providerId === "nvidia" && profile.results[0]?.status === "pass",
    profile,
  );
  const request = stub.requests[0];
  const body = request ? JSON.parse(request.body) as { model?: string; apiKey?: string } : {};
  check(
    "Capability Lab sends NVIDIA probes to the model proxy with the proxy token and no key",
    request?.url === `${STUB_PROXY_URL}/v2/model-proxy/nvidia/chat/completions` &&
      request.headers.get("authorization") === "Bearer proxy_lab-stub" &&
      !request.headers.has("x-runner-token") && body.apiKey === undefined && body.model === "z-ai/glm-5.2",
    { url: request?.url, body },
  );
} finally {
  stub.restore();
}

console.log(failures === 0 ? "PASS" : `FAIL ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
