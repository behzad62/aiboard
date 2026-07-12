import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  createBrowserTools,
  PlaywrightBrowserBackend,
  type BrowserBackend,
} from "../src/browser-tools.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolBroker } from "../src/tool-broker.js";

class FakeBrowserBackend implements BrowserBackend {
  readonly calls: Array<{ operation: string; sessionId: string; input?: unknown }> = [];
  async open(sessionId: string, input: { url: string; width: number; height: number }) {
    this.calls.push({ operation: "open", sessionId, input });
    return { url: input.url, title: "App" };
  }
  async navigate(sessionId: string, url: string) {
    this.calls.push({ operation: "navigate", sessionId, input: url });
    return { url, title: "Page" };
  }
  async snapshot(sessionId: string) {
    this.calls.push({ operation: "snapshot", sessionId });
    return { url: "http://localhost:3000", title: "App", text: "Visible text", html: "<main>Visible text</main>" };
  }
  async click(sessionId: string, selector: string) {
    this.calls.push({ operation: "click", sessionId, input: selector });
  }
  async fill(sessionId: string, selector: string, value: string) {
    this.calls.push({ operation: "fill", sessionId, input: { selector, value } });
  }
  async screenshot(sessionId: string) {
    this.calls.push({ operation: "screenshot", sessionId });
    return Buffer.from("png-bytes");
  }
  async events(sessionId: string) {
    this.calls.push({ operation: "events", sessionId });
    return {
      console: [{ type: "error", text: "boom", occurredAt: "2026-01-01T00:00:00.000Z" }],
      network: [{ method: "GET", url: "http://localhost/api", status: 500, occurredAt: "2026-01-01T00:00:00.000Z" }],
    };
  }
  async close(sessionId: string) {
    this.calls.push({ operation: "close", sessionId });
  }
  async closeAll() {}
}

test("browser tools keep one task session and persist DOM and screenshot artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-browser-tools-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const backend = new FakeBrowserBackend();
  try {
    const broker = new ToolBroker({
      permissionProfile: "full",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createBrowserTools({
      backend,
      artifacts,
      evidenceStore: evidence,
      taskId: "task_ui",
    })) {
      broker.register(tool);
    }
    const context = {
      runId: "run_ui",
      sessionId: "worker_session",
      actor: { role: "worker" as const, id: "worker_1" },
      workspacePath: root,
    };
    const open = await broker.invoke(call("open", "browser.open", {
      url: "http://localhost:3000",
      width: 1280,
      height: 720,
    }), context);
    assert.equal(open.isError, false);
    const snapshot = await broker.invoke(call("snapshot", "browser.snapshot", {}), context);
    const snap = jsonValue(snapshot) as { htmlArtifactHash: string; text: string };
    assert.equal(snap.text, "Visible text");
    assert.equal((await artifacts.get(snap.htmlArtifactHash)).toString(), "<main>Visible text</main>");
    const screenshot = await broker.invoke(call("shot", "browser.screenshot", {}), context);
    const shot = jsonValue(screenshot) as { artifactHash: string; mediaType: string };
    assert.equal(shot.mediaType, "image/png");
    assert.equal((await artifacts.get(shot.artifactHash)).toString(), "png-bytes");
    const events = await broker.invoke(call("events", "browser.events", {}), context);
    assert.equal((jsonValue(events) as { console: unknown[] }).console.length, 1);
    const records = evidence.list({ runId: "run_ui", taskId: "task_ui" });
    assert.deepEqual(records.map((record) => record.fact.kind), [
      "browser_snapshot",
      "browser_screenshot",
      "browser_events",
    ]);
    assert.equal(records[0].fact.kind, "browser_snapshot");
    if (records[0].fact.kind === "browser_snapshot") {
      assert.equal(records[0].fact.url, "http://localhost:3000");
      assert.equal(records[0].fact.htmlArtifactHash, snap.htmlArtifactHash);
    }
    assert.equal(records[1].fact.kind, "browser_screenshot");
    if (records[1].fact.kind === "browser_screenshot") {
      assert.equal(records[1].fact.screenshotArtifactHash, shot.artifactHash);
    }
    assert.equal(records[2].fact.kind, "browser_events");
    if (records[2].fact.kind === "browser_events") {
      assert.equal(records[2].fact.consoleErrorCount, 1);
      assert.equal(records[2].fact.networkFailureCount, 1);
      assert.equal((await artifacts.get(records[2].fact.eventsArtifactHash)).toString(), JSON.stringify(jsonValue(events)));
    }
    assert.equal(new Set(backend.calls.map((entry) => entry.sessionId)).size, 1);
    assert.equal(backend.calls[0].sessionId, "run_ui:task_ui");
  } finally {
    evidence.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser interactions require approval outside Full Access", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-browser-permission-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  try {
    const broker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createBrowserTools({
      backend: new FakeBrowserBackend(),
      artifacts,
      taskId: "task_ui",
    })) broker.register(tool);
    const result = await broker.invoke(call("open", "browser.open", {
      url: "http://localhost:3000",
    }), {
      runId: "run_ui",
      sessionId: "worker_session",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.error?.code, "approval_required");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Playwright task session rehydrates URL and storage after runner restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-browser-recovery-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><body><script>
      document.body.textContent = localStorage.getItem("runner-state") || "first";
      localStorage.setItem("runner-state", "restored");
    </script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/state`;
    const first = new PlaywrightBrowserBackend(join(root, "sessions"));
    assert.equal((await first.open("run:task", { url, width: 800, height: 600 })).url, url);
    assert.equal((await first.snapshot("run:task")).text, "first");
    await first.closeAll();

    const recovered = new PlaywrightBrowserBackend(join(root, "sessions"));
    const snapshot = await recovered.snapshot("run:task");
    assert.equal(snapshot.url, url);
    assert.equal(snapshot.text, "restored");
    await recovered.close("run:task");
    await recovered.closeAll();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Playwright open settles delayed dynamic imports before acceptance tools continue", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-browser-settle-"));
  const server = createServer((request, response) => {
    if (request.url === "/late.js") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("console.error('late dynamic import failure'); export default 1;");
      }, 100);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><body><script type="module">
      setTimeout(() => import('/late.js'), 50);
    </script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const backend = new PlaywrightBrowserBackend(join(root, "sessions"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await backend.open("run:settle", {
      url: `http://127.0.0.1:${address.port}/`,
      width: 800,
      height: 600,
    });
    const events = await backend.events("run:settle");
    assert.equal(
      events.console.some((event) => event.text.includes("late dynamic import failure")),
      true
    );
  } finally {
    await backend.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

function call(callId: string, name: string, arguments_: unknown) {
  return { type: "tool_call" as const, callId, name, arguments: arguments_ };
}

function jsonValue(result: Awaited<ReturnType<ToolBroker["invoke"]>>): unknown {
  const block = result.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json");
  return block.value;
}
