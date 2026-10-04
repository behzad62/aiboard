import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { GitRunner } from "./git-repository.js";
import { knownTestSuitePath, type TestIntegrityPin } from "./test-integrity.js";

function configurationPath(path: string): boolean {
  const name = path.split("/").at(-1)!.toLowerCase();
  return ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(name) || name === ".npmrc" || name === ".yarnrc" || name === ".yarnrc.yml" ||
    /^vitest\.workspace(?:\.|$)/.test(name) || name === "pyproject.toml" || name === "pytest.ini" || name === "conftest.py" || name === "tox.ini" || name === "setup.cfg" ||
    /^(?:jest|vitest|playwright|cypress|ava|karma|tap|nyc|coverage|mocha|test)[._-].*config/.test(name) ||
    /^(?:jest|vitest|playwright|cypress|ava|karma|tap|nyc|coverage|mocha|test)\.config(?:\.|$)/.test(name) ||
    /^\.(?:mocha|nyc|tap|ava|c8|test).*rc/.test(name);
}

/** Inspect immutable Git blobs; the candidate working directory cannot supply its baseline pin. */
export async function inspectTestIntegrityPin(input: {
  git: GitRunner;
  repositoryRoot: string;
  revision: string;
  commands: TestIntegrityPin["commands"];
}): Promise<TestIntegrityPin> {
  const listed = await input.git({ cwd: input.repositoryRoot, args: ["ls-tree", "-r", "-z", input.revision] });
  if (listed.exitCode !== 0) throw new Error("Test-integrity configuration inventory is unavailable.");
  const entries = listed.stdout.split("\0").filter(Boolean).map((row) => {
    const match = /^\d+ (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("Test-integrity configuration inventory is malformed.");
    return { kind: match[1]!, digest: match[2]!, path: match[3]! };
  }).filter((entry) => entry.kind === "blob");
  let script: string | undefined;
  let declaresTestRunner = false;
  let scripts: Record<string, unknown> = {};
  const packageRecord = entries.find((entry) => entry.path === "package.json");
  if (packageRecord) {
    const content = await input.git({ cwd: input.repositoryRoot, args: ["show", `${input.revision}:package.json`] });
    if (content.exitCode !== 0) throw new Error("Test-integrity package script is unavailable.");
    const manifest: unknown = JSON.parse(content.stdout.replace(/^\uFEFF/, ""));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Test-integrity package manifest is invalid.");
    const dependencies = { ...((manifest as { dependencies?: object }).dependencies ?? {}), ...((manifest as { devDependencies?: object }).devDependencies ?? {}) };
    declaresTestRunner = Object.keys(dependencies).some((name) => /^(?:vitest|jest|@playwright\/test|cypress|mocha|ava|karma|tap|nyc|pytest)$/.test(name));
    const recorded = (manifest as { scripts?: unknown }).scripts;
    if (recorded && typeof recorded === "object" && !Array.isArray(recorded)) scripts = recorded as Record<string, unknown>;
    script = typeof scripts.test === "string" ? scripts.test : undefined;
  }
  // Explicit selectors and script helpers participate regardless of filename convention.
  const customConfigs = new Set<string>();
  for (const command of Object.values(scripts)) if (typeof command === "string") {
    for (const match of command.matchAll(/(?:--(?:config|config-file|workspace|project|require|import|loader|experimental-loader|setupFiles)|(?<!\S)-[cr])(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
      customConfigs.add((match[1] ?? match[2] ?? match[3]!).replaceAll("\\", "/").replace(/^\.\//, ""));
    }
  }
  // Fingerprint executed script helpers, not test/source files selected by the runner.
  for (const [name, command] of Object.entries(scripts)) if (typeof command === "string") {
    for (const segment of command.split("&&")) {
      if (name === "test" && /(?:^|\s)(?:--test|pytest|vitest|mocha|jest|dotnet\s+test)(?:\s|$)/.test(segment)) continue;
      for (const token of segment.matchAll(/(?:^|\s)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)) {
        const path = (token[1] ?? token[2] ?? token[3]!).replaceAll("\\", "/").replace(/^\.\//, "");
        if (entries.some((entry) => entry.path === path)) customConfigs.add(path);
      }
    }
  }
  // Follow relative imports of configuration and helper files so moving a selector
  // into a second file cannot evade the immutable pin. Unknown external packages
  // remain tied to package manifests/lockfiles rather than source-file contents.
  for (const entry of entries) if (configurationPath(entry.path)) customConfigs.add(entry.path);
  const pending = [...customConfigs]; const inspected = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 256) throw new Error("Test configuration dependency inventory exceeds its bound.");
    const path = pending[index]!;
    if (inspected.has(path) || !/\.(?:[cm]?[jt]s|json)$/.test(path) || !entries.some((entry) => entry.path === path)) continue;
    inspected.add(path);
    const content = await input.git({ cwd: input.repositoryRoot, args: ["show", `${input.revision}:${path}`] });
    if (content.exitCode !== 0) throw new Error("Test configuration dependency is unavailable.");
    for (const match of content.stdout.matchAll(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*|["']extends["']\s*:\s*)["'](\.[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]!));
      const resolved = [target, ...[".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json", "/index.js", "/index.ts"].map((suffix) => target + suffix)]
        .find((candidate) => entries.some((entry) => entry.path === candidate));
      if (resolved && !customConfigs.has(resolved)) { customConfigs.add(resolved); pending.push(resolved); }
    }
  }
  // Hash file identities/presence, never export config contents or environment values.
  const config = entries.filter((entry) => configurationPath(entry.path) || customConfigs.has(entry.path))
    .map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { revision: input.revision, commands: input.commands.map((command) => ({ executable: command.executable, args: [...command.args] })),
    ...(script !== undefined ? { script } : {}), hasTestSignals: declaresTestRunner || entries.some((entry) => knownTestSuitePath(entry.path)), configDigest: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}
