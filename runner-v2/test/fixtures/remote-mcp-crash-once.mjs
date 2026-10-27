import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The directory belongs to the test; it records launches and calls across restarts.
const directory = process.argv[2];
if (!directory) throw new Error("A fixture state directory is required.");
const latch = join(directory, "crashed-once");
appendFileSync(join(directory, "launches.log"), `${process.pid}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "remote-crash-once-fixture", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: "read",
      description: "Return a synthetic read-only value.",
      inputSchema: { type: "object", properties: { crash: { type: "boolean" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }] });
  } else if (message.method === "tools/call" && message.params?.name === "read") {
    const crash = message.params.arguments?.crash === true;
    appendFileSync(join(directory, "calls.log"), `${process.pid} ${crash ? "crash" : "read"}\n`);
    if (crash) {
      try {
        writeFileSync(latch, "crashed\n", { flag: "wx" });
        process.exit(23);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    reply(message.id, { content: [{ type: "text", text: "synthetic read" }] });
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
