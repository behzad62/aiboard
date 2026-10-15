import { createHash } from "node:crypto";
import { posix } from "node:path";
import { msbuildImportIsKnownExternal } from "./language-execution-profile.js";
import type { GitRunner } from "./git-repository.js";
import { knownTestSuitePath, type TestIntegrityPin } from "./test-integrity.js";

function configurationPath(path: string): boolean {
  const name = path.split("/").at(-1)!.toLowerCase();
  return ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(name) || name === ".npmrc" || name === ".yarnrc" || name === ".yarnrc.yml" ||
    /^vitest\.workspace(?:\.|$)/.test(name) || name === "pyproject.toml" || name === "pytest.ini" || name === "conftest.py" || name === "tox.ini" || name === "setup.cfg" ||
    // V3 (AR-R26): non-JS build/test configuration identities participate in
    // the immutable pin. JavaScript semantics above are unchanged.
    name === "pom.xml" || name === "build.gradle" || name === "build.gradle.kts" ||
    name === "settings.gradle" || name === "settings.gradle.kts" || name === "gradle.properties" ||
    name === "cargo.toml" || name === "cargo.lock" || name === "go.mod" || name === "go.sum" ||
    name === "cmakelists.txt" || name === "directory.build.props" ||
    name === "directory.build.targets" || name === "directory.packages.props" ||
    /\.(?:cs|fs|vb)proj$/.test(name) || /\.(?:sln|slnx)$/.test(name) || /\.cmake$/.test(name) ||
    /\.props$/.test(name) || /\.targets$/.test(name) ||
    /^(?:jest|vitest|playwright|cypress|ava|karma|tap|nyc|coverage|mocha|test)[._-].*config/.test(name) ||
    /^(?:jest|vitest|playwright|cypress|ava|karma|tap|nyc|coverage|mocha|test)\.config(?:\.|$)/.test(name) ||
    /^\.(?:mocha|nyc|tap|ava|c8|test).*rc/.test(name) || name === "aiboard-validation.json";
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
  // F6: the originating configuration language travels with every tracked
  // edge, so a supported local reference stays resolvable even when the
  // target carries a nonstandard extension (a custom .txt helper imported
  // from MSBuild/CMake/Python still parses with its importer's language).
  // Unknown external package/SDK references stay external; a local
  // reference whose identity cannot be established refuses the pin.
  type TestConfigOrigin = "js" | "msbuild" | "cmake" | "python" | "maven";
  const configOrigin = (path: string): TestConfigOrigin => {
    if (/\.(?:cs|fs|vb)proj$/i.test(path) || /\.(?:props|targets)$/i.test(path) ||
      /(?:^|\/)(?:directory\.build\.props|directory\.build\.targets)$/i.test(path)) return "msbuild";
    if (/(?:^|\/)cmakelists\.txt$/i.test(path) || /\.cmake$/i.test(path)) return "cmake";
    if (/\.py$/i.test(path)) return "python";
    if (/(?:^|\/)pom\.xml$/i.test(path)) return "maven";
    return "js";
  };
  const pending: Array<{ path: string; origin: TestConfigOrigin }> =
    [...customConfigs].map((path) => ({ path, origin: configOrigin(path) }));
  const inspected = new Set<string>();
  const showBlob = async (blob: string): Promise<string> => {
    const content = await input.git({ cwd: input.repositoryRoot, args: ["show", `${input.revision}:${blob}`] });
    if (content.exitCode !== 0) throw new Error("Test configuration dependency is unavailable.");
    return content.stdout;
  };
  const trackBlob = (target: string, origin: TestConfigOrigin): void => {
    if (!customConfigs.has(target)) { customConfigs.add(target); pending.push({ path: target, origin }); }
  };
  const parseMsbuildImportEdges = async (text: string, path: string): Promise<void> => {
    for (const tag of text.matchAll(/<Import\s[^<>]*?>/gi)) {
      const element = tag[0]!;
      const match = /\bProject\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(element);
      if (!match) continue;
      const raw = (match[1] ?? match[2]!).replaceAll("\\", "/");
      if (msbuildImportIsKnownExternal(raw, element)) continue;
      if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || /[$%*?]/.test(raw)) {
        throw new Error("Test configuration dependency is unavailable.");
      }
      const target = posix.normalize(posix.join(posix.dirname(path), raw));
      if (target === ".." || target.startsWith("../")) throw new Error("Test configuration dependency escapes the repository.");
      if (!entries.some((entry) => entry.path === target)) throw new Error("Test configuration dependency is unavailable.");
      trackBlob(target, "msbuild");
    }
  };
  const parseCmakeIncludeEdges = async (text: string, path: string): Promise<void> => {
    for (const match of text.matchAll(/^[ \t]*include\s*\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)#]+))/gim)) {
      const raw = (match[1] ?? match[2] ?? match[3]!).replaceAll("\\", "/");
      if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) continue;
      if (raw.includes("$") || /[%*?]/.test(raw)) {
        // A variable or generated module name that still names a local
        // path (a slash, a .cmake suffix, or a leading dot) cannot be
        // proven external: fail closed. Bare module names resolve
        // through project-external module paths.
        if (raw.includes("/") || /\.cmake$/i.test(raw) || /^\./.test(raw)) {
          throw new Error("Test configuration dependency is unavailable.");
        }
        continue;
      }
      const joined = posix.normalize(posix.join(posix.dirname(path), raw));
      const candidates = /\.cmake$/i.test(joined) ? [joined] : [joined, `${joined}.cmake`];
      for (const candidate of candidates) {
        if (candidate === ".." || candidate.startsWith("../")) throw new Error("Test configuration dependency escapes the repository.");
      }
      const target = candidates.find((candidate) => entries.some((entry) => entry.path === candidate));
      if (target) {
        trackBlob(target, "cmake");
      } else if (raw.includes("/") || /\.cmake$/i.test(raw)) {
        throw new Error("Test configuration dependency is unavailable.");
      }
    }
  };
  const trackPythonCandidates = (dir: string, dotted: string): void => {
    // Absolute dotted references resolve against the importing file's
    // directory: every package __init__.py along the chain plus the
    // actual submodule, so changing only a transitive helper trips the
    // pin. Unresolvable names are external packages tied to manifests.
    const parts = dotted.split(".").filter(Boolean);
    if (parts.length === 0 || !parts.every((part) => /^\w+$/.test(part))) return;
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const stem = parts.slice(0, depth).join("/");
      for (const candidate of [`${dir}/${stem}.py`, `${dir}/${stem}/__init__.py`]) {
        const target = posix.normalize(candidate);
        if (target === ".." || target.startsWith("../")) continue;
        if (entries.some((entry) => entry.path === target)) trackBlob(target, "python");
      }
    }
  };
  const parsePythonImportEdges = async (text: string, path: string): Promise<void> => {
    for (const line of text.split("\n")) {
      const match = /^\s*(?:from\s+([.\w]+)\s+import\s+([^\n#]+)|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/.exec(line);
      if (!match) continue;
      const names = (match[2] ?? "").replaceAll("(", "").replaceAll(")", "").split(",")
        .map((part) => part.trim().split(/\s/)[0] ?? "").filter((name) => /^\w+$/.test(name));
      if (match[1] !== undefined && !/^\.+/.test(match[1])) {
        // from pkg import submodule evaluates the imported package member,
        // not just pkg/__init__.py. Both root and importer-relative local
        // candidates are pinned; external names still depend on manifests.
        for (const dir of new Set([".", posix.dirname(path)])) {
          trackPythonCandidates(dir, match[1]);
          for (const name of names) trackPythonCandidates(dir, `${match[1]}.${name}`);
        }
      } else if (match[1] !== undefined) {
        const dots = /^\.+/.exec(match[1])![0].length;
        const rest = match[1].slice(dots);
        let dir = posix.dirname(path);
        for (let up = 1; up < dots; up += 1) dir = posix.normalize(posix.join(dir, ".."));
        if (dir === ".." || dir.startsWith("../")) throw new Error("Test configuration dependency escapes the repository.");
        const before = customConfigs.size;
        if (rest) trackPythonCandidates(dir, rest);
        else {
          const init = posix.normalize(`${dir}/__init__.py`);
          if (entries.some((entry) => entry.path === init)) trackBlob(init, "python");
        }
        for (const name of names) trackPythonCandidates(dir, rest ? `${rest}.${name}` : name);
        const stem = posix.normalize(posix.join(dir, rest.replaceAll(".", "/")));
        const localBase = entries.some((entry) => entry.path === `${stem}.py` || entry.path.startsWith(`${stem}/`));
        if (customConfigs.size === before && !localBase) throw new Error("Test configuration dependency is unavailable.");
      } else {
        for (const dotted of match[3]!.split(",").map((part) => part.trim().split(/\s/)[0] ?? "")) {
          for (const dir of new Set([".", posix.dirname(path)])) trackPythonCandidates(dir, dotted);
        }
      }
    }
  };
  const parseJsReferenceEdges = async (text: string, path: string): Promise<void> => {
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*|["']extends["']\s*:\s*)["'](\.[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]!));
      const resolved = [target, ...[".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json", "/index.js", "/index.ts"].map((suffix) => target + suffix)]
        .find((candidate) => entries.some((entry) => entry.path === candidate));
      if (resolved) trackBlob(resolved, "js");
    }
  };
  const parseMavenParentEdges = async (text: string, path: string): Promise<void> => {
    // A literal local parent POM joins the closure through <relativePath>
    // (default ../pom.xml when a <parent> carries none). An explicitly
    // empty relativePath, coordinates-only parents, and variable or
    // absolute paths resolve through external repositories and stay
    // normal external controls; only a literal local path that names no
    // tracked blob refuses the pin as unknown local identity.
    const parent = /<parent(?:\s[^<>]*)?>([\s\S]*?)<\/parent\s*>/i.exec(text);
    if (!parent) return;
    const relativeMatch = /<relativePath[^>]*>([\s\S]*?)<\/relativePath\s*>/i.exec(parent[1]!);
    if (relativeMatch && relativeMatch[1]!.trim() === "") return;
    const raw = (relativeMatch ? relativeMatch[1]!.trim() : "../pom.xml").replaceAll("\\", "/");
    if (!raw || /[$%*?]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return;
    const target = posix.normalize(posix.join(posix.dirname(path), raw));
    if (target === ".." || target.startsWith("../")) {
      // The repository-default parent above the checkout root lives in an
      // external repository; only an explicit local path above the root
      // refuses the pin.
      if (!relativeMatch) return;
      throw new Error("Test configuration dependency escapes the repository.");
    }
    if (!entries.some((entry) => entry.path === target)) {
      if (relativeMatch) throw new Error("Test configuration dependency is unavailable.");
      return;
    }
    trackBlob(target, "maven");
  };
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 256) throw new Error("Test configuration dependency inventory exceeds its bound.");
    const path = pending[index]!.path;
    const origin = pending[index]!.origin;
    if (inspected.has(path) || !entries.some((entry) => entry.path === path)) continue;
    if (/\.(?:cs|fs|vb)proj|props|targets$/i.test(path)) {
      // V3 (AR-R26): MSBuild <Import> edges. SDK, absolute, and bare-name
      // imports are external; a relative import that resolves to no
      // tracked blob, and a variable local reference, fail closed (their
      // identity cannot be established).
      inspected.add(path);
      await parseMsbuildImportEdges(await showBlob(path), path);
      continue;
    }
    if (/(?:^|\/)cmakelists\.txt$/i.test(path) || /\.cmake$/i.test(path)) {
      // V3: CMake include() edges with the same external/missing rules.
      // Bare module names resolve through project-external module paths.
      inspected.add(path);
      await parseCmakeIncludeEdges(await showBlob(path), path);
      continue;
    }
    if (/(?:^|\/)pom\.xml$/i.test(path)) {
      // V3: Maven literal local parent POMs join through <relativePath>;
      // coordinates-only parents stay external.
      inspected.add(path);
      await parseMavenParentEdges(await showBlob(path), path);
      continue;
    }
    if (!/\.(?:[cm]?[jt]s|json)$/.test(path) && !/\.py$/i.test(path)) {
      // A supported local edge reached a nonstandard extension: keep the
      // originating configuration language instead of hashing the file
      // without following its own local references.
      inspected.add(path);
      const text = await showBlob(path);
      if (origin === "msbuild") await parseMsbuildImportEdges(text, path);
      else if (origin === "cmake") await parseCmakeIncludeEdges(text, path);
      else if (origin === "python") await parsePythonImportEdges(text, path);
      else if (origin === "maven") await parseMavenParentEdges(text, path);
      else await parseJsReferenceEdges(text, path);
      continue;
    }
    if (!/\.(?:[cm]?[jt]s|json)$/.test(path)) {
      // V3: Python config-helper edges (conftest.py and its local
      // helpers). Relative imports must resolve to tracked blobs;
      // anything else is an external package tied to the manifests.
      inspected.add(path);
      await parsePythonImportEdges(await showBlob(path), path);
      continue;
    }
    inspected.add(path);
    await parseJsReferenceEdges(await showBlob(path), path);
  }
  // Hash file identities/presence, never export config contents or environment values.
  const config = entries.filter((entry) => configurationPath(entry.path) || customConfigs.has(entry.path))
    .map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { revision: input.revision, commands: input.commands.map((command) => ({ executable: command.executable, args: [...command.args] })),
    ...(script !== undefined ? { script } : {}), hasTestSignals: declaresTestRunner || entries.some((entry) => knownTestSuitePath(entry.path)), configDigest: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}
