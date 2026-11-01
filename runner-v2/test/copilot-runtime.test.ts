import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  copilotPlatformPackage, copilotRuntimeRoot, ensureCopilotRuntime, parseCopilotRuntimePin, readBundledCopilotPin, verifyCopilotArchive,
  type CopilotRuntimePin,
} from "../src/copilot-runtime.js";
import { writeTarGz } from "../src/release-archive.js";

const NAME = copilotPlatformPackage();

function archive(options: { name?: string; root?: string; omit?: string } = {}): Buffer {
  const root = options.root ?? "package";
  return writeTarGz([
    { path: `${root}/package.json`, data: Buffer.from(JSON.stringify({ name: options.name ?? NAME, version: "1.0.71" })), mode: 0o644 },
    { path: `${root}/index.js`, data: Buffer.from("// CLI entry\n"), mode: 0o755 },
    { path: `${root}/app.js`, data: Buffer.from("// application\n"), mode: 0o644 },
    { path: `${root}/sdk/index.js`, data: Buffer.from("// SDK\n"), mode: 0o644 },
    { path: `${root}/LICENSE.md`, data: Buffer.from("GitHub Copilot CLI license\n"), mode: 0o644 },
  ].filter((file) => file.path !== `${root}/${options.omit}`));
}

function pinFor(bytes: Buffer, name = NAME): CopilotRuntimePin {
  return { schemaVersion: 1, name, version: "1.0.71", url: `https://registry.npmjs.org/${name}/-/copilot-1.0.71.tgz`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

function fakeFetch(bytes: Buffer, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
}

test("pins accept only the npm registry and a SHA-512 integrity", () => {
  const pin = pinFor(archive());
  assert.deepEqual(parseCopilotRuntimePin(pin), pin);
  for (const bad of [
    { ...pin, url: "http://registry.npmjs.org/x.tgz" }, { ...pin, url: "https://evil.example/x.tgz" },
    { ...pin, url: "https://user@registry.npmjs.org/x.tgz" }, { ...pin, integrity: "sha1-abc" },
    { ...pin, name: "left-pad" }, { ...pin, schemaVersion: 2 }, null,
  ]) assert.throws(() => parseCopilotRuntimePin(bad), /^CopilotRuntimeError: copilot_runtime_unavailable: /);
});

test("archives are checked against the pin before any file is used", () => {
  const bytes = archive();
  const files = verifyCopilotArchive(pinFor(bytes), bytes);
  assert.deepEqual(files.map((file) => file.path).sort(), ["LICENSE.md", "app.js", "index.js", "package.json", "sdk/index.js"]);
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => verifyCopilotArchive(pinFor(bytes), tampered), /does not match its pinned SHA-512 integrity/);
  for (const [variant, pattern] of [
    [archive({ omit: "sdk/index.js" }), /missing a Copilot SDK entry point/],
    [archive({ name: "@github/copilot-other-x64" }), /metadata does not match its pin/],
    [archive({ root: "other" }), /unexpected archive root/],
  ] as const) assert.throws(() => verifyCopilotArchive(pinFor(variant), variant), pattern);
});

test("the runtime is downloaded once, unpacked unmodified and reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-copilot-runtime-"));
  try {
    const bytes = archive();
    const pin = pinFor(bytes);
    const calls: string[] = [];
    const log: string[] = [];
    const entry = await ensureCopilotRuntime({ pin, root, fetchImpl: fakeFetch(bytes, calls), log: (line) => log.push(line) });
    assert.deepEqual(calls, [pin.url]);
    assert.equal(await readFile(entry, "utf8"), "// CLI entry\n");
    assert.equal(await readFile(join(entry, "..", "LICENSE.md"), "utf8"), "GitHub Copilot CLI license\n", "license kept as published");
    if (process.platform !== "win32") assert.equal((await stat(entry)).mode & 0o111, 0o111);
    assert.match(log[0]!, /^Downloading the GitHub Copilot runtime .*1\.0\.71 \(first use only\)/);
    assert.equal(await ensureCopilotRuntime({ pin, root, fetchImpl: fakeFetch(bytes, calls) }), entry);
    assert.equal(calls.length, 1, "an installed runtime is not downloaded again");
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".staging-")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a tampered download or another platform's pin installs nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-copilot-runtime-"));
  try {
    const bytes = archive();
    const tampered = Buffer.from(bytes);
    tampered[20]! ^= 1;
    await assert.rejects(ensureCopilotRuntime({ pin: pinFor(bytes), root, fetchImpl: fakeFetch(tampered, []) }), /does not match its pinned SHA-512 integrity/);
    assert.deepEqual(await readdir(root), []);
    const other = process.platform === "win32" ? "@github/copilot-linux-x64" : "@github/copilot-win32-x64";
    const calls: string[] = [];
    await assert.rejects(ensureCopilotRuntime({ pin: pinFor(bytes, other), root, fetchImpl: fakeFetch(bytes, calls) }), /this machine needs/);
    assert.deepEqual(calls, []);
    const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(ensureCopilotRuntime({ pin: pinFor(bytes), root, fetchImpl: offline }), /Could not download the Copilot runtime from https:\/\/registry\.npmjs\.org \(fetch failed\)/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a checkout has no bundled pin; the runtime root is overridable", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-copilot-pin-"));
  try {
    assert.equal(await readBundledCopilotPin(join(root, "missing.json")), undefined);
    const pin = pinFor(archive());
    await writeFile(join(root, "copilot-runtime.json"), JSON.stringify(pin));
    assert.deepEqual(await readBundledCopilotPin(join(root, "copilot-runtime.json")), pin);
    assert.equal(existsSync(join(import.meta.dirname, "..", "copilot-runtime.json")), false, "the checkout itself ships no pin");
    assert.equal(copilotRuntimeRoot({ AIBOARD_COPILOT_RUNTIME_DIR: root }, "/home/alice"), root);
    assert.equal(copilotRuntimeRoot({}, "/home/alice"), join("/home/alice", ".aiboard", "runtimes", "copilot"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
