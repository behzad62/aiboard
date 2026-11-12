/*
 * Capability Lab probes NVIDIA NIM through the Runner's model proxy (HM4a, OD-32).
 * Run: npx tsx scripts/test-nvidia-capability-lab.mts
 *
 * NVIDIA used to be probed through the account peer with its key in the body; this script pinned that.
 * Since HM4a the probe is an OpenAI-compatible call to the proxy, which adds the key from the AIBoard
 * home, so the browser holds no NVIDIA key. A stub Runner and a stub upstream answer.
 */
import { runCapabilityProbes } from "../lib/client/capability-api";
import { NVIDIA_PROVIDER_ID } from "../lib/client/providers";
import { __resetClientStoreForTests } from "../lib/client/store";
import { STUB_PROXY_URL } from "./model-proxy-test-support.mts";
import { connectStubHome, removeStubHomes } from "./home-test-support.mts";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

__resetClientStoreForTests({});
// The NVIDIA row lives in the AIBoard home (HM4b), and the probe's profile is saved there.
const stub = await connectStubHome({
  seed: [{ path: `providers.${NVIDIA_PROVIDER_ID}`, op: "set", value: { models: ["nvidia:z-ai/glm-5.2"], defaultModel: "z-ai/glm-5.2", enabled: true } }],
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
  removeStubHomes();
}

console.log(failures === 0 ? "PASS" : `FAIL ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
