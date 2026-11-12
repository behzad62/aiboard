/**
 * The opt-in live provider suite's harness, without a live call (stub keys only):
 * - it is inert unless AIBOARD_PROVIDER_RUNTIME_LIVE=1;
 * - opted in with no key anywhere, every probe group skips with provider/model/transport;
 * - keys come from the AIBoard home, not a browser store (HM6, plan §17 item 18): a stub home with an
 *   OpenRouter key makes the OpenRouter group run (in dry-run, so nothing is called), and the probe
 *   script finds the same key with `--dry-run`; the key never appears in the output;
 * - the probe always names its upstream (a call without a base URL is refused since HM4a): an env key
 *   and a home key without a base URL get the catalog default, and with a loopback stub as the home's
 *   base URL the probe, run for real, sends its request there with the home's key.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";

import { resolveAiboardHome } from "../runner-v2/src/aiboard-home-paths.js";
import { applyHomeBatch } from "../runner-v2/src/aiboard-home-store.js";
import { snapshotProvider } from "../runner-v2/src/home-model-policy.js";
import { liveProviderKey } from "./live-home-key.mts";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const harness = "scripts/test-provider-runtime-live.mts";
const openRouterProbe = "scripts/test-openrouter-structured-output-live.mts";
const STUB_KEY = "stub-openrouter-live-harness-key";

/** An environment patch; Next's types make NODE_ENV required on NodeJS.ProcessEnv itself. */
type EnvPatch = Record<string, string | undefined>;

function run(script: string, envPatch: EnvPatch, args: string[] = []) {
  const env = { ...process.env, ...envPatch };
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error,
  };
}

/** A user whose home folder, data root and AIBoard home are all inside `root`. */
function fakeUser(root: string): EnvPatch {
  const user = join(root, "user");
  mkdirSync(user, { recursive: true });
  return {
    HOME: user,
    USERPROFILE: user,
    LOCALAPPDATA: join(root, "local"),
    XDG_DATA_HOME: join(root, "data"),
    AIBOARD_HOME: join(root, "home"),
    OPENROUTER_API_KEY: "",
  };
}

const defaultRun = run(harness, { AIBOARD_PROVIDER_RUNTIME_LIVE: "" });
assert.equal(defaultRun.error, undefined);
assert.equal(defaultRun.status, 0);
assert.match(defaultRun.output, /SKIP provider runtime live suite/i);
console.log("PASS live provider suite is inert without explicit opt-in");

const emptyRoot = mkdtempSync(join(tmpdir(), "aiboard-provider-live-test-"));
try {
  const optedIn = run(harness, { AIBOARD_PROVIDER_RUNTIME_LIVE: "1", ...fakeUser(emptyRoot) });
  assert.equal(optedIn.error, undefined);
  assert.equal(optedIn.status, 0, optedIn.output);
  assert.match(
    optedIn.output,
    /SKIP provider=openrouter transport=responses model=\S+ reason=no OPENROUTER_API_KEY and no AIBoard home/i,
    "OpenRouter skip must record provider/model/transport and name the AIBoard home",
  );
  assert.match(
    optedIn.output,
    /SKIP provider=github-copilot transport=copilot_sdk,runner_proxy model=/i,
    "Copilot skip must record provider/model/transport",
  );
  assert.match(optedIn.output, /no configured live providers/i);
  console.log("PASS opted-in live suite reports credential-aware provider/model/transport skips");

  const probe = run(openRouterProbe, fakeUser(emptyRoot), ["--dry-run"]);
  assert.equal(probe.status, 0, probe.output);
  assert.match(probe.output, /SKIP - no OPENROUTER_API_KEY and no AIBoard home/);
  console.log("PASS the OpenRouter probe skips, naming the AIBoard home, when neither the env nor the home has a key");
} finally {
  rmSync(emptyRoot, { recursive: true, force: true });
}

const homeRoot = mkdtempSync(join(tmpdir(), "aiboard-provider-live-home-"));
try {
  const env = fakeUser(homeRoot);
  const location = resolveAiboardHome({ platform: process.platform, environment: env as NodeJS.ProcessEnv, home: env.HOME! });
  await applyHomeBatch(location, { baseRevision: 0, ops: [
    { path: "providers.openrouter", op: "set", value: { enabled: true } },
    { path: "credentials.providers.openrouter", op: "set", value: { secret: STUB_KEY } },
  ] });

  const dry = run(harness, { AIBOARD_PROVIDER_RUNTIME_LIVE: "1", AIBOARD_PROVIDER_RUNTIME_LIVE_DRY_RUN: "1", ...env });
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /LIVE provider=openrouter transport=responses model=/);
  assert.match(dry.output, /DRY-RUN provider=openrouter would run scripts\/test-openrouter-structured-output-live\.mts/);
  assert.match(dry.output, /SKIP provider=github-copilot/);
  assert.ok(!dry.output.includes(STUB_KEY), "the harness never prints the key");
  console.log("PASS the live suite takes the OpenRouter key from the AIBoard home, not a browser store");

  const probe = run(openRouterProbe, env, ["--dry-run"]);
  assert.equal(probe.status, 0, probe.output);
  assert.match(probe.output, /DRY-RUN - OpenRouter key found \(source=home\); no provider call made/);
  assert.ok(!probe.output.includes(STUB_KEY), "the probe never prints the key");
  console.log("PASS the OpenRouter probe reads its key from the AIBoard home and prints none of it");
} finally {
  rmSync(homeRoot, { recursive: true, force: true });
}

