import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
const pidMarker = process.argv[3];
const triggerMarker = process.argv[4];
const lazy = process.argv[5] === "--lazy";
let marked = false;
function markLive() { if (!marked) { writeFileSync(pidMarker, String(process.pid), { flag: "wx" }); marked = true; } }
if (!lazy) markLive();

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "post-ready-fixture", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: "trigger",
      inputSchema: { type: "object", additionalProperties: false },
    }, ...(lazy ? [{ name: "probe", inputSchema: { type: "object" } }] : [])] });
  } else if (message.method === "tools/call" && message.params.name === "probe") {
    markLive(); reply(message.id, { content: [{ type: "text", text: "ready-to-trigger" }] });
  } else if (message.method === "tools/call") {
    appendFileSync(triggerMarker, `${mode}\n`);
    if (mode === "self-exit") {
      setTimeout(() => process.exit(23), 25);
    } else if (mode === "oversized-line") {
      // Exercise exact force escalation: cleanup must not depend on a child
      // cooperating with its graceful termination request.
      process.on("SIGTERM", () => undefined);
      process.stdout.write("x".repeat(64 * 1024 + 1));
    }
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
