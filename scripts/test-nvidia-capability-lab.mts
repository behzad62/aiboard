import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { runCapabilityProbes } from "../lib/client/capability-api";
import type { saveProviderKey } from "../lib/client/settings-api";

const require = createRequire(import.meta.url);
const capabilityApi = require("../lib/client/capability-api") as {
  runCapabilityProbes: typeof runCapabilityProbes;
};
const settingsApi = require("../lib/client/settings-api") as {
  saveProviderKey: typeof saveProviderKey;
};
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: () => void;
};
const providerApi = require("../lib/client/providers") as {
  NVIDIA_PROVIDER_ID: string;
};

let failures = 0;

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
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
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
      server.close();
      await once(server, "close");
    },
  };
}

async function main(): Promise<void> {
  let requestPath = "";
  let requestToken: string | string[] | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const runner = await withRunnerStub(async (req, res) => {
    requestPath = req.url ?? "";
    requestToken = req.headers["x-runner-token"];
    requestBody = await readBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write(sseEvent({ type: "token", content: "AIBOARD_TEXT_OK" }));
    res.write(sseEvent({ type: "done" }));
    res.end();
  });

  try {
    storeApi.__resetClientStoreForTests();
    settingsApi.saveProviderKey({
      providerId: providerApi.NVIDIA_PROVIDER_ID,
      apiKey: "nvapi-probe-key",
      runnerToken: "runner-probe-token",
      baseURL: runner.url,
      models: ["nvidia:z-ai/glm-5.2"],
      defaultModel: "z-ai/glm-5.2",
      enabled: true,
    });

    const profile = await capabilityApi.runCapabilityProbes({
      fullModelId: "nvidia:z-ai/glm-5.2",
      probeIds: ["text"],
    });

    check(
      "Capability Lab resolves user-defined NVIDIA models",
      profile.fullModelId === "nvidia:z-ai/glm-5.2" &&
        profile.providerId === "nvidia" &&
        profile.results[0]?.status === "pass",
      profile
    );
    check(
      "Capability Lab sends NVIDIA probes through the local provider runner",
      requestPath === "/providers/nvidia/chat" &&
        requestToken === "runner-probe-token" &&
        requestBody?.apiKey === "nvapi-probe-key" &&
        requestBody?.model === "z-ai/glm-5.2",
      { requestPath, requestToken, requestBody }
    );
  } finally {
    await runner.close();
  }

  if (failures === 0) {
    console.log("PASS");
  } else {
    console.log(`FAIL ${failures} check(s) failed`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
