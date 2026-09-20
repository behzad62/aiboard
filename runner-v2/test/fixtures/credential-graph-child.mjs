import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [readyPath, releasePath] = process.argv.slice(2);
const prefix = "SYNTHETIC_GRAPH_CREDENTIAL_";
writeFileSync(readyPath, JSON.stringify({
  pid: process.pid,
  parentPid: process.ppid,
  credentialPresent: Object.values(process.env).some((value) => value?.includes(prefix)),
  argvCredentialPresent: process.argv.some((value) => value.includes(prefix)),
  safeValue: process.env.GRAPH_SAFE_VALUE,
}), { flag: "wx" });
if (process.argv[4] === "mcp") {
  const lines = createInterface({input: process.stdin});
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      const interval = setInterval(() => {
        if (!existsSync(releasePath)) return;
        clearInterval(interval);
        process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {name: "credential-fixture", version: "1"},
        }})}\n`);
      }, 25);
    } else if (message.method === "tools/list") {
      process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result: {tools: []}})}\n`);
    }
  });
  lines.on("close", () => process.exit(0));
} else {
  const interval = setInterval(() => {
    if (existsSync(releasePath)) { clearInterval(interval); process.exit(0); }
  }, 25);
}
