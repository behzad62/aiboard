// End-to-end installer acceptance (plan L2 DoD, acceptance row T11) against a locally signed TEST release:
//   npx tsx scripts/release/installer-e2e.mts --work <short-dir> [--port 8765] [--shell powershell|pwsh]
//     [--bundles <dir> --key-dir <dir>]  reuse prebuilt bundles and the test key they embed (release-keys.mts generate-test)
//     [--templates <dir>]                installer templates when the driver runs outside the repository
// Builds two test releases for this host, serves them from http://127.0.0.1:<port>, then drives the real
// rendered one-liner (irm | iex / curl | sh) and the installed `aiboard` command: install -> PATH in a new
// shell -> doctor + smoke start/stop -> update -> rollback -> reinstall -> uninstall, plus fail-closed
// negatives (tampered manifest, tampered bundle, wrong signing key, expired, replayed/older manifest).
// HOME (POSIX) or LOCALAPPDATA (Windows) is redirected into --work. On Windows the user PATH in HKCU is
// edited for real and restored from a snapshot if the uninstall leaves it different.
import { spawn, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLER_PROTOCOL, RELEASE_PRODUCT, RELEASE_TARGETS, PREVIEW_TARGETS, serializeManifest, signManifestBytes, targetFormat,
  trustedKeyFromPublicKey, type ReleaseManifest, type ReleaseTarget,
} from "../../runner-v2/src/release-manifest.js";
import { renderInstallers } from "./render-installers.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const work = resolve(option("work") ?? "");
if (!option("work")) throw new Error("--work <short directory> is required (Windows paths must stay short).");
const port = Number(option("port") ?? "8765");
const origin = `http://127.0.0.1:${port}`;
const windows = process.platform === "win32";
const shell = option("shell") ?? "powershell";
const target: ReleaseTarget = `${windows ? "win" : process.platform}-${process.arch}` as ReleaseTarget;
if (!(RELEASE_TARGETS as readonly string[]).includes(target)) throw new Error(`Unsupported host target ${target}.`);
const versions = ["0.9.1", "0.9.2"] as const;

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passes += 1; else failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

interface RunResult { code: number | null; stdout: string; stderr: string }
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env: options.env ?? process.env, cwd: options.cwd ?? work, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill(), options.timeout ?? 300_000);
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}

// ---------------------------------------------------------------- release fixtures
rmSync(work, { recursive: true, force: true });
const site = join(work, "site");
mkdirSync(join(site, "release", "stable"), { recursive: true });
mkdirSync(join(site, "downloads"), { recursive: true });
// Prebuilt bundles embed the test channel (key and origin), so they arrive with the key that signs for them.
const keyDirectory = option("key-dir");
const trustedPrivate: KeyObject = keyDirectory
  ? createPrivateKey(readFileSync(join(keyDirectory, "test-release-key.pem"), "utf8"))
  : generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
const trustedPair = { privateKey: trustedPrivate, publicKey: createPublicKey({ key: trustedPrivate.export({ format: "jwk" }), format: "jwk" }) };
const wrongPair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const trusted = trustedKeyFromPublicKey("test-release-key", trustedPair.publicKey);
const channel = { channel: "stable", manifestUrl: `${origin}/release/stable/manifest.json`, artifactPrefix: `${origin}/downloads/`, keys: [trusted], minSequence: 1 };
if (keyDirectory) {
  const pinned = JSON.parse(readFileSync(join(keyDirectory, "channel.json"), "utf8")) as typeof channel;
  if (pinned.manifestUrl !== channel.manifestUrl || pinned.keys[0]?.n !== trusted.n) throw new Error("--key-dir was generated for another key or --port.");
}
writeFileSync(join(work, "channel.json"), `${JSON.stringify(channel, null, 2)}\n`);
const installers = renderInstallers(channel, option("templates") ? { templateDirectory: resolve(option("templates")!) } : {});
writeFileSync(join(site, "install.ps1"), installers.ps1);
writeFileSync(join(site, "install.sh"), installers.sh);

