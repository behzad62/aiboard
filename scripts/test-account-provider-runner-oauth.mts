/** Account-provider runner OAuth regression (run: npx tsx scripts/test-account-provider-runner-oauth.mts) */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
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

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function getRegisteredCallbackPort(): Promise<number> {
  for (const candidate of [1455, 1457]) {
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error("neither registered ChatGPT OAuth callback port is available");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-"));
const port = await getRegisteredCallbackPort();
const token = "test-token";
const authFile = path.join(tmp, "auth.json");
const runner = spawn(
  process.execPath,
  ["lib/account-provider-runner.mjs", "--port", String(port), "--token", token, "--auth-file", authFile],
  {
    cwd: process.cwd(),
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

const baseUrl = `http://127.0.0.1:${port}`;
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

  const login = await fetch(`${baseUrl}/providers/chatgpt/login`, {
    method: "POST",
    headers,
  });
  const data = await login.json();
  check("ChatGPT login returns HTTP 200", login.ok, data);
  check("ChatGPT login returns authorize URL", data.ok === true && typeof data.url === "string", data);

  const authorizeUrl = new URL(String(data.url));
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  check(
    "authorize URL targets OpenAI OAuth",
    authorizeUrl.origin === "https://auth.openai.com" && authorizeUrl.pathname === "/oauth/authorize",
    data.url
  );
  check(
    "authorize URL uses the Codex client callback path",
    redirectUri === `http://localhost:${port}/auth/callback`,
    { redirectUri }
  );
  check(
    "authorize URL uses the Codex account scopes",
    authorizeUrl.searchParams.get("scope") ===
      "openid profile email offline_access api.connectors.read api.connectors.invoke",
    data.url
  );
  check("authorize URL uses the Codex originator", authorizeUrl.searchParams.get("originator") === "codex_cli_rs", data.url);
  check("authorize URL uses PKCE S256", authorizeUrl.searchParams.get("code_challenge_method") === "S256", data.url);
  check(
    "authorize URL requests the Codex simplified flow",
    authorizeUrl.searchParams.get("codex_cli_simplified_flow") === "true",
    data.url
  );
  check(
    "authorize URL avoids the legacy provider-scoped callback path",
    !String(redirectUri).includes("/auth/chatgpt/callback"),
    { redirectUri }
  );

  const callback = await fetch(`${baseUrl}/auth/callback?state=wrong&code=fake`);
  const callbackText = await callback.text();
  check(
    "generic OAuth callback endpoint is routed before runner-token auth",
    callback.status === 400 && callbackText.includes("Invalid or expired OAuth callback"),
    { status: callback.status, callbackText }
  );

  const disallowedPort = await getFreePort();
  const disallowedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-account-runner-bad-port-"));
  const disallowedRunner = spawn(
    process.execPath,
    [
      "lib/account-provider-runner.mjs",
      "--port",
      String(disallowedPort),
      "--token",
      token,
      "--auth-file",
      path.join(disallowedTmp, "auth.json"),
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  const disallowedBaseUrl = `http://127.0.0.1:${disallowedPort}`;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${disallowedBaseUrl}/health`);
        if (res.ok) break;
      } catch {
        // keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const badLogin = await fetch(`${disallowedBaseUrl}/providers/chatgpt/login`, {
      method: "POST",
      headers,
    });
    const badData = await badLogin.json();
    check("ChatGPT login rejects unregistered callback ports", badLogin.status === 400, badData);
    check(
      "unregistered port error tells users the registered ports",
      String(badData.error).includes("1455") && String(badData.error).includes("1457"),
      badData
    );
  } finally {
    if (disallowedRunner.exitCode === null) {
      if (process.platform === "win32" && disallowedRunner.pid) {
        spawnSync("taskkill", ["/pid", String(disallowedRunner.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        disallowedRunner.kill("SIGINT");
      }
      await Promise.race([
        new Promise<void>((resolve) => disallowedRunner.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    fs.rmSync(disallowedTmp, { recursive: true, force: true });
  }
} catch (err) {
  check("account-provider runner OAuth integration", false, err instanceof Error ? err.message : String(err));
} finally {
  await stopRunner();
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
