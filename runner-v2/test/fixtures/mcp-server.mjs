import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: "lookup",
      description: "Look up fixture documentation",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }] });
  } else if (message.method === "tools/call") {
    reply(message.id, {
      content: [
        { type: "text", text: `found:${message.params.arguments.query}` },
        { type: "image", mimeType: "image/png", data: Buffer.from("image-bytes").toString("base64") },
      ],
      isError: false,
    });
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
