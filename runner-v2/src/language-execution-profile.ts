/**
 * Language-neutral execution profiles (Runner V2 P6.6 V3, AR-R26).
 *
 * Pure, deterministic, zero model calls, no subprocess execution. Detects
 * build/test commands and machine-readable report contracts for
 * non-`package.json` projects from tracked working-tree files only.
 * `unknown` applies only when nothing applies: a detected family with a
 * missing SDK or a missing/malformed report stays detected and fails
 * closed downstream (never a clean no-test inventory).
 *
 * Report wiring exists only where the runner can collect real reports:
 * `pytest --junitxml`, `dotnet test` TRX logging, `ctest --output-junit`,
 * and the Maven Surefire per-class JUnit report set (`mvn -B test` writes
 * `target/surefire-reports/TEST-*.xml` with no flag the runner must add;
 * the invocation-owned fresh set is collected and aggregated with the
 * existing JUnit reader). Gradle writes per-class JUnit the same way but
 * stays unwired until qualified, and cargo/go write no JUnit without
 * project-side reporter configuration the runner cannot set; those
 * families are detected with exact commands but their reports stay
 * unsupported, so exit 0 or prose can never mint test counts. The
 * conservative `test-report-readers.ts` JUnit/TRX readers already accept
 * the surefire/nextest/go-junit-report shapes those families produce.
 */

import { lstat, readdir } from "node:fs/promises";

export type LanguageFamily = "dotnet" | "cmake" | "pytest" | "maven" | "gradle" | "cargo" | "go";

export type LanguageReportFormat = "junit" | "trx";

/** A report contract the runner can wire for one detected tests command. */
export interface LanguageTestRunner {
  /** Stable runner identity recorded in trusted descriptors and reports. */
  runner: "pytest" | "dotnet test" | "ctest" | "maven test";
  format: LanguageReportFormat;
}

/** One detected non-package.json build or tests command (stable, archivable). */
export interface LanguageExecutionCommand {
  label: string;
  executable: string;
  args: string[];
}

export interface LanguageFamilyDetection {
  family: LanguageFamily;
  /** Repository-relative marker path that proves the family applies. */
  source: string;
  detail: string;
  build?: LanguageExecutionCommand[];
  tests?: LanguageExecutionCommand;
  /**
   * Set when the detected tests command cannot be collected as one
   * unambiguous result (several test projects sharing one TRX filename,
   * solution-only member resolution, multi-target projects, or
   * unavailable marker contents). The command stays detected and
   * uncertain; no single-result descriptor is issued, so downstream
   * readers must refuse counts instead of shrinking the denominator.
   */
  testsAmbiguous?: string;
}

/** Trusted per-command report descriptor: which wired runner a tests command reports through. */
export interface LanguageReportDescriptor {
  /** Exact `commands.tests` label the descriptor belongs to. */
  commandLabel: string;
  runner: LanguageTestRunner["runner"];
  format: LanguageReportFormat;
}

const WIRED_RUNNERS: Readonly<Record<LanguageTestRunner["runner"], LanguageReportFormat>> = {
  "pytest": "junit",
  "dotnet test": "trx",
  "ctest": "junit",
  "maven test": "junit",
};

export function languageReportFormat(runner: string): LanguageReportFormat | undefined {
  return (WIRED_RUNNERS as Readonly<Record<string, LanguageReportFormat>>)[runner];
}

/** Bounded inventory walk: relative posix paths of regular files, sorted, symlinks never followed. */
const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".vs", ".vscode", ".idea",
  "node_modules", "target", "bin", "obj", "out", "dist", "build",
  "TestResults", "test-results", ".aiboard-reports", "packages",
  "__pycache__", ".venv", "venv", ".tox",
]);
const MAX_INVENTORY_FILES = 4000;
const MAX_INVENTORY_DEPTH = 8;

export interface LanguageInventory {
  /** Relative posix paths of regular files, sorted, symlinks never followed. */
  files: string[];
  /**
   * True when the walk hit a bound (file cap, depth cap, or a readdir
   * failure), so absence of a marker proves nothing. Callers must carry
   * this explicitly and fail closed instead of reporting a clean
   * no-family inventory.
   */
  incomplete: boolean;
}

