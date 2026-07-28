/** Copilot SDK adapter contract checks (run: npx tsx scripts/test-account-provider-copilot-sdk.mts) */

import assert from "node:assert/strict";
import { supportedBenchmarkReasoningEfforts } from "../lib/benchmark/model-effort";

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
const supportedCopilotEfforts = supportedBenchmarkReasoningEfforts({
  modelId: "github-copilot:gpt-5.4",
  providerId: "github-copilot",
});
const copilotNativeConfigs = supportedCopilotEfforts.map((reasoningEffort) => {
  const nativeConfig = sdk.buildCopilotSdkSessionConfig({
    model: "gpt-5.4",
    reasoningEffort,
  });
  return JSON.stringify({
    reasoningEffort: nativeConfig.reasoningEffort ?? null,
  });
});
check(
  "every advertised Copilot effort produces a distinct SDK reasoning config",
  new Set(copilotNativeConfigs).size === supportedCopilotEfforts.length,
  { supportedCopilotEfforts, copilotNativeConfigs }
);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cancellationBody() {
  return {
    model: "gpt-5.4",
    messages: [{ role: "user", content: "Keep this session open." }],
  };
}

const preStartController = new AbortController();
const preStartReason = new Error("pre-start cancellation");
const preStartCounts = { start: 0, create: 0, send: 0 };
preStartController.abort(preStartReason);
await assert.rejects(
  sdk.runCopilotSdkChat(cancellationBody(), "test-token", "C:\\aiboard-sdk-pre-start-test", undefined, {
    signal: preStartController.signal,
    clientFactory() {
      return {
        async start() { preStartCounts.start += 1; },
        async createSession() {
          preStartCounts.create += 1;
          return {
            on() { return () => undefined; },
            async sendAndWait() { preStartCounts.send += 1; return { data: { content: "" } }; },
          };
        },
        async stop() {},
      };
    },
  }),
  (error) => error === preStartReason
);
assert.deepEqual(preStartCounts, { start: 0, create: 0, send: 0 });
check("Copilot SDK does not begin setup when already cancelled", true);

const undefinedReasonSignal = {
  aborted: true,
  reason: undefined,
  addEventListener() {},
  removeEventListener() {},
} as AbortSignal;
await assert.rejects(
  sdk.runCopilotSdkChat(cancellationBody(), "test-token", "C:\\aiboard-sdk-undefined-reason-test", undefined, {
    signal: undefinedReasonSignal,
    clientFactory() {
      return { async start() {}, async createSession() {}, async stop() {} };
    },
  }),
  (error) => error instanceof Error && error.message === "Copilot SDK request aborted."
);
check("Copilot SDK uses the literal fallback when an aborted signal has no reason", true);

const startController = new AbortController();
const startReason = new Error("start cancellation");
const startSdkError = new Error("SDK startup failure");
const startEntered = deferred<void>();
const startGate = deferred<void>();
const startCounts = { create: 0, send: 0 };
const startCleanup: string[] = [];
const duringStart = sdk.runCopilotSdkChat(cancellationBody(), "test-token", "C:\\aiboard-sdk-start-test", undefined, {
  signal: startController.signal,
  clientFactory() {
    return {
      async start() { startEntered.resolve(); await startGate.promise; },
      async createSession() {
        startCounts.create += 1;
        return {
          on() { return () => undefined; },
          async sendAndWait() { startCounts.send += 1; return { data: { content: "" } }; },
        };
      },
      async stop() { startCleanup.push("stop"); },
    };
  },
});
await startEntered.promise;
startController.abort(startReason);
startGate.reject(startSdkError);
await assert.rejects(duringStart, (error) => error === startReason);
assert.deepEqual(startCounts, { create: 0, send: 0 });
assert.deepEqual(startCleanup, ["stop"]);
check("Copilot SDK stops after cancellation during client startup", true);

const rejectedCreateController = new AbortController();
const rejectedCreateReason = new Error("create cancellation");
const rejectedCreateSdkError = new Error("SDK create-session failure");
const rejectedCreateEntered = deferred<void>();
const rejectedCreateGate = deferred<never>();
const rejectedCreateCleanup: string[] = [];
const rejectedDuringCreate = sdk.runCopilotSdkChat(cancellationBody(), "test-token", "C:\\aiboard-sdk-rejected-create-test", undefined, {
  signal: rejectedCreateController.signal,
  clientFactory() {
    return {
      async start() {},
      async createSession() { rejectedCreateEntered.resolve(); return rejectedCreateGate.promise; },
      async stop() { rejectedCreateCleanup.push("stop"); },
    };
  },
});
await rejectedCreateEntered.promise;
rejectedCreateController.abort(rejectedCreateReason);
rejectedCreateGate.reject(rejectedCreateSdkError);
await assert.rejects(rejectedDuringCreate, (error) => error === rejectedCreateReason);
assert.deepEqual(rejectedCreateCleanup, ["stop"]);
check("Copilot SDK prioritizes cancellation over a delayed create-session error", true);

