import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

async function checkSetup(helper: string, expected: RegExp) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiboard-copilot-setup-"));
  await copyFile("lib/account-provider-runner.mjs", path.join(directory, "runner.mjs"));
  await writeFile(path.join(directory, "account-provider-copilot-sdk.mjs"), helper);
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({ githubCopilot: { access: "fixture-login" } }));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing listener address"));
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(process.execPath, ["runner.mjs", "--port", String(port), "--token", "fixture-runner-token", "--auth-file", path.join(directory, "auth.json")],
    { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Runner did not start")), 10000);
      child.stdout.on("data", (data) => {
        output += data.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Runner exited before startup")); });
    });
    for (const action of ["models", "capabilities"]) {
      const response = await fetch(`${url}/providers/github-copilot/${action}`, { method: "POST", headers: { "x-runner-token": "fixture-runner-token", "content-type": "application/json" }, body: "{}" });
      const body = await response.json() as { error: string };
      assert.equal(response.ok, false);
      assert.match(body.error, expected);
      assert.doesNotMatch(body.error, /Cannot find package|imported from|fixture-login|fixture-runner-token/);
    }
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(), "aiboard-copilot-setup-")));
    await rm(directory, { recursive: true, force: true });
  }
}

await checkSetup('import "@github/copilot-sdk-not-installed-test-fixture";', /dependencies are missing.*npm install and npm start/i);
await checkSetup('export function runCopilotSdkChat() {}', /helper is out of date.*current Copilot runner ZIP/i);
console.log("PASS Copilot missing dependencies and mismatched helpers return actionable setup errors");
