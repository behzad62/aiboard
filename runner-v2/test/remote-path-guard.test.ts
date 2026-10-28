import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost } from "../src/execution-host.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { resolveProtectedLocations, type ProtectedLocations } from "../src/protected-locations.js";
import { createRemotePathGuard, RemotePathDeniedError, type RemotePathGuard } from "../src/remote-path-guard.js";
import { RemotePrincipalStore } from "../src/remote-principal.js";
import { createLocalMcpOwner, LocalMcpToolSession, RemoteToolRuntime } from "../src/remote-tool-runtime.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { ToolBroker } from "../src/tool-broker.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const alice = { accountId: "account", clientId: "client-a", deviceId: "device" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");

interface Fixture {
  root: string; home: string; state: string; project: string; allowed: string;
  locations: ProtectedLocations; guard: RemotePathGuard;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-guard-"));
  const home = join(root, "home"), state = join(root, "aiboard-state"), project = join(root, "project"), allowed = join(root, "allowed");
  for (const dir of [join(home, ".ssh"), join(home, ".docker"), state, project, allowed, join(root, "ext-secrets")]) await mkdir(dir, { recursive: true });
  await writeFile(join(home, ".ssh", "id_rsa"), "SECRETKEY\n");
  await writeFile(join(home, ".docker", "config.json"), "{}\n");
  await writeFile(join(state, "token.txt"), "TOKEN\n");
  await writeFile(join(project, "README.md"), "hello allowed\n");
  await writeFile(join(project, "normal.txt"), "SECRETWORD in normal file\n");
  await writeFile(join(allowed, "file.txt"), "allowed contents\n");
  const env: NodeJS.ProcessEnv = process.platform === "win32"
    ? { LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), USERPROFILE: home, HOME: home }
    : { HOME: home, XDG_DATA_HOME: join(home, ".local", "share") };
  const locations = resolveProtectedLocations({ platform: process.platform, env, home, stateDirectory: state, uid: 1000, extensionDirectories: [join(root, "ext-secrets")] });
  assert.equal(locations.failClosed, false, JSON.stringify(locations.failures));
  return { root, home, state, project, allowed, locations, guard: createRemotePathGuard(locations) };
}

async function denied(promise: Promise<unknown>, reason?: string): Promise<RemotePathDeniedError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof RemotePathDeniedError, String(error));
    assert.equal(error.code, "path_denied");
    if (reason) assert.equal(error.reason, reason);
    return error;
  }
  assert.fail("expected path_denied");
}

test("protected location discovery classifies each OS with env relocations", () => {
  const pathsOf = (locations: ProtectedLocations) => locations.locations.map((entry) => entry.path);
  const win = resolveProtectedLocations({ platform: "win32", home: "C:\\Users\\u", stateDirectory: "C:\\state",
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming", USERPROFILE: "C:\\Users\\u",
      AWS_CONFIG_FILE: "D:\\creds\\aws.ini", AWS_SHARED_CREDENTIALS_FILE: "D:\\creds\\shared.ini", KUBECONFIG: "D:\\k\\one;E:\\k\\two", GH_CONFIG_DIR: "D:\\gh", DOCKER_CONFIG: "D:\\docker" } });
  assert.equal(win.failClosed, false, JSON.stringify(win.failures));
  for (const expected of ["C:\\state", "C:\\Users\\u\\.ssh", "C:\\Users\\u\\AppData\\Local\\AIBoard\\bin",
    "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data", "C:\\Users\\u\\AppData\\Roaming\\gcloud",
    "D:\\creds\\aws.ini", "D:\\creds\\shared.ini", "D:\\k\\one", "E:\\k\\two", "D:\\gh", "D:\\docker"]) {
    assert.ok(pathsOf(win).includes(expected), expected);
  }
  assert.equal(win.locations.find((entry) => entry.path === "D:\\creds\\aws.ini")?.kind, "file");

  const mac = resolveProtectedLocations({ platform: "darwin", home: "/Users/u", env: { HOME: "/Users/u" }, stateDirectory: "/state" });
  assert.equal(mac.failClosed, false, JSON.stringify(mac.failures));
  for (const expected of ["/Users/u/.ssh", "/Users/u/Library/Keychains", "/Library/Keychains", "/Users/u/.aiboard/bin",
    "/Users/u/Library/Application Support/Google/Chrome", "/Users/u/Library/Safari", "/Users/u/.config/gh/hosts.yml"]) {
    assert.ok(pathsOf(mac).includes(expected), expected);
  }

  const linux = resolveProtectedLocations({ platform: "linux", home: "/home/u", uid: 1000, stateDirectory: "/state",
    env: { HOME: "/home/u", XDG_DATA_HOME: "/home/u/.local/share", AZURE_CONFIG_DIR: "/opt/azure", CLOUDSDK_CONFIG: "/opt/gcloud" } });
  assert.equal(linux.failClosed, false, JSON.stringify(linux.failures));
  for (const expected of ["/home/u/.ssh", "/proc", "/sys", "/dev", "/etc/shadow", "/run/user/1000/keyring", "/opt/azure", "/opt/gcloud", "/home/u/.config/google-chrome"]) {
    assert.ok(pathsOf(linux).includes(expected), expected);
  }
  assert.equal(linux.locations.find((entry) => entry.path === "/etc/shadow")?.kind, "file");

  assert.equal(resolveProtectedLocations({ platform: "win32", home: "relative", env: {} }).failClosed, true);
  assert.equal(resolveProtectedLocations({ platform: "linux", home: "/home/u", env: { HOME: "/home/u" }, requireStateDirectory: true }).failClosed, true);
});

