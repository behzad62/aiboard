import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { resolveProtectedLocations } from "../src/protected-locations.js";
import { RemoteAuditStore } from "../src/remote-audit-store.js";
import { createRemotePathGuard } from "../src/remote-path-guard.js";
import { RemotePrincipalStore } from "../src/remote-principal.js";
import { createLocalMcpOwner, LocalMcpToolSession, RemoteToolRuntime } from "../src/remote-tool-runtime.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const identity = { accountId: "account", clientId: "client", deviceId: "device" };
const aliases: Readonly<Record<string, string>> = {
  "fs.read": "files_read", "fs.list": "files_list", "fs.search": "files_search", "fs.write": "files_write",
  "fs.patch": "files_patch", "fs.move": "files_move", "fs.delete": "files_delete",
  "process.run": "process_run", "process.start": "process_start", "process.write_stdin": "process_write_stdin",
};

test("device controls confine remote and local MCP tools and audit refusals", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".device-policy-"));
  const project = join(root, "project"), state = join(root, "state"), outside = join(root, "outside"), home = join(root, "home");
  for (const path of [project, state, outside, home, join(root, "PROJECT-ESCAPE")]) await mkdir(path);
  await mkdir(join(project, "subdirectory"));
  await mkdir(join(home, ".ssh"));
  await writeFile(join(home, ".ssh", "key"), "protected\n");
  await writeFile(join(project, "inside.txt"), "needle inside\n");
  await writeFile(join(project, "move.txt"), "unchanged\n");
  await writeFile(join(outside, "secret.txt"), "outside unchanged\n");
  await symlink(outside, join(project, "outward"), process.platform === "win32" ? "junction" : "dir");
  const env: NodeJS.ProcessEnv = process.platform === "win32"
    ? { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") }
    : { HOME: home, XDG_DATA_HOME: join(home, ".local", "share") };
  const locations = resolveProtectedLocations({ platform: process.platform, home, env, stateDirectory: state, uid: 1000 });
  assert.equal(locations.failClosed, false, JSON.stringify(locations.failures));
  const guard = createRemotePathGuard(locations);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const principals = new RemotePrincipalStore(join(state, "principals.sqlite"));
  principals.getOrCreate(identity);
  const remote = new RemoteToolRuntime({ host, principals, workspacePath: project, permissionProfile: "full",
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), pathGuard: guard, admitEffect: async (_request, dispatch) => await dispatch() });
  const local = new LocalMcpToolSession({ host, workspacePath: project, permissionProfile: "full",
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), pathGuard: guard, policy: () => principals.policy(identity),
    policyIdentity: () => identity, auditStore: principals.auditStore }, createLocalMcpOwner(0));
  let sequence = 0;
  const call = async (role: "remote" | "local_mcp", name: string, args: Record<string, unknown>) => role === "remote"
    ? await remote.invoke(identity, name, args)
    : await local.invoke(aliases[name]!, { ...args, ...(["fs.write", "fs.patch", "fs.move", "fs.delete", "process.run", "process.start", "process.write_stdin"].includes(name) ? { idempotencyKey: `case-${++sequence}` } : {}) });
  let failed = false, primary: unknown;
  try {
    principals.updatePolicy(identity, { onlyHere: true }, "local");
    assert.throws(() => principals.updatePolicy(identity, { onlyHere: false }, "remote"), /local user/);
    for (const role of ["remote", "local_mcp"] as const) {
      const inside = await call(role, "fs.read", { path: "inside.txt" });
      assert.equal(inside.isError, false, JSON.stringify(inside));
      const protectedRead = await call(role, "fs.read", { path: join(home, ".ssh", "key") });
      assert.equal(protectedRead.error?.code, "path_denied");
      assert.equal(principals.auditStore.list(1)[0]?.pathCategory, "ssh");
      assert.equal(await readFile(join(home, ".ssh", "key"), "utf8"), "protected\n");
      for (const [path, expected] of [
        [join("..", "outside", `${role}-relative.txt`), join(outside, `${role}-relative.txt`)],
        [join(outside, `${role}-absolute.txt`), join(outside, `${role}-absolute.txt`)],
        [join("outward", `${role}-link.txt`), join(outside, `${role}-link.txt`)],
        [join(root, "project-escape", `${role}-case.txt`), join(root, "PROJECT-ESCAPE", `${role}-case.txt`)],
      ] as const) {
        const result = await call(role, "fs.write", { path, content: "must not be written" });
        assert.equal(result.error?.code, "outside_only_here", JSON.stringify(result));
        assert.equal(existsSync(expected), false);
        const record = principals.auditStore.list(1)[0]!;
        assert.equal(record.role, role); assert.equal(record.decision, "denied");
        assert.equal(record.reasonCode, "outside_only_here"); assert.equal(record.pathCategory, "outside_only_here");
      }
      const read = await call(role, "fs.read", { path: join(outside, "secret.txt") });
      assert.equal(read.error?.code, "outside_only_here");
      assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside unchanged\n");
      assert.equal(principals.auditStore.list(1)[0]?.reasonCode, "outside_only_here");
      const forced = await call(role, "process.run", { command: process.execPath, cwd: "subdirectory", args: ["-e", "process.stdout.write(process.cwd())"] });
      assert.equal(forced.isError, false, JSON.stringify(forced));
      assert.ok(forced.content.some((part) => part.type === "text" && part.text.toLowerCase().includes(project.toLowerCase())), JSON.stringify(forced));
      const move = await call(role, "fs.move", { source: "move.txt", destination: join(outside, `${role}-moved.txt`) });
      assert.equal(move.error?.code, "outside_only_here", JSON.stringify(move));
      assert.equal(await readFile(join(project, "move.txt"), "utf8"), "unchanged\n");
      assert.equal(existsSync(join(outside, `${role}-moved.txt`)), false);
      assert.equal(principals.auditStore.list(1)[0]?.reasonCode, "outside_only_here");
      const listing = await call(role, "fs.list", { path: "." });
      assert.equal(listing.isError, false, JSON.stringify(listing));
      assert.match(JSON.stringify(listing.content), /inside\.txt/);
      assert.doesNotMatch(JSON.stringify(listing.content), /outward/);
      const searching = await call(role, "fs.search", { path: ".", pattern: "needle" });
      assert.equal(searching.isError, false, JSON.stringify(searching));
      assert.match(JSON.stringify(searching.content), /inside\.txt/);
      assert.doesNotMatch(JSON.stringify(searching.content), /outside unchanged/);
      const processResult = await call(role, "process.run", { command: process.execPath, cwd: outside,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(join(outside, `${role}-ran`))}, 'bad')`] });
      assert.equal(processResult.error?.code, "outside_only_here", JSON.stringify(processResult));
      assert.equal(existsSync(join(outside, `${role}-ran`)), false);
      assert.equal(principals.auditStore.list(1)[0]?.reasonCode, "outside_only_here");
    }

    principals.updatePolicy(identity, { onlyHere: false, readOnly: true }, "local");
    for (const role of ["remote", "local_mcp"] as const) {
      for (const [name, args] of [
        ["fs.write", { path: "new.txt", content: "no" }],
        ["fs.patch", { path: "move.txt", edits: [{ oldText: "unchanged", newText: "changed" }] }],
        ["fs.move", { source: "move.txt", destination: "renamed.txt" }],
        ["fs.delete", { path: "move.txt" }],
        ["process.start", { command: process.execPath }],
      ] as const) {
        const result = await call(role, name, args);
        assert.equal(result.error?.code, "permission_denied", JSON.stringify(result));
        assert.equal(principals.auditStore.list(1)[0]?.reasonCode, "permission_denied");
      }
      for (const [name, args] of [["fs.read", { path: "inside.txt" }], ["fs.list", { path: "." }], ["fs.search", { path: ".", pattern: "needle" }]] as const) {
        const result = await call(role, name, args);
        assert.equal(result.isError, false, JSON.stringify(result));
      }
      assert.equal(await readFile(join(project, "move.txt"), "utf8"), "unchanged\n");
      assert.equal(existsSync(join(project, "new.txt")), false);
      assert.equal(existsSync(join(project, "renamed.txt")), false);
    }
    principals.updatePolicy(identity, { readOnly: false, shell: false }, "local");
    assert.throws(() => principals.updatePolicy(identity, { shell: true }, "remote"), /local user/);
    for (const role of ["remote", "local_mcp"] as const) {
      for (const [name, args] of [["process.run", { command: process.execPath }], ["process.start", { command: process.execPath }],
        ["process.write_stdin", { processId: "unowned", writeId: "input", data: "no" }]] as const) {
        const result = await call(role, name, args);
        assert.equal(result.error?.code, "permission_denied", JSON.stringify(result));
        assert.equal(principals.auditStore.list(1)[0]?.reasonCode, "permission_denied");
      }
    }

    const marker = "unique-audit-content-and-path-marker-12345";
    principals.updatePolicy(identity, { onlyHere: true }, "local");
    await call("remote", "fs.write", { path: join(outside, marker), content: marker });
    const policyBefore = principals.auditStore.list(10_000).length;
    principals.updatePolicy(identity, { audit: false }, "local");
    const afterPolicy = principals.auditStore.list(10_000);
    assert.equal(afterPolicy.length, policyBefore + 1);
    assert.equal(afterPolicy[0]?.kind, "policy");
    assert.throws(() => principals.updatePolicy(identity, { shell: true }, "remote"), /local user/);
    await call("remote", "fs.read", { path: "inside.txt" });
    await call("local_mcp", "fs.read", { path: "inside.txt" });
    assert.equal(principals.auditStore.list(10_000).length, afterPolicy.length);
    principals.updatePolicy(identity, { audit: true }, "local");
    assert.throws(() => principals.updatePolicy(identity, { audit: false }, "remote"), /local user/);
    const policy = principals.auditStore.list(1)[0]!;
    assert.equal(policy.kind, "policy"); assert.equal(policy.origin, "local");
    assert.match(policy.beforeFlags!, /"audit":false/); assert.match(policy.afterFlags!, /"audit":true/);
    for (const path of [join(state, "remote-audit.sqlite"), join(state, "remote-audit.sqlite-wal")]) {
      if (existsSync(path)) assert.equal((await readFile(path)).includes(Buffer.from(marker)), false);
    }
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "remote device policy", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { await local.close(); await remote.close(); await host.close(); principals.close(); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); }, removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
});

test("audit retention prunes oldest rows and records a gap", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".device-audit-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const audit = new RemoteAuditStore(join(root, "audit.sqlite"), { maxRows: 4, maxAgeDays: 2, now: () => now });
  try {
    for (let index = 0; index < 6; index += 1) audit.recordTool({ role: "remote", ...identity,
      toolName: "fs.read", decision: "allowed", outcomeCode: `ok_${index}` }, true);
    const rows = audit.list(10);
    assert.ok(rows.length <= 4);
    assert.ok(rows.some((row) => row.kind === "pruned" && row.outcomeCode === "gap"));
    assert.ok(!rows.some((row) => row.outcomeCode === "ok_0"));
    now = new Date("2026-01-05T00:00:00.000Z");
    audit.recordTool({ role: "remote", ...identity, toolName: "fs.read", decision: "allowed", outcomeCode: "fresh" }, true);
    const aged = audit.list(10);
    assert.ok(aged.some((row) => row.kind === "pruned"));
    assert.ok(aged.some((row) => row.outcomeCode === "fresh"));
    assert.ok(aged.every((row) => row.occurredAt === now.toISOString()));
  } finally { audit.close(); await rm(root, { recursive: true }); }
});

test("device policy survives project changes and migrates earlier restrictions", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".shared-device-policy-"));
  const firstPath = join(root, "first", "principals.sqlite"), secondPath = join(root, "second", "principals.sqlite");
  const devicePolicyPath = join(root, "device", "policy.sqlite");
  try {
    const legacy = new RemotePrincipalStore(firstPath);
    legacy.getOrCreate(identity);
    legacy.updatePolicy(identity, { onlyHere: true, shell: false }, "local");
    legacy.close();
    const first = new RemotePrincipalStore(firstPath, undefined, devicePolicyPath);
    assert.equal(first.policy(identity).onlyHere, true);
    assert.equal(first.policy(identity).shell, false);
    assert.equal(first.auditStore.list(1)[0]?.origin, "system");
    const second = new RemotePrincipalStore(secondPath, undefined, devicePolicyPath);
    second.getOrCreate(identity);
    assert.equal(second.policy(identity).onlyHere, true);
    assert.throws(() => second.updatePolicy(identity, { shell: true }, "remote"), /local user/);
    first.updatePolicy(identity, { onlyHere: false }, "local");
    assert.equal(second.policy(identity).onlyHere, false);
    second.close(); first.close();
    const reopened = new RemotePrincipalStore(firstPath, undefined, devicePolicyPath);
    assert.equal(reopened.policy(identity).onlyHere, false, "the legacy row must not re-narrow on every restart");
    reopened.close();
  } finally { await rm(root, { recursive: true }); }
});
