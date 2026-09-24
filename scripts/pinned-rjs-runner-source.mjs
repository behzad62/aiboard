import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const PINNED_RJS_RUNNER_COMMIT = "6c166f974e8c0b6f522d70327a838b1e6c3432b5";

function git(repoRoot, args, options = {}) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function resolvePinnedCommit(repoRoot) {
  const resolved = git(repoRoot, ["rev-parse", `${PINNED_RJS_RUNNER_COMMIT}^{commit}`]).trim();
  if (resolved !== PINNED_RJS_RUNNER_COMMIT) {
    throw new Error("Pinned Recoverable Job Service Runner commit did not resolve exactly.");
  }
}

export function verifyPinnedRjsRunnerSource(repoRoot) {
  const absoluteRoot = path.resolve(repoRoot);
  resolvePinnedCommit(absoluteRoot);
  const raw = git(absoluteRoot, [
    "ls-tree", "-r", "-z", PINNED_RJS_RUNNER_COMMIT, "--", "runner-v2/src", "runner-v2/skills",
  ]);
  const records = raw.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d+)\s+(\S+)\s+([0-9a-f]{40,64})\t(.+)$/);
    if (!match) throw new Error("Pinned Runner tree contains an invalid record.");
    const [, mode, type, objectId, sourcePath] = match;
    const normalized = sourcePath.replace(/\\/g, "/");
    if (
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      (!normalized.startsWith("runner-v2/src/") && !normalized.startsWith("runner-v2/skills/")) ||
      normalized.includes("/../")
    ) {
      throw new Error("Pinned Runner tree contains a disallowed entry.");
    }
    return { path: normalized, objectId, mode };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (
    records.length === 0 ||
    !records.some((record) => record.path === "runner-v2/src/cli.ts") ||
    !records.some((record) => record.path.startsWith("runner-v2/skills/"))
  ) {
    throw new Error("Pinned Runner source is incomplete.");
  }
  for (const record of records) {
    const type = git(absoluteRoot, ["cat-file", "-t", record.objectId]).trim();
    if (type !== "blob") throw new Error("Pinned Runner source contains a missing blob.");
  }
  return records;
}

function flagValue(args, name) {
  const indices = args.flatMap((value, index) => value === name ? [index] : []);
  if (indices.length !== 1 || !args[indices[0] + 1] || args[indices[0] + 1].startsWith("--")) {
    throw new Error(`${name} requires exactly one value.`);
  }
  return args[indices[0] + 1];
}

function ciMode(environment) {
  return [environment.CI, environment.GITHUB_ACTIONS]
    .some((value) => ["true", "1"].includes(String(value ?? "").trim().toLowerCase()));
}

function normalizeHostedRemote(remote, expectedServer, expectedRepository) {
  const expected = new URL(expectedServer);
  let host;
  let repositoryPath;
  try {
    const parsed = new URL(remote);
    host = parsed.hostname.toLowerCase();
    repositoryPath = parsed.pathname;
  } catch {
    const scp = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (!scp) throw new Error("Configured origin is not a supported same-project remote.");
    host = scp[1].toLowerCase();
    repositoryPath = `/${scp[2]}`;
  }
  const normalizedPath = repositoryPath.replace(/^\/+|\.git\/?$/g, "").toLowerCase();
  if (host !== expected.hostname.toLowerCase() || normalizedPath !== expectedRepository.toLowerCase()) {
    throw new Error("Configured origin does not name the expected project.");
  }
}

export function acquirePinnedRjsRunnerSource(repoRoot, options, environment = process.env) {
  const absoluteRoot = path.resolve(repoRoot);
  if (options.allowLocalOrigin && ciMode(environment)) {
    throw new Error("Local-origin acquisition is disabled in CI.");
  }
  const remoteUrl = git(absoluteRoot, ["remote", "get-url", options.remote]).trim();
  if (options.allowLocalOrigin) {
    if (!options.expectedOrigin) throw new Error("Local-origin acquisition requires --expected-origin.");
    const canonicalRemote = pathToFileURL(path.resolve(fileURLToPath(new URL(remoteUrl)))).href;
    const canonicalExpected = pathToFileURL(path.resolve(fileURLToPath(new URL(options.expectedOrigin)))).href;
    if (canonicalRemote !== canonicalExpected) throw new Error("Configured local origin does not match the expected origin.");
  } else {
    normalizeHostedRemote(remoteUrl, options.expectedServer, options.expectedRepository);
  }
  try {
    return verifyPinnedRjsRunnerSource(absoluteRoot);
  } catch {
    git(absoluteRoot, [
      "fetch", "--no-tags", "--depth=1", options.remote,
      `+${PINNED_RJS_RUNNER_COMMIT}:refs/aiboard/rjs-runner/${PINNED_RJS_RUNNER_COMMIT}`,
    ], { stdio: "inherit" });
    return verifyPinnedRjsRunnerSource(absoluteRoot);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes("--acquire")) throw new Error("Use --acquire for explicit pinned-source acquisition.");
  const allowLocalOrigin = args.includes("--allow-local-origin");
  const knownFlags = new Set([
    "--acquire", "--remote", "--expected-repository", "--expected-server",
    "--allow-local-origin", "--expected-origin",
  ]);
  for (const arg of args.filter((value) => value.startsWith("--"))) {
    if (!knownFlags.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  const records = acquirePinnedRjsRunnerSource(process.cwd(), {
    remote: flagValue(args, "--remote"),
    expectedRepository: allowLocalOrigin ? undefined : flagValue(args, "--expected-repository"),
    expectedServer: allowLocalOrigin ? undefined : flagValue(args, "--expected-server"),
    allowLocalOrigin,
    expectedOrigin: allowLocalOrigin ? flagValue(args, "--expected-origin") : undefined,
  });
  process.stdout.write(`${JSON.stringify({ commit: PINNED_RJS_RUNNER_COMMIT, blobs: records.length })}\n`);
}
