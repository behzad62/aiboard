import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { ExtensionManagementService } from "../src/extension-management-service.js";
import { ensureMcpLauncher, MCP_LAUNCHER_DIGEST, sweepMcpSecrets } from "../src/extension-mcp-launcher.js";
import { ManagedMcpRuntime } from "../src/extension-mcp.js";
import { buildTree, ExtensionPackageStore } from "../src/extension-package-store.js";
import { resolveGit, type GitSourceOptions } from "../src/extension-sources.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";

const uuid = "11111111-1111-4111-8111-111111111111";

function uploadService(home: string): ExtensionManagementService {
  return Object.assign(Object.create(ExtensionManagementService.prototype), { options: { home }, uploads: new Map() }) as ExtensionManagementService;
}

test("extension upload refuses an existing generated name", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  const original = crypto.randomBytes;
  try {
    await mkdir(join(root, "uploads"));
    const target = join(root, "uploads", "upl_" + "ab".repeat(16));
    await writeFile(target, "untouched");
    const stub = mock.method(crypto, "randomBytes", ((size: number) => Buffer.alloc(size, 0xab)) as typeof crypto.randomBytes);
    syncBuiltinESMExports();
    try { await assert.rejects(uploadService(root).storeUpload("a.zip", Buffer.from("new")), /EEXIST/); }
    finally { stub.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(crypto.randomBytes, original);
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired upload cleanup preserves replacement contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const service = uploadService(root);
    const upload = await service.storeUpload("a.zip", Buffer.from("original"));
    const target = join(root, "uploads", upload.uploadId);
    const internal = service as unknown as { uploads: Map<string, { createdAt: number }>; pruneUploads(): Promise<void> };
    internal.uploads.get(upload.uploadId)!.createdAt = 0;
    await writeFile(target, "replacement");
    const cleanup = internal.pruneUploads();
    assert.ok(cleanup instanceof Promise, "pruning waits for verification before it completes");
    await cleanup;
    assert.equal(await readFile(target, "utf8"), "replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP secret sweep keeps unrelated aged files", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const owned = join(root, "000000000000001-" + uuid + ".secret");
    const unrelated = join(root, "notes.secret");
    await writeFile(owned, "owned");
    await writeFile(unrelated, "untouched");
    await sweepMcpSecrets(root, Date.now() + 120_000);
    await assert.rejects(access(owned));
    assert.equal(await readFile(unrelated, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP launcher refuses an unexpected existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const target = join(root, `mcp-env-launcher-${MCP_LAUNCHER_DIGEST.slice(0, 16)}.mjs`);
    await writeFile(target, "unexpected");
    await assert.rejects(ensureMcpLauncher(root), /not the expected file/);
    assert.equal(await readFile(target, "utf8"), "unexpected");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generated MCP launcher does not claim an unrelated secret name", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const launcher = await ensureMcpLauncher(root);
    const foreign = join(root, "foreign.secret");
    await writeFile(foreign, JSON.stringify({ expiresAt: Date.now() + 60_000, values: {} }));
    const result = spawnSync(process.execPath, [launcher, root, "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8" });
    assert.equal(result.status, 78, result.stderr);
    await access(foreign);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("git and package staging collisions preserve existing directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const scratch = join(root, "scratch", "git-" + uuid);
    const tree = buildTree([{ path: "file.txt", bytes: Buffer.from("new"), executable: false }]);
    const staging = join(root, "staging", tree.digest.slice(0, 16) + "-" + uuid);
    await mkdir(scratch, { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(scratch, "sentinel"), "scratch");
    await writeFile(join(staging, "sentinel"), "staging");
    const stub = mock.method(crypto, "randomUUID", () => uuid);
    syncBuiltinESMExports();
    try {
      await assert.rejects(resolveGit({ type: "git", url: "https://example.test/repo.git" }, {
        scratchDirectory: join(root, "scratch"), allowLocal: false,
        executorFor: () => async () => ({ exitCode: 1, stdout: "", stderr: "stopped" }),
      } as GitSourceOptions));
      await assert.rejects(new ExtensionPackageStore(root).commit(tree), /EEXIST/);
    } finally { stub.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(join(scratch, "sentinel"), "utf8"), "scratch");
    assert.equal(await readFile(join(staging, "sentinel"), "utf8"), "staging");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP install collision does not clean an existing runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const target = join(root, "mcp-runtimes", "ext_test", "1-aaaaaaaa");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "sentinel"), "untouched");
    const runtime = new ManagedMcpRuntime({ home: root } as ConstructorParameters<typeof ManagedMcpRuntime>[0]);
    const internal = runtime as unknown as { install(plan: object, context: object): Promise<unknown>; installNpm(): Promise<never> };
    internal.installNpm = async () => { throw new Error("failed installer"); };
    const stub = mock.method(crypto, "randomBytes", ((size: number) => Buffer.alloc(size, 0xaa)) as typeof crypto.randomBytes);
    syncBuiltinESMExports();
    try { await assert.rejects(internal.install({ source: { type: "npm" }, version: "1", components: [{ kind: "mcp_server" }] }, { extensionId: "ext_test" })); }
    finally { stub.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(join(target, "sentinel"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed MCP discovery does not remove a run root it never created", async () => {
  const root = await mkdtemp(join(tmpdir(), "extension-owner-"));
  try {
    const run = join(root, "builds", runnerRunStateSegment("ext-check-" + "aa".repeat(8)));
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "sentinel"), "untouched");
    const runtime = new ManagedMcpRuntime({ stateDirectory: root, credentials: { list: () => [] } } as unknown as ConstructorParameters<typeof ManagedMcpRuntime>[0]);
    const internal = runtime as unknown as { launchPlan(): Promise<never> };
    internal.launchPlan = async () => { throw new Error("before directory creation"); };
    const stub = mock.method(crypto, "randomBytes", ((size: number) => Buffer.alloc(size, 0xaa)) as typeof crypto.randomBytes);
    syncBuiltinESMExports();
    try {
      await runtime.checkComponent("ext_test", "v1", { kind: "mcp_server", componentId: "mcp:test", serverName: "test", route: "runner", transport: "stdio", environment: [] } as Parameters<typeof runtime.checkComponent>[2]);
    } finally { stub.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(join(run, "sentinel"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});
