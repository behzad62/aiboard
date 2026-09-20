import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const arguments_ = process.argv.slice(2);
const lazy = arguments_.includes("--lazy");
const detached = arguments_.includes("--detached");
const markerArguments = arguments_.filter((value) => !value.startsWith("--"));
const [descendantMarker, serverMarker] = markerArguments;
let descendantPid;
function startTree() {
  if (descendantPid) return descendantPid;
  if (serverMarker) writeFileSync(serverMarker, String(process.pid), { flag: "wx" });
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!descendant.pid) throw new Error("MCP tree fixture descendant has no PID.");
  descendantPid = descendant.pid;
  descendant.unref();
  if (descendantMarker) writeFileSync(descendantMarker, String(descendantPid), { flag: "wx" });
  return descendantPid;
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
  if (message.method === "tools/call" && message.params.name === "probe") { const pid = startTree(); reply(message.id, { content: [{ type: "text", text: `tree-alive:${pid}` }] }); }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
