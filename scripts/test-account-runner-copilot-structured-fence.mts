/**
 * GitHub Copilot provider structured-output fence normalization
 * (run: npx tsx scripts/test-account-runner-copilot-structured-fence.mts)
 *
 * App-side twin of the bridge-side stripStructuredOutputFence: a v15
 * account-provider runner still forwards Copilot gemini replies wrapped in a
 * markdown fence even though structuredOutput was requested, and the strict
 * certified scorer (parseStructuredJson) then scores them failed_tool_use.
 * The github-copilot provider must unwrap whole-reply fences on structured
 * requests regardless of runner version — and must NOT touch anything else.
 */
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { githubCopilotProvider } from "../lib/providers/github-copilot";
import type { ChatParams, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const structuredOutput = {
  name: "fence_test",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "number" } },
  },
};

const FENCED_JSON = '```json\n{"answer":42}\n```';

type RunnerReply =
  | { kind: "json"; content: string }
  | { kind: "sse"; tokens: string[] };

async function collect(reply: RunnerReply, params: Omit<ChatParams, "apiKey" | "baseURL" | "model">): Promise<{
  text: string;
  chunks: StreamChunk[];
}> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (reply.kind === "json") {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true, content: reply.content }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      for (const token of reply.tokens) {
        res.write(`data: ${JSON.stringify({ type: "token", content: token })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const chunks: StreamChunk[] = [];
    for await (const chunk of githubCopilotProvider.streamChat({
      apiKey: "runner-token",
      baseURL: `http://127.0.0.1:${port}`,
      model: "gemini-3.5-flash",
      ...params,
    })) {
      chunks.push(chunk);
    }
    const text = chunks
      .filter((chunk) => chunk.type === "token")
      .map((chunk) => chunk.content ?? "")
      .join("");
    return { text, chunks };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const messages: ChatParams["messages"] = [{ role: "user", content: "Answer with the structured JSON." }];

try {
  const fencedStructured = await collect({ kind: "json", content: FENCED_JSON }, { messages, structuredOutput });
  check(
    "fenced runner reply is unwrapped when structuredOutput is set",
    fencedStructured.text === '{"answer":42}',
    fencedStructured
  );

  const fencedPlain = await collect({ kind: "json", content: FENCED_JSON }, { messages });
  check("fenced runner reply is untouched without structuredOutput", fencedPlain.text === FENCED_JSON, fencedPlain);

  const cleanStructured = await collect({ kind: "json", content: '{"answer":1}' }, { messages, structuredOutput });
  check("clean JSON reply is untouched", cleanStructured.text === '{"answer":1}', cleanStructured);

  const sseStructured = await collect(
    { kind: "sse", tokens: ["```json\n{\"ans", 'wer":42}', "\n```"] },
    { messages, structuredOutput }
  );
  check(
    "fence split across streamed tokens is unwrapped when structuredOutput is set",
    sseStructured.text === '{"answer":42}' && sseStructured.chunks.at(-1)?.type === "done",
    sseStructured
  );

  const ssePlain = await collect({ kind: "sse", tokens: ["```json\n", '{"answer":42}', "\n```"] }, { messages });
  check("streamed fence is untouched without structuredOutput", ssePlain.text === FENCED_JSON, ssePlain);
} catch (err) {
  check("github-copilot provider fence normalization", false, err instanceof Error ? err.message : String(err));
}

// No process.exit: an abrupt exit while undici's fetch sockets tear down hits
// a libuv assert on Windows (async.c). Every server is closed above, so the
// loop drains and Node exits with this code on its own.
process.exitCode = failures === 0 ? 0 : 1;
