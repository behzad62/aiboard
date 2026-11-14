import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep, win32 } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost } from "../src/execution-host.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { resolveProtectedLocations, type ProtectedLocations } from "../src/protected-locations.js";
import { aiboardHomeDenyEntries } from "../src/aiboard-home-paths.js";
import { createRemotePathGuard, FixedPathDeny, parseMountInfo, RemotePathDeniedError, type RemotePathGuard, type RemotePathGuardOptions } from "../src/remote-path-guard.js";
import { RemotePrincipalStore } from "../src/remote-principal.js";
import { createLocalMcpOwner, LocalMcpToolSession, RemoteToolRuntime } from "../src/remote-tool-runtime.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { ToolBroker } from "../src/tool-broker.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const alice = { accountId: "account", clientId: "client-a", deviceId: "device" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

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

/**
 * A guard over only the fixture's own protected roots (plus any `extra` host roots). The host's real
 * system roots decide the hard-link result on their own: a non-root Linux user cannot list
 * /etc/ssl/private, which correctly leaves every multi-link file on that filesystem unprovable.
 */
function hermeticGuard(fx: Fixture, extra: (location: ProtectedLocations["locations"][number]) => boolean = () => false,
  options: RemotePathGuardOptions = {}): RemotePathGuard {
  const inside = (path: string) => path === fx.root || path.startsWith(`${fx.root}${sep}`);
  return createRemotePathGuard({ ...fx.locations, locations: fx.locations.locations.filter((location) => inside(location.path) || extra(location)) }, options);
}

/** The folded drive (path root) of a path's canonical spelling, or of the path itself when it cannot be resolved. */
async function canonicalDrive(path: string): Promise<string> {
  let canonical = path;
  try { canonical = await realpath(path); } catch { /* A missing root keeps its configured spelling. */ }
  return win32.parse(canonical).root.toLowerCase();
}

const canDropPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

test("guard refuses hard links to protected files but allows provably benign links", async () => {
  const fx = await fixture();
  try {
    const guard = hermeticGuard(fx);
    await link(join(fx.home, ".ssh", "id_rsa"), join(fx.allowed, "copy.txt"));
    assert.equal((await denied(guard.assertAllowed(join(fx.allowed, "copy.txt"), "read"))).reason, "hardlink_alias");
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    await guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("on Linux the pseudo filesystems do not make a benign hard link unprovable", { skip: process.platform !== "linux" }, async () => {
  const fx = await fixture();
  try {
    // /proc cannot be listed in full by anyone and /sys exceeds the scan cap; neither can hold the target's device.
    const guard = hermeticGuard(fx, (location) => location.category === "pseudo_filesystem");
    assert.deepEqual(guard.locations.locations.filter((location) => location.category === "pseudo_filesystem").map((location) => location.path).sort(), ["/dev", "/proc", "/sys"]);
    await link(join(fx.home, ".ssh", "id_rsa"), join(fx.allowed, "copy.txt"));
    assert.equal((await denied(guard.assertAllowed(join(fx.allowed, "copy.txt"), "read"))).reason, "hardlink_alias");
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    await guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
    await denied(guard.assertAllowed("/proc/self/environ", "read"), "protected_location");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("on Windows the host's protected folders on another volume do not make a benign hard link unprovable", { skip: process.platform !== "win32" }, async (t) => {
  const fx = await fixture();
  try {
    const systemRoot = process.env.SystemRoot;
    assert.ok(systemRoot && win32.isAbsolute(systemRoot), "SystemRoot is set");
    // The host's real per-user roots (browser profiles and the AIBoard data root alone can exceed the scan cap), plus
    // %SystemRoot% as a configured folder: on every Windows host it holds unlistable folders and far more entries than the cap.
    const real = resolveProtectedLocations({ platform: "win32", env: process.env, home: homedir(), configuredDirectories: [systemRoot] });
    assert.equal(real.failClosed, false, JSON.stringify(real.failures));
    const fixtureDrive = await canonicalDrive(fx.root);
    const elsewhere: ProtectedLocations["locations"][number][] = [];
    for (const location of real.locations) if (await canonicalDrive(location.path) !== fixtureDrive) elsewhere.push(location);
    if (!elsewhere.some((location) => location.category === "configured")) {
      t.skip("the checkout shares a drive with %SystemRoot%, so no unlistable protected folder is on another volume");
      return;
    }
    const own = fx.locations.locations.filter((location) => location.path.startsWith(`${fx.root}${sep}`));
    const guard = createRemotePathGuard({ ...fx.locations, locations: [...own, ...elsewhere] });
    await link(join(fx.home, ".ssh", "id_rsa"), join(fx.allowed, "copy.txt"));
    assert.equal((await denied(guard.assertAllowed(join(fx.allowed, "copy.txt"), "read"))).reason, "hardlink_alias");
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    await guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
    await denied(guard.assertAllowed(join(systemRoot, "System32", "config", "SAM"), "read"), "protected_location");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("protected folders on the target's own volume are still enumerated in full, cap included", async () => {
  const fx = await fixture();
  try {
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    // The fixture's protected folders share the target's volume and hold more than two entries.
    await denied(hermeticGuard(fx, undefined, { maxProtectedScanEntries: 2 }).assertAllowed(join(fx.allowed, "benign-copy.txt"), "read"),
      "hardlink_confinement_unprovable");
    await hermeticGuard(fx).assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("on Windows a file behind a volume junction in a protected folder is placed on its own volume", { skip: process.platform !== "win32" }, async (t) => {
  const fx = await fixture();
  const other = await mkdtemp(join(tmpdir(), "remote-guard-volume-"));
  const vault = join(other, "vault"), junction = join(vault, "mounted");
  try {
    const drive = win32.parse(await realpath(fx.root)).root;
    if (await canonicalDrive(other) === drive.toLowerCase()) { t.skip("the temp folder shares the checkout's drive"); return; }
    let volume = "";
    try { volume = execFileSync("mountvol", [drive.slice(0, 2), "/L"], { encoding: "utf8" }).trim(); } catch { /* Checked below. */ }
    if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(volume)) { t.skip("mountvol could not name the checkout's volume"); return; }
    await mkdir(vault);
    // A junction to \\?\Volume{GUID}\…, the form a mount point takes: lstat follows it, unlike a drive-letter junction.
    execFileSync("cmd", ["/c", "mklink", "/J", junction, `${volume}${(await realpath(fx.allowed)).slice(drive.length)}`], { stdio: "ignore" });
    await writeFile(join(fx.allowed, "single.txt"), "single\n");
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    const guard = hermeticGuard(fx);
    const withVault = createRemotePathGuard({ ...guard.locations, locations: [...guard.locations.locations, { path: vault, category: "configured", kind: "directory" }] });
    // The spelling through the vault is denied, but realpath places the file on its own volume, where it was always readable.
    await denied(withVault.assertAllowed(join(junction, "single.txt"), "read"), "protected_location");
    assert.equal(await realpath(join(junction, "single.txt")), await realpath(join(fx.allowed, "single.txt")));
    await withVault.assertAllowed(join(fx.allowed, "single.txt"), "read");
    // A multi-link file there is treated the same way. Only the old scan entered the vault through the junction, refusing this one.
    await withVault.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read");
  } finally {
    await rmdir(junction).catch(() => undefined); // removes the junction itself, never what it points to
    await rm(other, { recursive: true, force: true });
    await rm(fx.root, { recursive: true, force: true });
  }
});

for (const mode of [
  { label: "every recently changed folder is listed again", options: {}, quiet: 0 },
  // Folders older than the racy window are reused, so here only their changed times reveal each change.
  { label: "unchanged folders are reused", options: { scanRacyWindowMs: 50 }, quiet: 150 },
]) {
  test(`a protected file that appears after an earlier check is still found (${mode.label})`, async () => {
    const fx = await fixture();
    try {
      const ssh = join(fx.home, ".ssh"), benign = join(fx.allowed, "benign-copy.txt");
      await link(join(fx.allowed, "file.txt"), benign);
      const guard = hermeticGuard(fx, undefined, mode.options);
      // A check after a pause leaves every folder listed, and old enough to be reused by the next check.
      const settled = async () => { await sleep(mode.quiet); await guard.assertAllowed(benign, "read"); };
      const reason = async (name: string) => (await denied(guard.assertAllowed(join(fx.allowed, name), "read"))).reason;

      await settled();
      await writeFile(join(ssh, "id_new"), "NEW\n");
      await link(join(ssh, "id_new"), join(fx.allowed, "new-alias.txt"));
      assert.equal(await reason("new-alias.txt"), "hardlink_alias", "a new key");

      await settled();
      await writeFile(join(ssh, "id_rsa.next"), "ROTATED\n");
      await rename(join(ssh, "id_rsa.next"), join(ssh, "id_rsa"));
      await link(join(ssh, "id_rsa"), join(fx.allowed, "rotated-alias.txt"));
      assert.equal(await reason("rotated-alias.txt"), "hardlink_alias", "a key replaced under the same name");

      await settled();
      await mkdir(join(ssh, "more"));
      await writeFile(join(ssh, "more", "key"), "K\n");
      await link(join(ssh, "more", "key"), join(fx.allowed, "nested-alias.txt"));
      assert.equal(await reason("nested-alias.txt"), "hardlink_alias", "a key in a new subfolder");

      await settled();
      await mkdir(join(fx.home, ".aws"));
      await writeFile(join(fx.home, ".aws", "credentials"), "C\n");
      await link(join(fx.home, ".aws", "credentials"), join(fx.allowed, "aws-alias.txt"));
      assert.equal(await reason("aws-alias.txt"), "hardlink_alias", "a protected folder that did not exist before");

      await settled();
      await writeFile(join(fx.state, "fresh-token"), "T\n");
      await link(join(fx.state, "fresh-token"), join(fx.allowed, "state-alias.txt"));
      const names = ["state-alias.txt", "new-alias.txt", "aws-alias.txt", "rotated-alias.txt"];
      assert.deepEqual(await Promise.all(names.map(reason)), names.map(() => "hardlink_alias"), "concurrent checks");
      await guard.assertAllowed(benign, "read");
    } finally { await rm(fx.root, { recursive: true, force: true }); }
  });
}

test("on Linux a file bind-mounted over a protected key after a check is seen, and so is the key after unmounting",
  { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async (t) => {
    const fx = await fixture();
    const key = join(fx.home, ".ssh", "id_rsa");
    let mounted = false;
    try {
      const source = join(fx.allowed, "mount-source.txt"), sourceAlias = join(fx.allowed, "source-alias.txt");
      await writeFile(source, "SOURCE\n");
      await link(source, sourceAlias);
      const guard = hermeticGuard(fx, undefined, { scanRacyWindowMs: 50 });
      // Two checks a pause apart, so the second keeps .ssh's files from the first without looking at them.
      await guard.assertAllowed(sourceAlias, "read");
      await sleep(150);
      await guard.assertAllowed(sourceAlias, "read");
      try { execFileSync("mount", ["--bind", source, key], { stdio: "ignore" }); mounted = true; } catch {
        t.skip("mount --bind is not permitted here");
        return;
      }
      // The mount moves neither of .ssh's times, but the protected key now shows the source file.
      assert.equal((await denied(guard.assertAllowed(sourceAlias, "read"))).reason, "hardlink_alias");
      await sleep(150);
      assert.equal((await denied(guard.assertAllowed(sourceAlias, "read"))).reason, "hardlink_alias");
      execFileSync("umount", [key]);
      mounted = false;
      // Unmounted, the key is itself again: its own identity is protected and the source is not.
      await link(key, join(fx.allowed, "key-alias.txt"));
      assert.equal((await denied(guard.assertAllowed(join(fx.allowed, "key-alias.txt"), "read"))).reason, "hardlink_alias");
      await guard.assertAllowed(sourceAlias, "read");
    } finally {
      if (mounted) { try { execFileSync("umount", [key]); } catch { /* Reported by the assertion that failed. */ } }
      await rm(fx.root, { recursive: true, force: true });
    }
  });

test("a scan that could not read a protected folder recovers when it can, and notices when it no longer can", { skip: !canDropPermissions }, async () => {
  const fx = await fixture();
  const secrets = join(fx.root, "ext-secrets");
  try {
    const benign = join(fx.allowed, "benign-copy.txt");
    await link(join(fx.allowed, "file.txt"), benign);
    const guard = hermeticGuard(fx, undefined, { scanRacyWindowMs: 50 });
    await chmod(secrets, 0o000);
    await denied(guard.assertAllowed(benign, "read"), "hardlink_confinement_unprovable");
    await chmod(secrets, 0o755);
    await guard.assertAllowed(benign, "read");
    await sleep(150);
    await guard.assertAllowed(benign, "read");
    await chmod(secrets, 0o000);
    await denied(guard.assertAllowed(benign, "read"), "hardlink_confinement_unprovable");
  } finally {
    await chmod(secrets, 0o755).catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a protected folder the guard cannot fully enumerate keeps multi-link files unprovable", { skip: !canDropPermissions }, async () => {
  const fx = await fixture();
  const secrets = join(fx.root, "ext-secrets");
  try {
    await writeFile(join(secrets, "api.key"), "KEY\n");
    await link(join(secrets, "api.key"), join(fx.allowed, "key-alias.txt"));
    await link(join(fx.allowed, "file.txt"), join(fx.allowed, "benign-copy.txt"));
    // Listable but not searchable: the names are visible, the objects behind them are not.
    await chmod(secrets, 0o444);
    let guard = hermeticGuard(fx);
    await denied(guard.assertAllowed(join(fx.allowed, "key-alias.txt"), "read"), "hardlink_confinement_unprovable");
    await denied(guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read"), "hardlink_confinement_unprovable");
    // Not listable at all.
    await chmod(secrets, 0o000);
    guard = hermeticGuard(fx);
    await denied(guard.assertAllowed(join(fx.allowed, "key-alias.txt"), "read"), "hardlink_confinement_unprovable");
    await denied(guard.assertAllowed(join(fx.allowed, "benign-copy.txt"), "read"), "hardlink_confinement_unprovable");
  } finally {
    await chmod(secrets, 0o755).catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("mountinfo parsing decodes escapes and the type after the optional fields, and refuses malformed rows", () => {
  const table = parseMountInfo([
    "22 1 0:21 / /proc rw,nosuid shared:12 - proc proc rw",
    "35 22 0:32 / /proc/sys/fs/binfmt_misc rw - autofs systemd-1 rw,fd=29",
    "40 1 8:1 /data /mnt/with\\040space rw,relatime shared:1 master:2 - ext4 /dev/sda1 rw",
    "41 1 259:65536 / /big rw - xfs /dev/nvme0n1p1 rw",
    "",
  ].join("\n"));
  assert.deepEqual(table, [
    { mountPoint: "/proc", device: 21n, fsType: "proc" },
    { mountPoint: "/proc/sys/fs/binfmt_misc", device: 32n, fsType: "autofs" },
    { mountPoint: "/mnt/with space", device: (8n << 8n) | 1n, fsType: "ext4" },
    { mountPoint: "/big", device: (259n << 8n) | (65536n & 0xffn) | ((65536n & 0xffffff00n) << 12n), fsType: "xfs" },
  ]);
  assert.equal(parseMountInfo("22 1 0:21 / /proc rw shared:12 proc proc rw"), undefined, "no separator");
  assert.equal(parseMountInfo("22 1 zero / /proc rw - proc proc rw"), undefined, "bad device");
  assert.equal(parseMountInfo(""), undefined, "empty table");
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
    // An allowed image is prepared for the connector, which attaches it as image content: never a text-only refusal.
    const image = await runtime.invoke(alice, "image.inspect", { path: "pic.png" });
    assert.equal(image.isError, false, JSON.stringify(image));
    assert.equal((image.content.find((block) => block.type === "json")!.value as { reason?: unknown }).reason, "image_not_attached");
    assert.ok(image.content.some((block) => block.type === "artifact" && block.visual), JSON.stringify(image));
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


async function homeFixture(): Promise<{ root: string; home: string; data: string; deny: FixedPathDeny; elsewhere: string }> {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".home-deny-"));
  const home = join(root, "aiboard-home"), data = join(root, "local", "AIBoard"), elsewhere = join(root, "elsewhere");
  for (const dir of [home, data, elsewhere]) await mkdir(dir, { recursive: true });
  for (const name of ["config.json", "credentials.json", "home-lock.sqlite", "notes.txt"]) await writeFile(join(home, name), "{}");
  await writeFile(join(data, "home-key"), Buffer.alloc(32, 7));
  const environment = { AIBOARD_HOME: home, LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "local") };
  const userHome = join(root, "user");
  const entries = aiboardHomeDenyEntries({ platform: process.platform, environment, home: userHome });
  // On macOS the data root is under the user's home, not XDG_DATA_HOME: point the key entry at the fixture.
  const fixed = entries.map((entry) => entry.category === "aiboard_home_key" ? { ...entry, path: join(data, "home-key") } : entry);
  return { root, home, data, elsewhere, deny: new FixedPathDeny(fixed) };
}

test("the AIBoard home's fixed deny refuses credentials, lock and key at every mode, and config writes", async () => {
  const fx = await homeFixture();
  try {
    for (const name of ["credentials.json", "home-lock.sqlite", "home-lock.sqlite.identity", "credentials.json.tmp-0123"]) {
      for (const access of ["read", "write", "delete"] as const) assert.ok(await fx.deny.check(join(fx.home, name), access), `${name} ${access}`);
    }
    for (const access of ["read", "write", "delete"] as const) {
      assert.equal((await fx.deny.check(join(fx.data, "home-key"), access))?.category, "aiboard_home_key");
      assert.ok(await fx.deny.check(join(fx.data, "home-key.tmp-abcd"), access), "the key's temporary file");
    }
    assert.equal(await fx.deny.check(join(fx.home, "config.json"), "read"), undefined, "config.json is readable");
    assert.equal((await fx.deny.check(join(fx.home, "config.json"), "write"))?.category, "aiboard_home_config");
    assert.ok(await fx.deny.check(join(fx.home, "config.json"), "delete"));
    assert.equal(await fx.deny.check(join(fx.home, "notes.txt"), "write"), undefined, "other files in the home are not denied");
    // A folder that holds a denied file: delete and search are refused, a plain read of the folder is not.
    assert.ok(await fx.deny.check(fx.home, "delete"));
    assert.ok(await fx.deny.check(fx.root, "read", { tree: true }));
    assert.equal(await fx.deny.check(fx.root, "read"), undefined);
    assert.equal(await fx.deny.check(fx.elsewhere, "delete"), undefined);
    assert.ok(await fx.deny.check(join(fx.home, "sub", "..", "credentials.json"), "read"), "dot segments");
    if (process.platform === "win32" || process.platform === "darwin") assert.ok(await fx.deny.check(join(fx.home, "CREDENTIALS.JSON"), "read"), "case");
    if (process.platform === "win32") {
      assert.ok(await fx.deny.check(`${join(fx.home, "credentials.json")}::$DATA`, "read"), "alternate data stream");
      assert.ok(await fx.deny.check(`${join(fx.home, "credentials.json")}. `, "read"), "trailing dot and space");
      assert.ok(await fx.deny.check(`${join(fx.home, "config.json")}:extra`, "write"), "a stream of config.json");
    }
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("the AIBoard home's fixed deny resolves symlinks, junctions and hard links", async () => {
  const fx = await homeFixture();
  try {
    const linkType = process.platform === "win32" ? "junction" as const : "dir" as const;
    await symlink(fx.home, join(fx.elsewhere, "home-link"), linkType);
    assert.ok(await fx.deny.check(join(fx.elsewhere, "home-link", "credentials.json"), "read"), "through a junction to the home");
    assert.ok(await fx.deny.check(join(fx.elsewhere, "home-link", "config.json"), "write"));
    assert.ok(await fx.deny.check(join(fx.elsewhere, "home-link"), "read", { tree: true }), "a search through the junction");
    await symlink(fx.data, join(fx.elsewhere, "data-link"), linkType);
    assert.ok(await fx.deny.check(join(fx.elsewhere, "data-link", "home-key"), "read"), "through a junction to the data root");
    await link(join(fx.home, "credentials.json"), join(fx.elsewhere, "copy.json"));
    assert.ok(await fx.deny.check(join(fx.elsewhere, "copy.json"), "read"), "a hard link to credentials.json");
    await link(join(fx.data, "home-key"), join(fx.elsewhere, "key-copy"));
    assert.ok(await fx.deny.check(join(fx.elsewhere, "key-copy"), "read"), "a hard link to the home key");
    let fileLink = false;
    try { await symlink(join(fx.home, "credentials.json"), join(fx.elsewhere, "file-link.json"), "file"); fileLink = true; } catch { /* Windows may deny file-symlink privilege. */ }
    if (fileLink) assert.ok(await fx.deny.check(join(fx.elsewhere, "file-link.json"), "read"), "a file symlink");
    await writeFile(join(fx.elsewhere, "plain.txt"), "plain");
    assert.equal(await fx.deny.check(join(fx.elsewhere, "plain.txt"), "write"), undefined);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
