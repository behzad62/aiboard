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

if (failures > 0) { console.error(`${failures} installer check(s) failed.`); process.exit(1); }
console.log("All installer checks passed.");
