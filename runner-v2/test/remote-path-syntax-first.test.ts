import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { createImageTools } from "../src/image-tools.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import { createProcessTools } from "../src/process-tools.js";
import { createRemotePathGuard } from "../src/remote-path-guard.js";
import { ToolBroker } from "../src/tool-broker.js";

// A UNC path names a host: on Windows a realpath, stat or open of it is a connection through the SMB/WebDAV redirector
// to a host the remote client chose, which can send it the user's NTLM credentials. The remote guard refuses UNC
// spellings by syntax, and that refusal must come before every check that touches the path, the fixed deny included.

const HOST = "attacker.invalid";
/** A folder name in the local paths whose last segment the guard refuses: no call may name it either. */
const PROBE = "syntax-probe";

function mentions(value: unknown, markers: readonly string[]): boolean {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : value instanceof URL ? value.href : undefined;
  return text !== undefined && markers.some((marker) => text.toLowerCase().includes(marker));
}

/**
 * Every node:fs and node:fs/promises function (and realpath.native), live through syncBuiltinESMExports. A call that
 * names a marker is recorded and fails with ENOENT instead of running, so even a regression never reaches the network.
 */
function spyOnHostCalls(markers: readonly string[] = [HOST]): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const restores: Array<() => void> = [];
  const wrap = (original: (...args: unknown[]) => unknown, label: string, promised: boolean) => {
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      if (!args.some((arg) => mentions(arg, markers))) return original.apply(this, args);
      calls.push(label);
      const error = Object.assign(new Error(`${label} was called on a refused path`), { code: "ENOENT" });
      if (promised) return Promise.reject(error);
      const callback = args.at(-1);
      if (!label.endsWith("Sync") && typeof callback === "function") { process.nextTick(() => (callback as (error: Error) => void)(error)); return undefined; }
      throw error;
    };
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key)!;
      if (key === "native" && typeof descriptor.value === "function") descriptor.value = wrap(descriptor.value as (...args: unknown[]) => unknown, `${label}.native`, promised);
      Object.defineProperty(wrapped, key, descriptor);
    }
    return wrapped;
  };
  for (const [target, prefix, promised] of [[fs, "fs", false], [fsp, "fs/promises", true]] as const) {
    const record = target as unknown as Record<string, unknown>;
    for (const name of Object.keys(record)) {
      const original = record[name];
      if (typeof original !== "function" || /^[A-Z]/.test(name)) continue;
      record[name] = wrap(original as (...args: unknown[]) => unknown, `${prefix}.${name}`, promised);
      restores.push(() => { record[name] = original; });
    }
  }
  syncBuiltinESMExports();
  return { calls, restore: () => { for (const restore of restores) restore(); syncBuiltinESMExports(); } };
}

