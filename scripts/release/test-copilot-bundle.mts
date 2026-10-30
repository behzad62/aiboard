import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTarGz } from "../../runner-v2/src/release-archive.js";
import { RELEASE_TARGETS, type ReleaseTarget } from "../../runner-v2/src/release-manifest.js";
import { copilotPackageFiles, pinnedCopilotFiles, type CopilotLock } from "./copilot-bundle.mjs";

function fixture(target: ReleaseTarget, missing?: "sdk" | "app", metadataName?: string) {
  const [platform, arch] = target.split("-");
  const os = platform === "win" ? "win32" : platform;
  const name = `@github/copilot-${os}-${arch}`;
  const version = "1.0.71";
  const archive = writeTarGz([
    { path: "package/package.json", data: Buffer.from(JSON.stringify({ name: metadataName ?? name, version })), mode: 0o644 },
    { path: "package/index.js", data: Buffer.from("// CLI"), mode: 0o644 },
    ...(missing !== "app" ? [{ path: "package/app.js", data: Buffer.from("// application"), mode: 0o644 }] : []),
    ...(missing !== "sdk" ? [{ path: "package/sdk/index.js", data: Buffer.from("// SDK"), mode: 0o644 }] : []),
    { path: "package/copilot", data: Buffer.from("binary"), mode: 0o755 },
  ]);
  const lock: CopilotLock = { packages: {
    "node_modules/@github/copilot-sdk": { dependencies: { "@github/copilot": "^1.0.69" } },
    "node_modules/@github/copilot": { optionalDependencies: { [name]: version } },
    [`node_modules/${name}`]: { version, os: [os!], cpu: [arch!], resolved: `https://registry.npmjs.org/${name}/-/copilot.tgz`,
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` },
  } };
  return { name, archive, lock };
}

for (const target of RELEASE_TARGETS) {
  const { name, archive, lock } = fixture(target);
  const files = copilotPackageFiles(lock, target, archive);
  assert.ok(files.some((file) => file.path === `app/node_modules/${name}/sdk/index.js`));
  assert.equal(files.find((file) => file.path.endsWith("/copilot"))?.mode, 0o755);
  const changed = Buffer.from(archive);
  changed[changed.length - 1]! ^= 1;
  assert.throws(() => copilotPackageFiles(lock, target, changed), /does not match package-lock/);
  const wrongPin = structuredClone(lock);
  wrongPin.packages["node_modules/@github/copilot"]!.optionalDependencies![name] = "9.9.9";
  assert.throws(() => copilotPackageFiles(wrongPin, target, archive), /no matching Copilot/);
  const nested = structuredClone(lock);
  nested.packages["node_modules/@github/copilot-sdk/node_modules/@github/copilot"] = { optionalDependencies: { [name]: "9.9.9" } };
  assert.throws(() => copilotPackageFiles(nested, target, archive), /unsupported nested dependency layout/);
  const nestedPlatform = structuredClone(lock);
  nestedPlatform.packages[`node_modules/@github/copilot-sdk/node_modules/${name}`] = {};
  assert.throws(() => copilotPackageFiles(nestedPlatform, target, archive), /unsupported nested dependency layout/);
}
for (const path of ["sdk", "app"] as const) {
  const missing = fixture("linux-x64", path);
  assert.throws(() => copilotPackageFiles(missing.lock, "linux-x64", missing.archive), /missing a required SDK entry point/);
}
const wrongMetadata = fixture("linux-x64", undefined, "other-package");
assert.throws(() => copilotPackageFiles(wrongMetadata.lock, "linux-x64", wrongMetadata.archive), /metadata does not match/);
const untrusted = fixture("linux-x64");
untrusted.lock.packages[`node_modules/${untrusted.name}`]!.resolved = "http://registry.npmjs.org/package.tgz";
assert.throws(() => copilotPackageFiles(untrusted.lock, "linux-x64", untrusted.archive), /approved npm registry/);
const poisoned = fixture("linux-x64");
const cache = mkdtempSync(join(tmpdir(), "aiboard-copilot-cache-"));
try {
  const integrity = poisoned.lock.packages[`node_modules/${poisoned.name}`]!.integrity!;
  writeFileSync(join(cache, `${Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex")}.tgz`), "poisoned cache");
  await assert.rejects(() => pinnedCopilotFiles(poisoned.lock, "linux-x64", cache), /does not match package-lock/);
} finally { rmSync(cache, { recursive: true, force: true }); }
console.log("PASS Copilot packages are target-specific and authenticated by the lockfile");
