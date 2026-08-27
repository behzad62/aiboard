import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

test("CLI rejects malformed capability configuration before Git preflight or readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
    plaintextEnvironment: { API_KEY: "not-allowed" },
  }));
  try {
    const child = spawn(
      process.execPath,
      [
        tsxPath,
        cliPath,
        "--project",
        project,
        "--state-dir",
        state,
        "--port",
        "0",
        "--token",
        "cli-capabilities-test-token",
        "--capabilities-config",
        config,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(existsSync(state), false);
    assert.match(stderr, /capabilities configuration contains unknown field plaintextEnvironment/i);
    assert.doesNotMatch(stderr, /git/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI accepts a valid external capability configuration before listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-valid-Ω-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(root, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
  }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        tsxPath,
        cliPath,
        "--project",
        project,
        "--state-dir",
        state,
        "--port",
        "0",
        "--token",
        "cli-capabilities-valid-token",
        "--capabilities-config",
        config,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const diagnostics: string[] = [];
    const streams = runnerStreams(child);
    streams.stderr.setEncoding("utf8");
    streams.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
    const lines = createInterface({ input: streams.stdout });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const readiness = await Promise.race([
        once(lines, "line").then(([line]) => JSON.parse(String(line)) as {
          protocolVersion: number;
          projectPath: string;
          stateDirectory: string;
        }),
        once(child, "exit").then(([code]) => {
          throw new Error(`Runner exited before readiness (${String(code)}): ${diagnostics.join("")}`);
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Runner readiness timed out.")), 10_000);
        }),
      ]);
      assert.equal(readiness.protocolVersion, 2);
      assert.equal(readiness.projectPath, project);
      assert.equal(readiness.stateDirectory, state);
    } finally {
      if (timeout) clearTimeout(timeout);
      lines.close();
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLI rejects a capability configuration placed inside the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cli-capabilities-contained-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const config = join(project, "runner-capabilities.json");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(config, JSON.stringify({
    version: 1,
    extensions: [],
    languageServers: [],
  }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        tsxPath,
        cliPath,
        "--project",
        project,
        "--state-dir",
        state,
        "--port",
        "0",
        "--token",
        "cli-capabilities-contained-token",
        "--capabilities-config",
        config,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const streams = runnerStreams(child);
    streams.stdout.setEncoding("utf8");
    streams.stderr.setEncoding("utf8");
    streams.stdout.on("data", (chunk: string) => { stdout += chunk; });
    streams.stderr.on("data", (chunk: string) => { stderr += chunk; });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      once(child, "exit").then(([code]) => ({ type: "exit" as const, code: code as number | null })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ type: "timeout" }), 3_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.type === "timeout") {
      assert.fail("Runner should reject an in-project capabilities configuration before listening.");
    }

    assert.equal(outcome.code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /capabilities configuration must be outside the project directory/i);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function runnerStreams(child: ReturnType<typeof spawn>) {
  const { stdout, stderr } = child;
  if (!stdout || !stderr) {
    throw new Error("Runner CLI test requires stdout and stderr pipes.");
  }
  return { stdout, stderr };
}
