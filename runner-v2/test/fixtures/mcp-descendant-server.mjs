import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const descendantMarker = process.argv[2];
const serverMarker = process.argv[3];
const lazy = process.argv[4] === "--lazy";
let treeStarted = false;
function startTree() {
  if (treeStarted) return;
  treeStarted = true;
  if (serverMarker) writeFileSync(serverMarker, String(process.pid), { flag: "wx" });
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!descendant.pid) throw new Error("MCP tree fixture descendant has no PID.");
  descendant.unref();
  writeFileSync(descendantMarker, String(descendant.pid), { flag: "wx" });
}
if (!lazy) startTree();

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "descendant-fixture", version: "1" },
  });
  if (message.method === "tools/list") reply(message.id, { tools: lazy ? [{ name: "probe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }] : [] });
  if (message.method === "tools/call" && message.params.name === "probe") { startTree(); reply(message.id, { content: [{ type: "text", text: "tree-alive" }] }); }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