export async function listLanguageInventoryFiles(input: {
  repositoryRoot: string;
  readdir: (path: string) => Promise<Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>>;
}): Promise<LanguageInventory> {
  const files: string[] = [];
  let incomplete = false;
  const queue: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
  while (queue.length > 0 && files.length < MAX_INVENTORY_FILES) {
    const current = queue.shift()!;
    if (current.depth > MAX_INVENTORY_DEPTH) {
      incomplete = true;
      continue;
    }
    const absolute = current.relative
      ? `${input.repositoryRoot}/${current.relative}`
      : input.repositoryRoot;
    let entries: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
    try {
      entries = await input.readdir(absolute);
    } catch {
      incomplete = true;
      continue;
    }
    entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink || entry.name === "." || entry.name === "..") continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (current.depth < MAX_INVENTORY_DEPTH && !SKIP_DIRECTORIES.has(entry.name)) {
          queue.push({ relative, depth: current.depth + 1 });
        } else if (!SKIP_DIRECTORIES.has(entry.name)) {
          incomplete = true;
        }
        continue;
      }
      files.push(relative);
      if (files.length >= MAX_INVENTORY_FILES) {
        incomplete = true;
        break;
      }
    }
  }
  if (queue.length > 0) incomplete = true;
  return { files: files.sort(), incomplete };
}

const TEST_PROJECT_NAME = /(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)/i;
const DOTNET_TEST_PACKAGE = /(?:Microsoft\.NET\.Test\.Sdk|xunit|mstest|nunit|tunit|expecto)\b/i;
const DOTNET_MULTI_TARGET = /<\s*TargetFrameworks(?:\s[^<>]*)?>/i;

/** Upper bound on files in one .NET test-property closure. */
const DOTNET_PROPERTY_CLOSURE_BOUND = 32;

/** Specific SDK roots are external; arbitrary properties may resolve locally. */
export function msbuildImportIsKnownExternal(raw: string, importElement = ""): boolean {
  return /\bSdk\s*=\s*(?:"[^"$]+"|'[^'$]+')/i.test(importElement) ||
    /^\$\((?:MSBuildToolsPath|MSBuildSDKsPath|MSBuildExtensionsPath(?:32|64)?|MSBuildBinPath)\)(?:\/|$)/i.test(raw);
}


function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const out = (absolute ? "/" : "") + parts.join("/");
  return out || (absolute ? "/" : ".");
}

function joinPosixPath(dir: string, raw: string): string {
  const cleaned = raw.replaceAll("\\", "/");
  if (cleaned.startsWith("/")) return normalizePosixPath(cleaned);
  return normalizePosixPath(dir === "." ? cleaned : `${dir}/${cleaned}`);
}

/**
 * MSBuild files MSBuild imports automatically, from the project directory
 * upward. Matched case-insensitively: a tracked spelling still applies on
 * case-sensitive checkouts when the build runs on Windows.
 */
function dotnetAutomaticPropertyFiles(project: string, files: readonly string[]): string[] {
  const lower = new Map<string, string>();
  for (const file of files) {
    const key = file.toLowerCase();
    if (!lower.has(key)) lower.set(key, file);
  }
  const found: string[] = [];
  let dir = posixDirname(project);
  for (;;) {
    for (const name of ["directory.build.props", "directory.build.targets"]) {
      const wanted = dir === "." ? name : `${dir}/${name}`.toLowerCase();
      const actual = lower.get(wanted);
      if (actual !== undefined && !found.includes(actual)) found.push(actual);
    }
    if (dir === "." || dir === "/") break;
    dir = posixDirname(dir);
  }
  return found;
}

/**
 * Qualifies a single-project .NET tests command as one unambiguous result
 * (F5, AR-R26). The relevant property closure is the test project itself,
 * every automatically imported Directory.Build.props/targets file above it,
 * and every transitively imported relative property file. A multi-target
 * marker (bare or attributed), an unreadable or unavailable local member,
 * a conditional import, and a property-driven local import each return an
 * ambiguity reason: the run stays detected but receives no single-result
 * descriptor, so downstream readers refuse counts instead of shrinking
 * the denominator. Absolute, SDK, and bare-name references stay
 * external; non-property import targets cannot define frameworks.
 */
