/* Rendered one-line installer checks (run: npx tsx scripts/release/test-installers.mts) */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALLER_PROTOCOL, parseReleaseChannelConfig, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, releaseAnchorDigest,
  serializeManifest, signManifestBytes, targetFormat, trustedKeyFromPublicKey } from "../../runner-v2/src/release-manifest.js";
import { POSIX_SHIM, WINDOWS_SHIM } from "../../runner-v2/src/self-update.js";
import { renderInstallers } from "./render-installers.mjs";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const key = trustedKeyFromPublicKey("release-test", publicKey);
const production = { channel: "stable", manifestUrl: "https://aiboard.me/release/stable/manifest.json", artifactPrefix: "https://github.com/behzad62/aiboard/releases/download/", keys: [key], minSequence: 1 };
const rendered = renderInstallers(production, { minSequence: 7 });

// Shims: the installers write exactly what the updater rewrites.
const psShimLines = WINDOWS_SHIM.split("\r\n").filter(Boolean).map((line) => `'${line.replace(/'/g, "''")}'`);
check("install.ps1 writes the shared Windows shim", psShimLines.every((line) => rendered.ps1.includes(line)) && rendered.ps1.includes(') -join "`r`n"'),
  psShimLines.filter((line) => !rendered.ps1.includes(line)));
const shHeredoc = /cat > "\$root\/bin\/aiboard\.tmp" <<'SHIM'\n([\s\S]*?)\nSHIM\n/.exec(rendered.sh)?.[1];
check("install.sh writes the shared POSIX shim", `${shHeredoc}\n` === POSIX_SHIM, shHeredoc);

// Trust anchors and settings are baked in, and only the pinned key.
const modulus = Buffer.from(key.n, "base64url").toString("base64");
check("install.ps1 embeds the pinned modulus", rendered.ps1.includes(`Id = 'release-test'; Modulus = '${modulus}'; Exponent = 'AQAB'`));
const spki = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" }).export({ type: "spki", format: "der" }).toString("base64");
check("install.sh embeds the pinned SubjectPublicKeyInfo", rendered.sh.includes(`TRUSTED_KEYS='release-test ${spki}'`));
check("production render refuses plain-HTTP downloads", rendered.ps1.includes("$AllowLoopback = $false") && rendered.sh.includes("ALLOW_LOOPBACK=0"));
check("min sequence comes from the published manifest", rendered.ps1.includes("$MinSequence = 7") && rendered.sh.includes("MIN_SEQUENCE=7"));
check("no placeholder survives rendering", !/__AIBOARD_[A-Z_]+__/.test(rendered.ps1 + rendered.sh));
check("install.sh requires openssl with no unverified fallback", /need openssl/.test(rendered.sh) && !/--insecure|-k /.test(rendered.sh));

// Mixed or unsafe configuration never renders.
const refuses = (config: Record<string, unknown>) => { try { renderInstallers(config); return false; } catch { return true; } };
check("mixed test/production origins are refused", refuses({ ...production, artifactPrefix: "http://127.0.0.1:8765/d/" }));
check("quotes cannot be injected through URLs", refuses({ ...production, manifestUrl: "https://aiboard.me/x';calc;'" }));
const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
check("weak keys never render", refuses({ ...production, keys: [{ keyId: "weak-key", n: weak.n, e: weak.e }] }));

