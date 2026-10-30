import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatAgentSessions } from "../src/chat-agent-session.js";
import { ManagedMcpRuntime } from "../src/extension-mcp.js";
import { ExtensionRunBindings } from "../src/extension-run-bindings.js";
import { openProvenSnapshotLinks } from "../src/proven-snapshot-links.js";
import { RemoteService } from "../src/remote-service.js";
import { ToolBenchSessions } from "../src/toolbench-session.js";

async function makeLink(t: test.TestContext, target: string, path: string): Promise<boolean> {
  try { await symlink(target, path, "file"); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("File symlinks unavailable"); return false; }
    throw error;
  }
}

test("chat session save leaves an existing fixed temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    const directory = join(root, "chat-sessions", "s1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.tmp"), "untouched");
    const sessions = new ChatAgentSessions({ stateDirectory: root } as ConstructorParameters<typeof ChatAgentSessions>[0]);
    const internal = sessions as unknown as { save(id: string, value: object): Promise<void> };
    await internal.save("s1", {});
    assert.equal(await readFile(join(directory, "session.tmp"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extension binding leaves an existing fixed temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    const directory = join(root, "extension-bindings");
    await mkdir(directory);
    await writeFile(join(directory, "r1.json.tmp"), "untouched");
    const service = { subscribe: () => () => {}, generation: async () => ({ generation: 1 }) };
    const bindings = new ExtensionRunBindings(root, service as unknown as ConstructorParameters<typeof ExtensionRunBindings>[1]);
    await bindings.bind("r1");
    bindings.close();
    assert.equal(await readFile(join(directory, "r1.json.tmp"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP OAuth and tool policy writes leave fixed temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    await writeFile(join(root, "oauth-clients.json.tmp"), "oauth sentinel");
    await writeFile(join(root, "mcp-tool-policy.json.tmp"), "policy sentinel");
    const runtime = new ManagedMcpRuntime({ home: root } as ConstructorParameters<typeof ManagedMcpRuntime>[0]);
    const internal = runtime as unknown as { writeOAuthClient(id: string, client: object): Promise<void> };
    await internal.writeOAuthClient("ext_test", { tokenEndpoint: "https://example.test", clientId: "id", resource: "https://example.test" });
    const state = { extension: () => ({ desiredGeneration: 1 }), setToolApproval: () => {}, putExtension: () => {}, publishGeneration: () => {}, registry: { currentGeneration: 1 } };
    runtime.attach({ registry: { mutate: async (callback: (value: typeof state) => Promise<void>) => callback(state) } } as unknown as Parameters<typeof runtime.attach>[0]);
    await runtime.setToolPolicy("ext_test", "all");
    assert.equal(await readFile(join(root, "oauth-clients.json.tmp"), "utf8"), "oauth sentinel");
    assert.equal(await readFile(join(root, "mcp-tool-policy.json.tmp"), "utf8"), "policy sentinel");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ToolBench recovery leaves an existing fixed temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    const directory = join(root, "toolbench", "s1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "snapshot.tmp"), "untouched");
    await writeFile(join(directory, "snapshot.json"), JSON.stringify({ sessionId: "s1", status: "running", reason: "" }));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ request: { budget: {} }, runtime: { runtimeId: "r", providerId: "p", modelId: "m" } }));
    const sessions = new ToolBenchSessions({ stateDirectory: root } as ConstructorParameters<typeof ToolBenchSessions>[0]);
    assert.equal((await sessions.get("s1")).status, "failed");
    assert.equal(await readFile(join(directory, "snapshot.tmp"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshot proof append does not follow a link leaf", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    const target = join(root, "target");
    await writeFile(target, "untouched");
    if (!(await makeLink(t, target, join(root, "links")))) return;
    openProvenSnapshotLinks(join(root, "links"), Buffer.alloc(32, 1)).add("proof");
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("remote status write does not follow a link leaf", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atomic-owner-"));
  try {
    const target = join(root, "target");
    await writeFile(target, "untouched");
    if (!(await makeLink(t, target, join(root, "remote-status.json")))) return;
    const service = Object.assign(Object.create(RemoteService.prototype), { options: { stateDirectory: root } }) as { writeStatusFile(status: object): void };
    service.writeStatusFile({ state: "logged-out" });
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});
