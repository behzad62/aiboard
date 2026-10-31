import assert from "node:assert/strict";
import { RELEASE_TARGETS, type ReleaseTarget } from "../../runner-v2/src/release-manifest.js";
import { parseCopilotRuntimePin } from "../../runner-v2/src/copilot-runtime.js";
import { COPILOT_PIN_PATH, copilotPinFile, copilotRuntimePin, type CopilotLock } from "./copilot-bundle.mjs";

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function fixture(target: ReleaseTarget) {
  const [platform, arch] = target.split("-");
  const os = platform === "win" ? "win32" : platform;
  const name = `@github/copilot-${os}-${arch}`;
  const version = "1.0.71";
  const lock: CopilotLock = { packages: {
    "node_modules/@github/copilot-sdk": { dependencies: { "@github/copilot": "^1.0.69" } },
    "node_modules/@github/copilot": { optionalDependencies: { [name]: version } },
    [`node_modules/${name}`]: { version, os: [os!], cpu: [arch!], resolved: `https://registry.npmjs.org/${name}/-/copilot.tgz`, integrity: INTEGRITY },
  } };
  return { name, version, lock };
}

for (const target of RELEASE_TARGETS) {
  const { name, version, lock } = fixture(target);
  const pin = copilotRuntimePin(lock, target);
  assert.deepEqual(pin, { schemaVersion: 1, name, version, url: `https://registry.npmjs.org/${name}/-/copilot.tgz`, integrity: INTEGRITY });
  const file = copilotPinFile(lock, target);
  assert.equal(file.path, COPILOT_PIN_PATH);
  assert.deepEqual(parseCopilotRuntimePin(JSON.parse(file.data.toString("utf8"))), pin, "the Runner accepts the pin the build writes");
  const wrongPin = structuredClone(lock);
  wrongPin.packages["node_modules/@github/copilot"]!.optionalDependencies![name] = "9.9.9";
  assert.throws(() => copilotRuntimePin(wrongPin, target), /no matching Copilot/);
  const nested = structuredClone(lock);
  nested.packages["node_modules/@github/copilot-sdk/node_modules/@github/copilot"] = { optionalDependencies: { [name]: "9.9.9" } };
  assert.throws(() => copilotRuntimePin(nested, target), /unsupported nested dependency layout/);
  const nestedPlatform = structuredClone(lock);
  nestedPlatform.packages[`node_modules/@github/copilot-sdk/node_modules/${name}`] = {};
  assert.throws(() => copilotRuntimePin(nestedPlatform, target), /unsupported nested dependency layout/);
}
const unpinned = fixture("linux-x64");
delete unpinned.lock.packages[`node_modules/${unpinned.name}`]!.integrity;
assert.throws(() => copilotRuntimePin(unpinned.lock, "linux-x64"), /does not pin a SHA-512/);
for (const resolved of ["http://registry.npmjs.org/package.tgz", "https://registry.example.com/package.tgz", "https://registry.npmjs.org:8443/package.tgz"]) {
  const untrusted = fixture("linux-x64");
  untrusted.lock.packages[`node_modules/${untrusted.name}`]!.resolved = resolved;
  assert.throws(() => copilotRuntimePin(untrusted.lock, "linux-x64"), /approved npm registry/, resolved);
}
console.log("PASS Copilot runtime pins are target-specific, lockfile-exact and npm-registry only");
