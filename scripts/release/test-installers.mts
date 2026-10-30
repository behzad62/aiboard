/* Rendered one-line installer checks (run: npx tsx scripts/release/test-installers.mts) */
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseReleaseChannelConfig, trustedKeyFromPublicKey } from "../../runner-v2/src/release-manifest.js";
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

if (failures > 0) { console.error(`${failures} installer check(s) failed.`); process.exit(1); }
console.log("All installer checks passed.");
