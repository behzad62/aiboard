import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { getNativeToolBenchPack, NATIVE_TOOLBENCH_BROWSER_SUITE } from "../lib/benchmark/toolreliability/native-cases";
import { createBrowserTools, PlaywrightBrowserBackend } from "../runner-v2/src/browser-tools";
import { ToolBroker } from "../runner-v2/src/tool-broker";
import { ArtifactStore } from "../runner-v2/src/artifact-store";

const fixture = getNativeToolBenchPack(NATIVE_TOOLBENCH_BROWSER_SUITE)!.cases[0].case;
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "native-toolbench-browser-")));
for (const [path, content] of Object.entries(fixture.fixtureFiles!)) {
  const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
}
const child = spawn(process.execPath, ["browser-server.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const backend = new PlaywrightBrowserBackend();
try {
  const url = await new Promise<string>((resolve, reject) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Fixture server did not start: ${stderr}`)), 5000);
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture server exited ${code}: ${stderr}`)); });
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(stdout.split("\n")[0]).url); } });
  });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  for (const tool of createBrowserTools({ backend, artifacts: new ArtifactStore(join(root, ".artifacts")), taskId: "browser" })) broker.register(tool);
  let id = 0;
  const call = (name: string, args: Record<string, unknown>) => broker.invoke({ type: "tool_call", callId: `browser-${++id}`, name, arguments: args }, { runId: "browser-run", sessionId: "browser-session", actor: { role: "worker", id: "worker" }, workspacePath: root });
  assert.equal((await call("browser.open", { url })).isError, false);
  const before = await call("browser.snapshot", {});
  assert.ok(JSON.stringify(before.content).includes("Save changes"));
  assert.equal((await call("not_a_real_tool", { target: "save" })).isError, true, "nonexistent browser tooling is refused");
  assert.throws(() => readFileSync(join(root, "saved.json")), /ENOENT/);
  assert.equal((await call("browser.click", { selector: "#save" })).isError, false);
  const deadline = Date.now() + 5_000;
  let savedObserved = false;
  do {
    const after = await call("browser.snapshot", {});
    savedObserved = after.content.some(block => block.type === "json" && (block.value as { text?: string }).text?.includes("Saved"));
  } while (!savedObserved && Date.now() < deadline);
  assert.ok(savedObserved, "the post-click page must converge to the observed Saved state");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "saved.json"), "utf8")), { saved: true });
  console.log("PASS optional ToolBench fixture with production browser tools, actual Chromium, and observable state change");
} finally {
  await backend.closeAll();
  if (child.exitCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
  rmSync(root, { recursive: true, force: true });
}
