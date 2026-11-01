// Builds the per-target AIBoard Runner bundles (plan L2, ADR-E) reproducibly:
//   npx tsx scripts/release/build-bundle.mts --version 0.2.0 --target all --out dist/release
// Each bundle holds the pinned official Node.js runtime, Runner V2 transpiled ahead of time (the same
// per-file esbuild transform tsx applies at runtime, so no tsx/npm at install time), the legacy and
// account peer runners, the lockfile-resolved runtime dependency tree, the Copilot runtime pin (the
// package itself is downloaded on first use) and a release.json inventory.
// Identical inputs give byte-identical archives on any build host (fixed order, modes and timestamps).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

import { readArchive, writeTarGz, writeZip, type ArchiveFile } from "../../runner-v2/src/release-archive.js";
import {
  isReleaseVersion, parseReleaseChannelConfig, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, targetFormat, type ReleaseTarget,
} from "../../runner-v2/src/release-manifest.js";
import { importClosureGaps, LEGAL_FILES, PEER_FILES, RUNTIME_PACKAGES } from "./bundle-contents.mjs";
import { copilotPinFile, type CopilotLock } from "./copilot-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

let lfInIndex: Set<string> | undefined;
/**
 * Repository bytes are independent of the checkout: a Windows checkout (core.autocrlf) turns LF into CRLF only
 * for files whose index copy is LF, so exactly those are converted back (extensionless LICENSE/NOTICE included).
 */