const bundles = resolve(option("bundles") ?? join(work, "bundles"));
for (const version of versions) {
  const file = `aiboard-${version}-${target}.${targetFormat(target)}`;
  if (!existsSync(join(bundles, file))) {
    execFileSync(process.execPath, [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "scripts", "release", "build-bundle.mts"),
      "--version", version, "--target", target, "--out", bundles, "--channel-config", join(work, "channel.json")], { stdio: "inherit" });
  }
  writeFileSync(join(site, "downloads", file), readFileSync(join(bundles, file)));
}
const bundleFile = (version: string) => `aiboard-${version}-${target}.${targetFormat(target)}`;
const tampered = Buffer.from(readFileSync(join(site, "downloads", bundleFile("0.9.2"))));
tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
writeFileSync(join(site, "downloads", `tampered-${bundleFile("0.9.2")}`), tampered);

function iso(offsetDays: number): string {
  return `${new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 19)}Z`;
}
function manifestFor(version: string, sequence: number, overrides: { url?: string; sha256?: string; expiresAt?: string } = {}): ReleaseManifest {
  const real = readFileSync(join(site, "downloads", bundleFile(version)));
  return {
    schemaVersion: 1, product: RELEASE_PRODUCT, channel: "stable", version, sequence,
    createdAt: iso(-1), expiresAt: overrides.expiresAt ?? iso(30), minInstallerVersion: INSTALLER_PROTOCOL, keyId: trusted.keyId, nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((entry) => entry === target
      ? { target: entry, format: targetFormat(entry), preview: PREVIEW_TARGETS.has(entry), bytes: real.length,
        sha256: overrides.sha256 ?? createHash("sha256").update(real).digest("hex"), url: overrides.url ?? `${origin}/downloads/${bundleFile(version)}` }
      : { target: entry, format: targetFormat(entry), preview: PREVIEW_TARGETS.has(entry), bytes: 1, sha256: "0".repeat(64), url: `${origin}/downloads/unused-${entry}` }),
  };
}
function publish(manifest: ReleaseManifest, key: KeyObject = trustedPair.privateKey, mutate?: (bytes: Buffer) => Buffer): void {
  const signed = Buffer.from(serializeManifest(manifest), "utf8");
  const signature = signManifestBytes(signed, key);
  writeFileSync(join(site, "release", "stable", "manifest.json"), mutate ? mutate(Buffer.from(signed)) : signed);
  writeFileSync(join(site, "release", "stable", "manifest.json.sig"), `${signature}\n`);
}

const server = createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]!);
  const file = join(site, ...path.split("/").filter(Boolean));
  if (!file.startsWith(site) || !existsSync(file) || path.includes("..")) { response.writeHead(404).end(); return; }
  const body = readFileSync(file);
  response.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" }).end(body);
});
await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", () => resolveListen()));

// --serve-only <seconds>: publish release 0.9.1 and only serve it (CI drives a different OS user against it).
const serveOnly = option("serve-only");
if (serveOnly !== undefined) {
  publish(manifestFor("0.9.1", 1));
  console.log(`SERVING ${origin} for ${serveOnly}s`);
  await new Promise((wait) => setTimeout(wait, Number(serveOnly) * 1000));
  server.close();
  process.exit(0);
}

// ---------------------------------------------------------------- sandboxed user environment
const home = join(work, "home");
const localAppData = join(home, "AppData", "Local");
const root = windows ? join(localAppData, "AIBoard") : join(home, ".aiboard");
const baseEnv: NodeJS.ProcessEnv = windows
  ? { ...process.env, LOCALAPPDATA: localAppData }
  : { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), SHELL: "/bin/sh" };
