/**
 * Affected tests ladder (Runner V2 P6.6 T5, OA-12/EP46).
 *
 * Pure ladder core with injectable rungs; deterministic, zero model calls.
 * Ladder: project impact tool -> LSP/compiler references -> build-system
 * module graph -> full suite. Widening triggers step down to at least the
 * module graph (full suite when none exists). A rung not configured /
 * failing / answering `unsupported_language` is a FAILED rung, not an empty
 * selection: step down and record the lower rung. The rung used is recorded.
 */
import type { CodeIntelligenceResult, CodeLocation } from "./language-intelligence.js";

// ---------------------------------------------------------------------------
// Rungs and inputs
// ---------------------------------------------------------------------------

export type AffectedTestsRung = "impact_tool" | "lsp_references" | "module_graph" | "full_suite" | "no_tests_required";

export interface ImpactToolRung {
  readonly configured: boolean;
  readonly run?: (changedFiles: readonly string[]) => readonly string[];
}

export interface LspReferencesRung {
  readonly query: (file: string) => CodeIntelligenceResult<CodeLocation>;
}

export interface ModuleGraphRungInput {
  /** All project files (paths) known to the caller. */
  readonly allFiles: readonly string[];
  /** Build-file contents by path (package.json, *.csproj, CMakeLists.txt, ...). */
  readonly fileContents: ReadonlyMap<string, string>;
  /**
   * Optional source-file contents by path, used to parse dependency edges
   * that live in source (Go package imports). When absent, edges that
   * cannot be parsed make every module a dependent (the safe direction).
   */
  readonly sourceContents?: ReadonlyMap<string, string>;
}

export interface AffectedTestsInput {
  readonly changedFiles: readonly string[];
  readonly impactTool?: ImpactToolRung;
  readonly lsp?: LspReferencesRung;
  readonly moduleGraph?: ModuleGraphRungInput;
  /** Full-suite test list (rung 4). Required so the safe floor always exists. */
  readonly fullSuiteTests: readonly string[];
}

export interface AttemptedRung {
  readonly rung: AffectedTestsRung;
  readonly status: "ok" | "failed" | "skipped_widening";
  readonly reason: string;
}

export interface AffectedTestsResult {
  readonly tests: readonly string[];
  readonly rung: AffectedTestsRung;
  readonly widened: boolean;
  readonly wideningReasons: readonly string[];
  readonly attemptedRungs: readonly AttemptedRung[];
}

// ---------------------------------------------------------------------------
// Widening triggers
// ---------------------------------------------------------------------------

const LOCKFILE_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "cargo.lock", "go.sum", "poetry.lock", "pipfile.lock", "uv.lock",
  "gemfile.lock", "composer.lock", "podfile.lock", "pubspec.lock",
  "packages.lock.json", "gradle.lockfile", "mix.lock", "deno.lock",
  "flake.lock", "bun.lock", "bun.lockb",
]);

const BUILD_CONFIG_BASENAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "settings.gradle.kts", "cargo.toml", "go.mod", "cmakelists.txt", "makefile",
  "directory.build.props", "directory.build.targets", "directory.packages.props",
  ".csproj", ".sln",
]);

/**
 * Config-file basenames (or prefixes) that configure the whole build or
 * test run: a change here can affect every module, so the ladder widens.
 * Checked with a lower-cased basename (the caller lower-cases first).
 */
function isBuildConfigBasename(base: string): boolean {
  if (BUILD_CONFIG_BASENAMES.has(base)) return true;
  if (base.startsWith("jest.config.") || base.startsWith("vitest.config.") ||
      base.startsWith("vite.config.") || base.startsWith("playwright.config.")) return true;
  if (base.startsWith("tsconfig.")) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return true;
  return false;
}

const SHARED_HEADER_EXTENSIONS = new Set([".h", ".hpp", ".hxx", ".hh"]);

const KNOWN_SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".c", ".h", ".cpp", ".hpp", ".hxx", ".cc", ".hh",
  ".cs", ".java", ".go", ".rs", ".kt", ".swift", ".py",
  ".json", ".xml", ".yaml", ".yml", ".toml", ".gradle",
]);

// `.txt` and `.svg` are deliberately absent: CMakeLists.txt,
// requirements.txt, golden fixtures and runtime templates/icons are
// build inputs or data, not documentation (R4-B1).
const DOCUMENTATION_EXTENSIONS = new Set([
  ".md", ".mdx", ".rst", ".adoc",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
]);

const DOCUMENTATION_BASENAME = /^(license|copying|notice|changelog|changes|authors|contributors|contributing|readme|security|code_of_conduct)([._-]|$)/;

/** Extensions a conventional doc basename (LICENSE, README.txt, …) may carry. */
const DOCUMENTATION_BASENAME_EXTENSIONS = new Set(["", ".txt", ...DOCUMENTATION_EXTENSIONS]);

const TEST_DATA_SEGMENTS = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__", "testdata", "golden"]);

const PROJECT_BUILD_EXTENSIONS = new Set([
  ".csproj", ".fsproj", ".vbproj", ".sln", ".slnx", ".proj",
]);

const PROJECT_BUILD_BASENAMES = new Set([
  "package.json", "cargo.toml", "go.mod", "pom.xml", "cmakelists.txt",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
]);