const OPENROUTER_DEFAULT = snapshotProvider("openrouter")?.defaultBaseUrl;
assert.ok(OPENROUTER_DEFAULT?.startsWith("https://"), "the catalog snapshot names OpenRouter's default base URL");

const defaultRoot = mkdtempSync(join(tmpdir(), "aiboard-provider-live-default-"));
try {
  const env = fakeUser(defaultRoot);
  const fromEnv = liveProviderKey("openrouter", "OPENROUTER_API_KEY", { ...env, OPENROUTER_API_KEY: STUB_KEY } as EnvPatch as NodeJS.ProcessEnv);
  assert.ok(fromEnv.found && fromEnv.source === "env");
  assert.equal(fromEnv.found && fromEnv.baseUrl, OPENROUTER_DEFAULT);
  const location = resolveAiboardHome({ platform: process.platform, environment: env as NodeJS.ProcessEnv, home: env.HOME! });
  await applyHomeBatch(location, { baseRevision: 0, ops: [
    { path: "providers.openrouter", op: "set", value: { enabled: true } },
    { path: "credentials.providers.openrouter", op: "set", value: { secret: STUB_KEY } },
  ] });
  const fromHome = liveProviderKey("openrouter", "OPENROUTER_API_KEY", env as NodeJS.ProcessEnv);
  assert.ok(fromHome.found && fromHome.source === "home");
  assert.equal(fromHome.found && fromHome.baseUrl, OPENROUTER_DEFAULT);
  console.log("PASS an env key and a home key without a base URL both get OpenRouter's catalog default base URL");
} finally {
  rmSync(defaultRoot, { recursive: true, force: true });
}

/** Runs a script without blocking this process, so a stub server here can answer it. */
function runAsync(script: string, envPatch: EnvPatch, args: string[] = []): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, script, ...args], { cwd: process.cwd(), env: { ...process.env, ...envPatch }, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

const stubRequests: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
const stub = createServer((request, response) => {
  stubRequests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
  request.resume();
  request.on("end", () => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "stub upstream: no live call" } }));
  });
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${(stub.address() as { port: number }).port}/api/v1`;
const stubRoot = mkdtempSync(join(tmpdir(), "aiboard-provider-live-stub-"));
try {
  const env = fakeUser(stubRoot);
  const location = resolveAiboardHome({ platform: process.platform, environment: env as NodeJS.ProcessEnv, home: env.HOME! });
  await applyHomeBatch(location, { baseRevision: 0, ops: [{ path: "providers.openrouter", op: "set", value: { enabled: true, baseUrl: stubBase } }] });
  await applyHomeBatch(location, { baseRevision: 1, ops: [{ path: "credentials.providers.openrouter", op: "set", value: { secret: STUB_KEY } }] });
  const found = liveProviderKey("openrouter", "OPENROUTER_API_KEY", env as NodeJS.ProcessEnv);
  assert.equal(found.found && found.baseUrl, stubBase, "a home base URL is the probe's upstream");

  // The probe's own verdict may fail against the stub; only the request it sent matters.
  const probe = await runAsync(openRouterProbe, { ...env, OPENROUTER_LIVE_MODELS: "stub/one-model" });
  assert.ok(stubRequests.length > 0, `the probe sent no request to the home's base URL:
${probe.output}`);
  for (const request of stubRequests) {
    assert.ok(request.url.startsWith("/api/v1/"), `request under the base URL: ${request.url}`);
    assert.equal(request.headers.authorization, `Bearer ${STUB_KEY}`);
  }
  assert.ok(!probe.output.includes(STUB_KEY), "the probe never prints the key");
  console.log("PASS run for real, the OpenRouter probe calls the home's base URL with the home's key (stub upstream, no live call)");
} finally {
  stub.closeAllConnections();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  rmSync(stubRoot, { recursive: true, force: true });
}

console.log("PASS");
