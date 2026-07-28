/** Direct provider cancellation checks (run: npx tsx scripts/test-provider-abort-signals.mts) */
import assert from "node:assert/strict";
import type { ChatParams, StreamChunk } from "../lib/providers/base";
import { anthropicProvider } from "../lib/providers/anthropic";
import { streamCustomChat } from "../lib/providers/custom";
import { foundryProvider } from "../lib/providers/foundry";
import { googleProvider } from "../lib/providers/google";
import { openaiProvider } from "../lib/providers/openai";
import { openrouterProvider } from "../lib/providers/openrouter";
import { xaiProvider } from "../lib/providers/xai";
import type { CustomModel } from "../lib/db/schema";

const originalFetch = globalThis.fetch;
const SETTLE_TIMEOUT_MS = 250;
let failures = 0;

type ProviderCase = {
  name:
    | "openai-chat"
    | "openai-responses"
    | "openrouter"
    | "custom"
    | "xai"
    | "anthropic"
    | "foundry"
    | "google";
  model: string;
  stream(params: ChatParams): AsyncIterable<StreamChunk>;
  extraParams?: Partial<ChatParams>;
};

const customModel: CustomModel = {
  id: "abort-test",
  label: "Abort Test",
  baseURL: "https://custom.test/v1",
  model: "custom-model",
  apiKey: "test-key",
  hasKey: true,
  createdAt: "2026-07-28T00:00:00.000Z",
};

const cases: ProviderCase[] = [
  {
    name: "openai-chat",
    model: "gpt-5.4-mini",
    stream: (params) => openaiProvider.streamChat(params),
  },
  {
    name: "openai-responses",
    model: "gpt-5.3-codex",
    stream: (params) => openaiProvider.streamChat(params),
  },
  {
    name: "openrouter",
    model: "qwen/qwen3.7-max",
    stream: (params) => openrouterProvider.streamChat(params),
  },
  {
    name: "custom",
    model: customModel.model,
    stream: (params) => streamCustomChat(customModel, params),
  },
  {
    name: "xai",
    model: "grok-4.5",
    stream: (params) => xaiProvider.streamChat(params),
  },
  {
    name: "anthropic",
    model: "claude-sonnet-4-6",
    stream: (params) => anthropicProvider.streamChat(params),
  },
  {
    name: "foundry",
    model: "claude-opus-4-5",
    stream: (params) => foundryProvider.streamChat(params),
    extraParams: {
      baseURL: "https://foundry.test/anthropic/",
      capabilities: {
        image: false,
        document: false,
        audio: false,
        video: false,
      },
    },
  },
  {
    name: "google",
    model: "gemini-2.5-flash",
    stream: (params) => googleProvider.streamChat(params),
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    delay(timeoutMs).then(() => false),
  ]);
}

async function exerciseProvider(providerCase: ProviderCase): Promise<void> {
  let observedRequestSignal: AbortSignal | undefined;
  let connectionCancelled = false;
  let cleanupRequested = false;
  let releaseStarted: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const pendingRejects = new Set<(reason?: unknown) => void>();

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    observedRequestSignal = requestSignal ?? undefined;
    releaseStarted?.();

    return new Promise<Response>((_resolve, reject) => {
      if (cleanupRequested) {
        reject(new DOMException("Test cleanup", "AbortError"));
        return;
      }
      pendingRejects.add(reject);
      requestSignal?.addEventListener(
        "abort",
        () => {
          connectionCancelled = true;
          pendingRejects.delete(reject);
          reject(requestSignal.reason);
        },
        { once: true }
      );
    });
  }) as typeof fetch;

  const controller = new AbortController();
  const iterator = providerCase
    .stream({
      apiKey: "test-key",
      model: providerCase.model,
      messages: [{ role: "user", content: "Abort this request." }],
      maxTokens: 16,
      signal: controller.signal,
      ...providerCase.extraParams,
    })
    [Symbol.asyncIterator]();
  const nextResult = iterator.next();

  await Promise.race([
    requestStarted,
    delay(1_000).then(() => {
      throw new Error(`${providerCase.name} never reached the fetch boundary`);
    }),
  ]);

  controller.abort(new DOMException("Test abort", "AbortError"));
  const iteratorSettledAfterAbort = await settlesWithin(
    nextResult,
    SETTLE_TIMEOUT_MS
  );

  cleanupRequested = true;
  for (const reject of pendingRejects) {
    reject(new DOMException("Test cleanup", "AbortError"));
  }
  pendingRejects.clear();
  await settlesWithin(nextResult, 1_000);
  globalThis.fetch = originalFetch;

  try {
    assert.equal(observedRequestSignal?.aborted, true);
    assert.equal(connectionCancelled, true);
    assert.equal(iteratorSettledAfterAbort, true);
    console.log(`PASS ${providerCase.name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${providerCase.name}`, {
      observedRequestSignalAborted: observedRequestSignal?.aborted,
      connectionCancelled,
      iteratorSettledAfterAbort,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

try {
  for (const providerCase of cases) {
    await exerciseProvider(providerCase);
  }
} finally {
  globalThis.fetch = originalFetch;
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.error(`FAIL ${failures} provider abort check(s) failed`);
  process.exitCode = 1;
}