function repoFile(relativePath: string): Buffer {
  lfInIndex ??= new Set(execFileSync("git", ["-C", root, "ls-files", "-z", "--eol"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter((entry) => entry.startsWith("i/lf ")).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
  const bytes = readFileSync(join(root, ...relativePath.split("/")));
  return lfInIndex.has(relativePath) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : bytes;
}

function trackedFiles(...paths: string[]): string[] {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--", ...paths], { encoding: "utf8" });
  const files = output.split("\0").filter(Boolean).sort();
  for (const file of files) if (!existsSync(join(root, file))) throw new Error(`Tracked file ${file} is missing from the working tree.`);
  return files;
}

const TRANSFORM_OPTIONS = {
  loader: "ts" as const,
  format: "esm" as const,
  target: "node24",
  keepNames: true,
  tsconfigRaw: { compilerOptions: { target: "ES2023", useDefineForClassFields: true } },
};

function runnerFiles(version: string, channelConfig: unknown): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  for (const path of trackedFiles("runner-v2/src", "runner-v2/skills")) {
    if (path.endsWith(".d.ts") || path.endsWith(".d.mts")) continue;
    const destination = `app/${path}`;
    if (path.endsWith(".ts")) {
      const result = transformSync(repoFile(path).toString("utf8"), { ...TRANSFORM_OPTIONS, sourcefile: path });
      files.push({ path: destination.replace(/\.ts$/, ".js"), data: Buffer.from(result.code, "utf8"), mode: 0o644 });
    } else {
      files.push({ path: destination, data: repoFile(path), mode: 0o644 });
    }
  }
  const runnerPackage = JSON.parse(repoFile("runner-v2/package.json").toString("utf8")) as { engines?: unknown };
  files.push({
    path: "app/runner-v2/package.json",
    data: Buffer.from(`${JSON.stringify({ name: "@aiboard/runner-v2", version, private: true, type: "module", engines: runnerPackage.engines }, null, 2)}\n`),
    mode: 0o644,
  });
  files.push({ path: "app/runner-v2/release-channel.json", data: Buffer.from(`${JSON.stringify(channelConfig, null, 2)}\n`), mode: 0o644 });
  files.push({
    path: "app/runner-v2/bin/aiboard.mjs",
    data: Buffer.from([
      "#!/usr/bin/env node",
      "// Installed bundle entry: Runner V2 is precompiled, so no tsx at runtime.",
      'import { reportLauncherError, runLauncher } from "../src/launcher.js";',
      "",
      "try {",
      "  await runLauncher(process.argv.slice(2));",
      "} catch (error) {",
      "  reportLauncherError(error);",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n")),
    mode: 0o644,
  });
  files.push({ path: "app/runner-v2/bin/aiboard-runner-v2.mjs", data: Buffer.from('#!/usr/bin/env node\nawait import("../src/cli.js");\n'), mode: 0o644 });
  for (const path of trackedFiles(...PEER_FILES)) files.push({ path: `app/${path}`, data: repoFile(path), mode: 0o644 });
  if (trackedFiles(...PEER_FILES).length !== PEER_FILES.length) throw new Error("A peer runner file is not tracked.");
  for (const path of LEGAL_FILES) files.push({ path, data: repoFile(path), mode: 0o644 });
  return files;
}

interface LockEntry { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; link?: boolean }

/** Runtime dependency closure exactly as npm laid it out from package-lock.json (optional deps are excluded). */
function dependencyFiles(): { files: ArchiveFile[]; packages: string[]; skippedOptional: string[] } {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { lockfileVersion: number; packages: Record<string, LockEntry> };
  if (lock.lockfileVersion < 2) throw new Error("package-lock.json v2+ is required.");
  const resolveFrom = (location: string, name: string): string | undefined => {
    let base = location;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      if (!base) return undefined;
      const index = base.lastIndexOf("/node_modules/");
      base = index < 0 ? "" : base.slice(0, index);
    }
  };
  const visited = new Set<string>();
  const skippedOptional = new Set<string>();
  const queue = RUNTIME_PACKAGES.map((name) => {
    const location = resolveFrom("", name);
    if (!location) throw new Error(`Runtime package ${name} is not in package-lock.json.`);
    return location;
  });
  while (queue.length > 0) {
    const location = queue.shift()!;
    if (visited.has(location)) continue;
    const entry = lock.packages[location]!;
    if (entry.link) throw new Error(`Linked package ${location} cannot be bundled.`);
    visited.add(location);
    const required = new Set(Object.keys(entry.dependencies ?? {}));
    for (const [name] of Object.entries(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[name]?.optional) required.add(name);
    for (const name of Object.keys(entry.optionalDependencies ?? {})) { required.delete(name); skippedOptional.add(`${location} -> ${name}`); }
    for (const name of [...required].sort()) {
      const resolved = resolveFrom(location, name);
      if (!resolved) throw new Error(`${location} needs ${name}, which package-lock.json does not provide.`);
      queue.push(resolved);
    }
  }
  const packages = [...visited].sort();
  const files: ArchiveFile[] = [];
  for (const location of packages) {
    const directory = join(root, ...location.split("/"));
    if (!existsSync(join(directory, "package.json"))) throw new Error(`${location} is not installed; run npm ci first.`);
    const installed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version?: string };
    if (installed.version !== lock.packages[location]!.version) throw new Error(`${location} is ${installed.version}, lockfile says ${lock.packages[location]!.version}; run npm ci.`);
    const walk = (current: string, prefix: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
        if (prefix === "" && entry.name === "node_modules") continue;
        const path = join(current, entry.name);
        const archivePath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(path, `${archivePath}/`);
        else if (entry.isFile()) files.push({ path: `app/${location}/${archivePath}`, data: readFileSync(path), mode: 0o644 });
        else throw new Error(`${location}/${archivePath} is not a regular file.`);
      }
    };
    walk(directory, "");
  }
  return { files, packages, skippedOptional: [...skippedOptional].sort() };
}

interface NodeRuntimePins { version: string; archives: Record<ReleaseTarget, { file: string; sha256: string }> }

async function nodeRuntimeFiles(target: ReleaseTarget, pins: NodeRuntimePins, cache: string): Promise<ArchiveFile[]> {
  const pin = pins.archives[target];
  const cached = join(cache, pin.file);
  if (!existsSync(cached)) {
    mkdirSync(cache, { recursive: true });
    const url = `https://nodejs.org/dist/v${pins.version}/${pin.file}`;
    process.stderr.write(`Downloading ${url}\n`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
    const temporary = `${cached}.${process.pid}.tmp`;
    writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    renameSync(temporary, cached);
  }
  const archive = readFileSync(cached);
  if (sha256(archive) !== pin.sha256) throw new Error(`${pin.file} does not match its pinned SHA-256 (release/node-runtime.json); delete ${cached} and verify the pin.`);
  const folder = pin.file.replace(/\.(zip|tar\.gz)$/, "");
  const binary = target.startsWith("win-") ? `${folder}/node.exe` : `${folder}/bin/node`;
  const wanted = new Set([binary, `${folder}/LICENSE`]);
  const entries = readArchive(archive, target.startsWith("win-") ? "zip" : "tar.gz", {
    skipLinks: true, include: (path) => wanted.has(path),
    limits: { maxEntries: 40_000, maxTotalBytes: 2048 * 1024 * 1024, maxEntryBytes: 512 * 1024 * 1024 },
  });
  if (entries.length !== 2) throw new Error(`${pin.file} lacks the Node binary or LICENSE.`);
  return entries.map((entry) => entry.path === binary
    ? { path: target.startsWith("win-") ? "node/node.exe" : "node/node", data: entry.data, mode: 0o755 }
    : { path: "node/LICENSE", data: entry.data, mode: 0o644 });
}

export interface BuildReport {
  product: string;
  version: string;
  target: ReleaseTarget;
  file: string;
  format: "zip" | "tar.gz";
  preview: boolean;
  bytes: number;
  sha256: string;
  nodeVersion: string;
  entries: number;
  commit: string;
  dirty: boolean;
}

async function main(): Promise<void> {
  const version = option("version");
  if (!isReleaseVersion(version)) throw new Error("--version must be a release version such as 0.2.0.");
  const targetOption = option("target") ?? "all";
  const targets = targetOption === "all" ? [...RELEASE_TARGETS] : targetOption.split(",");
  for (const target of targets) if (!(RELEASE_TARGETS as readonly string[]).includes(target)) throw new Error(`Unknown target ${target}.`);
  const gaps = importClosureGaps(root);
  if (gaps.length > 0) throw new Error(`The bundle would miss modules its own files import:\n  ${gaps.join("\n  ")}`);
  const out = resolve(option("out") ?? join(root, "dist", "release"));
  const configPath = resolve(option("channel-config") ?? join(root, "release", "channel.json"));
  const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const config = parseReleaseChannelConfig(rawConfig);
  if (config.keys.length === 0) throw new Error(`${configPath} has no trusted release key; a bundle built from it could never verify an update. See docs/remote/l2-release-owner-setup.md.`);
  const { $comment: _comment, ...channelConfig } = rawConfig as Record<string, unknown>;
  void _comment;
  const pins = JSON.parse(readFileSync(join(root, "release", "node-runtime.json"), "utf8")) as NodeRuntimePins;
  const cache = resolve(option("node-cache") ?? join(root, ".release-cache", "node"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as CopilotLock;
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim().length > 0;

  const shared = runnerFiles(version, channelConfig);
  const dependencies = dependencyFiles();
  process.stderr.write(`Runtime packages: ${dependencies.packages.length}; optional dependencies left out: ${dependencies.skippedOptional.join(", ") || "none"}\n`);
  mkdirSync(out, { recursive: true });
  for (const target of targets as ReleaseTarget[]) {
    const files = [...shared, ...dependencies.files, copilotPinFile(lock, target), ...await nodeRuntimeFiles(target, pins, cache)];
    const inventory = Object.fromEntries([...files].sort((left, right) => (left.path < right.path ? -1 : 1)).map((file) => [file.path, sha256(file.data)]));
    const info = { schemaVersion: 1, product: RELEASE_PRODUCT, version, target, nodeVersion: pins.version, files: inventory };
    files.push({ path: "release.json", data: Buffer.from(`${JSON.stringify(info, null, 1)}\n`), mode: 0o644 });
    const format = targetFormat(target);
    const archive = format === "zip" ? writeZip(files) : writeTarGz(files);
    const file = `aiboard-${version}-${target}.${format}`;
    writeFileSync(join(out, file), archive);
    const report: BuildReport = {
      product: RELEASE_PRODUCT, version, target, file, format, preview: PREVIEW_TARGETS.has(target),
      bytes: archive.length, sha256: sha256(archive), nodeVersion: pins.version, entries: files.length, commit, dirty,
    };
    writeFileSync(join(out, `aiboard-${version}-${target}.build.json`), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${file} ${report.bytes} bytes sha256 ${report.sha256}\n`);
  }
}

await main();
