import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { NativeTool, ToolExecutionContext, ToolResult } from "../src/agent-contracts.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { captureFilesystemMutation, authorizeFilesystemMutation, fencedDelete } from "../src/filesystem-mutation-fence.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Fixture {
  t: TestContext;
  root: string;
  workspace: string;
  outside: string;
  authority: ReturnType<typeof createExecutionGrantAuthority>;
  beforeIssue?: () => void;
  beforeExecute?: (tool: NativeTool<unknown>, input: unknown, context: ToolExecutionContext) => Promise<void>;
  invoke(name: string, input: unknown): Promise<ToolResult>;
}
function fixtureTest(name: string, run: (fixture: Fixture) => Promise<void>): void {
  test(`filesystem fence: ${name}`, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task10-fence-"));
    const workspace = join(root, "workspace"); const outside = join(root, "outside");
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "sentinel.txt"), "outside-original");
    const f = { t, root, workspace, outside } as Fixture;
    const authority = createExecutionGrantAuthority({ beforeIssueCommit: async () => f.beforeIssue?.() });
    f.authority = authority;
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, executionGrants: authority });
    for (const tool of createFilesystemTools()) broker.register({
      ...tool,
      execute: async (input, context) => {
        await f.beforeExecute?.(tool, input, context);
        return tool.execute(input, context);
      },
    });
    let ordinal = 0;
    f.invoke = (name, input) => broker.invoke({ type: "tool_call", callId: `call-${++ordinal}`, name, arguments: input }, {
      runId: "fence-run", sessionId: "fence-session", actor: { role: "worker", id: "fence-worker" },
    });
    let passed = false;
    try { await run(f); assert.equal(authority.activeSnapshots().length, 0); passed = true; }
    finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await authority.revokeAll("cleanup");
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else t.diagnostic(`Task 10 RED/diagnostic root retained: ${root}`);
    }
  });
}
function refused(result: ToolResult, code: string | readonly string[]): void {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok((typeof code === "string" ? [code] : code).includes(result.error?.code ?? ""), JSON.stringify(result));
}

