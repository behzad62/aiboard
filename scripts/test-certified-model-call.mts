/* Certified model-call checks (run: npx tsx scripts/test-certified-model-call.mts) */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
} from "../lib/benchmark/store";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import { callCertifiedModel } from "../lib/benchmark/certified/model-call";
import type { SelectedModel, StreamChunk, StructuredOutputFormat } from "../lib/providers/base";
import type * as ClientStore from "../lib/client/store";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<unknown>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
}

const model: SelectedModel = {
  modelId: "openai:gpt-certified",
  providerId: "openai",
  displayName: "GPT Certified",
};
const structuredOutput: StructuredOutputFormat = {
  name: "move",
  strict: true,
  schema: {
    type: "object",
    properties: {
      move: { type: "number" },
    },
    required: ["move"],
    additionalProperties: false,
  },
};

__resetBenchmarkStoreForTests();
const context = createCertifiedRunContext({
  runId: "run-certified-model-call",
  suiteId: "suite-model-call",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  startedAt: "2026-06-28T08:30:00.000Z",
  caseIds: ["case-model-call"],
  teamCompositionIds: ["team-model-call"],
});

let streamCallCount = 0;
const result = await callCertifiedModel({
  model,
  system: "You are a certified benchmark participant.",
  user: "Return the best move as JSON.",
  structuredOutput,
  maxTokens: 64,
  temperature: 0,
  context,
  caseId: "case-model-call",
  attemptId: "attempt-model-call",
  participantId: "single",
  pricing: {
    inputUsdPer1M: 2,
    outputUsdPer1M: 4,
  },
  streamChat: async function* (input): AsyncIterable<StreamChunk> {
    streamCallCount++;
    check("certified stream receives provider id", input.providerId === "openai", input);
    check("certified stream receives unqualified model id", input.params.model === "gpt-certified", input.params);
    check("certified stream forces temperature zero", input.params.temperature === 0, input.params);
    check("certified stream receives structured output", input.params.structuredOutput?.name === "move", input.params.structuredOutput);
    yield { type: "token", content: "{\"move\":" };
    yield { type: "token", content: "3}" };
    yield { type: "done" };
  },
});

check("certified model call returns raw response", result.rawResponse === "{\"move\":3}", result);
check("certified model call parses structured JSON", (result.parsedJson as { move?: number }).move === 3, result);
check("certified model call estimates tokens and cost", result.inputTokens > 0 && result.outputTokens > 0 && result.estimatedUsd !== null && result.estimatedUsd > 0, result);
check("certified model call records one stream", streamCallCount === 1, streamCallCount);

await expectReject(
  "provider error is rethrown after trace recording",
  () =>
    callCertifiedModel({
      model,
      system: "System",
      user: "User",
      maxTokens: 16,
      temperature: 0,
      context,
      caseId: "case-model-call",
      attemptId: "attempt-model-call-error",
      participantId: "single",
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield { type: "error", error: "Provider 503 before output" };
      },
    }),
  /provider 503/i
);

const customServer = await startOpenAICompatibleServer();
try {
  const require = createRequire(import.meta.url);
  const clientStore = require("@/lib/client/store") as typeof ClientStore;
  clientStore.addCustomModel({
    id: "local-certified",
    label: "Local Certified",
    baseURL: customServer.baseURL,
    model: "local-certified-model",
    apiKey: "",
    hasKey: false,
    capabilities: {
      image: false,
      document: false,
      audio: false,
      video: false,
    },
  });
  const customResult = await callCertifiedModel({
    model: {
      modelId: "custom:local-certified",
      providerId: "custom",
      displayName: "Local Certified",
    },
    system: "You are a custom certified benchmark participant.",
    user: "Return the best move as JSON.",
    structuredOutput,
    maxTokens: 64,
    temperature: 0,
    context,
    caseId: "case-model-call",
    attemptId: "attempt-custom-model-call",
    participantId: "custom-single",
  });
  const customRequest = customServer.requests.at(-1);
  check(
    "custom certified model call uses custom endpoint",
    customServer.requests.length === 1 && customRequest?.url?.endsWith("/chat/completions") === true,
    customServer.requests
  );
  check(
    "custom certified model call uses stored provider model id",
    customRequest?.body.model === "local-certified-model",
    customRequest?.body
  );
  check(
    "custom certified model call uses OpenAI-compatible custom params",
    customRequest?.body.stream === true &&
      customRequest.body.temperature === 0 &&
      customRequest.body.max_tokens === 64 &&
      customRequest.body.max_completion_tokens === undefined,
    customRequest?.body
  );
  check(
    "custom certified model call parses and traces",
    (customResult.parsedJson as { move?: number }).move === 4 &&
      exportBenchmarkReportBundleV2().traces.some(
        (trace) => trace.id === customResult.traceId && trace.providerId === "custom"
      ),
    customResult
  );
} finally {
  await customServer.close();
}

const bundle = exportBenchmarkReportBundleV2();
const successTrace = bundle.traces.find((trace) => trace.id === result.traceId);
const errorTrace = bundle.traces.find((trace) => trace.attemptId === "attempt-model-call-error");
check("successful model call trace persisted", successTrace?.rawResponse === "{\"move\":3}" && successTrace.parsedResponseJson?.includes("\"move\":3") === true, successTrace);
check("model call trace links certified run metadata", successTrace?.runId === context.runId && successTrace.caseId === "case-model-call" && successTrace.attemptId === "attempt-model-call", successTrace);
check("provider error trace persisted", errorTrace?.error?.includes("Provider 503") === true && errorTrace.retryHistory.some((attempt) => attempt.status === "provider_error"), errorTrace);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

async function startOpenAICompatibleServer(): Promise<{
  baseURL: string;
  requests: Array<{ url: string | undefined; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void readRequestJson(request).then((body) => {
        requests.push({ url: request.url, body });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({
            id: "chunk-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "{\"move\":" } }],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chunk-2",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "4}" } }],
          })}\n\n`
        );
        response.end("data: [DONE]\n\n");
      });
    }
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

async function readRequestJson(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