test("a UNC path is refused before any filesystem call, in every remote file tool", { skip: process.platform !== "win32" && "UNC paths are a Windows spelling" }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "remote-syntax-first-")));
  const workspace = join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(join(workspace, "local.txt"), "local fixture\n");
  const guard = createRemotePathGuard();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  // The default fixed deny (the AIBoard home), whose realpath of the raw path was the first call to reach the host.
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, pathGuard: guard, artifacts });
  for (const tool of [...createFilesystemTools({ artifacts, pathGuard: guard }), ...createImageTools({ artifacts, pathGuard: guard })]) broker.register(tool);
  const spy = spyOnHostCalls();
  try {
    // The spy sees a call that names the host (a local path here, so nothing leaves the machine).
    await fsp.stat(join(root, `${HOST}-marker`)).catch(() => undefined);
    assert.deepEqual(spy.calls, ["fs/promises.stat"], "the spy records a call that names the host");
    spy.calls.length = 0;

    let call = 0;
    for (const unc of [`\\\\${HOST}\\share\\x.png`, `//${HOST}/share/x.png`, `\\\\?\\UNC\\${HOST}\\share\\x.png`, `\\\\.\\UNC\\${HOST}\\share\\x.png`]) {
      const share = unc.slice(0, unc.lastIndexOf(unc.includes("/") ? "/" : "\\"));
      for (const [name, args] of [
        ["fs.read", { path: unc }],
        ["fs.list", { path: share }],
        ["fs.search", { path: share, pattern: "x" }],
        ["fs.stat", { path: unc }],
        ["fs.write", { path: unc, content: "x" }],
        ["fs.patch", { path: unc, search: "a", replace: "b" }],
        ["fs.move", { source: unc, destination: "moved.txt" }],
        ["fs.move", { source: "local.txt", destination: unc }],
        ["fs.delete", { path: unc }],
        ["image.inspect", { path: unc }],
      ] as const) {
        for (const role of ["remote", "local_mcp"] as const) {
          const result = await broker.invoke({ type: "tool_call", callId: `unc-${++call}`, name, arguments: args },
            { runId: "run", sessionId: "session", actor: { role, id: "principal" }, workspacePath: workspace });
          const label = `${role} ${name} ${JSON.stringify(args)}`;
          assert.equal(result.isError, true, label);
          assert.equal(result.error?.code, "path_denied", `${label}: ${JSON.stringify(result)}`);
          assert.deepEqual(spy.calls, [], `${label} reached the filesystem: ${spy.calls.join(", ")}`);
        }
      }
    }
    assert.ok(broker.auditRecords().some((record) => record.decision === "denied" && record.pathDenialReason === "unc_path" && record.actor.role === "remote"));
    assert.ok(guard.auditRecords().some((record) => record.reasonCode === "unc_path" && record.toolName === "image.inspect"));
    // Ordinary remote calls still pass the syntax check and run.
    const read = await broker.invoke({ type: "tool_call", callId: "local-read", name: "fs.read", arguments: { path: "local.txt" } },
      { runId: "run", sessionId: "session", actor: { role: "remote", id: "principal" }, workspacePath: workspace });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.match(JSON.stringify(read.content), /local fixture/);
  } finally {
    spy.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a refused last segment of fs.stat and a refused remote cwd are refused before any filesystem call", { skip: process.platform !== "win32" && "these are Windows spellings" }, async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "remote-syntax-first-")));
  const workspace = join(root, "workspace");
  fs.mkdirSync(join(workspace, PROBE), { recursive: true });
  fs.writeFileSync(join(workspace, "local.txt"), "local fixture\n");
  const guard = createRemotePathGuard();
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, pathGuard: guard, artifacts });
  // Nothing may run: a call that got past the syntax check would fail loudly here, after the spy's assertion.
  const refusedService = new Proxy({}, { get: () => { throw new Error("the managed process service was reached"); } }) as ManagedProcessService;
  for (const tool of [...createFilesystemTools({ artifacts, pathGuard: guard }), ...createProcessTools({ names: "mcp" }), ...createManagedProcessTools(refusedService, { names: "mcp" })]) broker.register(tool);
  const spy = spyOnHostCalls([HOST, PROBE]);
  try {
    // fs.stat declares only the parent folder (it reads the entry there), so the parent here is a real local folder:
    // before the broker checked the named path too, its realpath, stat and lstat ran before the tool refused.
    const lastSegments = [String.raw`${PROBE}\CON`, String.raw`${PROBE}\nul.txt`, String.raw`${PROBE}\x.txt:stream`, String.raw`${PROBE}\x.`, String.raw`${PROBE}\x `];
    // A cwd is a declared path of the process tools.
    const cwds = [String.raw`\\${HOST}\share`, `//${HOST}/share`, String.raw`${PROBE}\CON`, String.raw`${PROBE}\aux`, `${PROBE}.`, String.raw`${PROBE}\dir `];
    const calls: Array<readonly [string, Record<string, unknown>]> = [
      ...lastSegments.map((path) => ["fs.stat", { path }] as const),
      ...cwds.flatMap((cwd) => [
        ["process.run", { command: "echo refused", cwd }] as const,
        ["process.start", { command: "node", args: ["--version"], cwd }] as const,
      ]),
    ];
    let call = 0;
    for (const [name, args] of calls) {
      for (const role of ["remote", "local_mcp"] as const) {
        const result = await broker.invoke({ type: "tool_call", callId: `segment-${++call}`, name, arguments: args },
          { runId: "run", sessionId: "session", actor: { role, id: "principal" }, workspacePath: workspace });
        const label = `${role} ${name} ${JSON.stringify(args)}`;
        assert.deepEqual(spy.calls, [], `${label} reached the filesystem: ${spy.calls.join(", ")}`);
        assert.equal(result.isError, true, label);
        assert.equal(result.error?.code, "path_denied", `${label}: ${JSON.stringify(result)}`);
      }
    }
    const reasons = new Set(broker.auditRecords().filter((record) => record.decision === "denied").map((record) => record.pathDenialReason));
    for (const reason of ["device_name", "alternate_data_stream", "trailing_dot_or_space", "unc_path"]) assert.ok(reasons.has(reason), `audited ${reason}`);
    // An ordinary remote fs.stat still runs, on the entry itself.
    const stat = await broker.invoke({ type: "tool_call", callId: "local-stat", name: "fs.stat", arguments: { path: "local.txt" } },
      { runId: "run", sessionId: "session", actor: { role: "remote", id: "principal" }, workspacePath: workspace });
    assert.equal(stat.isError, false, JSON.stringify(stat));
    assert.match(JSON.stringify(stat.content), /"type":"file"/);
  } finally {
    spy.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