for (const tool of ["fs.write", "fs.patch"]) fixtureTest(`${tool} requires the caller's expected revision`, async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const result = await f.invoke(tool, { path: "value.txt", content: "replacement", search: "original", replace: "replacement" });
  refused(result, "expected_revision_required");
  assert.equal(fs.readFileSync(path, "utf8"), "original");
});
fixtureTest("stale revision refuses replacement and supplies a current revision", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement", expectedSha256: hash("stale") });
  refused(result, "revision_conflict");
  assert.equal(fs.readFileSync(path, "utf8"), "original");
});
fixtureTest("an authorization-time create race cannot become replacement", async (f) => {
  const path = join(f.workspace, "value.txt");
  f.beforeIssue = () => fs.writeFileSync(path, "other-writer", { flag: "wx" });
  refused(await f.invoke("fs.write", { path: "value.txt", content: "replacement" }), "target_already_exists");
  assert.equal(fs.readFileSync(path, "utf8"), "other-writer");
});
fixtureTest("publication is create-if-absent even after the final absence check", async (f) => {
  const path = join(f.workspace, "value.txt"); let raced = false;
  const inject = (destination: fs.PathLike) => {
    if (resolve(String(destination)) === path && !raced) { raced = true; fs.writeFileSync(path, "race-winner", { flag: "wx" }); }
  };
  const link = fs.linkSync; const rename = fs.promises.rename;
  f.t.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => { inject(destination); return link(source, destination); });
  f.t.mock.method(fs.promises, "rename", async (source: fs.PathLike, destination: fs.PathLike) => { inject(destination); return rename(source, destination); });
  syncBuiltinESMExports();
  const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement" });
  assert.equal(raced, true); assert.equal(fs.readFileSync(path, "utf8"), "race-winner");
  refused(result, "target_already_exists");
  assert.deepEqual(fs.readdirSync(f.workspace), ["value.txt"], "owned staging files are cleaned");
});
fixtureTest("parent replacement cannot redirect an approved write", async (f) => {
  const parent = join(f.workspace, "parent"); fs.mkdirSync(parent);
  fs.writeFileSync(join(parent, "value.txt"), "original");
  f.beforeIssue = () => {
    fs.renameSync(parent, `${parent}-old`); fs.mkdirSync(parent);
    fs.writeFileSync(join(parent, "value.txt"), "original");
  };
  refused(await f.invoke("fs.write", { path: "parent/value.txt", content: "replacement", expectedSha256: hash("original") }), "filesystem_identity_changed");
  assert.equal(fs.readFileSync(join(parent, "value.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(join(`${parent}-old`, "value.txt"), "utf8"), "original");
});
fixtureTest("target symbolic links are refused before replacement", async (f) => {
  fs.symlinkSync(join(f.outside, "sentinel.txt"), join(f.workspace, "alias.txt"), "file");
  refused(await f.invoke("fs.write", { path: "alias.txt", content: "replacement", expectedSha256: hash("outside-original") }), "filesystem_alias");
  assert.equal(fs.readFileSync(join(f.outside, "sentinel.txt"), "utf8"), "outside-original");
  assert.equal(fs.lstatSync(join(f.workspace, "alias.txt")).isSymbolicLink(), true);
});
fixtureTest("directory junction or reparse alias cannot redirect a write", async (f) => {
  fs.symlinkSync(f.outside, join(f.workspace, "alias"), "junction");
  refused(await f.invoke("fs.write", { path: "alias/sentinel.txt", content: "replacement", expectedSha256: hash("outside-original") }), "filesystem_alias");
  assert.equal(fs.readFileSync(join(f.outside, "sentinel.txt"), "utf8"), "outside-original");
});
fixtureTest("retargeting an authorized parent to a junction is refused", async (f) => {
  const parent = join(f.workspace, "parent"); fs.mkdirSync(parent);
  fs.writeFileSync(join(parent, "sentinel.txt"), "outside-original");
  f.beforeExecute = async () => { fs.renameSync(parent, `${parent}-old`); fs.symlinkSync(f.outside, parent, "junction"); };
  refused(await f.invoke("fs.write", { path: "parent/sentinel.txt", content: "replacement", expectedSha256: hash("outside-original") }), "filesystem_alias");
  assert.equal(fs.readFileSync(join(f.outside, "sentinel.txt"), "utf8"), "outside-original");
});
fixtureTest("outside hard links are refused rather than claiming confinement", async (f) => {
  fs.linkSync(join(f.outside, "sentinel.txt"), join(f.workspace, "linked.txt"));
  refused(await f.invoke("fs.write", { path: "linked.txt", content: "replacement", expectedSha256: hash("outside-original") }), "hardlink_confinement_unprovable");
  assert.equal(fs.statSync(join(f.workspace, "linked.txt")).nlink, 2);
  assert.equal(fs.readFileSync(join(f.outside, "sentinel.txt"), "utf8"), "outside-original");
});
fixtureTest("move destination must not overwrite an existing file", async (f) => {
  fs.writeFileSync(join(f.workspace, "source.txt"), "source"); fs.writeFileSync(join(f.workspace, "destination.txt"), "destination");
  refused(await f.invoke("fs.move", { source: "source.txt", destination: "destination.txt" }), "target_already_exists");
  assert.equal(fs.readFileSync(join(f.workspace, "source.txt"), "utf8"), "source");
  assert.equal(fs.readFileSync(join(f.workspace, "destination.txt"), "utf8"), "destination");
});
for (const side of ["source", "destination"] as const) fixtureTest(`move ${side} substitution is refused`, async (f) => {
  const parent = join(f.workspace, "parent"); fs.mkdirSync(parent);
  fs.writeFileSync(join(f.workspace, "source.txt"), "source");
  f.beforeExecute = async () => {
    if (side === "source") { fs.renameSync(join(f.workspace, "source.txt"), join(f.workspace, "original.txt")); fs.writeFileSync(join(f.workspace, "source.txt"), "replacement"); }
    else { fs.renameSync(parent, `${parent}-old`); fs.symlinkSync(f.outside, parent, "junction"); }
  };
  refused(await f.invoke("fs.move", { source: "source.txt", destination: "parent/moved.txt" }), side === "source" ? "filesystem_identity_changed" : "filesystem_alias");
  assert.equal(fs.existsSync(join(f.outside, "moved.txt")), false);
  assert.equal(fs.existsSync(join(f.workspace, "source.txt")), true);
});
for (const variant of ["identity", "symlink"] as const) fixtureTest(`delete ${variant} substitution is refused`, async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  f.beforeExecute = async () => {
    fs.renameSync(path, `${path}.original`);
    if (variant === "identity") fs.writeFileSync(path, "replacement");
    else fs.symlinkSync(join(f.outside, "sentinel.txt"), path, "file");
  };
  refused(await f.invoke("fs.delete", { path: "value.txt" }), variant === "identity" ? "filesystem_identity_changed" : "filesystem_alias");
  assert.equal(fs.existsSync(path), true); assert.equal(fs.readFileSync(`${path}.original`, "utf8"), "original");
  assert.equal(fs.readFileSync(join(f.outside, "sentinel.txt"), "utf8"), "outside-original");
});
fixtureTest("the same call cannot reserve or perform a second filesystem mutation", async (f) => {
  let repeated: Awaited<ReturnType<NativeTool<unknown>["execute"]>> | undefined;
  f.beforeExecute = async (tool, input, context) => {
    if (tool.definition.name !== "fs.write") return;
    const first = await tool.execute(input, context); assert.equal(first.isError, false);
    repeated = await tool.execute({ path: "other.txt", content: "escalation" }, context);
  };
  const result = await f.invoke("fs.write", { path: "value.txt", content: "original" });
  assert.ok(repeated); assert.equal(repeated.isError, true);
  refused(result, ["grant_consumed", "grant_mismatch"]);
  assert.equal(fs.existsSync(join(f.workspace, "other.txt")), false);
  assert.equal(fs.readFileSync(join(f.workspace, "value.txt"), "utf8"), "original");
});
fixtureTest("revocation at the last mile prevents writes", async (f) => {
  f.beforeExecute = async () => { await f.authority.revokeAll("cancelled"); };
  refused(await f.invoke("fs.write", { path: "value.txt", content: "unauthorized" }), "grant_revoked");
  assert.equal(fs.existsSync(join(f.workspace, "value.txt")), false);
});
fixtureTest("controlled external writer proves replacement is not atomic CAS", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original"); let writes = 0;
  const externalWrite = (destination: fs.PathLike) => {
    if (resolve(String(destination)) !== path) return;
    const child = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'external-after-validation')", path], { windowsHide: true });
    assert.equal(child.status, 0); assert.equal(child.error, undefined);
    assert.equal(fs.readFileSync(path, "utf8"), "external-after-validation"); writes++;
  };
  const asyncRename = fs.promises.rename; const syncRename = fs.renameSync;
  f.t.mock.method(fs.promises, "rename", async (source: fs.PathLike, destination: fs.PathLike) => { externalWrite(destination); return asyncRename(source, destination); });
  f.t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => { externalWrite(destination); return syncRename(source, destination); });
  syncBuiltinESMExports();
  const result = await f.invoke("fs.write", { path: "value.txt", content: "runner-replacement", expectedSha256: hash("original") });
  assert.equal(result.isError, false); assert.equal(writes, 1);
  assert.equal(fs.readFileSync(path, "utf8"), "runner-replacement", "the documented final OS gap is not a compare-and-swap");
});
fixtureTest("ordinary create, revision replacement, patch, directory move and recursive delete work", async (f) => {
  let result = await f.invoke("fs.write", { path: "created/value.txt", content: "one", createDirectories: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  result = await f.invoke("fs.write", { path: "created/value.txt", content: "two", expectedSha256: hash("one") });
  assert.equal(result.isError, false, JSON.stringify(result));
  result = await f.invoke("fs.patch", { path: "created/value.txt", search: "two", replace: "three", expectedSha256: hash("two") });
  assert.equal(result.isError, false, JSON.stringify(result));
  result = await f.invoke("fs.move", { source: "created", destination: "moved" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(fs.readFileSync(join(f.workspace, "moved/value.txt"), "utf8"), "three");
  result = await f.invoke("fs.delete", { path: "moved", recursive: true });
  assert.equal(result.isError, false, JSON.stringify(result)); assert.deepEqual(fs.readdirSync(f.workspace), []);
});

for (const changed of ["run", "session", "actor", "call", "tool", "grant", "case-only path"] as const) {
  fixtureTest(`a permit cannot change its ${changed} after authorization`, async (f) => {
    f.beforeExecute = async (tool, input, context) => {
      const altered = { ...context };
      if (changed === "run") altered.runId = "other-run";
      if (changed === "session") altered.sessionId = "other-session";
      if (changed === "actor") altered.actor = { ...context.actor, id: "other-worker" };
      if (changed === "call") altered.callId = "other-call";
      if (changed === "tool") altered.toolName = "fs.delete";
      if (changed === "grant") altered.executionGrant = Object.freeze({ ...context.executionGrant! });
      const result = await tool.execute(changed === "case-only path" ? { path: "VALUE.txt", content: "unauthorized" } : input, altered);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.error?.code, "grant_mismatch", JSON.stringify(result));
    };
    refused(await f.invoke("fs.write", { path: "value.txt", content: "original" }), "grant_consumed");
    assert.deepEqual(fs.readdirSync(f.workspace), []);
  });
}
fixtureTest("a new-file parent retarget cannot redirect create publication", async (f) => {
  const parent = join(f.workspace, "parent"); fs.mkdirSync(parent);
  f.beforeExecute = async () => { fs.renameSync(parent, `${parent}-old`); fs.symlinkSync(f.outside, parent, "junction"); };
  const result = await f.invoke("fs.write", { path: "parent/new.txt", content: "confined" });
  assert.deepEqual(fs.readdirSync(f.outside), ["sentinel.txt"]);
  assert.deepEqual(fs.readdirSync(`${parent}-old`), []);
  refused(result, "filesystem_alias");
});
for (const tool of ["fs.write", "fs.patch"]) fixtureTest(`${tool} rechecks revision after staging immediately before publication`, async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const flush = fs.fsyncSync;
  f.t.mock.method(fs, "fsyncSync", (fd: number) => { flush(fd); fs.writeFileSync(path, "late-writer"); });
  refused(await f.invoke(tool, { path: "value.txt", content: "replacement", search: "original", replace: "replacement", expectedSha256: hash("original") }), "revision_conflict");
  assert.equal(fs.readFileSync(path, "utf8"), "late-writer");
  assert.deepEqual(fs.readdirSync(f.workspace), ["value.txt"]);
});
fixtureTest("revocation after staging refuses publication and cleans its owned temporary", async (f) => {
  const flush = fs.fsyncSync; let revoked: Promise<void> | undefined;
  f.t.mock.method(fs, "fsyncSync", (fd: number) => { flush(fd); revoked = f.authority.revokeAll("cancelled"); });
  refused(await f.invoke("fs.write", { path: "value.txt", content: "replacement" }), "grant_revoked");
  await revoked;
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
fixtureTest("move destination publication cannot overwrite a late race winner", async (f) => {
  const source = join(f.workspace, "source.txt"); const destination = join(f.workspace, "destination.txt");
  fs.writeFileSync(source, "source"); const link = fs.linkSync; let injected = false;
  f.t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (resolve(String(to)) === destination) { injected = true; fs.writeFileSync(destination, "winner", { flag: "wx" }); }
    return link(from, to);
  });
  refused(await f.invoke("fs.move", { source: "source.txt", destination: "destination.txt" }), "target_already_exists");
  assert.equal(injected, true); assert.equal(fs.readFileSync(source, "utf8"), "source");
  assert.equal(fs.readFileSync(destination, "utf8"), "winner"); assert.equal(fs.statSync(source).nlink, 1);
});
fixtureTest("a source substitution at the move syscall is detected before unlink and reports partial effects", async (f) => {
  const source = join(f.workspace, "source.txt"); const destination = join(f.workspace, "destination.txt");
  fs.writeFileSync(source, "original"); const link = fs.linkSync;
  f.t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (resolve(String(to)) === destination) { fs.renameSync(source, `${source}.original`); fs.writeFileSync(source, "replacement"); }
    return link(from, to);
  });
  const result = await f.invoke("fs.move", { source: "source.txt", destination: "destination.txt" });
  refused(result, "filesystem_identity_changed");
  assert.equal(fs.readFileSync(source, "utf8"), "replacement");
  assert.equal(fs.readFileSync(`${source}.original`, "utf8"), "original");
  assert.equal(fs.readFileSync(destination, "utf8"), "replacement");
  assert.ok(result.content.some((block) => block.type === "json" && (block.value as { partialMutation?: boolean }).partialMutation === true), JSON.stringify(result));
});
for (const operation of ["fs.move", "fs.delete"]) fixtureTest(`${operation} refuses changed recursive directory membership before any effect`, async (f) => {
  const source = join(f.workspace, "source"); fs.mkdirSync(source); fs.writeFileSync(join(source, "original.txt"), "original");
  f.beforeExecute = async () => { fs.writeFileSync(join(source, "late.txt"), "late"); };
  refused(await f.invoke(operation, { path: "source", source: "source", destination: "moved", recursive: true }), "filesystem_identity_changed");
  assert.deepEqual(fs.readdirSync(source), ["late.txt", "original.txt"]);
  assert.equal(fs.existsSync(join(f.workspace, "moved")), false);
});
fixtureTest("delete requires the original grant's destructive approval", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const capture = captureFilesystemMutation(f.workspace, "fs.delete", [{ path, access: "delete" }]);
  const binding = { runId: "fence-run", sessionId: "fence-session", actor: { role: "worker" as const, id: "fence-worker" },
    toolName: "fs.delete", callId: "manual-delete", permissionProfile: "full" as const };
  const grant = await f.authority.issue({ ...binding, workspacePath: f.workspace, access: [{ path, mode: "write" }],
    externalApproved: false, destructiveApproved: false, networkApproved: false });
  try {
    assert.throws(() => {
      const filesystemMutation = authorizeFilesystemMutation(capture, { authority: f.authority, grant, binding });
      fencedDelete({ ...binding, workspacePath: f.workspace, executionGrant: grant, filesystemMutation }, path, false);
    }, { code: "grant_escalation" });
    assert.equal(fs.readFileSync(path, "utf8"), "original");
  } finally { await f.authority.revoke(grant, "completed"); }
});
fixtureTest("a configured workspace junction cannot bypass the original grant root policy", async (f) => {
  const alias = join(f.root, "configured-workspace"); fs.symlinkSync(f.workspace, alias, "junction");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: alias, executionGrants: f.authority });
  for (const tool of createFilesystemTools()) broker.register(tool);
  const result = await broker.invoke({ type: "tool_call", callId: "root-alias", name: "fs.write", arguments: { path: "value.txt", content: "confined" } },
    { runId: "root-run", sessionId: "root-session", actor: { role: "worker", id: "worker" } });
  refused(result, "filesystem_alias");
  assert.equal(fs.existsSync(join(f.workspace, "value.txt")), false);
});
fixtureTest("unprovable staging identity returns an explicit retained-resource failure", async (f) => {
  const stat = fs.fstatSync;
  f.t.mock.method(fs, "fstatSync", (fd: number, options: { bigint: true }) => Object.assign(Object.create(stat(fd, options)), { ino: 0n }));
  const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement" });
  refused(result, "filesystem_cleanup_unverified");
  assert.equal(fs.existsSync(join(f.workspace, "value.txt")), false);
  const retained = fs.readdirSync(f.workspace); assert.equal(retained.length, 1); assert.match(retained[0]!, /^\.aiboard-.*\.tmp$/);
  assert.ok(result.content.some((block) => block.type === "json" && String((block.value as { temporary?: string }).temporary).includes(retained[0]!)));
  f.t.mock.restoreAll(); // The fixture owner can now identify and clean its test root; the fence could not.
});
fixtureTest("POSIX identity contract does not treat ctime fallback as immutable creation time", async (f) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = fs.lstatSync; const fstat = fs.fstatSync;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  const fallback = (stat: fs.BigIntStats) => Object.assign(Object.create(stat), { birthtimeNs: stat.ctimeNs });
  f.t.mock.method(fs, "lstatSync", (path: fs.PathLike, options: { bigint: true }) => fallback(lstat(path, options)));
  f.t.mock.method(fs, "fstatSync", (fd: number, options: { bigint: true }) => fallback(fstat(fd, options)));
  try {
    const result = await f.invoke("fs.write", { path: "value.txt", content: "portable" });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(fs.readFileSync(join(f.workspace, "value.txt"), "utf8"), "portable");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
fixtureTest("recursive capture has a typed depth bound before mutation", async (f) => {
  let path = join(f.workspace, "deep"); fs.mkdirSync(path);
  for (let depth = 0; depth < 66; depth++) { path = join(path, "d"); fs.mkdirSync(path); }
  refused(await f.invoke("fs.delete", { path: "deep", recursive: true }), "filesystem_safety_unsupported");
  assert.equal(fs.existsSync(path), true);
});
fixtureTest("Windows open destination causes a typed refusal without losing the file", async (f) => {
  if (process.platform !== "win32") { f.t.skip("Real Windows sharing semantics only"); return; }
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original"); const fd = fs.openSync(path, "r");
  try {
    refused(await f.invoke("fs.write", { path: "value.txt", content: "replacement", expectedSha256: hash("original") }), "filesystem_operation_failed");
    assert.equal(fs.readFileSync(path, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(f.workspace), ["value.txt"]);
  } finally { fs.closeSync(fd); }
});
fixtureTest("an unobserved entry after recursive preflight survives the removal syscall", async (f) => {
  const root = join(f.workspace, "tree"); fs.mkdirSync(root); fs.writeFileSync(join(root, "old.txt"), "old");
  const remove = fs.rmdirSync;
  f.t.mock.method(fs, "rmdirSync", (path: fs.PathLike) => { if (resolve(String(path)) === root) fs.writeFileSync(join(root, "late.txt"), "late"); return remove(path); });
  const result = await f.invoke("fs.delete", { path: "tree", recursive: true });
  refused(result, "filesystem_identity_changed");
  assert.equal(fs.readFileSync(join(root, "late.txt"), "utf8"), "late");
  assert.ok(result.content.some((block) => block.type === "json" && (block.value as { partialMutation?: boolean }).partialMutation === true));
});
fixtureTest("POSIX distinct birthtime still detects a generation change", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = fs.lstatSync; let changed = false;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  f.t.mock.method(fs, "lstatSync", (file: fs.PathLike, options: { bigint: true }) => {
    const stat = lstat(file, options);
    return resolve(String(file)) === path ? Object.assign(Object.create(stat), { birthtimeNs: changed ? 1100n : 1000n, ctimeNs: 2000n }) : stat;
  });
  f.beforeExecute = async () => { changed = true; };
  try {
    refused(await f.invoke("fs.delete", { path: "value.txt" }), "filesystem_identity_changed");
    assert.equal(fs.readFileSync(path, "utf8"), "original");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
for (const operation of ["fs.write", "fs.move", "fs.delete"]) fixtureTest(`${operation} refuses a hard link introduced after authorization`, async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  f.beforeExecute = async () => { fs.linkSync(path, join(f.outside, "late-link.txt")); };
  refused(await f.invoke(operation, { path: "value.txt", source: "value.txt", destination: "moved.txt", content: "replacement", expectedSha256: hash("original") }), "hardlink_confinement_unprovable");
  assert.equal(fs.readFileSync(path, "utf8"), "original");
  assert.equal(fs.readFileSync(join(f.outside, "late-link.txt"), "utf8"), "original");
});
fixtureTest("consuming diagnostics authority prevents a subsequent filesystem effect", async (f) => {
  f.beforeExecute = async (_tool, _input, context) => {
    f.authority.consume(context.executionGrant!, { runId: context.runId, sessionId: context.sessionId, actor: context.actor,
      callId: context.callId!, toolName: context.toolName!, permissionProfile: "full" });
  };
  refused(await f.invoke("fs.write", { path: "value.txt", content: "forbidden" }), "grant_consumed");
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
fixtureTest("project policy preserves logical move approval and denies unapproved outside writes", async (f) => {
  let approvals = 0;
  const broker = new ToolBroker({ permissionProfile: "project", workspacePath: f.workspace, executionGrants: f.authority, approve: async () => { approvals++; return false; } });
  for (const tool of createFilesystemTools()) broker.register(tool);
  fs.mkdirSync(join(f.workspace, "source")); fs.writeFileSync(join(f.workspace, "source/value.txt"), "original");
  const context = { runId: "project-run", sessionId: "project-session", actor: { role: "worker" as const, id: "worker" } };
  const moved = await broker.invoke({ type: "tool_call", callId: "move", name: "fs.move", arguments: { source: "source", destination: "moved" } }, context);
  assert.equal(moved.isError, false, JSON.stringify(moved)); assert.equal(approvals, 0, "Do not silently broaden existing Broker approval policy");
  const outside = await broker.invoke({ type: "tool_call", callId: "outside", name: "fs.write", arguments: { path: join(f.outside, "new.txt"), content: "forbidden" } }, context);
  assert.equal(outside.isError, true); assert.equal(approvals, 1); assert.equal(fs.existsSync(join(f.outside, "new.txt")), false);
});
fixtureTest("OS refusal is durably completed and replayed rather than left in doubt", async (f) => {
  if (process.platform !== "win32") { f.t.skip("Real Windows sharing semantics only"); return; }
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const database = join(f.root, "ledger.sqlite"); let ledger = new SqliteToolLedger(database);
  const makeBroker = () => { const broker = new ToolBroker({ permissionProfile: "full", workspacePath: f.workspace, executionGrants: f.authority, ledger });
    for (const tool of createFilesystemTools()) broker.register(tool); return broker; };
  const call = { type: "tool_call" as const, callId: "locked", name: "fs.write", arguments: { path: "value.txt", content: "replacement", expectedSha256: hash("original") } };
  const context = { runId: "locked-run", sessionId: "locked-session", actor: { role: "worker" as const, id: "worker" } };
  try {
    const fd = fs.openSync(path, "r"); let first: ToolResult;
    try { first = await makeBroker().invoke(call, context); } finally { fs.closeSync(fd); }
    refused(first!, "filesystem_operation_failed");
    assert.deepEqual(ledger.listRun(context.runId).map((event) => event.type), ["tool.started", "tool.completed"]);
    ledger.close(); ledger = new SqliteToolLedger(database);
    const replay = await makeBroker().invoke(call, context);
    assert.deepEqual(replay, first!); assert.equal(fs.readFileSync(path, "utf8"), "original");
  } finally { ledger.close(); }
});
fixtureTest("Windows device, alternate stream and ambiguous names are refused", async (f) => {
  if (process.platform !== "win32") { f.t.skip("Win32 path parsing only"); return; }
  for (const path of ["value.txt:stream", "NUL.txt", "trailing.", "trailing "])
    refused(await f.invoke("fs.write", { path, content: "forbidden" }), "filesystem_safety_unsupported");
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});

for (const osCode of ["EPERM", "EACCES", "EMLINK"]) fixtureTest(`review2: create link refusal ${osCode} is actionable and cleans staging`, async (f) => {
  f.t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("link publication unavailable"), { code: osCode }); });
  const result = await f.invoke("fs.write", { path: "new.txt", content: "complete-bytes" });
  refused(result, "filesystem_safety_unsupported");
  assert.ok(result.content.some(block => block.type === "json" && (block.value as { osCode?: string }).osCode === osCode));
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
fixtureTest("review2: POSIX canonical spelling refusal supplies the exact retry path without broadening authority", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realpath = fs.realpathSync.native;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  f.t.mock.method(fs.realpathSync, "native", (file: fs.PathLike) => {
    const actual = realpath(file);
    return resolve(String(file)) === path ? join(f.workspace, "VALUE.txt") : actual;
  });
  try {
    const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement", expectedSha256: hash("original") });
    refused(result, "filesystem_alias");
    assert.ok(result.content.some(block => block.type === "json" &&
      (block.value as { canonicalPath?: string }).canonicalPath === join(f.workspace, "VALUE.txt")), JSON.stringify(result));
    assert.equal(fs.readFileSync(path, "utf8"), "original");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
fixtureTest("review2: POSIX catches a same-object writer after the final revision read", async (f) => {
  const path = join(f.workspace, "value.txt"); fs.writeFileSync(path, "original");
  const targetIno = fs.statSync(path, { bigint: true }).ino;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const read = fs.readFileSync; const realpath = fs.realpathSync.native;
  let reads = 0; let injected = false;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  f.t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = read(...args);
    if (typeof args[0] === "number" && fs.fstatSync(args[0], { bigint: true }).ino === targetIno) reads++;
    return bytes;
  });
  f.t.mock.method(fs.realpathSync, "native", (file: fs.PathLike) => {
    const actual = realpath(file);
    if (!injected && reads >= 2 && resolve(String(file)) === path) {
      injected = true; fs.writeFileSync(path, "external");
    }
    return actual;
  });
  try {
    const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement", expectedSha256: hash("original") });
    assert.equal(injected, true);
    refused(result, "revision_conflict");
    assert.equal(fs.readFileSync(path, "utf8"), "external");
    assert.deepEqual(fs.readdirSync(f.workspace), ["value.txt"]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

for (const length of [0, 131_073]) fixtureTest(`review2: POSIX positioned rehash and handle cleanup contract (${length} bytes)`, async (f) => {
  const path = join(f.workspace, "value.txt"), original = "o".repeat(length);
  fs.writeFileSync(path, original);
  const ino = fs.statSync(path, { bigint: true }).ino;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const read = fs.readFileSync; const readAt = fs.readSync;
  let targetFd: number | undefined; let reachedRename = false;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  f.t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const result = read(...args);
    if (typeof args[0] === "number" && fs.fstatSync(args[0], { bigint: true }).ino === ino) targetFd = args[0];
    return result;
  });
  f.t.mock.method(fs, "readSync", (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, count: number, position: number) =>
    readAt(fd, buffer, offset, Math.min(count, 997), position));
  f.t.mock.method(fs, "renameSync", () => {
    assert.equal(fs.fstatSync(targetFd!, { bigint: true }).ino, ino);
    reachedRename = true;
    // Contract test only: do not pretend Windows executed POSIX rename semantics.
    throw Object.assign(new Error("controlled publication failure"), { code: "EACCES" });
  });
  try {
    const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement", expectedSha256: hash(original) });
    assert.equal(reachedRename, true, JSON.stringify(result));
    refused(result, "filesystem_operation_failed");
    assert.throws(() => fs.fstatSync(targetFd!), { code: "EBADF" });
    assert.equal(fs.readFileSync(path, "utf8"), original);
    assert.deepEqual(fs.readdirSync(f.workspace), ["value.txt"]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
fixtureTest("review2: missing intermediate parent needs explicit createDirectories", async (f) => {
  refused(await f.invoke("fs.write", { path: "missing/value.txt", content: "new" }), "target_missing");
  assert.deepEqual(fs.readdirSync(f.workspace), []);
});
fixtureTest("review2: mkdir race never takes over the winning directory", async (f) => {
  const parent = join(f.workspace, "missing"), mkdir = fs.mkdirSync;
  f.t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]) === parent && !fs.existsSync(parent)) { mkdir(parent); fs.writeFileSync(join(parent, "winner.txt"), "winner"); }
    return mkdir(...args);
  });
  refused(await f.invoke("fs.write", { path: "missing/value.txt", content: "new", createDirectories: true }), "target_already_exists");
  assert.deepEqual(fs.readdirSync(parent), ["winner.txt"]);
});
fixtureTest("review2: cross-device move refuses without copying or deleting the source", async (f) => {
  const source = join(f.workspace, "source.txt"); fs.writeFileSync(source, "original");
  f.t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("cross device"), { code: "EXDEV" }); });
  refused(await f.invoke("fs.move", { source: "source.txt", destination: "dest.txt" }), "filesystem_safety_unsupported");
  assert.equal(fs.readFileSync(source, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(f.workspace), ["source.txt"]);
});

for (const mode of ["create", "replace"] as const) for (const phase of ["flush", "publication"] as const)
  fixtureTest(`review3: ${mode} refuses staged-byte tampering at ${phase}`, async (f) => {
    const path = join(f.workspace, "value.txt");
    if (mode === "replace") fs.writeFileSync(path, "original");
    const flush = fs.fsyncSync, stat = fs.lstatSync; let flushed = false; let injected = false;
    const tamper = () => {
      const temporary = fs.readdirSync(f.workspace).find((name) => name.startsWith(".aiboard-") && name.endsWith(".tmp"));
      assert.ok(temporary);
      fs.writeFileSync(join(f.workspace, temporary), "tampered");
      injected = true;
    };
    f.t.mock.method(fs, "fsyncSync", (fd: number) => {
      flush(fd); flushed = true;
      if (phase === "flush") tamper();
    });
    f.t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (phase === "publication" && flushed && !injected && resolve(String(args[0])) === path) tamper();
      return stat(...args);
    });
    const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement",
      ...(mode === "replace" ? { expectedSha256: hash("original") } : {}) });
    assert.equal(injected, true);
    refused(result, "filesystem_identity_changed");
    assert.ok(result.content.some((block) => block.type === "json" &&
      (block.value as { partialMutation?: boolean }).partialMutation === false));
    if (mode === "replace") assert.equal(fs.readFileSync(path, "utf8"), "original");
    else assert.equal(fs.existsSync(path), false);
    assert.deepEqual(fs.readdirSync(f.workspace), mode === "replace" ? ["value.txt"] : []);
  });