function basenameOf(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function extensionOf(path: string): string {
  const base = basenameOf(path).toLowerCase();
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Documentation that selects no tests on its own. Fails closed: a file
 * under a test/fixture dir, a lockfile, a build-config or project file is
 * never documentation, and the conventional doc basenames (LICENSE,
 * README, SECURITY, …) count only without a code extension, so
 * `src/security.ts` or `Notice.java` stay code (R4-B1).
 */
export function isDocumentationPath(path: string): boolean {
  const normalized = normalizedPath(path);
  const lower = normalized.toLowerCase();
  if (lower.split("/").some((segment) => TEST_DATA_SEGMENTS.has(segment))) return false;
  const base = basenameOf(lower);
  if (LOCKFILE_BASENAMES.has(base) || isBuildConfigBasename(base) || isProjectBuildFile(normalized)) return false;
  const ext = extensionOf(normalized);
  if (DOCUMENTATION_EXTENSIONS.has(ext)) return true;
  return DOCUMENTATION_BASENAME_EXTENSIONS.has(ext) && DOCUMENTATION_BASENAME.test(base);
}

function isProjectBuildFile(path: string): boolean {
  const normalized = normalizedPath(path);
  const base = basenameOf(normalized).toLowerCase();
  return PROJECT_BUILD_EXTENSIONS.has(extensionOf(normalized)) || PROJECT_BUILD_BASENAMES.has(base);
}

export function detectWideningTriggers(changedFiles: readonly string[]): readonly string[] {
  const reasons: string[] = [];
  for (const file of changedFiles) {
    if (isDocumentationPath(file)) continue;
    const normalized = file.replaceAll("\\", "/").toLowerCase();
    const base = basenameOf(normalized);
    if (LOCKFILE_BASENAMES.has(base)) {
      reasons.push(`lockfile ${file}`);
      continue;
    }
    if (isBuildConfigBasename(base) || base.endsWith(".csproj") || base.endsWith(".sln") ||
        base === "cmakelists.txt" || base === "cargo.toml" || base === "go.mod" || base === "pom.xml") {
      reasons.push(`build configuration ${file}`);
      continue;
    }
    if (SHARED_HEADER_EXTENSIONS.has(extensionOf(file))) {
      reasons.push(`shared header ${file}`);
      continue;
    }
    if (normalized.includes("generated")) {
      reasons.push(`generated code ${file}`);
      continue;
    }
    const ext = extensionOf(file);
    if (ext !== "" && !KNOWN_SOURCE_EXTENSIONS.has(ext)) {
      reasons.push(`unknown file type ${file}`);
    }
  }
  return [...new Set(reasons)].sort();
}

/**
 * Recognize test files across realistic layouts: path segments, `.test.` /
 * `.spec.` infixes, language suffixes (`*_test.*`, `test_*.py`,
 * `*_spec.rb`), and
 * CamelCase `*Test(s)` basenames (`CalcTests.cs`, `UnitTest1.cs`,
 * `CTest.java`, `ATest.java`). The CamelCase rule requires an uppercase T
 * after a lowercase letter or separator, so `Contest.cs` is not a test.
 */
/**
 * Languages whose test convention is a CamelCase `*Test(s)` class file.
 * Restricting the CamelCase rule to them keeps `SpeedTest.tsx` or
 * `affected-tests.ts` from being read as tests.
 */
const CAMEL_CASE_TEST_EXTENSIONS = new Set([
  ".java", ".kt", ".kts", ".scala", ".groovy", ".cs", ".fs", ".vb", ".swift",
]);

function isTestBasename(base: string): boolean {
  const lower = base.toLowerCase();
  if (lower.includes(".test.") || lower.includes(".spec.") ||
      lower.includes(".cy.") || lower.includes(".e2e.") ||
      lower.startsWith("test-") || lower.startsWith("test_") ||
      /_test\.[^.]+$/.test(lower) || lower.endsWith("_spec.rb")) {
    return true;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (/^tests?\d*$/i.test(stem)) return true;
  if (!CAMEL_CASE_TEST_EXTENSIONS.has(extensionOf(base))) return false;
  if (/[a-z]Tests?\d*$/.test(stem)) return true;
  if (/^[A-Z]+Tests?\d*$/.test(stem)) return true;
  return false;
}

/**
 * A test the runner can actually execute: a member of the full suite, or a
 * file whose basename follows a test convention. Helpers, setup files and
 * fixtures under a test dir are NOT runnable (R4-B3): they are treated as
 * ordinary changes whose dependents must be found, never as the selection.
 */
export function isRunnableTestFile(path: string, context: TestIdentityContext = {}): boolean {
  const normalized = normalizedPath(path);
  if (isProjectBuildFile(normalized)) return false;
  if (context.fullSuiteTests?.has(normalized)) return true;
  return isTestBasename(basenameOf(normalized));
}

export interface TestIdentityContext {
  readonly fullSuiteTests?: ReadonlySet<string>;
  readonly testProjectDirs?: ReadonlySet<string>;
}

export function isTestFile(path: string, context: TestIdentityContext = {}): boolean {
  const normalized = normalizedPath(path);
  if (isProjectBuildFile(normalized)) return false;
  const lower = normalized.toLowerCase();
  const segments = lower.split("/");
  if (segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__")) {
    return true;
  }
  if (context.fullSuiteTests?.has(normalized)) return true;
  if (context.testProjectDirs && [...context.testProjectDirs].some((dir) => underDir(normalized, dir))) {
    return true;
  }
  return isTestBasename(basenameOf(normalized));
}

// ---------------------------------------------------------------------------
// Module graphs (pure, over injected file contents)
// ---------------------------------------------------------------------------

export type ModuleGraphKind = "npm" | "dotnet" | "cmake" | "cargo" | "go" | "maven_gradle";

export interface ParsedModule {
  readonly name: string;
  readonly dir: string;
  readonly dependsOn: readonly string[];
}

export interface ParsedModuleGraph {
  readonly kind: ModuleGraphKind;
  readonly modules: readonly ParsedModule[];
  readonly testProjectDirs?: readonly string[];
  /**
   * True when dependency edges could not be parsed (e.g. Go imports
   * without source contents): every module counts as a dependent of a
   * changed module, the safe direction.
   */
  readonly edgesUnknown?: boolean;
}

function isTestProjectContent(content: string): boolean {
  return /microsoft\.net\.test\.sdk|\bxunit\b|\bnunit\b|\bmstest\b|\bjunit\b|\btestng\b/i.test(content);
}

function dirOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

function underDir(file: string, dir: string): boolean {
  if (dir === "." || dir === "") return true;
  const f = file.replaceAll("\\", "/");
  const d = dir.replaceAll("\\", "/").replace(/\/$/, "");
  return f === d || f.startsWith(`${d}/`);
}

/** npm workspaces: root package.json `workspaces` + per-workspace package.json names/deps. */
export function parseNpmGraph(fileContents: ReadonlyMap<string, string>): ParsedModuleGraph | undefined {
  const rootRaw = fileContents.get("package.json");
  if (!rootRaw) return undefined;
  let root: { workspaces?: string[] | { packages?: string[] } };
  try {
    root = JSON.parse(rootRaw) as typeof root;
  } catch {
    return undefined;
  }
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
  if (!patterns || patterns.length === 0) return undefined;
  const modules: ParsedModule[] = [];
  for (const [path, content] of fileContents) {
    if (!path.endsWith("/package.json") && path !== "package.json") continue;
    if (path === "package.json") continue;
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(content) as typeof pkg;
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    modules.push({ name: pkg.name, dir: dirOf(path), dependsOn: [...deps].sort() });
  }
  if (modules.length === 0) return undefined;
  return { kind: "npm", modules };
}

/** .NET: .sln listing projects + .csproj ProjectReference edges. */
export function parseDotnetGraph(fileContents: ReadonlyMap<string, string>): ParsedModuleGraph | undefined {
  const csprojs = [...fileContents.keys()].filter((p) => p.toLowerCase().endsWith(".csproj"));
  if (csprojs.length === 0) return undefined;
  const modules: ParsedModule[] = csprojs.map((path) => {
    const content = fileContents.get(path) ?? "";
    const refs = [...content.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => {
      const ref = m[1].replaceAll("\\", "/");
      const base = ref.split("/").at(-1) ?? ref;
      return base.replace(/\.csproj$/i, "");
    });
    const name = basenameOf(path).replace(/\.csproj$/i, "");
    return { name, dir: dirOf(path), dependsOn: [...new Set(refs)].sort() };
  });
  const testProjectDirs = csprojs
    .filter((path) => isTestProjectContent(fileContents.get(path) ?? ""))
    .map((path) => dirOf(path));
  return { kind: "dotnet", modules, ...(testProjectDirs.length > 0 ? { testProjectDirs } : {}) };
}

/** CMake: add_library/add_executable targets + target_link_libraries edges. */
export function parseCmakeGraph(fileContents: ReadonlyMap<string, string>): ParsedModuleGraph | undefined {
  const lists = [...fileContents.entries()].filter(([p]) => basenameOf(p).toLowerCase() === "cmakelists.txt");
  if (lists.length === 0) return undefined;
  const modules: ParsedModule[] = [];
  for (const [path, content] of lists) {
    const targets = [...content.matchAll(/add_(?:library|executable)\s*\(\s*([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
    for (const target of targets) {
      const linkPattern = new RegExp(`target_link_libraries\\s*\\(\\s*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([^)]+)\\)`, "g");
      const deps = new Set<string>();
      for (const match of content.matchAll(linkPattern)) {
        for (const token of match[1].split(/\s+/)) {
          const t = token.trim();
          if (t && t !== "PUBLIC" && t !== "PRIVATE" && t !== "INTERFACE") deps.add(t);
        }
      }
      modules.push({ name: target, dir: dirOf(path), dependsOn: [...deps].sort() });
    }
  }
  if (modules.length === 0) return undefined;
  return { kind: "cmake", modules };
}

// ---------------------------------------------------------------------------
// Cargo (TOML sections parsed line by line, never cut at the first `[`)
// ---------------------------------------------------------------------------

interface CargoSection {
  readonly header: string;
  readonly lines: string[];
}

/** Split TOML content into lower-cased `[section]` groups (full-line comments skipped). */
function cargoSections(content: string): CargoSection[] {
  const sections: CargoSection[] = [];
  let current: { header: string; lines: string[] } | undefined;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(trimmed)?.[1]?.trim().toLowerCase();
    if (header !== undefined) {
      current = { header, lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(rawLine);
  }
  return sections;
}

/** Cut a TOML line at a `#` comment outside double-quoted strings. */
function stripTomlComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function cargoPackageName(content: string): string | undefined {
  for (const section of cargoSections(content)) {
    if (section.header !== "package") continue;
    for (const rawLine of section.lines) {
      const name = /^\s*name\s*=\s*"([^"]+)"\s*(#.*)?$/.exec(rawLine)?.[1];
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * Collect dependency edges from every dependency-bearing section:
 * `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`,
 * `[target.*.dependencies]` (and dev/build variants), and the
 * `[dependencies.<name>]` table form. A renamed inline table
 * (`alias = { package = "real", ... }`) resolves to the real package name.
 * A dependency-ish section that is not understood sets `unknown`
 * (edgesUnknown, the safe direction).
 */
function cargoDependencyNames(content: string): { deps: string[]; unknown: boolean } {
  const deps: string[] = [];
  let unknown = false;
  for (const section of cargoSections(content)) {
    const header = section.header;
    const tableForm = /^workspace\.(dependencies|dev-dependencies|build-dependencies)\.(.+)$/.exec(header) ??
      /^(dependencies|dev-dependencies|build-dependencies)\.(.+)$/.exec(header);
    if (tableForm) {
      const dep = tableForm[2].trim().split(".")[0];
      if (dep !== "") deps.push(dep);
      else unknown = true;
      continue;
    }
    if (/^workspace\.(dependencies|dev-dependencies|build-dependencies)$/.test(header) ||
        /^workspace\.(package|metadata|lints)(\.|$)/.test(header)) {
      continue;
    }
    if (header === "dependencies" || header === "dev-dependencies" || header === "build-dependencies" ||
        /^target\..+\.(dependencies|dev-dependencies|build-dependencies)$/.test(header)) {
      for (const rawLine of section.lines) {
        const line = stripTomlComment(rawLine).trim();
        if (line === "") continue;
        const decl = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\s*=\s*(.+)$/.exec(line);
        if (!decl) {
          unknown = true;
          continue;
        }
        const rename = /package\s*=\s*"([^"]+)"/.exec(decl[2])?.[1];
        if (!rename && decl[2].trim().startsWith("{") && /\bpackage\s*=/.test(decl[2])) {
          unknown = true;
          continue;
        }
        deps.push(rename ?? decl[1]);
      }
      continue;
    }
    if (header.includes("dependencies")) {
      unknown = true;
    }
  }
  return { deps, unknown };
}

/** Cargo: Cargo.toml package names + workspace members + dependencies. */
export function parseCargoGraph(fileContents: ReadonlyMap<string, string>): ParsedModuleGraph | undefined {
  const manifests = [...fileContents.entries()].filter(([p]) => basenameOf(p).toLowerCase() === "cargo.toml");
  if (manifests.length === 0) return undefined;
  const modules: ParsedModule[] = [];
  let edgesUnknown = false;
  for (const [path, content] of manifests) {
    const name = cargoPackageName(content);
    if (!name) continue;
    const { deps, unknown } = cargoDependencyNames(content);
    if (unknown) edgesUnknown = true;
    modules.push({ name, dir: dirOf(path), dependsOn: [...new Set(deps)].sort() });
  }
  if (modules.length === 0) return undefined;
  return { kind: "cargo", modules, ...(edgesUnknown ? { edgesUnknown: true as const } : {}) };
}

// ---------------------------------------------------------------------------
// Go (every go.mod in the tree, replace directives, nested modules)
// ---------------------------------------------------------------------------

interface GoModule {
  readonly dir: string;
  readonly path: string;
  readonly replaces: ReadonlyArray<{ readonly from: string; readonly toDir?: string; readonly toPath?: string }>;
}

function normalizeGoDir(modDir: string, rel: string): string {
  const out = modDir === "." ? [] : modDir.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.length === 0 ? "." : out.join("/");
}

/**
 * Parse `replace` directives (single-line and parenthesized blocks) from one
 * go.mod. A local target (`./dir`, `../dir`) resolves to a workspace dir;
 * anything else is a rewritten module path.
 */
function parseGoReplaces(content: string, modDir: string): GoModule["replaces"] {
  const replaces: Array<{ from: string; toDir?: string; toPath?: string }> = [];
  let inBlock = false;
  for (const raw of content.split("\n")) {
    const line = raw.split("//")[0].trim();
    if (/^replace\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const match = !inBlock
      ? /^\s*replace\s+(\S+)(?:\s+\S+)?\s*=>\s*(\S+)(?:\s+\S+)?\s*$/.exec(raw)
      : /^\s*(\S+)(?:\s+\S+)?\s*=>\s*(\S+)(?:\s+\S+)?\s*$/.exec(raw);
    if (!match) continue;
    const [, from, to] = match;
    if (to === "." || to === ".." || to.startsWith("./") || to.startsWith("../")) {
      replaces.push({ from, toDir: normalizeGoDir(modDir, to) });
    } else {
      replaces.push({ from, toPath: to });
    }
  }
  return replaces;
}

/**
 * Resolve an import path to workspace package dirs, honouring `replace`
 * directives (local-dir targets and rewritten module paths, a few hops).
 * Unknown (external) imports resolve to no dirs.
 */
function resolveGoImport(
  imp: string,
  replaces: ReadonlyArray<{ readonly from: string; readonly toDir?: string; readonly toPath?: string }>,
  importToDirs: ReadonlyMap<string, ReadonlyArray<string>>,
): readonly string[] {
  let current = imp;
  for (let hops = 0; hops < 4; hops += 1) {
    const hit = replaces.find((r) => current === r.from || current.startsWith(`${r.from}/`));
    if (!hit) break;
    const rest = current === hit.from ? "" : current.slice(hit.from.length);
    if (hit.toDir !== undefined) {
      if (hit.toDir === ".") return [rest === "" ? "." : rest.replace(/^\//, "")];
      return [`${hit.toDir}${rest}`];
    }
    current = `${hit.toPath as string}${rest}`;
  }
  return importToDirs.get(current) ?? [];
}

/**
 * Go: every go.mod in the tree is a module with its own module path; files
 * under a nested module belong to it (longest-prefix ownership). Dependents
 * resolve via `import "<module>/<pkg>"` lines (single-line and block
 * imports) plus `replace … => ./dir` identities. Without source contents
 * the import edges cannot be parsed, so edgesUnknown is set: every module
 * counts as a dependent (safe direction). A go.mod without a parseable
 * module line also sets edgesUnknown.
 */
export function parseGoGraph(
  fileContents: ReadonlyMap<string, string>,
  allFiles: readonly string[],
  sourceContents?: ReadonlyMap<string, string>,
): ParsedModuleGraph | undefined {
  const modFiles = [...fileContents.entries()].filter(([p]) => basenameOf(p).toLowerCase() === "go.mod");
  if (modFiles.length === 0) return undefined;
  const goModules: GoModule[] = [];
  let edgesUnknown = sourceContents === undefined;
  for (const [path, content] of modFiles) {
    const dir = dirOf(path);
    const modPath = content.match(/^\s*module\s+(\S+)/m)?.[1];
    if (!modPath) {
      edgesUnknown = true;
      continue;
    }
    goModules.push({ dir, path: modPath, replaces: parseGoReplaces(content, dir) });
  }
  if (goModules.length === 0) return undefined;
  const byDepth = [...goModules].sort((a, b) => b.dir.length - a.dir.length);
  const ownerOf = (file: string): GoModule | undefined => byDepth.find((m) => underDir(file, m.dir));
  const pkgDirs = new Map<GoModule, Set<string>>();
  for (const file of allFiles) {
    if (!file.toLowerCase().endsWith(".go")) continue;
    const owner = ownerOf(file);
    if (!owner) continue;
    let set = pkgDirs.get(owner);
    if (!set) {
      set = new Set<string>();
      pkgDirs.set(owner, set);
    }
    set.add(dirOf(file));
  }
  const dirToImport = new Map<string, string>();
  const importToDirs = new Map<string, string[]>();
  for (const [mod, dirs] of pkgDirs) {
    for (const dir of dirs) {
      const rel = dir === mod.dir ? "" : dir.slice(mod.dir === "." ? 0 : mod.dir.length + 1);
      const imp = rel ? `${mod.path}/${rel}` : mod.path;
      dirToImport.set(dir, imp);
      const list = importToDirs.get(imp) ?? [];
      list.push(dir);
      importToDirs.set(imp, list);
    }
  }
  if (dirToImport.size === 0) return undefined;
  const allReplaces = goModules.flatMap((m) => m.replaces);
  const modules: ParsedModule[] = [];
  for (const dir of [...dirToImport.keys()].sort()) {
    const deps = new Set<string>();
    if (sourceContents) {
      for (const [path, content] of sourceContents) {
        if (dirOf(path) !== dir || !path.toLowerCase().endsWith(".go")) continue;
        for (const imp of scanGoImports(content)) {
          if (imp === dirToImport.get(dir)) continue;
          for (const target of resolveGoImport(imp, allReplaces, importToDirs)) {
            if (target !== dir) deps.add(target);
          }
        }
      }
    }
    modules.push({ name: dir, dir, dependsOn: [...deps].sort() });
  }
  return { kind: "go", modules, ...(edgesUnknown ? { edgesUnknown: true as const } : {}) };
}

/** Scan Go import paths from single-line and parenthesized import blocks. */
function scanGoImports(content: string): readonly string[] {
  const imports: string[] = [];
  const lines = content.split("\n");
  let inBlock = false;
  for (const line of lines) {
    const code = line.split("//")[0];
    if (!inBlock && /^\s*import\s*\(/.test(code)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^\s*\)/.test(code)) {
      inBlock = false;
      continue;
    }
    const single = !inBlock ? code.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/) : undefined;
    // Block entries are usually indented with no alias (`"fmt"`): the alias
    // must be optional (a mandatory alias group never matches them).
    const blockEntry = inBlock ? code.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"/) : undefined;
    const hit = (single ?? blockEntry)?.[1];
    if (hit) imports.push(hit);
  }
  return imports;
}

// ---------------------------------------------------------------------------
// Maven/Gradle (Groovy + Kotlin DSL includes, comma lists)
// ---------------------------------------------------------------------------

/**
 * Parse `include` statements from a settings.gradle(.kts) file. Accepts the
 * Kotlin DSL call form `include(":app", ":core")`, the Groovy single form
 * `include ':core'`, and comma-separated lists
 * (`include 'app', 'core', 'web'`). A token becomes a module whose name and
 * dir are the colon path without the leading colon (`:a:b` -> `a/b`), the
 * same normalization `project(":a:b")` dependencies use below. An include
 * with no parseable quoted module sets `unparseable` (edgesUnknown, the
 * safe direction).
 */
function parseGradleIncludes(content: string): { names: string[]; unparseable: boolean } {
  const names: string[] = [];
  let unparseable = false;
  const pattern = /(?<![A-Za-z0-9_])include(?![A-Za-z0-9_])\s*(\(([^)]*)\)|([^\n;#]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const lineStart = content.lastIndexOf("\n", match.index - 1) + 1;
    if (content.slice(lineStart, match.index).includes("//")) continue;
    const args = (match[2] ?? match[3] ?? "").split("//")[0];
    const quoted = [...args.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (quoted.length === 0) {
      if (args.trim() !== "") unparseable = true;
      continue;
    }
    for (const token of quoted) {
      const path = token.replace(/^:/, "").replaceAll(":", "/");
      if (path !== "") names.push(path);
    }
  }
  return { names, unparseable };
}

function gradleProjectName(path: string): string {
  return path.replace(/^:/, "").split(/[:.]/).map((segment) => {
    return segment
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replaceAll("_", "-")
      .toLowerCase();
  }).join("/");
}

/**
 * Remove `//` and `/* *\/` comments from Groovy/Kotlin build scripts while
 * copying string literals verbatim (single, double and triple quotes), so
 * `'**\/*Test.class'`, `"https://…"` or `"gen/*"` inside strings never
 * delete real code (R7-B1).
 */
export function stripGradleComments(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && content[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const triple = content.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      while (j < n) {
        if (!triple && content[j] === "\\") { j += 2; continue; }
        if (content.startsWith(quote, j)) { j += quote.length; break; }
        if (!triple && content[j] === "\n") break;
        j++;
      }
      out += content.slice(i, Math.min(j, n));
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseTypesafeGradleEdges(content: string): { names: string[]; unparseable: boolean } {
  const code = stripGradleComments(content);
  const names: string[] = [];
  let unparseable = false;
  for (const match of code.matchAll(/\bprojects\s*\.\s*([A-Za-z0-9_$.]+)/g)) {
    const path = gradleProjectName(match[1]);
    if (path === "") unparseable = true;
    else names.push(path);
  }
  return { names, unparseable };
}

/** Block openers that configure OTHER projects: deps inside them have no readable owner. */
const GRADLE_CROSS_PROJECT_OPENER = /\b(?:subprojects|allprojects|configure|afterEvaluate|each|forEach|with|let|run|also|apply|project|findProject)\b/;

/** A plain literal project dependency: `project(':a')`, `project(path: ':a', …)`, `findProject(":a")!!`. */
const GRADLE_PLAIN_PROJECT_CALL = /(?:project|findProject)\s*\(\s*(?:path\s*[:=]\s*)?(['"])(:?[^'"\n$]{1,200})\1\s*(?:,[^()\n]{0,200})?\)(?:\s*!!)?/y;

/**
 * Read a Gradle build script's project dependencies structurally, in one
 * linear, string-aware pass over comment-free code (R9 redesign):
 * - Braces are tracked with a stack; each block records whether it is a
 *   `dependencies { }` block and whether its opener (the text on its line
 *   before `{`) configures another project (`subprojects`, `allprojects`,
 *   `configure(…)`, `project(':x') {`, `findProject(…)?.let {`, `.with {`, …).
 * - A `project(`/`findProject(` call INSIDE a dependencies block is an edge
 *   only when it is a plain literal whose result is not dereferenced
 *   (`.also`, `.tasks`, `?.let`, …); anything else there (templates,
 *   concatenation, receivers, variables) is unreadable → unknown.
 * - A dependencies block nested under a cross-project opener has no
 *   readable owner: any project reference in it → unknown. Nested
 *   same-module blocks (`kotlin { sourceSets { commonMain { dependencies {`)
 *   are not cross-project and stay precise.
 * - Outside dependencies blocks a call configures or references another
 *   project (`project(':x') {`, `dependsOn(project(":a").tasks…)`,
 *   `findProject(":a")?.let { it.version = … }`) and is ignored — unless its
 *   line manipulates dependencies (`p.dependencies.add(…, project(…))`,
 *   `project(':a').dependencies.add(…)`), which is unknown.
 * - `projects.<name>` type-safe accessors inside a cross-project
 *   dependencies block are unknown as well (their edges are read by
 *   parseTypesafeGradleEdges).
 */
export function readGradleProjectEdges(code: string): { edges: string[]; unknown: boolean } {
  const edges: string[] = [];
  let unknown = false;
  type Frame = { deps: boolean; cross: boolean; projectScoped: boolean; savedStmt: number; savedParen: number };
  const stack: Frame[] = [];
  // Statement start (R10-B1): an opener is the text from the start of its
  // statement, not of its physical line, so `dependencies\n{`,
  // `subprojects\n{` and wrapped `configure(\n…\n) {` are read correctly.
  // A newline ends a statement only at paren depth 0 and when the next
  // token does not continue it (`{`, `.`, `?.`, `)`).
  let stmtStart = 0;
  let parenDepth = 0;
  const n = code.length;
  const WINDOW = 300;
  let i = 0;
  const context = () => {
    let depsIndex = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].deps) { depsIndex = k; break; }
    }
    const inDeps = depsIndex >= 0;
    let crossAbove = false;
    for (let k = 0; k < depsIndex; k++) if (stack[k].cross) { crossAbove = true; break; }
    return { inDeps, crossAbove };
  };
  const statementBefore = (at: number) => code.slice(Math.max(stmtStart, at - WINDOW), at);
  while (i < n) {
    const ch = code[i];
    if (ch === "\n") {
      if (parenDepth === 0) {
        let j = i + 1;
        while (j < n && j < i + WINDOW && (code[j] === " " || code[j] === "\t" || code[j] === "\r" || code[j] === "\n")) j++;
        const c = code[j];
        if (!(c === "{" || c === "." || c === ")" || (c === "?" && code[j + 1] === "."))) stmtStart = i + 1;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      const triple = code.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      let j = i + quote.length;
      while (j < n) {
        if (!triple && code[j] === "\\") { j += 2; continue; }
        if (code.startsWith(quote, j)) { j += quote.length; break; }
        if (!triple && code[j] === "\n") break;
        j++;
      }
      i = j;
      continue;
    }
    if (ch === "(") { parenDepth++; i++; continue; }
    if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); i++; continue; }
    if (ch === ";" && parenDepth === 0) { stmtStart = i + 1; i++; continue; }
    if (ch === "{") {
      const opener = statementBefore(i);
      const deps = /\bdependencies\s*$/.test(opener);
      const head = opener.replace(/\bdependencies\s*$/, "");
      // A dependencies block inside a block scoped to ANOTHER project's
      // object (`findProject(":a")?.let {`, `project(":a").with {`) can
      // declare edges through `it` / the receiver without naming them:
      // unknown whatever it contains.
      if (deps && stack.some((b) => b.projectScoped)) unknown = true;
      stack.push({
        deps,
        // The opener window keeps the statement's tail; its head (where
        // `configure(subprojects…` / `subprojects` live) is checked too,
        // so a long opener cannot hide the cross-project word (R11-B1).
        cross: GRADLE_CROSS_PROJECT_OPENER.test(head) ||
          GRADLE_CROSS_PROJECT_OPENER.test(code.slice(stmtStart, Math.min(i, stmtStart + WINDOW))),
        projectScoped: /\b(?:project|findProject)\s*\(\s*[^)\s]/.test(head) && !/\bdependencies\b/.test(head),
        savedStmt: stmtStart,
        savedParen: parenDepth,
      });
      stmtStart = i + 1;
      parenDepth = 0;
      i++;
      continue;
    }
    if (ch === "}") {
      const frame = stack.pop();
      if (frame) { stmtStart = frame.savedStmt; parenDepth = frame.savedParen; }
      i++;
      continue;
    }
    const wordStart = i === 0 || !/[\w$.]/.test(code[i - 1]) || code[i - 1] === ".";
    const isFind = code.startsWith("findProject", i);
    if (wordStart && (isFind || code.startsWith("project", i)) && !/[\w$]/.test(code[i + (isFind ? 11 : 7)] ?? "")) {
      const nameLength = isFind ? 11 : 7;
      let k = i + nameLength;
      while (k < n && (code[k] === " " || code[k] === "\t")) k++;
      if (code[k] === "(") {
        // `project()` with no path is the current project: no edge (R10-B4).
        let e = k + 1;
        while (e < n && (code[e] === " " || code[e] === "\t")) e++;
        if (code[e] === ")") { i = e + 1; continue; }
        const { inDeps, crossAbove } = context();
        GRADLE_PLAIN_PROJECT_CALL.lastIndex = i;
        const match = GRADLE_PLAIN_PROJECT_CALL.exec(code);
        let rest = match ? i + match[0].length : -1;
        // Skip spaces and line breaks (bounded): `project(':a')\n{` opens a
        // block and a next-line `.also {` dereferences (R11 N2).
        if (rest >= 0) {
          const limit = Math.min(n, rest + WINDOW);
          while (rest < limit && /\s/.test(code[rest])) rest++;
        }
        const dereferenced = rest >= 0 && (code[rest] === "." || (code[rest] === "?" && code[rest + 1] === "."));
        if (inDeps) {
          if (match && !dereferenced) {
            const name = match[2].replace(/^:/, "").replaceAll(":", "/");
            if (name === "") unknown = true;
            else edges.push(name);
            if (crossAbove) unknown = true;
            i += match[0].length;
            continue;
          }
          unknown = true;
        } else {
          // Outside a dependencies block a project value is benign only
          // when it is used on the spot: dereferenced (`.tasks`, `?.let`),
          // opening a configuration block, or a task-ordering argument.
          // A value that escapes (a variable, a list, a helper argument, an
          // `ext` property) may become a dependency elsewhere (R10-B2); a
          // statement that manipulates `dependencies` is unknown as well.
          const before = statementBefore(i);
          const opensBlock = rest >= 0 && code[rest] === "{";
          const orderingArgument = /\b(?:dependsOn|mustRunAfter|shouldRunAfter|finalizedBy|evaluationDependsOn)\s*\(\s*$/.test(before);
          // Any element of a `configure(listOf(…))` / `configure([…])` list (R11 N2).
          const configureArgument = /\bconfigure\s*\(\s*(?:(?:listOf\s*\(|\[)[^{};]*)?$/.test(before);
          if (/\bdependencies\b/.test(before) || !match || !(dereferenced || opensBlock || orderingArgument || configureArgument)) {
            unknown = true;
          }
        }
        i += nameLength;
        continue;
      }
    }
    if (wordStart && code.startsWith("projects", i) && /^projects\s*\./.test(code.slice(i, i + 20))) {
      const { inDeps, crossAbove } = context();
      if (inDeps && crossAbove) unknown = true;
    }
    i++;
  }
  return { edges, unknown };
}

/** Maven/Gradle: pom.xml modules or settings.gradle includes. */
export function parseMavenGradleGraph(fileContents: ReadonlyMap<string, string>): ParsedModuleGraph | undefined {
  const modules: ParsedModule[] = [];
  let edgesUnknown = false;
  const includedNames = new Set<string>();
  const includedBuildDirs: string[] = [];
  for (const [path, content] of fileContents) {
    const base = basenameOf(path).toLowerCase();
    if (base === "settings.gradle" || base === "settings.gradle.kts") {
      const { names, unparseable } = parseGradleIncludes(content);
      if (unparseable) edgesUnknown = true;
      for (const name of names) {
        includedNames.add(name);
        modules.push({ name, dir: name, dependsOn: [] });
      }
      for (const m of stripGradleComments(content).matchAll(/\bincludeBuild\s*\(?\s*['"]([^'"\n]+)['"]/g)) {
        includedBuildDirs.push(m[1].replace(/^\.\//, "").replace(/\/$/, ""));
      }
    }
  }
  // Build logic outside build.gradle(.kts) — convention plugins in buildSrc /
  // build-logic / included builds, `apply from:` scripts — can add project
  // dependencies to any module; they cannot be attributed, so any project
  // reference there fails closed (R10-B3). The caller must pass these files
  // in `fileContents` for this check to see them.
  for (const [path, content] of fileContents) {
    const normalized = normalizedPath(path);
    const base = basenameOf(normalized).toLowerCase();
    if (base === "build.gradle" || base === "build.gradle.kts" || base === "settings.gradle" || base === "settings.gradle.kts") continue;
    const inBuildLogic = /^(?:buildSrc|build-logic)\//.test(normalized) || includedBuildDirs.some((dir) => dir !== "" && underDir(normalized, dir));
    const isScript = base.endsWith(".gradle") || base.endsWith(".gradle.kts");
    if (!inBuildLogic && !isScript) continue;
    if (/\b(?:project|findProject)\s*\(\s*[^)\s]|\bprojects\s*\./.test(stripGradleComments(content))) edgesUnknown = true;
  }
  for (const [path, content] of fileContents) {
    const base = basenameOf(path).toLowerCase();
    if (base === "pom.xml") {
      // The <parent> block carries the parent's artifactId, not this
      // module's: strip it before reading the module name (N8).
      const withoutParent = content.replace(/<parent>[\s\S]*?<\/parent>/g, "");
      const artifact = withoutParent.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
      if (artifact) {
        const deps = [...withoutParent.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g)]
          .map((m) => m[1].trim());
        modules.push({ name: artifact, dir: dirOf(path), dependsOn: [...new Set(deps)].sort() });
      }
    } else if (base === "build.gradle" || base === "build.gradle.kts") {
      // One structural reading (R9 redesign, replacing the per-shape rules
      // of R4–R8): see readGradleProjectEdges.
      const read = readGradleProjectEdges(stripGradleComments(content));
      if (read.unknown) edgesUnknown = true;
      const projectDeps = read.edges;
      // A literal edge to a module settings does not include cannot be
      // resolved to tests: fail closed, as the type-safe accessor path does.
      if (includedNames.size > 0 && projectDeps.some((name) => !includedNames.has(name))) edgesUnknown = true;
      const typesafe = parseTypesafeGradleEdges(content);
      const gradleDeps = [...projectDeps, ...typesafe.names];
      if (typesafe.unparseable) edgesUnknown = true;
      for (const dependency of typesafe.names) {
        if (!includedNames.has(dependency)) edgesUnknown = true;
      }
      if (gradleDeps.length > 0) {
        const dir = dirOf(path);
        modules.push({ name: dir, dir, dependsOn: [...new Set(gradleDeps)].sort() });
      }
    }
  }
  if (modules.length === 0) return undefined;
  const merged = new Map<string, ParsedModule>();
  for (const entry of modules) {
    const prior = merged.get(entry.name);
    if (!prior) {
      merged.set(entry.name, entry);
    } else {
      merged.set(entry.name, {
        name: entry.name,
        dir: prior.dir.length <= entry.dir.length ? prior.dir : entry.dir,
        dependsOn: [...new Set([...prior.dependsOn, ...entry.dependsOn])].sort(),
      });
    }
  }
  // No content-based test projects for Maven/Gradle: nearly every module
  // pom declares junit at test scope, so "has junit" would mark every
  // module (and the root) as a test project and every file as a test
  // (R4-B4). Java tests are recognized by `src/test/**` and `*Test` names.
  return {
    kind: "maven_gradle",
    modules: [...merged.values()],
    ...(edgesUnknown ? { edgesUnknown: true as const } : {}),
  };
}

export function parseAnyModuleGraph(
  fileContents: ReadonlyMap<string, string>,
  allFiles: readonly string[],
  sourceContents?: ReadonlyMap<string, string>,
): ParsedModuleGraph | undefined {
  return parseNpmGraph(fileContents) ?? parseDotnetGraph(fileContents) ??
    parseCmakeGraph(fileContents) ?? parseCargoGraph(fileContents) ??
    parseGoGraph(fileContents, allFiles, sourceContents) ?? parseMavenGradleGraph(fileContents);
}

function cargoInlineTestTargets(module: ParsedModule, allFiles: readonly string[]): string[] {
  return allFiles.filter((file) => {
    if (!underDir(file, module.dir) || extensionOf(file) !== ".rs") return false;
    const relative = normalizedPath(file).slice(module.dir === "." ? 0 : module.dir.length + 1);
    return relative === "src/lib.rs" || relative === "src/main.rs" || relative.startsWith("src/bin/");
  });
}

/** Tests in changed modules plus transitive dependents. */
export function moduleGraphTests(
  graph: ParsedModuleGraph,
  changedFiles: readonly string[],
  allFiles: readonly string[],
  context: TestIdentityContext = {},
): readonly string[] {
  const byName = new Map(graph.modules.map((m) => [m.name, m]));
  const changedModules = new Set<string>();
  for (const file of changedFiles) {
    let best: ParsedModule | undefined;
    for (const entry of graph.modules) {
      if (underDir(file, entry.dir) && (!best || entry.dir.length > best.dir.length)) best = entry;
    }
    if (best) changedModules.add(best.name);
  }
  // Transitive dependents (reverse edges).
  const dependents = new Map<string, Set<string>>();
  for (const entry of graph.modules) {
    for (const dep of entry.dependsOn) {
      if (!byName.has(dep)) continue;
      const set = dependents.get(dep) ?? new Set<string>();
      set.add(entry.name);
      dependents.set(dep, set);
    }
  }
  const affected = new Set(changedModules);
  if (graph.edgesUnknown && changedModules.size > 0) {
    for (const entry of graph.modules) affected.add(entry.name);
  }
  const queue = [...affected];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  // Attribute each test file to its most-specific (longest-dir) module: a
  // test belongs to the nearest package containing it. Overlapping module
  // dirs (a Go root package, a Cargo/Maven root crate with dir ".") must
  // not pull every nested test in when only the outer module is affected —
  // `underDir(f, ".")` is true for the whole tree. Dependents stay covered:
  // they are members of `affected` themselves.
  const identity: TestIdentityContext = {
    ...context,
    testProjectDirs: new Set([...(context.testProjectDirs ?? []), ...(graph.testProjectDirs ?? [])]),
  };
  const selected = new Set(allFiles
    .filter((f) => {
      if (!isTestFile(f, identity)) return false;
      let best: ParsedModule | undefined;
      for (const entry of graph.modules) {
        if (underDir(f, entry.dir) && (!best || entry.dir.length > best.dir.length)) best = entry;
      }
      return best !== undefined && affected.has(best.name);
    })
    .concat(graph.kind === "cargo"
      ? graph.modules.filter((module) => affected.has(module.name)).flatMap((module) => cargoInlineTestTargets(module, allFiles))
      : []));
  for (const file of changedFiles) {
    if (isRunnableTestFile(file, identity)) selected.add(file);
  }
  return [...selected].sort();
}

/**
 * Changed files that no module dir contains and that are not test files
 * themselves. Their dependents cannot be enumerated, so the module graph
 * cannot justify a narrow selection for them (NB1): each changed file is
 * accounted for individually, and one unmapped file widens the whole
 * change to the full suite.
 */
function unmappedNonTestFiles(
  graph: ParsedModuleGraph,
  changedFiles: readonly string[],
  context: TestIdentityContext,
): string[] {
  return changedFiles.filter((f) =>
    !isDocumentationPath(f) && !isRunnableTestFile(f, context) && !graph.modules.some((m) => underDir(f, m.dir)));
}

// ---------------------------------------------------------------------------
// LSP references with transitive closure
// ---------------------------------------------------------------------------

/**
 * Bound on files visited while following LSP references transitively.
 * Hitting the cap is a failed rung (never a silently partial selection):
 * the caller steps down to the module graph or the full suite.
 */
export const LSP_CLOSURE_NODE_CAP = 1000;

/**
 * Follow LSP references transitively: importers of importers, through
 * every reached file (helpers under test/ included), collecting test
 * files (NB3). Stopping at the first test file would silently drop the
 * tests that reach the change through a shared helper. A hop that fails
 * (`unsupported_language`, truncation, a throwing query) or a closure
 * that outgrows LSP_CLOSURE_NODE_CAP throws, so the rung fails closed
 * and steps down.
 */
export function followLspReferences(
  lsp: LspReferencesRung,
  changedFiles: readonly string[],
  changedTestFiles: readonly string[] = changedFiles.filter((file) => isRunnableTestFile(file)),
  context: TestIdentityContext = {},
): string[] {
  // `found` holds only what the references reached; the changed tests are
  // unioned in after the emptiness guard, so a co-changed test can never
  // mask an LSP that found nothing for the changed code (R4-B2).
  const found = new Set<string>();
  const visited = new Set<string>(changedFiles);
  const queue = [...changedFiles];
  while (queue.length > 0) {
    if (visited.size > LSP_CLOSURE_NODE_CAP) {
      throw new Error(
        `LSP reference closure exceeded ${LSP_CLOSURE_NODE_CAP} files; the selection would be partial`,
      );
    }
    const file = queue.shift() as string;
    const result = lsp.query(file);
    if (result.status === "unsupported_language") {
      throw new Error(`unsupported_language for ${file}`);
    }
    if (result.truncated) {
      throw new Error(`truncated LSP result for ${file}: incomplete reference set`);
    }
    for (const location of result.results) {
      if (isRunnableTestFile(location.path, context)) found.add(location.path);
      if (!visited.has(location.path)) {
        visited.add(location.path);
        queue.push(location.path);
      }
    }
  }
  const changedTests = new Set(changedTestFiles);
  const changedNonTests = changedFiles.filter((file) => !changedTests.has(file) && !isDocumentationPath(file));
  if (changedNonTests.length > 0 && found.size === 0) {
    throw new Error("LSP returned zero test references for a changed exported symbol");
  }
  return [...new Set([...found, ...changedTests])].sort();
}

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

/**
 * Compute affected tests by ladder. Pure except for the injected rung calls
 * (impact tool command, LSP query), which the caller supplies. Never returns
 * a narrower selection than justified; failed rungs step down.
 */
export function computeAffectedTests(input: AffectedTestsInput): AffectedTestsResult {
  if (!Array.isArray(input.changedFiles) || !Array.isArray(input.fullSuiteTests)) {
    throw new Error("computeAffectedTests requires changedFiles and fullSuiteTests arrays.");
  }
  const graph = input.moduleGraph
    ? parseAnyModuleGraph(input.moduleGraph.fileContents, input.moduleGraph.allFiles, input.moduleGraph.sourceContents)
    : undefined;
  const fullSuitePaths = new Set(input.fullSuiteTests.map(normalizedPath));
  const identity: TestIdentityContext = {
    fullSuiteTests: fullSuitePaths,
    testProjectDirs: new Set(graph?.testProjectDirs ?? []),
  };
  const changedTests = input.changedFiles.filter((file) => isRunnableTestFile(file, identity));
  const changedTestSet = new Set(changedTests);
  const changedNonTests = input.changedFiles.filter((file) => !changedTestSet.has(file) && !isDocumentationPath(file));
  const executableChangedFiles = input.changedFiles.filter((file) => !isDocumentationPath(file));
  if (input.changedFiles.length > 0 && executableChangedFiles.length === 0) {
    return {
      tests: [],
      rung: "no_tests_required",
      widened: false,
      wideningReasons: [],
      attemptedRungs: [{
        rung: "no_tests_required",
        status: "ok",
        reason: "documentation-only change selects no tests",
      }],
    };
  }
  const wideningReasons = detectWideningTriggers(executableChangedFiles);
  const widened = wideningReasons.length > 0;
  const attemptedRungs: AttemptedRung[] = [];
  const fullSuite = [...new Set([...input.fullSuiteTests, ...changedTests])].sort();

  if (!widened) {
    // Rung 1: project impact tool. Configured without a run function is a
    // failed rung (not an empty ok); an empty result steps down as well.
    if (input.impactTool?.configured) {
      if (typeof input.impactTool.run !== "function") {
        attemptedRungs.push({ rung: "impact_tool", status: "failed", reason: "impact tool configured without a run function; stepping down" });
      } else {
        try {
          // The emptiness guard judges the tool's own answer; changed tests
          // are unioned only into a successful result (R4-B2).
          const own = input.impactTool.run(input.changedFiles);
          const tests = [...new Set([...own, ...changedTests])].sort();
          if (own.length > 0 || (changedNonTests.length === 0 && tests.length > 0)) {
            attemptedRungs.push({
              rung: "impact_tool",
              status: "ok",
              reason: `impact tool selected ${tests.length} test(s)${changedTests.length > 0 ? ` (includes ${changedTests.length} changed test(s))` : ""}`,
            });
            return { tests, rung: "impact_tool", widened, wideningReasons, attemptedRungs };
          }
          attemptedRungs.push({ rung: "impact_tool", status: "failed", reason: "impact tool returned an empty selection; stepping down" });
        } catch (error) {
          attemptedRungs.push({
            rung: "impact_tool",
            status: "failed",
            reason: `impact tool failed (${error instanceof Error ? error.message : String(error)}); stepping down`,
          });
        }
      }
    } else {
      attemptedRungs.push({ rung: "impact_tool", status: "failed", reason: "impact tool not configured; stepping down" });
    }

    // Rung 2: LSP/compiler references, followed transitively (importers of
    // importers) to a fixpoint. Zero test references, a truncated result, a
    // failed hop, an unsupported language, or a closure that outgrows the
    // cap is a failed rung, never an empty or partial selection.
    if (input.lsp) {
      try {
        const tests = followLspReferences(input.lsp, input.changedFiles, changedTests, identity);
        attemptedRungs.push({
          rung: "lsp_references",
          status: "ok",
          reason: `LSP references selected ${tests.length} test(s)${changedTests.length > 0 ? ` (includes ${changedTests.length} changed test(s))` : ""}`,
        });
        return { tests, rung: "lsp_references", widened, wideningReasons, attemptedRungs };
      } catch (error) {
        attemptedRungs.push({
          rung: "lsp_references",
          status: "failed",
          reason: `LSP rung failed (${error instanceof Error ? error.message : String(error)}); stepping down`,
        });
      }
    } else {
      attemptedRungs.push({ rung: "lsp_references", status: "failed", reason: "LSP rung not configured; stepping down" });
    }
  } else {
    attemptedRungs.push({ rung: "impact_tool", status: "skipped_widening", reason: `widening: ${wideningReasons.join("; ")}` });
    attemptedRungs.push({ rung: "lsp_references", status: "skipped_widening", reason: `widening: ${wideningReasons.join("; ")}` });
  }

  // Rung 3: build-system module graph (floor when a build system exists).
  // A lockfile or root build-config change affects every module. A changed
  // file outside every module widens the whole change to the full suite,
  // even when other changed files map to modules (NB1). An empty rung
  // result steps down to the full suite: the ladder never returns an
  // empty selection on a non-empty change.
  if (input.moduleGraph) {
    if (graph) {
      const affectsEveryModule = widened && wideningReasons.some((r) =>
        r.startsWith("lockfile ") || r.startsWith("build configuration "));
      const unmapped = affectsEveryModule ? [] : unmappedNonTestFiles(graph, input.changedFiles, identity);
      if (unmapped.length > 0) {
        attemptedRungs.push({ rung: "module_graph", status: "failed", reason: `changed file(s) outside every module (${[...unmapped].sort().join(", ")}); stepping down to full suite` });
      } else {
        const tests = affectsEveryModule
          ? [...new Set(input.moduleGraph.allFiles.filter((file) => isTestFile(file, identity)))].sort()
          : [...moduleGraphTests(graph, input.changedFiles, input.moduleGraph.allFiles, identity)];
        if (tests.length > 0) {
          attemptedRungs.push({
            rung: "module_graph",
            status: "ok",
            reason: `${graph.kind} module graph selected ${tests.length} test(s)${affectsEveryModule ? " (widening: every module affected)" : ""}${changedTests.length > 0 ? ` (includes ${changedTests.length} changed test(s))` : ""}`,
          });
          return { tests, rung: "module_graph", widened, wideningReasons, attemptedRungs };
        }
        attemptedRungs.push({ rung: "module_graph", status: "failed", reason: `${graph.kind} module graph mapped the change to no tests; stepping down to full suite` });
      }
    } else {
      attemptedRungs.push({ rung: "module_graph", status: "failed", reason: "no module graph exists; stepping down to full suite" });
    }
  } else {
    attemptedRungs.push({ rung: "module_graph", status: "failed", reason: "module graph not provided; stepping down to full suite" });
  }

  // Rung 4: full suite (safe floor).
  attemptedRungs.push({ rung: "full_suite", status: "ok", reason: `full suite (${fullSuite.length} test(s))` });
  return { tests: fullSuite, rung: "full_suite", widened, wideningReasons, attemptedRungs };
}