function dotnetSingleResultAmbiguity(input: {
  project: string;
  files: readonly string[];
  readFile: (relativePath: string) => string | undefined;
  unreadable: ReadonlySet<string>;
}): string | undefined {
  const known = new Set(input.files);
  const closure: string[] = [input.project];
  const queued = new Set<string>(closure);
  for (const automatic of dotnetAutomaticPropertyFiles(input.project, input.files)) {
    if (!queued.has(automatic)) {
      queued.add(automatic);
      closure.push(automatic);
    }
  }
  for (let index = 0; index < closure.length; index += 1) {
    if (closure.length > DOTNET_PROPERTY_CLOSURE_BOUND) {
      return `${input.project} property closure exceeds its bound, so one shared TRX file cannot represent every target result.`;
    }
    const path = closure[index]!;
    if (input.unreadable.has(path)) {
      return `unreadable .NET property contents (${path}) cannot prove a single target result, so one shared TRX file cannot represent the run.`;
    }
    const content = input.readFile(path);
    if (content === undefined) {
      return `unavailable .NET property contents (${path}) cannot prove a single target result, so one shared TRX file cannot represent the run.`;
    }
    if (DOTNET_MULTI_TARGET.test(content)) {
      return `${path} targets several frameworks, so one shared TRX filename cannot represent every target result.`;
    }
    for (const tag of content.matchAll(/<Import\s[^<>]*?>/gi)) {
      const element = tag[0]!;
      const projectMatch = /\bProject\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(element);
      if (!projectMatch) continue;
      if (/\bCondition\s*=/i.test(element)) {
        return `${path} carries a conditional import, so the test property closure cannot be resolved to one result.`;
      }
      const raw = (projectMatch[1] ?? projectMatch[2]!).replaceAll("\\", "/");
      if (msbuildImportIsKnownExternal(raw, element)) continue;
      if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || /[$%*?]/.test(raw)) {
        return `${path} carries a property-driven local import (${raw}), so the test property closure cannot be resolved to one result.`;
      }
      const target = joinPosixPath(posixDirname(path), raw);
      if (target === ".." || target.startsWith("../")) {
        return `${path} imports properties outside the repository (${raw}), so the test property closure cannot be resolved to one result.`;
      }
      // MSBuild evaluates imported XML regardless of its filename extension.
      if (!known.has(target)) {
        return `${path} imports unavailable local properties (${raw}), so the test property closure cannot be resolved to one result.`;
      }
      if (!queued.has(target)) {
        queued.add(target);
        closure.push(target);
      }
    }
  }
  return undefined;
}
const CMAKE_TEST_COMMAND = /(?:^|\s)(?:enable_testing|add_test|include\s*\(\s*ctest)/i;
const PYTEST_TOML_SECTION = /\[tool\.pytest/i;

function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : index === 0 ? "/" : path.slice(0, index);
}

function executableName(executable: string): string {
  const normalized = executable.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") || base.endsWith(".cmd") || base.endsWith(".bat") ? base.slice(0, base.lastIndexOf(".")) : base;
}

/**
 * Detects non-package.json language families from repository-relative file
 * paths (plus bounded content reads supplied by the caller, so this module
 * never touches the filesystem itself). Families are reported in a fixed
 * order; at most one entry per family.
 *
 * Content-gated markers whose contents are listed in `unreadable` keep
 * their tests command in an explicitly ambiguous state instead of
 * proving absence: a caller that could not read the marker cannot claim
 * the family defines no tests.
 */
export function detectLanguageFamilies(input: {
  files: readonly string[];
  readFile?: (relativePath: string) => string | undefined;
  unreadable?: readonly string[];
}): LanguageFamilyDetection[] {
  const files = [...input.files].sort();
  const read = input.readFile ?? (() => undefined);
  const unreadable = new Set(input.unreadable ?? []);
  const byName = (predicate: (base: string) => boolean): string[] =>
    files.filter((path) => predicate(path.slice(path.lastIndexOf("/") + 1).toLowerCase()));
  const detections: LanguageFamilyDetection[] = [];

  const dotnetProjects = byName((base) => /\.(?:cs|fs|vb)proj$/.test(base));
  const dotnetSolutions = byName((base) => /\.(?:sln|slnx)$/.test(base));
  if (dotnetProjects.length > 0 || dotnetSolutions.length > 0) {
    const marker = dotnetProjects[0] ?? dotnetSolutions[0]!;
    const unknownProjects = dotnetProjects.filter((path) => unreadable.has(path));
    const testProjects = dotnetProjects.filter((path) => {
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (TEST_PROJECT_NAME.test(base.replace(/\.(?:cs|fs|vb)proj$/i, ""))) return true;
      const content = read(path);
      return content !== undefined && DOTNET_TEST_PACKAGE.test(content);
    });
    const uniqueProject = dotnetProjects.length + dotnetSolutions.length === 1
      ? [dotnetProjects[0] ?? dotnetSolutions[0]!]
      : [];
    // Native one-shot settlement must not retain persistent compiler/MSBuild
    // servers in its owned process boundary after the test workload exits.
    const detection: LanguageFamilyDetection = {
      family: "dotnet",
      source: marker,
      detail: uniqueProject.length > 0 ? `dotnet build ${uniqueProject[0]}` : "dotnet build",
      build: [{
        label: "dotnet build",
        executable: "dotnet",
        args: uniqueProject.length > 0 ? ["build", uniqueProject[0]!, "--disable-build-servers"] : ["build", "--disable-build-servers"],
      }],
    };
    if (dotnetProjects.length === 0) {
      detection.tests = { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] };
      detection.detail += "; dotnet test";
      detection.testsAmbiguous = "solution-only .NET detection cannot resolve member test projects, so one shared TRX file cannot represent the run.";
    } else if (unknownProjects.length > 0) {
      detection.tests = { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] };
      detection.detail += "; dotnet test";
      detection.testsAmbiguous = `unreadable project marker contents (${unknownProjects[0]}) cannot prove which projects define tests, so one shared TRX file cannot represent the run.`;
    } else if (testProjects.length > 1) {
      detection.tests = { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] };
      detection.detail += "; dotnet test";
      detection.testsAmbiguous = "several .NET test projects share one dotnet test invocation and one TRX filename, so the last report would hide the denominator.";
    } else if (testProjects.length === 1) {
      const project = testProjects[0]!;
      detection.tests = {
        label: "dotnet test",
        executable: "dotnet",
        args: ["test", project, "--disable-build-servers"],
      };
      detection.detail += `; dotnet test ${project}`;
      const ambiguity = dotnetSingleResultAmbiguity({ project, files, readFile: read, unreadable });
      if (ambiguity !== undefined) detection.testsAmbiguous = ambiguity;
    }
    detections.push(detection);
  }

  const cmakeLists = files.filter((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === "cmakelists.txt");
  if (cmakeLists.length > 0) {
    const root = cmakeLists.find((path) => posixDirname(path) === ".") ?? cmakeLists[0]!;
    const sourceDir = posixDirname(root);
    const sourceArg = sourceDir === "." ? "." : `./${sourceDir}`;
    const buildDir = ".aiboard-cmake-build";
    const unknownLists = cmakeLists.filter((path) => unreadable.has(path));
    const definesTests = cmakeLists.some((path) => {
      const content = read(path);
      return content !== undefined && CMAKE_TEST_COMMAND.test(content);
    });
    const detection: LanguageFamilyDetection = {
      family: "cmake",
      source: root,
      detail: definesTests || unknownLists.length > 0
        ? `cmake -S ${sourceArg} -B ${buildDir}; cmake --build ${buildDir}; ctest --test-dir ${buildDir}`
        : `cmake -S ${sourceArg} -B ${buildDir}; cmake --build ${buildDir}`,
      build: [
        { label: "cmake configure", executable: "cmake", args: ["-S", sourceArg, "-B", buildDir] },
        { label: "cmake build", executable: "cmake", args: ["--build", buildDir] },
      ],
    };
    if (definesTests) {
      detection.tests = { label: "ctest", executable: "ctest", args: ["--test-dir", buildDir] };
    } else if (unknownLists.length > 0) {
      detection.tests = { label: "ctest", executable: "ctest", args: ["--test-dir", buildDir] };
      detection.testsAmbiguous = `unreadable CMakeLists contents (${unknownLists[0]}) cannot prove no tests are defined, so the ctest report stays uncertain.`;
    }
    detections.push(detection);
  }

  const pytestConfigs = byName((base) =>
    base === "pytest.ini" || base === "tox.ini" || base === "setup.cfg" || base === "conftest.py");
  const pyproject = byName((base) => base === "pyproject.toml");
  const pytestProject = pyproject.filter((path) => {
    const content = read(path);
    return content !== undefined && PYTEST_TOML_SECTION.test(content);
  });
  const unreadablePyproject = pyproject.filter((path) => unreadable.has(path) && read(path) === undefined);
  const pytestMarker = pytestConfigs[0] ?? pytestProject[0];
  if (pytestMarker !== undefined) {
    detections.push({
      family: "pytest",
      source: pytestMarker,
      detail: "pytest --junitxml=<runner-owned report>",
      tests: { label: "pytest", executable: "pytest", args: [] },
    });
  } else if (unreadablePyproject.length > 0) {
    detections.push({
      family: "pytest",
      source: unreadablePyproject[0]!,
      detail: "pytest --junitxml=<runner-owned report>",
      tests: { label: "pytest", executable: "pytest", args: [] },
      testsAmbiguous: `unreadable pyproject.toml contents (${unreadablePyproject[0]}) cannot prove no pytest section exists, so the pytest report stays uncertain.`,
    });
  }

  const poms = files.filter((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === "pom.xml");
  if (poms.length > 0) {
    const root = poms.find((path) => posixDirname(path) === ".") ?? poms[0]!;
    detections.push({
      family: "maven",
      source: root,
      detail: "mvn -B compile; mvn -B test (Surefire per-class JUnit collected as an invocation-owned fresh report set)",
      build: [{ label: "maven compile", executable: "mvn", args: ["-B", "compile"] }],
      tests: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
    });
  }

  const gradle = byName((base) =>
    base === "build.gradle" || base === "build.gradle.kts" ||
    base === "settings.gradle" || base === "settings.gradle.kts");
  if (gradle.length > 0) {
    detections.push({
      family: "gradle",
      source: gradle.find((path) => posixDirname(path) === ".") ?? gradle[0]!,
      detail: "gradle assemble; gradle test (per-class JUnit; no qualified collector yet)",
      build: [{ label: "gradle assemble", executable: "gradle", args: ["assemble"] }],
      tests: { label: "gradle test", executable: "gradle", args: ["test"] },
    });
  }

  const cargo = byName((base) => base === "cargo.toml");
  if (cargo.length > 0) {
    detections.push({
      family: "cargo",
      source: cargo.find((path) => posixDirname(path) === ".") ?? cargo[0]!,
      detail: "cargo build; cargo test (no JUnit writer the runner can set)",
      build: [{ label: "cargo build", executable: "cargo", args: ["build"] }],
      tests: { label: "cargo test", executable: "cargo", args: ["test"] },
    });
  }

  const goMod = byName((base) => base === "go.mod");
  if (goMod.length > 0) {
    detections.push({
      family: "go",
      source: goMod.find((path) => posixDirname(path) === ".") ?? goMod[0]!,
      detail: "go build ./...; go test ./... (no JUnit writer the runner can set)",
      build: [{ label: "go build", executable: "go", args: ["build", "./..."] }],
      tests: { label: "go test", executable: "go", args: ["test", "./..."] },
    });
  }

  return detections;
}

/** Trusted descriptors for the detected tests commands that have wired, unambiguous reports. */
export function languageReportDescriptors(
  detections: readonly LanguageFamilyDetection[],
): LanguageReportDescriptor[] {
  const descriptors: LanguageReportDescriptor[] = [];
  for (const detection of detections) {
    if (!detection.tests || detection.testsAmbiguous) continue;
    if (detection.family === "pytest") {
      descriptors.push({ commandLabel: detection.tests.label, runner: "pytest", format: "junit" });
    } else if (detection.family === "dotnet") {
      descriptors.push({ commandLabel: detection.tests.label, runner: "dotnet test", format: "trx" });
    } else if (detection.family === "cmake") {
      descriptors.push({ commandLabel: detection.tests.label, runner: "ctest", format: "junit" });
    } else if (detection.family === "maven") {
      descriptors.push({ commandLabel: detection.tests.label, runner: "maven test", format: "junit" });
    }
  }
  return descriptors;
}

export interface LanguageTestReportPlan {
  runner: string;
  command?: LanguageExecutionCommand;
  /** Workspace-relative; unique per run, never a committed file. */
  reportPath?: string;
  format?: LanguageReportFormat;
  /** Maven Surefire fresh report-set collection (no flag to append). */
  reportSet?: { kind: "maven-surefire-reports" };
  unsupported?: string;
}

export function languageReportFileName(reportName: string, format: LanguageReportFormat): string {
  const safe = reportName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "report";
  return `.aiboard-report-${safe}.${format === "trx" ? "trx" : "xml"}`;
}

function existingFlagValue(args: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (const arg of args) {
    if (arg === flag) return "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function existingOptionValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) return args[index + 1];
  }
  return undefined;
}

/**
 * Plans the machine-readable report for a detected language-family tests
 * command. Pure shape match on the exact command: when the command already
 * carries the family's report flag, the existing path is reused (never
 * rewritten); otherwise the runner's flags are appended. Maven needs no
 * flag: Surefire always writes per-class JUnit, collected as an
 * invocation-owned fresh set. Returns `undefined` when the command is not
 * a wired family shape. Families without a qualified collector return an
 * explicit unsupported plan so the run stays detected but proves nothing.
 *
 * Shape-only: ambiguity between several projects sharing one report file
 * is enforced by the trusted descriptor gate (no descriptor, no counts),
 * not by this planner.
 */
export function planLanguageTestReport(input: {
  checkoutPath: string;
  command: LanguageExecutionCommand;
  reportName: string;
}): LanguageTestReportPlan | undefined {
  const name = executableName(input.command.executable);
  const args = input.command.args;

  const asPosix = (value: string): string => value.replaceAll("\\", "/");
  const checkoutPrefix = asPosix(input.checkoutPath).replace(/\/+$/, "");
  const toWorkspaceRelative = (value: string): string | undefined => {
    const normalized = asPosix(value);
    if (normalized === checkoutPrefix) return ".";
    if (normalized.startsWith(`${checkoutPrefix}/`)) {
      const relative = normalized.slice(checkoutPrefix.length + 1);
      if (relative && !relative.split("/").includes("..")) return relative;
    }
    if (!normalized.includes(":") && !normalized.startsWith("/") && !normalized.split("/").includes("..")) {
      return normalized.replace(/^\.\//, "");
    }
    return undefined;
  };

  if (name === "pytest" || name === "python" || name === "python3" || name === "py") {
    if (name !== "pytest") {
      if (!(args[0] === "-m" && args[1] === "pytest")) return undefined;
    }
    const existing = existingFlagValue(args, "--junitxml");
    if (existing !== undefined) {
      if (!existing) return { runner: "pytest", unsupported: "pytest carries an empty --junitxml flag; the runner cannot read a report with no path." };
      const relative = toWorkspaceRelative(existing);
      if (!relative) return { runner: "pytest", unsupported: "pytest --junitxml points outside the runner-owned verification workspace." };
      return { runner: "pytest", format: "junit", reportPath: relative };
    }
    const reportPath = languageReportFileName(input.reportName, "junit");
    return {
      runner: "pytest",
      format: "junit",
      reportPath,
      command: { ...input.command, args: [...args, `--junitxml=${reportPath}`] },
    };
  }

  if (name === "dotnet" && args[0] === "test") {
    const loggerIndex = args.findIndex((arg) => arg === "--logger" || arg === "-l");
    const loggerValue = loggerIndex >= 0 ? args[loggerIndex + 1] : undefined;
    if (loggerValue !== undefined) {
      const match = /trx\s*;\s*LogFileName\s*=\s*(.+?)\s*$/i.exec(loggerValue);
      if (!match) return { runner: "dotnet test", unsupported: "dotnet test already selects a logger the runner cannot read as TRX." };
      const relative = toWorkspaceRelative(match[1]!.replace(/^["']|["']$/g, ""));
      if (!relative) return { runner: "dotnet test", unsupported: "dotnet test TRX LogFileName points outside the runner-owned verification workspace." };
      return { runner: "dotnet test", format: "trx", reportPath: relative };
    }
    const reportPath = languageReportFileName(input.reportName, "trx");
    const absolute = `${asPosix(input.checkoutPath)}/${reportPath}`;
    return {
      runner: "dotnet test",
      format: "trx",
      reportPath,
      command: { ...input.command, args: [...args, "--logger", `trx;LogFileName=${absolute}`] },
    };
  }

  if (name === "ctest") {
    // T8: ctest resolves a relative --output-junit against the test dir
    // (--test-dir), not the invocation directory: a workspace-relative
    // flag would land in the build dir while the runner reads the
    // checkout root, so green runs would go red for "no readable
    // report". Fresh plans therefore carry an absolute path (like the
    // dotnet TRX planner); a reused existing relative flag resolves
    // against the test dir when one is given. The reused command itself
    // is never rewritten.
    const testDir = existingOptionValue(args, "--test-dir");
    const existing = existingOptionValue(args, "--output-junit");
    if (existing !== undefined) {
      if (!existing) return { runner: "ctest", unsupported: "ctest carries an empty --output-junit flag; the runner cannot read a report with no path." };
      const existingPosix = asPosix(existing);
      const testDirBase = testDir ? asPosix(testDir) : undefined;
      const candidate = testDirBase && !existingPosix.includes(":") && !existingPosix.startsWith("/")
        ? `${testDirBase.replace(/\/+$/, "")}/${existingPosix.replace(/^\.\//, "")}`
        : existing;
      const relative = toWorkspaceRelative(candidate);
      if (!relative) return { runner: "ctest", unsupported: "ctest --output-junit points outside the runner-owned verification workspace." };
      return { runner: "ctest", format: "junit", reportPath: relative };
    }
    const reportPath = languageReportFileName(input.reportName, "junit");
    const absolute = `${asPosix(input.checkoutPath)}/${reportPath}`;
    return {
      runner: "ctest",
      format: "junit",
      reportPath,
      command: { ...input.command, args: [...args, "--output-junit", absolute] },
    };
  }

  if (name === "mvn") {
    return { runner: "maven test", format: "junit", reportSet: { kind: "maven-surefire-reports" } };
  }
  if (name === "gradle" || name === "gradlew") {
    return { runner: "gradle test", unsupported: "Gradle writes one JUnit XML per test class into test-results/test; no qualified report-set collector exists yet." };
  }
  if (name === "cargo") {
    return { runner: "cargo test", unsupported: "cargo test writes no JUnit report; only a project-configured junit reporter the runner cannot set would apply." };
  }
  if (name === "go" && args[0] === "test") {
    return { runner: "go test", unsupported: "the runner has no reader for go test output without a project-configured JUnit writer." };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Maven Surefire fresh report-set scan (F1, AR-R26).
// ---------------------------------------------------------------------------

/** Surefire writes per-module `target/surefire-reports/TEST-*.xml`. */
/** Directories the Surefire scan never descends into (build outputs stay searchable). */
const MAVEN_SCAN_SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".vs", ".vscode", ".idea",
  "node_modules", "packages", "__pycache__", ".venv", "venv", ".tox",
]);

export const MAVEN_SUREFIRE_REPORT_DIR = "surefire-reports";
/** Upper bound on fresh report files collected for one run. */
export const MAVEN_SUREFIRE_MAX_FILES = 256;
const MAVEN_SCAN_MAX_DEPTH = 6;
const MAVEN_SCAN_MAX_DIRS = 512;

export interface MavenSurefireFileState {
  size: number;
  mtimeMs: number;
}

export interface MavenSurefireScan {
  /**
   * Workspace-relative posix paths of fresh `*.xml` report files, sorted:
   * absent from `before`, or changed in size/mtime since. Empty unless
   * `before` is supplied (a pure snapshot otherwise).
   */
  fresh: string[];
  /** Full snapshot of every bounded report file seen (fresh plus stale). */
  snapshot: Map<string, MavenSurefireFileState>;
  /**
   * True when a bound stopped the scan (directory cap, depth cap, file
   * cap, or a readdir/stat failure), so an empty fresh set proves
   * nothing. Callers fail closed on incomplete.
   */
  incomplete: boolean;
}

/**
 * Scans per-module target surefire-reports XML files under the checkout with bounded,
 * symlink-blind traversal. Pass the pre-run snapshot as `before` after
 * the run: only new or changed files count as this invocation's reports,
 * so stale or preexisting files can never be mistaken for fresh
 * evidence. Reads no file contents; per-file bounded reads happen in the
 * caller through the shared confined report reader.
 */
export async function scanMavenSurefireReportFiles(input: {
  checkoutPath: string;
  before?: ReadonlyMap<string, MavenSurefireFileState>;
  readdir?: (path: string) => Promise<Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>>;
  stat?: (path: string) => Promise<{ size: number; mtimeMs: number; isRegularFile: boolean } | undefined>;
}): Promise<MavenSurefireScan> {
  const prefix = input.checkoutPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const readDirectory = input.readdir ?? (async (path: string) =>
    (await readdir(path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() })));
  const statPath = input.stat ?? (async (path: string) => {
    try {
      const st = await lstat(path);
      return { size: st.size, mtimeMs: st.mtimeMs, isRegularFile: !st.isSymbolicLink() && st.isFile() };
    } catch {
      return undefined;
    }
  });
  const snapshot = new Map<string, MavenSurefireFileState>();
  let incomplete = false;
  const queue: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
  let visitedDirs = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > MAVEN_SCAN_MAX_DEPTH) {
      incomplete = true;
      continue;
    }
    visitedDirs += 1;
    if (visitedDirs > MAVEN_SCAN_MAX_DIRS) {
      incomplete = true;
      break;
    }
    const absolute = current.relative ? `${prefix}/${current.relative}` : prefix;
    let entries: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
    try {
      entries = await readDirectory(absolute);
    } catch {
      incomplete = true;
      continue;
    }
    entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const inReportDir = current.relative.split("/").at(-1) === MAVEN_SUREFIRE_REPORT_DIR;
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      // A linked module/target/report directory can hide expected members.
      // Never follow it and never turn uncertain traversal into a partial set.
      if (entry.isSymbolicLink) {
        if (!MAVEN_SCAN_SKIP_DIRECTORIES.has(entry.name)) incomplete = true;
        continue;
      }
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (MAVEN_SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
        // A directory carrying an expected report name is not a readable
        // member: the set is incomplete, never partial.
        if (inReportDir) {
          if (/\.xml$/i.test(entry.name)) incomplete = true;
          continue;
        }
        if (current.depth < MAVEN_SCAN_MAX_DEPTH) {
          queue.push({ relative, depth: current.depth + 1 });
        } else {
          incomplete = true;
        }
        continue;
      }
      if (!inReportDir || !/\.xml$/i.test(entry.name)) continue;
      const state = await statPath(absolute === prefix ? `${prefix}/${relative}` : `${absolute}/${entry.name}`);
      if (!state || !state.isRegularFile) {
        // A non-regular *.xml where a report is expected (fifo, socket,
        // device, or a directory entry the platform reports as a file)
        // cannot carry this run's counts: the set is incomplete, never
        // partial. A stat failure stays incomplete as before.
        incomplete = true;
        continue;
      }
      if (snapshot.size >= MAVEN_SUREFIRE_MAX_FILES) {
        incomplete = true;
        continue;
      }
      snapshot.set(relative, { size: state.size, mtimeMs: state.mtimeMs });
    }
  }
  const fresh: string[] = [];
  if (input.before !== undefined) {
    for (const [relative, state] of [...snapshot.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const previous = input.before.get(relative);
      if (!previous || previous.size !== state.size || previous.mtimeMs !== state.mtimeMs) {
        if (fresh.length >= MAVEN_SUREFIRE_MAX_FILES) {
          incomplete = true;
          break;
        }
        fresh.push(relative);
      }
    }
  }
  return { fresh, snapshot, incomplete };
}