test("fail-closed discovery refuses even allowed paths", async () => {
  const locations = resolveProtectedLocations({ platform: "win32", home: "relative", env: {} });
  const guard = createRemotePathGuard(locations);
  await denied(guard.assertAllowed("C:\\work\\file.txt", "read"), "protected_locations_unavailable");
});

test("guard rejects traversal, case, ADS, device, UNC and trailing tricks", async () => {
  const fx = await fixture();
  try {
    const secret = join(fx.home, ".ssh", "id_rsa");
    assert.equal((await denied(fx.guard.assertAllowed(secret, "read"))).category, "ssh");
    await denied(fx.guard.assertAllowed(join(fx.allowed, "..", "home", ".ssh", "id_rsa"), "read"), "protected_location");
    await denied(fx.guard.assertAllowed(join(fx.state, "token.txt"), "read"), "protected_location");
    await denied(fx.guard.assertAllowed(join(fx.home, ".docker", "config.json"), "read"), "protected_location");
    await denied(fx.guard.assertAllowed(join(fx.home, ".ssh", "brand-new.txt"), "write"), "protected_location");
    assert.equal(existsSync(join(fx.home, ".ssh", "brand-new.txt")), false);
    await denied(fx.guard.assertAllowed("file\0.txt", "read"), "malformed_path");
    if (process.platform === "win32" || process.platform === "darwin") {
      await denied(fx.guard.assertAllowed(join(fx.home, ".SSH", "id_rsa"), "read"), "protected_location");
    } else {
      // Linux names are case-sensitive bytes: .SSH is a different, unprotected name.
      await fx.guard.assertAllowed(join(fx.home, ".SSH", "id_rsa"), "read");
    }
    if (process.platform === "win32") {
      await denied(fx.guard.assertAllowed(`${join(fx.allowed, "file.txt")}:stream`, "read"), "alternate_data_stream");
      await denied(fx.guard.assertAllowed(join(fx.allowed, "CON.txt"), "read"), "device_name");
      await denied(fx.guard.assertAllowed(join(fx.allowed, "nul"), "read"), "device_name");
      await denied(fx.guard.assertAllowed(join(fx.allowed, "COM¹.txt"), "read"), "device_name");
      await denied(fx.guard.assertAllowed(join(fx.allowed, "conin$"), "read"), "device_name");
      await denied(fx.guard.assertAllowed("\\\\.\\C:\\secret", "read"), "device_namespace");
      await denied(fx.guard.assertAllowed("\\\\?\\GLOBALROOT\\Device\\Harddisk0", "read"), "device_namespace");
      await denied(fx.guard.assertAllowed("\\\\server\\share\\secret.txt", "read"), "unc_path");
      await denied(fx.guard.assertAllowed(`${fx.allowed}\\file.txt.`, "read"), "trailing_dot_or_space");
      await denied(fx.guard.assertAllowed(`${fx.allowed}\\dir \\file.txt`, "read"), "trailing_dot_or_space");
    }
    await fx.guard.assertAllowed(join(fx.allowed, "file.txt"), "read");
    const audit = fx.guard.auditRecords();
    assert.ok(audit.length >= 5);
    assert.ok(audit.every((record) => !JSON.stringify(record).includes("SECRETKEY") && !JSON.stringify(record).includes("id_rsa")));
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("8.3 short names resolve through realpath to the long protected form", async (t) => {
  if (process.platform !== "win32") { t.skip("8.3 names are a Windows spelling"); return; }
  const fx = await fixture();
  try {
    // The first 8.3 alias of "ext-secrets" is EXT-SE~1 when the volume generates short names.
    const shortName = join(fx.root, "EXT-SE~1");
    if (!existsSync(shortName)) { t.skip("8.3 name generation is disabled on this volume; no short alias exists to test."); return; }
    await writeFile(join(fx.root, "ext-secrets", "token.json"), "{}\n");
    await denied(fx.guard.assertAllowed(join(shortName, "token.json"), "read"), "protected_location");
    await denied(fx.guard.assertAllowed(join(shortName, "new.json"), "write"), "protected_location");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("a protected root configured through an alias denies its canonical spelling before it exists", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-guard-alias-"));
  try {
    const realHome = join(root, "real-home"), aliasHome = join(root, "alias-home"), state = join(root, "state");
    await mkdir(realHome); await mkdir(state);
    await symlink(realHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
    const env: NodeJS.ProcessEnv = process.platform === "win32"
      ? { LOCALAPPDATA: join(aliasHome, "AppData", "Local"), APPDATA: join(aliasHome, "AppData", "Roaming"), USERPROFILE: aliasHome, HOME: aliasHome }
      : { HOME: aliasHome, XDG_DATA_HOME: join(aliasHome, ".local", "share") };
    const guard = createRemotePathGuard(resolveProtectedLocations({ platform: process.platform, env, home: aliasHome, stateDirectory: state, uid: 1000 }));
    // ~/.aws does not exist yet; creating it through the real spelling must still be refused.
    assert.equal(existsSync(join(realHome, ".aws")), false);
    await denied(guard.assertAllowed(join(realHome, ".aws", "credentials"), "write"), "protected_location");
    await denied(guard.assertAllowed(join(realHome, ".ssh", "id_ed25519"), "write"), "protected_location");
    await guard.assertAllowed(join(realHome, "notes.txt"), "write");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guard follows symlinks and junctions only to allowed targets", async () => {
  const fx = await fixture();
  try {
    const linkType = process.platform === "win32" ? "junction" as const : "dir" as const;
    await symlink(join(fx.home, ".ssh"), join(fx.allowed, "ssh-link"), linkType);
    await denied(fx.guard.assertAllowed(join(fx.allowed, "ssh-link", "id_rsa"), "read"), "protected_location");
    await symlink(fx.allowed, join(fx.root, "allowed-link"), linkType);
    await fx.guard.assertAllowed(join(fx.root, "allowed-link", "file.txt"), "read");
    let fileLink = false;
    try { await symlink(join(fx.home, ".ssh", "id_rsa"), join(fx.allowed, "file-link.txt"), "file"); fileLink = true; } catch { /* Windows may deny file-symlink privilege. */ }
    if (fileLink) await denied(fx.guard.assertAllowed(join(fx.allowed, "file-link.txt"), "read"), "protected_location");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("guard refuses hard links to protected files but allows provably benign links", async () => {
  const fx = await fixture();
  try {
    await link(join(fx.home, ".ssh", "id_rsa"), join(fx.allowed, "copy.txt"));
    assert.equal((await denied(fx.guard.assertAllowed(join(fx.allowed, "copy.txt"), "read"))).reason, "hardlink_alias");
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    await fx.guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("broker guard binds remote and local_mcp actors only; an unguarded worker broker is unaffected", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.project, "fixture.txt"), "broker fixture\n");
    const secretPath = join(fx.home, ".ssh", "id_rsa");
    const guarded = new ToolBroker({ permissionProfile: "full", workspacePath: fx.project, pathGuard: fx.guard });
    for (const tool of createFilesystemTools({ pathGuard: fx.guard })) guarded.register(tool);
    const remoteRead = await guarded.invoke({ type: "tool_call", callId: "remote-read-1", name: "fs.read", arguments: { path: secretPath } },
      { runId: "r1", sessionId: "s1", actor: { role: "remote", id: "p1" }, workspacePath: fx.project });
    assert.equal(remoteRead.error?.code, "path_denied", JSON.stringify(remoteRead));
    const localRead = await guarded.invoke({ type: "tool_call", callId: "local-read-1", name: "fs.read", arguments: { path: secretPath } },
      { runId: "r2", sessionId: "s2", actor: { role: "local_mcp", id: "p2" }, workspacePath: fx.project });
    assert.equal(localRead.error?.code, "path_denied");
    const remoteStat = await guarded.invoke({ type: "tool_call", callId: "remote-stat-1", name: "fs.stat", arguments: { path: secretPath } },
      { runId: "r1", sessionId: "s1", actor: { role: "remote", id: "p1" }, workspacePath: fx.project });
    assert.equal(remoteStat.error?.code, "path_denied", JSON.stringify(remoteStat));
    const audit = guarded.auditRecords();
    assert.ok(audit.some((record) => record.decision === "denied" && record.pathCategory === "ssh" && record.errorCode === "path_denied" && record.actor.role === "remote"));
    assert.ok(!JSON.stringify(audit).includes("SECRETKEY"));

    const workerBroker = new ToolBroker({ permissionProfile: "full", workspacePath: fx.project });
    for (const tool of createFilesystemTools({})) workerBroker.register(tool);
    const workerRead = await workerBroker.invoke({ type: "tool_call", callId: "worker-read-1", name: "fs.read", arguments: { path: "fixture.txt" } },
      { runId: "r3", sessionId: "s3", actor: { role: "worker", id: "w1" }, workspacePath: fx.project });
    assert.equal(workerRead.isError, false, JSON.stringify(workerRead));
    assert.match(JSON.stringify(workerRead.content), /broker fixture/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

async function makeHost(root: string): Promise<{ host: ExecutionHost; project: string; hostState: string }> {
  const project = join(root, "project"), hostState = join(root, "runner-state");
  await mkdir(project, { recursive: true }); await mkdir(hostState, { recursive: true });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: hostState,
    artifacts: new ArtifactStore(join(hostState, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  return { host, project, hostState };
}

test("remote runtime denies protected file tools, skips protected children and audits with no effect", { timeout: 120_000 }, async () => {
  const fx = await fixture();
  const { host, project, hostState } = await makeHost(fx.root);
  // A protected state subtree inside the project (home-folder start model).
  const inProjectState = join(project, "aiboard-state");
  await mkdir(inProjectState, { recursive: true });
  await writeFile(join(inProjectState, "secret.txt"), "SECRETWORD protected\n");
  await writeFile(join(inProjectState, "pic.png"), PNG);
  await writeFile(join(project, "pic.png"), PNG);
  const locations = resolveProtectedLocations({ platform: process.platform,
    env: process.platform === "win32" ? { LOCALAPPDATA: join(fx.home, "AppData", "Local"), APPDATA: join(fx.home, "AppData", "Roaming"), USERPROFILE: fx.home, HOME: fx.home } : { HOME: fx.home, XDG_DATA_HOME: join(fx.home, ".local", "share") },
    home: fx.home, stateDirectory: inProjectState, uid: 1000 });
  const guard = createRemotePathGuard(locations);
  const principals = new RemotePrincipalStore(join(hostState, "principals.sqlite"));
  const runtime = new RemoteToolRuntime({ host, principals, workspacePath: project, permissionProfile: "full",
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), pathGuard: guard,
    admitEffect: async (_request, dispatch) => await dispatch() });
  let failed = false, primary: unknown;
  try {
    const ok = await runtime.invoke(alice, "fs.read", { path: "README.md" });
    assert.equal(ok.isError, false, JSON.stringify(ok));
    const outside = await runtime.invoke(alice, "fs.read", { path: join(fx.allowed, "file.txt") });
    assert.equal(outside.isError, false, JSON.stringify(outside));
    for (const [name, args] of [
      ["fs.read", { path: join(fx.home, ".ssh", "id_rsa") }],
      ["fs.read", { path: "aiboard-state/secret.txt" }],
      ["fs.read", { path: join("..", "home", ".ssh", "id_rsa") }],
      ["fs.read", { path: "aiboard-state/../aiboard-state/secret.txt" }],
      ["fs.list", { path: "aiboard-state" }],
      ["fs.search", { path: "aiboard-state", pattern: "SECRETWORD" }],
      ["image.inspect", { path: "aiboard-state/pic.png" }],
    ] as const) {
      const result = await runtime.invoke(alice, name, args);
      assert.equal(result.error?.code, "path_denied", `${name} ${JSON.stringify(result)}`);
    }
    const listed = await runtime.invoke(alice, "fs.list", { path: "." });
    assert.equal(listed.isError, false, JSON.stringify(listed));
    assert.doesNotMatch(JSON.stringify(listed.content), /aiboard-state/);
    assert.match(JSON.stringify(listed.content), /README\.md/);
    const searched = await runtime.invoke(alice, "fs.search", { path: ".", pattern: "SECRETWORD" });
    assert.equal(searched.isError, false, JSON.stringify(searched));
    assert.match(JSON.stringify(searched.content), /normal\.txt/);
    assert.doesNotMatch(JSON.stringify(searched.content), /aiboard-state/);

    const writeDenied = await runtime.invoke(alice, "fs.write", { path: "aiboard-state/new.txt", content: "x" });
    assert.equal(writeDenied.error?.code, "path_denied", JSON.stringify(writeDenied));
    assert.equal(existsSync(join(inProjectState, "new.txt")), false);
    const writeOk = await runtime.invoke(alice, "fs.write", { path: "created.txt", content: "created\n" });
    assert.equal(writeOk.isError, false, JSON.stringify(writeOk));
    assert.equal(await readFile(join(project, "created.txt"), "utf8"), "created\n");
    await writeFile(join(project, "moveme.txt"), "move me\n");
    const moveDenied = await runtime.invoke(alice, "fs.move", { source: "moveme.txt", destination: "aiboard-state/moved.txt" });
    assert.equal(moveDenied.error?.code, "path_denied", JSON.stringify(moveDenied));
    assert.equal(existsSync(join(project, "moveme.txt")), true);
    assert.equal(existsSync(join(inProjectState, "moved.txt")), false);
    const deleteDenied = await runtime.invoke(alice, "fs.delete", { path: "aiboard-state/secret.txt" });
    assert.equal(deleteDenied.error?.code, "path_denied", JSON.stringify(deleteDenied));
    assert.equal(await readFile(join(inProjectState, "secret.txt"), "utf8"), "SECRETWORD protected\n");

    const audit = runtime.pathAuditRecords();
    assert.ok(audit.some((record) => record.toolName === "fs.read" && record.pathCategory === "ssh" && record.reasonCode === "protected_location"), JSON.stringify(audit));
    assert.ok(audit.some((record) => record.pathCategory === "runner_state"), JSON.stringify(audit));
    assert.ok(audit.every((record) => record.principal.startsWith("remote:")));
    assert.ok(!JSON.stringify(audit).includes("SECRETKEY") && !JSON.stringify(audit).includes("id_rsa"));
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "remote path guard runtime", root: fx.root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => runtime.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } principals.close(); if (errors.length) throw new AggregateError(errors, "cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(fx.root, { recursive: true, force: true }); } });
  }
});

test("local MCP session denies protected paths inside the project while allowed reads work", { timeout: 120_000 }, async () => {
  const fx = await fixture();
  const { host, project, hostState } = await makeHost(fx.root);
  void hostState;
  const inProjectState = join(project, "aiboard-state");
  await mkdir(inProjectState, { recursive: true });
  await writeFile(join(inProjectState, "secret.txt"), "protected local\n");
  const locations = resolveProtectedLocations({ platform: process.platform,
    env: process.platform === "win32" ? { LOCALAPPDATA: join(fx.home, "AppData", "Local"), APPDATA: join(fx.home, "AppData", "Roaming"), USERPROFILE: fx.home, HOME: fx.home } : { HOME: fx.home, XDG_DATA_HOME: join(fx.home, ".local", "share") },
    home: fx.home, stateDirectory: inProjectState, uid: 1000 });
  const guard = createRemotePathGuard(locations);
  const session = new LocalMcpToolSession({ host, workspacePath: project, permissionProfile: "full",
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), pathGuard: guard }, createLocalMcpOwner(0));
  let failed = false, primary: unknown;
  try {
    const ok = await session.invoke("files_read", { path: "README.md" });
    assert.equal(ok.isError, false, JSON.stringify(ok));
    const deniedRead = await session.invoke("files_read", { path: "aiboard-state/secret.txt" });
    assert.equal(deniedRead.isError, true, JSON.stringify(deniedRead));
    assert.match(JSON.stringify(deniedRead), /path_denied/);
    const deniedWrite = await session.invoke("files_write", { path: "aiboard-state/new.txt", content: "x", idempotencyKey: "local-write-1" });
    assert.equal(deniedWrite.isError, true, JSON.stringify(deniedWrite));
    assert.equal(existsSync(join(inProjectState, "new.txt")), false);
    const audit = await session.pathAuditRecords();
    assert.ok(audit.some((record) => record.pathCategory === "runner_state"), JSON.stringify(audit));
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "local mcp path guard", root: fx.root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => session.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(fx.root, { recursive: true, force: true }); } });
  }
});