delete baseEnv.AIBOARD_NO_MODIFY_PATH;
function resetHome(): void {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(windows ? localAppData : home, { recursive: true });
}
const powershellCommand = (script: string): [string, string[]] =>
  [shell === "pwsh" ? "pwsh" : "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]];

function userPathSnapshot(): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $kind = if ($k.GetValueNames() -contains 'Path') { [string]$k.GetValueKind('Path') } else { 'none' }; [Console]::Out.Write($kind + '|' + [string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))"], { encoding: "utf8" });
}
function restoreUserPath(snapshot: string): void {
  const [kind, ...rest] = snapshot.split("|");
  const literal = rest.join("|").replace(/'/g, "''");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", kind === "none"
    ? "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); $k.DeleteValue('Path',$false); $k.Close()"
    : `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); $k.SetValue('Path','${literal}',[Microsoft.Win32.RegistryValueKind]::${kind}); $k.Close()`]);
}

async function runInstaller(): Promise<RunResult> {
  if (windows) {
    const [command, args] = powershellCommand(`irm ${origin}/install.ps1 | iex`);
    return run(command, args, { env: baseEnv });
  }
  return run("sh", ["-c", `curl -fsSL ${origin}/install.sh | sh`], { env: baseEnv });
}

/** Runs `aiboard ...` the way a NEW terminal would find it: PATH comes from the user's saved configuration only. */
async function aiboard(args: string, cwd = work): Promise<RunResult> {
  if (windows) {
    const [command, argv] = powershellCommand(
      `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); ` +
      `if (-not (Get-Command aiboard -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('aiboard: command not found'); exit 127 }; aiboard ${args}; exit $LASTEXITCODE`);
    return run(command, argv, { env: baseEnv, cwd });
  }
  return run("sh", ["-lc", `aiboard ${args}`], { env: { ...baseEnv, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, cwd });
}

function pointer(name: string): string | undefined {
  try { return readFileSync(join(root, name), "utf8").trim(); } catch { return undefined; }
}
const nothingInstalled = () => !existsSync(join(root, "current")) && !existsSync(join(root, "bin")) &&
  (!existsSync(join(root, "versions")) || readdirSync(join(root, "versions")).length === 0) && !existsSync(join(root, "install.lock"));

const originalUserPath = windows ? userPathSnapshot() : "";
try {
  // ---- negatives: nothing may be installed
  const negatives: { name: string; prepare: () => void; expect: RegExp }[] = [
    { name: "tampered manifest", prepare: () => publish(manifestFor("0.9.1", 1), undefined, (bytes) => Buffer.from(bytes.toString("utf8").replace('"sequence":1,', '"sequence":9,'))), expect: /signature does not verify/ },
    { name: "tampered bundle", prepare: () => publish(manifestFor("0.9.2", 1, { url: `${origin}/downloads/tampered-${bundleFile("0.9.2")}` })), expect: /does not match the signed checksum/ },
    { name: "wrong signing key", prepare: () => publish(manifestFor("0.9.1", 1), wrongPair.privateKey), expect: /signature does not verify/ },
    { name: "expired manifest", prepare: () => publish(manifestFor("0.9.1", 1, { expiresAt: iso(-0.5) })), expect: /expired/ },
  ];
  for (const negative of negatives) {
    resetHome();
    negative.prepare();
    const result = await runInstaller();
    const output = result.stdout + result.stderr;
    check(`installer refuses a ${negative.name} (non-zero exit)`, result.code !== 0, { code: result.code });
    check(`installer names the ${negative.name} failure`, negative.expect.test(output), output.slice(-600));
    check(`installer leaves nothing installed after a ${negative.name}`, nothingInstalled());
  }

  // ---- install 0.9.1
  resetHome();
  publish(manifestFor("0.9.1", 1));
  const installed = await runInstaller();
  check("installer exits 0", installed.code === 0, installed.stdout + installed.stderr);
  check("installer output carries no secret-looking material", !/BEGIN [A-Z ]*PRIVATE KEY|token=|Authorization/i.test(installed.stdout + installed.stderr));
  check("current points to 0.9.1", pointer("current") === "0.9.1", pointer("current"));
  check("sequence high-water mark is 1", pointer("sequence") === "1", pointer("sequence"));
  check("install.json marker exists", existsSync(join(root, "install.json")));
  const version1 = await aiboard("version");
  check("aiboard is on PATH in a new shell and reports 0.9.1", version1.stdout.trim() === "AIBoard Runner V2 0.9.1", version1);
  if (windows) {
    check("user PATH (HKCU) gained the bin directory", userPathSnapshot().toLowerCase().includes(join(root, "bin").toLowerCase()));
  } else {
    check("~/.profile carries the PATH block", readFileSync(join(home, ".profile"), "utf8").includes("# >>> aiboard installer >>>"));
  }
  const rerun = await runInstaller();
  check("re-running the installer is idempotent", rerun.code === 0 && /already installed/.test(rerun.stdout), rerun.stdout + rerun.stderr);
  if (windows) check("re-run does not duplicate the PATH entry", userPathSnapshot().toLowerCase().split(";").filter((entry) => entry.replace(/\\$/, "") === join(root, "bin").toLowerCase()).length === 1);
  else check("re-run does not duplicate the profile block", readFileSync(join(home, ".profile"), "utf8").split("# >>> aiboard installer >>>").length === 2);

  const doctor = await aiboard("doctor");
  check("aiboard doctor reports the managed install", doctor.code === 0 && doctor.stdout.includes(`Install: ${root}`) && /active 0\.9\.1/.test(doctor.stdout), doctor.stdout + doctor.stderr);

  // ---- smoke start/stop in a project folder
  const project = join(work, "project");
  mkdirSync(project, { recursive: true });
  const startArgs = "--no-open";
  const started = windows
    ? spawn(powershellCommand(`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); aiboard ${startArgs}`)[0],
      powershellCommand(`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); aiboard ${startArgs}`)[1], { cwd: project, env: baseEnv, windowsHide: true })
    : spawn("sh", ["-lc", `aiboard ${startArgs}`], { cwd: project, env: { ...baseEnv, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  let startOutput = "";
  started.stdout?.on("data", (chunk: Buffer) => { startOutput += chunk.toString("utf8"); });
  started.stderr?.on("data", (chunk: Buffer) => { startOutput += chunk.toString("utf8"); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !/Pairing code|runner_start_failed|rror/.test(startOutput)) await new Promise((wait) => setTimeout(wait, 500));
  check("installed Runner starts in a project folder", /Runner running/.test(startOutput), startOutput.replace(/Pairing code: \S+/, "Pairing code: [redacted]").replace(/pair=[^&]+/, "pair=[redacted]").slice(-800));
  const status = await aiboard("status", project);
  check("aiboard status sees the running Runner", /Runner running/.test(status.stdout), status.stdout + status.stderr);
  const stop = await aiboard("stop", project);
  check("aiboard stop stops it", /Runner stopped/.test(stop.stdout), stop.stdout + stop.stderr);
  await new Promise<void>((resolveExit) => { if (started.exitCode !== null) resolveExit(); else started.once("close", () => resolveExit()); setTimeout(resolveExit, 30_000); });

  // ---- update to 0.9.2, updater negatives, rollback
  publish(manifestFor("0.9.2", 2));
  const checkUpdate = await aiboard("update --check");
  check("aiboard update --check reports 0.9.2", /Update available: 0\.9\.2/.test(checkUpdate.stdout), checkUpdate.stdout + checkUpdate.stderr);
  check("update --check changes nothing", pointer("current") === "0.9.1" && pointer("sequence") === "1");
  const update = await aiboard("update");
  check("aiboard update installs 0.9.2", update.code === 0 && pointer("current") === "0.9.2" && pointer("previous") === "0.9.1", update.stdout + update.stderr);
  check("update raises the sequence high-water mark to 2", pointer("sequence") === "2", pointer("sequence"));
  const version2 = await aiboard("version");
  check("PATH command now runs 0.9.2", version2.stdout.trim() === "AIBoard Runner V2 0.9.2", version2);

  const updaterNegatives: { name: string; prepare: () => void; expect: RegExp }[] = [
    { name: "tampered manifest", prepare: () => publish(manifestFor("0.9.1", 3), undefined, (bytes) => Buffer.from(bytes.toString("utf8").replace('"sequence":3,', '"sequence":4,'))), expect: /signature does not verify/ },
    { name: "wrong signing key", prepare: () => publish(manifestFor("0.9.1", 3), wrongPair.privateKey), expect: /signature does not verify/ },
    { name: "tampered bundle", prepare: () => publish({ ...manifestFor("0.9.2", 3, { url: `${origin}/downloads/tampered-${bundleFile("0.9.2")}` }), version: "0.9.3" }), expect: /update_checksum_mismatch/ },
    { name: "replayed older manifest", prepare: () => publish(manifestFor("0.9.1", 1)), expect: /older than a release this machine already accepted/ },
  ];
  for (const negative of updaterNegatives) {
    negative.prepare();
    const result = await aiboard("update");
    check(`aiboard update refuses a ${negative.name}`, result.code !== 0 && negative.expect.test(result.stdout + result.stderr), (result.stdout + result.stderr).slice(-600));
    check(`active version unchanged after a ${negative.name}`, pointer("current") === "0.9.2" && pointer("sequence") === "2");
  }
  check("no staging left behind by refused updates", !existsSync(join(root, "versions", "0.9.3")));

  const rollback = await aiboard("update --rollback");
  check("aiboard update --rollback returns to 0.9.1", rollback.code === 0 && pointer("current") === "0.9.1" && pointer("previous") === "0.9.2", rollback.stdout + rollback.stderr);
  check("rollback never lowers the accepted sequence", pointer("sequence") === "2");
  const version3 = await aiboard("version");
  check("PATH command runs 0.9.1 after rollback", version3.stdout.trim() === "AIBoard Runner V2 0.9.1", version3);

  publish(manifestFor("0.9.2", 2));
  const reinstall = await runInstaller();
  check("installer upgrades an existing install to 0.9.2", reinstall.code === 0 && pointer("current") === "0.9.2" && pointer("previous") === "0.9.1", reinstall.stdout + reinstall.stderr);

  // ---- uninstall keeps state by default
  const statePath = windows ? join(root, "projects", "keep-me") : join(home, ".local", "share", "aiboard", "projects", "keep-me");
  mkdirSync(statePath, { recursive: true });
  const uninstall = await aiboard("uninstall --yes");
  check("aiboard uninstall --yes succeeds", uninstall.code === 0 && /uninstalled/.test(uninstall.stdout), uninstall.stdout + uninstall.stderr);
  const gone = () => !existsSync(join(root, "bin")) && !existsSync(join(root, "versions")) && !existsSync(join(root, "current"));
  const removalDeadline = Date.now() + 60_000;
  while (!gone() && Date.now() < removalDeadline) await new Promise((wait) => setTimeout(wait, 500));
  check("uninstall removes program files, shims and pointers", gone(), { bin: existsSync(join(root, "bin")), versions: existsSync(join(root, "versions")), current: existsSync(join(root, "current")) });
  check("uninstall keeps AIBoard state by default", existsSync(statePath));
  if (windows) {
    check("uninstall removes the bin directory from the user PATH", !userPathSnapshot().toLowerCase().includes(join(root, "bin").toLowerCase()));
    check("user PATH value and registry kind are exactly as before the test", userPathSnapshot() === originalUserPath);
  } else {
    check("uninstall removes the profile PATH block", !readFileSync(join(home, ".profile"), "utf8").includes("aiboard installer"));
  }
  const after = await aiboard("version");
  check("aiboard is no longer found in a new shell", after.code !== 0, after);
} finally {
  if (windows && userPathSnapshot() !== originalUserPath) {
    restoreUserPath(originalUserPath);
    check("restored the user PATH snapshot", false, "uninstall left the user PATH different; restored from snapshot");
  }
  server.close();
}
console.log(`\n${passes} passed, ${failures} failed (${target}${windows ? `, ${shell}` : ""}).`);
process.exitCode = failures === 0 ? 0 : 1;
