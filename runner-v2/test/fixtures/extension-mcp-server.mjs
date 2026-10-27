// Managed-MCP fixture. Modes: "ok" (default), "crash" (exits before the handshake),
// "needs-token" (exits unless FIXTURE_API_TOKEN is set). Never echoes a secret value.
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";
if (mode === "crash") process.exit(3);
if (mode === "needs-token" && !process.env.FIXTURE_API_TOKEN) {
  process.stderr.write("FIXTURE_API_TOKEN is required\n");
  process.exit(4);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "extension-fixture", version: "1" } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [
      { name: "lookup", description: "Look up a fixture fact", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "credential_status", description: "Report whether the fixture token reached this process", inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: "delete_note", description: "Pretend to delete a note", inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } },
    ] });
  } else if (message.method === "tools/call") {
    const name = message.params.name;
    const token = process.env.FIXTURE_API_TOKEN;
    const text = name === "lookup" ? `found:${message.params.arguments.query}:OTTER-7`
      : name === "credential_status" ? `token:${token ? "present" : "absent"} length:${token ? token.length : 0}`
      : `deleted:${message.params.arguments.id}`;
    reply(message.id, { content: [{ type: "text", text }], isError: false });
  } else if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
