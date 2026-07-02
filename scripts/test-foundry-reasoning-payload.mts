/** Azure Foundry Anthropic-compatible reasoning payload checks (run: npx tsx scripts/test-foundry-reasoning-payload.mts) */
import http from "node:http";
import { foundryProvider } from "../lib/providers/foundry";
import { buildConnectFourMoveResponseFormat } from "../lib/games/connect-four/ai";
import type { ReasoningEffort } from "../lib/db/schema";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

async function captureFoundryBody(input: {
  model: string;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
  structuredOutput?: boolean;
}): Promise<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  let capturedBody = "";
  let capturedHeaders: http.IncomingHttpHeaders = {};

  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      capturedBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.end(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
          "",
        ].join("\n\n")
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Test server did not bind to a local TCP port");
  }

  try {
    const chunks: string[] = [];
    for await (const chunk of foundryProvider.streamChat({
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${address.port}`,
      model: input.model,
      maxTokens: input.maxTokens,
      messages: [{ role: "user", content: "Pick the strongest Connect Four move." }],
      reasoningEffort: input.reasoningEffort,
      ...(input.structuredOutput
        ? { structuredOutput: buildConnectFourMoveResponseFormat() }
        : {}),
    })) {
      if (chunk.type === "token") chunks.push(chunk.content);
      if (chunk.type === "error") throw new Error(chunk.error);
    }
    check("fake Foundry stream returns token text", chunks.join("") === "ok", chunks);
    return {
      body: JSON.parse(capturedBody) as Record<string, unknown>,
      headers: capturedHeaders,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const opusHigh = await captureFoundryBody({
  model: "claude-opus-4-5",
  reasoningEffort: "high",
  maxTokens: 4096,
  structuredOutput: true,
});
check(
  "Foundry Opus 4.5 high sends output_config effort high",
  JSON.stringify(opusHigh.body.output_config) === JSON.stringify({ effort: "high" }),
  opusHigh
);
check(
  "Foundry Opus 4.5 high enables manual thinking with a bounded budget",
  JSON.stringify(opusHigh.body.thinking) ===
    JSON.stringify({ type: "enabled", budget_tokens: 3072, display: "omitted" }),
  opusHigh
);
check(
  "Foundry Opus 4.5 thinking request keeps structured-output tool choice compatible",
  JSON.stringify(opusHigh.body.tool_choice) === JSON.stringify({ type: "auto" }),
  opusHigh
);
check(
  "Foundry Opus 4.5 thinking with tools sends the interleaved-thinking beta header",
  typeof opusHigh.headers["anthropic-beta"] === "string" &&
    opusHigh.headers["anthropic-beta"].includes("interleaved-thinking-2025-05-14"),
  opusHigh.headers
);

const opusOff = await captureFoundryBody({
  model: "claude-opus-4-5",
  reasoningEffort: "none",
  maxTokens: 4096,
  structuredOutput: true,
});
check(
  "Foundry Opus 4.5 off omits effort and thinking controls",
  opusOff.body.output_config === undefined && opusOff.body.thinking === undefined,
  opusOff
);
check(
  "Foundry Opus 4.5 off keeps forced structured-output tool choice",
  JSON.stringify(opusOff.body.tool_choice) ===
    JSON.stringify({
      type: "tool",
      name: "connect_four_move",
      disable_parallel_tool_use: true,
    }),
  opusOff
);

const opus48High = await captureFoundryBody({
  model: "claude-opus-4-8",
  reasoningEffort: "high",
  maxTokens: 4096,
  structuredOutput: true,
});
check(
  "Foundry Opus 4.8 high still uses adaptive thinking",
  JSON.stringify(opus48High.body.thinking) === JSON.stringify({ type: "adaptive" }) &&
    JSON.stringify(opus48High.body.output_config) ===
      JSON.stringify({ effort: "high" }),
  opus48High
);
check(
  "Foundry Opus 4.8 thinking request keeps structured-output tool choice compatible",
  JSON.stringify(opus48High.body.tool_choice) === JSON.stringify({ type: "auto" }),
  opus48High
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
