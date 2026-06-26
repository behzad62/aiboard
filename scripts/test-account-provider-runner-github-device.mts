/** Account-provider runner GitHub device login regression (run: npx tsx scripts/test-account-provider-runner-github-device.mts) */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to allocate port"));
      });
    });
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-gh-device-"));
const token = "test-token";
const runnerPort = await getFreePort();
const fakeGithubPort = await getFreePort();
const authFile = path.join(tmp, "auth.json");
const capturedDeviceRequests: Record<string, unknown>[] = [];

const fakeGithub = http.createServer(async (req, res) => {
  const raw = await readRequestBody(req);
  if (req.url === "/login/device/code") {
    capturedDeviceRequests.push(raw ? JSON.parse(raw) : {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        device_code: "fake-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 30,
      })
    );
    return;
  }
  if (req.url === "/login/oauth/access_token") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "authorization_pending" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise<void>((resolve) => fakeGithub.listen(fakeGithubPort, "127.0.0.1", resolve));

const runner = spawn(
  process.execPath,
  ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", token, "--auth-file", authFile],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIBOARD_GITHUB_DEVICE_CODE_ENDPOINT: `http://127.0.0.1:${fakeGithubPort}/login/device/code`,
      AIBOARD_GITHUB_ACCESS_TOKEN_ENDPOINT: `http://127.0.0.1:${fakeGithubPort}/login/oauth/access_token`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }
);

let runnerOutput = "";
runner.stdout.setEncoding("utf8");
runner.stderr.setEncoding("utf8");
runner.stdout.on("data", (chunk) => {
  runnerOutput += chunk;
});
runner.stderr.on("data", (chunk) => {
  runnerOutput += chunk;
});

const baseUrl = `http://127.0.0.1:${runnerPort}`;
const headers = {
  "content-type": "application/json",
  "x-runner-token": token,
};

async function waitForRunner(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`account-provider runner did not become ready: ${runnerOutput}`);
}

async function stopRunner(): Promise<void> {
  if (runner.exitCode !== null) return;
  if (process.platform === "win32" && runner.pid) {
    spawnSync("taskkill", ["/pid", String(runner.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    runner.kill("SIGINT");
  }
  await Promise.race([
    new Promise<void>((resolve) => runner.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

try {
  await waitForRunner();

  const response = await fetch(`${baseUrl}/providers/github-copilot/login`, {
    method: "POST",
    headers,
  });
  const data = await response.json();

  check("GitHub Copilot login returns HTTP 200", response.ok, data);
  check("runner calls the configured GitHub device endpoint", capturedDeviceRequests.length === 1, capturedDeviceRequests);
  check("GitHub Copilot login returns verification URL", data.verificationUrl === "https://github.com/login/device", data);
  check("GitHub Copilot login keeps legacy url field", data.url === "https://github.com/login/device", data);
  check("GitHub Copilot login returns device code", data.deviceCode === "ABCD-EFGH", data);
  check("GitHub Copilot login returns user code alias", data.userCode === "ABCD-EFGH", data);
  check("GitHub Copilot login returns expiry", data.expiresIn === 900, data);
  check("GitHub Copilot login instructions include code", String(data.instructions).includes("ABCD-EFGH"), data);
} catch (err) {
  check("account-provider runner GitHub device login integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  await new Promise<void>((resolve) => fakeGithub.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
