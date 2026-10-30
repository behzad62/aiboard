import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { runCopilotSmoke } from "./copilot-smoke-control.mjs";

const root = mkdtempSync(join(tmpdir(), "aiboard-copilot-unresponsive-"));
const cli = join(root, "unresponsive.js");
writeFileSync(cli, "process.stdin.resume(); process.stderr.write('AIBOARD_FIXTURE_READY\\n'); setInterval(() => {}, 1000);\n");
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, TMP: root, TEMP: root };
const client = new CopilotClient({ mode: "empty", useLoggedInUser: false, baseDirectory: root, workingDirectory: root,
  connection: { kind: "stdio", path: cli }, env });
const attempt = runCopilotSmoke(client, { operationMs: 3_000, cleanupMs: 15_000 });
const child = client.cliProcess;
assert.ok(child, "the SDK started the fixture through its owned child handle");
let closed = false;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.once("close", () => { closed = true; });
await assert.rejects(attempt, (error) => {
  if (!(error instanceof AggregateError) || !error.errors.some((entry) => /start timed out/.test(String(entry)))) return false;
  return !error.errors.some((entry) => /stop timed out|runtime did not close|request did not settle/i.test(String(entry)));
});
assert.equal(closed, true, "the unresponsive fixture's child handle emitted close before cleanup completed");
assert.match(stderr, /AIBOARD_FIXTURE_READY/, "the unresponsive fixture actually started");
console.log("PASS an unresponsive Copilot runtime fails with its owned child closed");
