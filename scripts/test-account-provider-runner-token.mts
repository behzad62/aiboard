// The account runner's token survives a restart: the URL and token pasted into Settings keep working
// after the runner (or the PC) restarts. A fresh random token each start broke every saved connection
// and put the Build's ChatGPT models on an authentication cooldown (tunnel run, 2026-10-25).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Starts the runner, reads the token it prints, and stops it. */
async function startedToken(authFile: string, extra: string[] = []): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, ["lib/account-provider-runner.mjs", "--port", String(port), "--auth-file", authFile, ...extra], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`runner did not print its token: ${output}`)), 15_000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const match = /Token\s*:\s*(\S+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`runner exited ${code}: ${output}`)); });
    });
  } finally {
    child.kill();
  }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-token-"));
try {
  const authFile = path.join(directory, "auth.json");
  const first = await startedToken(authFile);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).runnerToken, first, "the token is kept in the auth file");
  assert.equal(await startedToken(authFile), first, "a restart keeps the same token");
  assert.equal(await startedToken(authFile, ["--token", "explicit-token"]), "explicit-token", "an explicit --token still wins");
  assert.equal(await startedToken(authFile), first, "an explicit token does not replace the stored one");
  console.log("PASS account runner token persists across restarts; an explicit --token overrides it");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
