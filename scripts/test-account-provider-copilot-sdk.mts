/** Copilot SDK adapter contract checks (run: npx tsx scripts/test-account-provider-copilot-sdk.mts) */

const sdk = await import("../lib/account-provider-copilot-sdk.mjs") as typeof import("../lib/account-provider-copilot-sdk.mjs");

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const config = sdk.buildCopilotSdkSessionConfig({
  model: "gemini-3.5-flash",
  reasoningEffort: "max",
  maxTokens: 1234,
  webSearch: true,
  messages: [
    { role: "system", content: "Use concise answers." },
    { role: "user", content: "Find the current answer." },
  ],
});

check("SDK session selects the requested Copilot Gemini model", config.model === "gemini-3.5-flash", config);
check("SDK session maps max reasoning to xhigh", config.reasoningEffort === "xhigh", config);
check(
  "SDK session explicitly enables Bing-backed web tools",
  JSON.stringify(config.availableTools?.toArray?.() ?? config.availableTools) ===
    JSON.stringify(["builtin:web_search", "builtin:web_fetch"]),
  config.availableTools
);
check(
  "SDK session forwards the requested output limit",
  config.modelCapabilities?.limits?.max_output_tokens === 1234,
  config.modelCapabilities
);
check(
  "SDK permission policy approves URL access",
  config.onPermissionRequest?.({ kind: "url" } as never, {} as never)?.kind === "approve-once",
  config.onPermissionRequest
);
check(
  "SDK permission policy denies shell access",
  config.onPermissionRequest?.({ kind: "shell" } as never, {} as never)?.kind === "reject",
  config.onPermissionRequest
);

const emitted: string[] = [];
let capturedClientOptions: Record<string, unknown> | undefined;
let capturedSessionConfig: Record<string, unknown> | undefined;

const fakeSession = {
  on(type: string, handler: (event: unknown) => void) {
    if (type === "assistant.message_delta") {
      queueMicrotask(() => handler({ data: { deltaContent: "SDK result" } }));
    }
    return () => undefined;
  },
  async sendAndWait() {
    return { data: { content: "SDK result" } };
  },
  async disconnect() {},
};

const result = await sdk.runCopilotSdkChat(
  {
    model: "gemini-3.5-flash",
    reasoningEffort: "high",
    maxTokens: 512,
    webSearch: true,
    messages: [{ role: "user", content: "Search now." }],
  },
  "test-token",
  "C:\\aiboard-sdk-test",
  (token: string) => emitted.push(token),
  {
    clientFactory(options: Record<string, unknown>) {
      capturedClientOptions = options;
      return {
        async start() {},
        async createSession(sessionConfig: Record<string, unknown>) {
          capturedSessionConfig = sessionConfig;
          return fakeSession;
        },
        async stop() {},
      };
    },
  }
);

check("SDK adapter returns final assistant content", result === "SDK result", result);
check("SDK adapter forwards streaming deltas", emitted.join("") === "SDK result", emitted);
check("SDK adapter passes the account token to the client", capturedClientOptions?.gitHubToken === "test-token", capturedClientOptions);
check("SDK adapter creates a web-search session", Boolean(capturedSessionConfig?.availableTools), capturedSessionConfig);

process.exit(failed === 0 ? 0 : 1);