const createController = new AbortController();
const createReason = new Error("session creation cancellation");
const createEntered = deferred<void>();
const createGate = deferred<{
  on(): () => undefined;
  sendAndWait(): Promise<{ data: { content: string } }>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}>();
const createCounts = { send: 0 };
const createCleanup: string[] = [];
const sessionCreatedDuringCancellation = {
  on() { return () => undefined; },
  async sendAndWait() { createCounts.send += 1; return { data: { content: "" } }; },
  async abort() { createCleanup.push("abort"); },
  async disconnect() { createCleanup.push("disconnect"); },
};
const duringCreate = sdk.runCopilotSdkChat(cancellationBody(), "test-token", "C:\\aiboard-sdk-create-test", undefined, {
  signal: createController.signal,
  clientFactory() {
    return {
      async start() {},
      async createSession() { createEntered.resolve(); return createGate.promise; },
      async stop() { createCleanup.push("stop"); },
    };
  },
});
await createEntered.promise;
createController.abort(createReason);
createGate.resolve(sessionCreatedDuringCancellation);
await assert.rejects(duringCreate, (error) => error === createReason);
assert.deepEqual(createCounts, { send: 0 });
assert.deepEqual(createCleanup, ["abort", "disconnect", "stop"]);
check("Copilot SDK cleans up a session created after cancellation", true);

const cancellationController = new AbortController();
const cleanupOrder: string[] = [];
let abortCalls = 0;
let disconnectCalls = 0;
let stopCalls = 0;
let releasePendingSend: (() => void) | undefined;
const sendEntered = deferred<void>();
const inFlightReason = { kind: "in-flight cancellation" };
const inFlightSdkError = new Error("SDK send failure");
const pendingSend = new Promise<void>((resolve) => {
  releasePendingSend = resolve;
});
const cancellingSession = {
  on() {
    return () => undefined;
  },
  async sendAndWait() {
    sendEntered.resolve();
    await pendingSend;
    throw inFlightSdkError;
  },
  async abort() {
    abortCalls += 1;
    cleanupOrder.push("abort");
    releasePendingSend?.();
  },
  async disconnect() {
    disconnectCalls += 1;
    cleanupOrder.push("disconnect");
  },
};
const cancellingRun = sdk.runCopilotSdkChat(
  {
    model: "gpt-5.4",
    messages: [{ role: "user", content: "Keep this session open." }],
  },
  "test-token",
  "C:\\aiboard-sdk-cancellation-test",
  undefined,
  {
    signal: cancellationController.signal,
    clientFactory() {
      return {
        async start() {},
        async createSession() {
          return cancellingSession;
        },
        async stop() {
          stopCalls += 1;
          cleanupOrder.push("stop");
        },
      };
    },
  }
);
await sendEntered.promise;
cancellationController.abort(inFlightReason);
await assert.rejects(cancellingRun, (error) => error === inFlightReason);
check("Copilot SDK prioritizes a non-Error cancellation reason over a send error", true);
check("Copilot SDK cancellation calls session.abort once", abortCalls === 1, abortCalls);
check(
  "Copilot SDK cancellation disconnects the session once",
  disconnectCalls === 1,
  disconnectCalls
);
check("Copilot SDK cancellation stops the client once", stopCalls === 1, stopCalls);
check(
  "Copilot SDK aborts before disconnecting and stopping",
  JSON.stringify(cleanupOrder) === JSON.stringify(["abort", "disconnect", "stop"]),
  cleanupOrder
);

const resolvedSendController = new AbortController();
const resolvedSendReason = { kind: "resolved-send cancellation" };
const resolvedSendEntered = deferred<void>();
const resolvedSendGate = deferred<void>();
const resolvedSendCleanup: string[] = [];
const resolvedAfterAbortSession = {
  on() { return () => undefined; },
  async sendAndWait() {
    resolvedSendEntered.resolve();
    await resolvedSendGate.promise;
    return { data: { content: "must not be returned" } };
  },
  async abort() { resolvedSendCleanup.push("abort"); resolvedSendGate.resolve(); },
  async disconnect() { resolvedSendCleanup.push("disconnect"); },
};
const resolvedAfterAbortRun = sdk.runCopilotSdkChat(
  cancellationBody(),
  "test-token",
  "C:\\aiboard-sdk-resolved-send-test",
  undefined,
  {
    signal: resolvedSendController.signal,
    clientFactory() {
      return {
        async start() {},
        async createSession() { return resolvedAfterAbortSession; },
        async stop() { resolvedSendCleanup.push("stop"); },
      };
    },
  }
);
await resolvedSendEntered.promise;
resolvedSendController.abort(resolvedSendReason);
await assert.rejects(resolvedAfterAbortRun, (error) => error === resolvedSendReason);
assert.deepEqual(resolvedSendCleanup, ["abort", "disconnect", "stop"]);
check("Copilot SDK does not return send content after cancellation", true);

process.exit(failed === 0 ? 0 : 1);