// The checked-in production channel parses; with no key pinned the served scripts refuse to install.
const channel = JSON.parse(readFileSync("release/channel.json", "utf8"));
parseReleaseChannelConfig(channel);
const unreleased = renderInstallers(channel, {});
check("release/channel.json is a valid production channel", channel.manifestUrl.startsWith("https://aiboard.me/") && channel.artifactPrefix === "https://github.com/behzad62/aiboard/releases/download/");
if (channel.keys.length === 0) {
  const dir = mkdtempSync(join(tmpdir(), "aiboard-installers-"));
  try {
    writeFileSync(join(dir, "install.sh"), unreleased.sh);
    const sh = spawnSync("sh", [join(dir, "install.sh")], { encoding: "utf8", env: { ...process.env, HOME: dir } });
    check("unreleased install.sh refuses with exit 1", sh.status === 1 && /not been released/.test(sh.stderr), sh.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Syntax: sh -n everywhere a POSIX sh exists; the PowerShell parser on Windows.
const dir = mkdtempSync(join(tmpdir(), "aiboard-installers-"));
try {
  writeFileSync(join(dir, "install.sh"), rendered.sh);
  writeFileSync(join(dir, "install.ps1"), rendered.ps1);
  const syntax = spawnSync("sh", ["-n", join(dir, "install.sh")], { encoding: "utf8" });
  check("install.sh parses (sh -n)", syntax.status === 0, syntax.stderr);
  if (process.platform === "win32") {
    const errors = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(dir, "install.ps1")}', [ref]$null, [ref]$e); $e.Count`], { encoding: "utf8" }).trim();
    check("install.ps1 parses (PowerShell 5.1 parser)", errors === "0", errors);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

// Staged-bundle processes are bounded: a hung command is stopped and confirmed gone before the installer
// can release its lock or delete staging. The real rendered functions are extracted and driven directly.
const node = process.execPath;
const hang = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (process.platform !== "win32") {
  const runBounded = /\nrun_bounded\(\) \{\n[\s\S]*?\n\}\n/.exec(rendered.sh)?.[0];
  check("install.sh defines run_bounded", Boolean(runBounded));
  const bounded = mkdtempSync(join(tmpdir(), "aiboard-bounded-"));
  try {
    const script = `set -eu\n${runBounded}\n` +
      `status=0; run_bounded "$1" "$2/out" "$3" -e "$4" "$2/pid" || status=$?; echo "status=$status"\n` +
      `ok=0; run_bounded 30 "$2/ok" "$3" -e 'console.log("ready"); process.exit(3)' || ok=$?; echo "ok=$ok $(cat "$2/ok")"\n`;
    const started = Date.now();
    const result = spawnSync("sh", ["-c", script, "sh", "1", bounded, node, hang], { encoding: "utf8", timeout: 60_000 });
    const pid = Number(readFileSync(join(bounded, "pid"), "utf8"));
    check("install.sh stops a hung staged command at its bound (124) and reaps it", /status=124/.test(result.stdout) && !alive(pid) && Date.now() - started < 30_000,
      { stdout: result.stdout, stderr: result.stderr, alive: alive(pid) });
    check("install.sh passes through a finished command's status and output", /ok=3 ready/.test(result.stdout), result.stdout);
  } finally { rmSync(bounded, { recursive: true, force: true }); }
} else {
  const invokeBounded = /\n {2}\$State = @\{ Unsettled = \$false \}\n {2}function Invoke-Bounded[\s\S]*?\n {2}\}\n/.exec(rendered.ps1)?.[0];
  check("install.ps1 defines Invoke-Bounded", Boolean(invokeBounded));
  const bounded = mkdtempSync(join(tmpdir(), "aiboard-bounded-"));
  try {
    const pidFile = join(bounded, "pid");
    const args = ["a b", 'q"x', "tail\\", "é✓"];
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "function Fail([string]$Message) { throw \"AIBoard install failed: $Message\" }",
      invokeBounded,
      `$echo = Invoke-Bounded '${node}' @('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ${args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(", ")}) 30 'Echo'`,
      "[Console]::Out.WriteLine('echo=' + $echo.ExitCode + ' ' + $echo.Output)",
      "$started = Get-Date",
      `try { Invoke-Bounded '${node}' @('-e', "${hang.replace(/"/g, '`"')}", '${pidFile}') 2 'The test command' | Out-Null; [Console]::Out.WriteLine('no-timeout') }`,
      "catch { [Console]::Out.WriteLine('timeout=' + $_.Exception.Message + ' seconds=' + [int]((Get-Date) - $started).TotalSeconds + ' unsettled=' + $State.Unsettled) }",
    ].join("\n");
    const shells = ["powershell.exe", ...(spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0 ? ["pwsh"] : [])];
    for (const shell of shells) {
      const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 60_000 });
      const echoed = /echo=0 (.*)/.exec(output)?.[1]?.trim();
      check(`install.ps1 Invoke-Bounded passes arguments with spaces, quotes, trailing backslashes and Unicode (${shell})`, echoed === JSON.stringify(args), { output });
      const pid = Number(readFileSync(pidFile, "utf8"));
      check(`install.ps1 Invoke-Bounded stops a hung staged command and confirms it exited (${shell})`, /timeout=AIBoard install failed: The test command did not finish within 2 seconds\. Nothing was installed\. seconds=\d+ unsettled=False/.test(output) && !alive(pid),
        { output, alive: alive(pid) });
      rmSync(pidFile, { force: true });
    }
  } finally { rmSync(bounded, { recursive: true, force: true }); }
}
check("install.ps1 keeps the lock and staging when a staged process cannot be confirmed stopped",
  /if \(\$State\.Unsettled\) \{[\s\S]*?\$Lock = \$null; \$staging = \$null; \$Work = \$null/.test(rendered.ps1));
check("installers run every staged-bundle command through the bound",
  !/& \(Join-Path \$staging 'node\\node\.exe'\)/.test(rendered.ps1) && !/^\s*(smoke=\$\()?"\$staging\/node\/node"/m.test(rendered.sh));

// Exercise the actual installer replay checks with the same and different trust anchors.
{
  const stateDir = mkdtempSync(join(tmpdir(), "aiboard-anchor-"));
  const anchor = releaseAnchorDigest(production);
  const otherAnchor = "f".repeat(64) === anchor ? "e".repeat(64) : "f".repeat(64);
  try {
    const shCheck = /\ncheck_recorded_sequence\(\) \{[\s\S]*?\n\}\n/.exec(rendered.sh)?.[0];
    if (process.platform !== "win32") {
      const invoke = (epoch: number, sequence: number) => spawnSync("sh", ["-c",
        `set -eu\nfail() { echo "$*" >&2; exit 1; }\n${shCheck}\nroot=$1; ANCHOR_DIGEST=$2; epoch=$3; sequence=$4; check_recorded_sequence`,
        "sh", stateDir, anchor, String(epoch), String(sequence)], { encoding: "utf8" });
      writeFileSync(join(stateDir, "sequence"), "0:9");
      writeFileSync(join(stateDir, "sequence-anchor"), anchor);
      check("install.sh same anchor refuses replay", invoke(0, 8).status !== 0);
      writeFileSync(join(stateDir, "sequence-anchor"), otherAnchor);
      check("install.sh different anchor resets the high-water mark", invoke(0, 8).status === 0);
      writeFileSync(join(stateDir, "sequence"), "1:1");
      writeFileSync(join(stateDir, "sequence-anchor"), anchor);
      check("install.sh refuses a lower epoch with the same anchor", invoke(0, 100).status !== 0);
      writeFileSync(join(stateDir, "sequence"), "9");
      check("install.sh reads a legacy bare sequence as epoch zero", invoke(0, 8).status !== 0 && invoke(1, 1).status === 0);
      rmSync(join(stateDir, "sequence-anchor"));
      check("install.sh resets an unanchored legacy reinstall", invoke(0, 8).status === 0);
    } else {
      const readPointer = /\n {2}function Read-Pointer[\s\S]*?\n {2}\}\n/.exec(rendered.ps1)?.[0];
      const replayCheck = /\n {2}function Test-RecordedSequence[\s\S]*?\n {2}\}\n/.exec(rendered.ps1)?.[0];
      const escaped = stateDir.replace(/'/g, "''");
      const invoke = (epoch: number, sequence: number) => {
        const script = `$ErrorActionPreference = 'Stop'\nfunction Fail([string]$m) { throw $m }\n${readPointer}\n${replayCheck}\nTest-RecordedSequence '${escaped}' ${epoch} ${sequence} '${anchor}'`;
        return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
      };
      writeFileSync(join(stateDir, "sequence"), "0:9");
      writeFileSync(join(stateDir, "sequence-anchor"), anchor);
      check("install.ps1 same anchor refuses replay", invoke(0, 8).status !== 0);
      writeFileSync(join(stateDir, "sequence-anchor"), otherAnchor);
      check("install.ps1 different anchor resets the high-water mark", invoke(0, 8).status === 0);
      writeFileSync(join(stateDir, "sequence"), "1:1");
      writeFileSync(join(stateDir, "sequence-anchor"), anchor);
      check("install.ps1 refuses a lower epoch with the same anchor", invoke(0, 100).status !== 0);
      writeFileSync(join(stateDir, "sequence"), "9");
      check("install.ps1 reads a legacy bare sequence as epoch zero", invoke(0, 8).status !== 0 && invoke(1, 1).status === 0);
      rmSync(join(stateDir, "sequence-anchor"));
      check("install.ps1 resets an unanchored legacy reinstall", invoke(0, 8).status === 0);
    }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}

// Redirects: every hop is checked before it is contacted, so a download can never leave the allowed
// transport (HTTPS in production; this loopback render additionally allows http://127.0.0.1 only).
{
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const port = (server.address() as AddressInfo).port;
    const go = (location: string) => { response.writeHead(302, { Location: location }); response.end(); };
    if (request.url === "/file") { response.writeHead(200); response.end("payload"); }
    else if (request.url === "/relative") go("/file");
    else if (request.url === "/absolute") go(`http://127.0.0.1:${port}/file`);
    else if (request.url === "/downgrade") go(`http://localhost:${port}/secret`);
    else if (request.url === "/loop") go("/loop");
    else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const loopback = renderInstallers({ ...production, manifestUrl: `${origin}/m.json`, artifactPrefix: `${origin}/d/` });
  const run = (command: string, args: string[]) => new Promise<{ code: number | null; output: string }>((resolveRun) => {
    execFile(command, args, { encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolveRun({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: stdout + stderr }));
  });
  const work = mkdtempSync(join(tmpdir(), "aiboard-redirect-"));
  const routes = ["relative", "absolute", "downgrade", "loop"];
  const expectations = (label: string, results: Record<string, string>) => {
    check(`${label} follows relative and absolute redirects on the allowed transport`, results.relative === "ok:payload" && results.absolute === "ok:payload", results);
    check(`${label} refuses a redirect off the allowed transport before contacting it`, /refusing a non-HTTPS download or redirect: http:\/\/localhost:\d+\/secret/.test(results.downgrade ?? "") && !requests.includes("/secret"), { results, requests });
    check(`${label} stops after five redirects`, /too many redirects/.test(results.loop ?? ""), results);
  };
  try {
    if (process.platform === "win32") {
      const pick = (pattern: RegExp) => pattern.exec(loopback.ps1)?.[0] ?? "";
      const functions = [
        pick(/\n {2}\$AllowLoopback = .*\n/), pick(/\n {2}function Fail.*\n/),
        pick(/\n {2}function Test-AllowedUrl[\s\S]*?\n {2}\}\n/), pick(/\n {2}function Get-Download[\s\S]*?\n {2}\}\n/),
      ].join("");
      const script = [
        "$ErrorActionPreference = 'Stop'", functions,
        ...routes.map((route) => `try { Get-Download '${origin}/${route}' '${join(work, route)}'; [Console]::Out.WriteLine('${route}=ok:' + [IO.File]::ReadAllText('${join(work, route)}')) } catch { [Console]::Out.WriteLine('${route}=' + $_.Exception.Message) }`),
      ].join("\n");
      for (const shell of ["powershell.exe", ...(spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0 ? ["pwsh"] : [])]) {
        requests.length = 0;
        const { output } = await run(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
        expectations(`install.ps1 Get-Download (${shell})`, Object.fromEntries(routes.map((route) => [route, new RegExp(`^${route}=(.*)$`, "m").exec(output)?.[1]?.trim() ?? output])));
      }
    }
    const wget = spawnSync("wget", ["--version"], { encoding: "utf8" });
    if (process.platform !== "win32" && wget.status === 0 && /GNU Wget/.test(wget.stdout)) {
      const pick = (pattern: RegExp) => pattern.exec(loopback.sh)?.[0] ?? "";
      const functions = [pick(/\nALLOW_LOOPBACK=.*\n/), pick(/\nfail\(\) .*\n/), pick(/\nallowed_url\(\) \{[\s\S]*?\n\}\n/), pick(/\nwget_checked\(\) \{[\s\S]*?\n\}\n/)].join("");
      const results: Record<string, string> = {};
      requests.length = 0;
      for (const route of routes) {
        const { code, output } = await run("sh", ["-c", `set -eu\n${functions}\nwget_checked "$1" "$2"`, "sh", `${origin}/${route}`, join(work, route)]);
        results[route] = code === 0 ? `ok:${readFileSync(join(work, route), "utf8")}` : output;
      }
      expectations("install.sh wget fallback", results);
    }
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

// Drive the rendered installer through signature and epoch checks. A valid opening manifest reaches
// the deliberately missing bundle; invalid signatures must stop before the bundle is requested.
{
  const ordinary = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const recovery = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const replacement = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const oldKey = trustedKeyFromPublicKey("ordinary-test", ordinary.publicKey);
  const offlineKey = trustedKeyFromPublicKey("recovery-test", recovery.publicKey);
  const nextKey = trustedKeyFromPublicKey("replacement-test", replacement.publicKey);
  let body = Buffer.alloc(0);
  let signature = "";
  let bundleRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/m") response.end(body);
    else if (request.url === "/m.sig") response.end(signature);
    else { bundleRequests++; response.writeHead(404); response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const channel = { channel: "stable", manifestUrl: `${origin}/m`, artifactPrefix: `${origin}/d/`, keys: [oldKey], recoveryKeys: [offlineKey], epoch: 0, minSequence: 1 };
  const scripts = renderInstallers(channel);
  const home = mkdtempSync(join(tmpdir(), "aiboard-epoch-installer-"));
  const installer = join(home, process.platform === "win32" ? "install.ps1" : "install.sh");
  writeFileSync(installer, process.platform === "win32" ? scripts.ps1 : scripts.sh);
  const now = new Date();
  const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const make = (epoch: number, keyId: string, signer: typeof ordinary.privateKey, signingKeys: typeof channel.keys) => {
    body = Buffer.from(serializeManifest({ schemaVersion: 2, product: RELEASE_PRODUCT, channel: "stable", version: "0.2.0", epoch,
      sequence: 1, signingKeys, createdAt: stamp(now), expiresAt: stamp(new Date(now.getTime() + 86400_000)),
      minInstallerVersion: INSTALLER_PROTOCOL, keyId, nodeVersion: "24.18.0", artifacts: RELEASE_TARGETS.map((target) => ({
        target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target), bytes: 1, sha256: "a".repeat(64), url: `${origin}/d/${target}`,
      })) }));
    signature = signManifestBytes(body, signer);
  };
  const run = () => new Promise<{ output: string; requested: number }>((done) => {
    bundleRequests = 0;
    const command = process.platform === "win32" ? "powershell.exe" : "sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-File", installer] : [installer];
    execFile(command, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home, LOCALAPPDATA: home, AIBOARD_ALLOW_ROOT: "1", AIBOARD_NO_MODIFY_PATH: "1" } },
      (_error, stdout, stderr) => done({ output: stdout + stderr, requested: bundleRequests }));
  });
  try {
    make(1, oldKey.keyId, ordinary.privateKey, [nextKey]);
    const ordinaryBump = await run();
    check("installer refuses an epoch bump signed only by the ordinary key", /new epoch requires a recovery signature/i.test(ordinaryBump.output) && ordinaryBump.requested === 0, ordinaryBump);
    make(1, offlineKey.keyId, recovery.privateKey, [nextKey]);
    const recoveryBump = await run();
    check("installer accepts a recovery-signed epoch bump before fetching its bundle", recoveryBump.requested > 0 && /could not download/i.test(recoveryBump.output), recoveryBump);
    make(0, offlineKey.keyId, recovery.privateKey, []);
    const ordinaryRecovery = await run();
    check("installer refuses a recovery key on an ordinary same-epoch manifest", /recovery key cannot sign an ordinary release/i.test(ordinaryRecovery.output) && ordinaryRecovery.requested === 0, ordinaryRecovery);
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
}

// Installers end with a Git note when Git is missing, and color only on a terminal (NO_COLOR / FORCE_COLOR).
{
  const extract = (pattern: RegExp, name: string) => { const found = pattern.exec(rendered.sh)?.[0]; check(`install.sh defines ${name}`, Boolean(found)); return found ?? ""; };
  const colorBlock = extract(/\n# Color only on a terminal[\s\S]*?\nfi\n/, "its color switch");
  const paint = extract(/\npaint\(\) \{[^\n]*\n/, "paint");
  const gitHint = extract(/\ngit_hint\(\) \{\n[\s\S]*?\n\}\n/, "git_hint");
  check("install.sh ends with the Git note", /hint=\$\(git_hint\)[\s\S]*Git was not found\. Chat and account providers work without it; Build mode needs Git\./.test(rendered.sh));
  const bins = mkdtempSync(join(tmpdir(), "aiboard-git-hint-"));
  try {
    const withGit = join(bins, "with-git");
    const withoutGit = join(bins, "without-git");
    for (const dir of [withGit, withoutGit]) {
      execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(dir)})`]);
      writeFileSync(join(dir, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
    }
    writeFileSync(join(withGit, "git"), "#!/bin/sh\necho git version 2.45.0\n", { mode: 0o755 });
    // POSIX hosts only: Git Bash on Windows cannot take these Windows paths as its PATH.
    if (process.platform !== "win32") {
      const hint = (path: string) => spawnSync("sh", ["-c", `${gitHint}\nPATH="$1"; printf '[%s]' "$(git_hint)"`, "sh", path], { encoding: "utf8" }).stdout;
      check("install.sh suggests installing Git when it is missing", hint(withoutGit) === "[Install it with your package manager, for example: sudo apt install git]", hint(withoutGit));
      check("install.sh says nothing about Git when it is present", hint(withGit) === "[]", hint(withGit));
    }
    const painted = (env: Record<string, string>) => spawnSync("sh", ["-c", `set -eu\n${colorBlock}${paint}paint 32 ok`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } }).stdout;
    check("install.sh output is plain when not a terminal", painted({}) === "ok", painted({}));
    check("install.sh FORCE_COLOR turns color on", painted({ FORCE_COLOR: "1" }) === "\u001b[32mok\u001b[0m", painted({ FORCE_COLOR: "1" }));
    check("install.sh FORCE_COLOR=0 keeps it off", painted({ FORCE_COLOR: "0" }) === "ok", painted({ FORCE_COLOR: "0" }));
  } finally { rmSync(bins, { recursive: true, force: true }); }

  const getGitHint = /\n {2}function Get-GitHint \{\n[\s\S]*?\n {2}\}\n/.exec(rendered.ps1)?.[0];
  check("install.ps1 defines Get-GitHint", Boolean(getGitHint));
  check("install.ps1 ends with the Git note", /\$gitHint = Get-GitHint[\s\S]*Git was not found\. Chat and account providers work without it; Build mode needs Git\./.test(rendered.ps1));
  check("install.ps1 honors NO_COLOR, FORCE_COLOR and redirected output", rendered.ps1.includes("$UseColor = if ($env:FORCE_COLOR) { @('0', 'false') -notcontains $env:FORCE_COLOR } else { -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected }"));
  if (process.platform === "win32" && getGitHint) {
    const script = `${getGitHint}\n$env:Path = '${tmpdir()}'\n[Console]::Out.WriteLine('[' + (Get-GitHint) + ']')`;
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" }).trim();
    check("install.ps1 points to Git for Windows when Git is missing", output === "[Install Git for Windows from https://git-scm.com/download/win, then open a new terminal]", output);
  }
}

if (failures > 0) { console.error(`${failures} installer check(s) failed.`); process.exit(1); }
console.log("All installer checks passed.");
