import { realpathSync, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isSensitiveKey } from "./sensitive-redaction.js";

export interface RunnerOwnedChildEnvironmentCredentialGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly expiresAt?: string;
  readonly names: readonly string[];
  /** Runner-private values; never present in a caller-facing type. */
  readonly values: Readonly<Record<string, string>>;
}

/** Runner-owned storage must atomically mark an id consumed before returning it. */
export interface RunnerOwnedChildEnvironmentCredentialResolver {
  consume(grantId: string): RunnerOwnedChildEnvironmentCredentialGrant;
}

export type ChildEnvironmentDecision =
  | { readonly kind: "removed_runner_path"; readonly name: string; readonly count: number }
  /** R3: Windows packaged-program alias folders (WindowsApps) taken off the child's PATH. */
  | { readonly kind: "removed_packaged_alias_path"; readonly name: string; readonly count: number }
  | { readonly kind: "removed_ambient"; readonly name: string }
  | { readonly kind: "removed_explicit"; readonly name: string }
  | { readonly kind: "applied_explicit"; readonly name: string }
  | { readonly kind: "rejected_explicit"; readonly name: string }
  | { readonly kind: "granted_credential"; readonly name: string }
  | { readonly kind: "applied_runner"; readonly name: string };

export interface ChildEnvironmentAudit {
  readonly inheritedNames: readonly string[];
  readonly removedNames: readonly string[];
  readonly explicitSafeNames: readonly string[];
  readonly grantedNames: readonly string[];
  readonly decisions: readonly ChildEnvironmentDecision[];
}

export interface PrepareChildEnvironmentInput {
  readonly workingDirectory?: string;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly explicitOverrides?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  /** The owning agent session; with runId it selects the Runner's own per-owner values (processEnvironment). */
  readonly sessionId?: string;
  readonly invocationId?: string;
  /** Caller-visible opaque id only; all authority is loaded from Runner storage. */
  readonly credentialGrantId?: string;
}

/**
 * VF7b: values the Runner itself sets for every process it starts for one owner (the Playwright CLI
 * session's name and state folders), and folders it puts first on PATH (the playwright-cli shims).
 * Runner authority: applied after the caller's overrides, and the PATH entries after the install-root filter.
 */
export interface RunnerProcessEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly pathPrepend: readonly string[];
  /**
   * CW5 (CLI workers plan §3.11): the `AIBOARD_MCP_DEPTH` every process of this owner gets, when it is above the
   * Runner's own next depth; never lower. A CLI worker's owner gets LOCAL_MCP_DEPTH_LIMIT, so an `aiboard mcp serve`
   * or `aiboard exec` the CLI starts refuses by depth.
   */
  readonly mcpDepth?: number;
}
export type RunnerProcessEnvironmentResolver = (owner: { readonly runId: string; readonly sessionId: string }) => RunnerProcessEnvironment | undefined;

/**
 * Several per-owner sources as one (the Playwright CLI session's values, a CLI worker's depth). Values and PATH
 * entries are merged in order; a name two sources set to different values is refused, and the depth is the highest.
 */
export function composeRunnerProcessEnvironments(...resolvers: readonly (RunnerProcessEnvironmentResolver | undefined)[]): RunnerProcessEnvironmentResolver | undefined {
  const present = resolvers.filter((resolver): resolver is RunnerProcessEnvironmentResolver => resolver !== undefined);
  if (present.length <= 1) return present[0];
  return (owner) => {
    const found = present.map((resolver) => resolver(owner)).filter((entry): entry is RunnerProcessEnvironment => entry !== undefined);
    if (found.length <= 1) return found[0];
    const values: Record<string, string> = {};
    // Windows environment names are case-insensitive: two spellings of one name are one name, and are refused.
    const spelled = new Map<string, string>();
    for (const entry of found) {
      for (const [name, value] of Object.entries(entry.values)) {
        const earlier = spelled.get(name.toUpperCase());
        if (earlier !== undefined && (earlier !== name || values[earlier] !== value)) throw new Error("Runner process environment is invalid.");
        spelled.set(name.toUpperCase(), name);
        values[name] = value;
      }
    }
    const depths = found.map((entry) => entry.mcpDepth).filter((depth): depth is number => depth !== undefined);
    return Object.freeze({
      values: Object.freeze(values),
      pathPrepend: Object.freeze(found.flatMap((entry) => entry.pathPrepend)),
      ...(depths.length > 0 ? { mcpDepth: Math.max(...depths) } : {}),
    });
  };
}

/** Opaque capability valid only in the factory closure that issued it. */
export interface ChildEnvironmentCapability { readonly _opaque?: never }

export interface PreparedChildEnvironment {
  readonly capability: ChildEnvironmentCapability;
  readonly audit: ChildEnvironmentAudit;
}

export interface ChildEnvironmentFactory {
  prepare(input: PrepareChildEnvironmentInput): PreparedChildEnvironment;
  /**
   * `rootProgramEnvironment` is the environment the launch's own program is looked up in (R3): the child's, except that
   * its PATH keeps the WindowsApps folders the child's PATH lost, in their places, so an installed Store program
   * (pwsh, python3, winget) is still found and pinned to its package's own program, started as the Job's root. It is
   * never a child's environment.
   */
  withChildEnvironment<T>(
    capability: ChildEnvironmentCapability,
    trustedSpawn: (environment: Readonly<Record<string, string>>, rootProgramEnvironment?: Readonly<Record<string, string>>) => T,
  ): T;
}

export interface CreateChildEnvironmentFactoryOptions {
  readonly credentialResolver: RunnerOwnedChildEnvironmentCredentialResolver;
  readonly now?: () => Date;
  readonly runnerInstallRoot?: string;
  /** Trusted next depth for a bound local MCP session. */
  readonly mcpChildDepth?: number;
  /** VF7b: the Runner's per-owner values; consulted only when a prepare names both runId and sessionId. */
  readonly processEnvironment?: RunnerProcessEnvironmentResolver;
  /** The platform whose PATH rules apply (R3 removes WindowsApps folders on win32). Defaults to this process's. */
  readonly platform?: NodeJS.Platform;
}

export const LOCAL_MCP_DEPTH_LIMIT = 2;

export function parseMcpDepth(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]{0,5})$/.test(value)) throw new Error("Invalid AIBOARD_MCP_DEPTH.");
  return Number(value);
}

interface EnvironmentEntry { readonly name: string; readonly value: string }
interface PrepareChildEnvironmentSnapshot {
  readonly workingDirectory?: string;
  readonly ambient: Readonly<Record<string, string | undefined>>;
  readonly explicitOverrides?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly invocationId?: string;
  readonly credentialGrantId?: string;
}

/**
 * Runner wires this factory once with private, atomically-consuming grant
 * storage. Per-call input can name a grant but cannot supply its authority.
 */
export function createChildEnvironmentFactory(
  options: CreateChildEnvironmentFactoryOptions,
): ChildEnvironmentFactory {
  const environments = new WeakMap<object, Readonly<Record<string, string>>>();
  const rootProgramEnvironments = new WeakMap<object, Readonly<Record<string, string>>>();
  const redeemedGrantIds = new Set<string>();
  const now = options.now ?? (() => new Date());
  const mcpChildDepth = options.mcpChildDepth ?? parseMcpDepth(process.env.AIBOARD_MCP_DEPTH) + 1;
  if (!Number.isSafeInteger(mcpChildDepth) || mcpChildDepth < 1 || mcpChildDepth > 1_000_000) throw new Error("Invalid child MCP depth.");
  const installRoots = runnerInstallRoots(options.runnerInstallRoot);
  const platform = options.platform ?? process.platform;

  return Object.freeze({
    prepare(input: PrepareChildEnvironmentInput): PreparedChildEnvironment {
      const request = snapshotPrepareChildEnvironmentInput(input);
      const environment = new Map<string, EnvironmentEntry>();
      const removedNames: string[] = [];
      const explicitSafeNames: string[] = [];
      const grantedNames: string[] = [];
      const decisions: ChildEnvironmentDecision[] = [];

      for (const [name, value] of sortedEntries(request.ambient)) {
        if (value === undefined) continue;
        assertEnvironmentEntry(name, value);
        if (isForbiddenChildEnvironmentName(name)) {
          removedNames.push(name);
          decisions.push({ kind: "removed_ambient", name });
        } else setEnvironment(environment, name, value);
      }
      const inheritedNames = names(environment);

      for (const [name, value] of sortedEntries(request.explicitOverrides ?? {})) {
        if (value === undefined) {
          if (!isEnvironmentName(name)) throw new Error("Child environment input is invalid.");
          const inherited = environment.get(canonicalName(name));
          if (inherited) {
            environment.delete(canonicalName(name));
            removedNames.push(inherited.name);
          }
          decisions.push({ kind: "removed_explicit", name });
          continue;
        }
        assertEnvironmentEntry(name, value);
        if (isForbiddenChildEnvironmentName(name)) decisions.push({ kind: "rejected_explicit", name });
        else {
          setEnvironment(environment, name, value);
          explicitSafeNames.push(name);
          decisions.push({ kind: "applied_explicit", name });
        }
      }

      if (request.credentialGrantId !== undefined) {
        reserveCredentialGrantId(request.credentialGrantId, redeemedGrantIds);
        const grant = consumeAndValidateGrant(options.credentialResolver, request, now);
        for (const name of grant.names) {
          setEnvironment(environment, name, grant.values.get(canonicalName(name))!);
          grantedNames.push(name);
          decisions.push({ kind: "granted_credential", name });
        }
      }

      const runner = nonEmpty(request.runId) && nonEmpty(request.sessionId)
        ? options.processEnvironment?.({ runId: request.runId, sessionId: request.sessionId })
        : undefined;
      const ownerDepth = runner?.mcpDepth;
      if (ownerDepth !== undefined && (!Number.isSafeInteger(ownerDepth) || ownerDepth < 1 || ownerDepth > 1_000_000)) {
        throw new Error("Runner process environment is invalid.");
      }
      // This is Runner authority, never a caller-controlled environment override. An owner's depth only raises it.
      setEnvironment(environment, "AIBOARD_MCP_DEPTH", String(Math.max(mcpChildDepth, ownerDepth ?? 0)));
      for (const [name, value] of sortedEntries(runner?.values ?? {})) {
        if (value === undefined) continue;
        assertEnvironmentEntry(name, value);
        if (canonicalName(name) === "PATH" || isForbiddenChildEnvironmentName(name)) throw new Error("Runner process environment is invalid.");
        setEnvironment(environment, name, value);
        decisions.push({ kind: "applied_runner", name });
      }
      const path = environment.get("PATH");
      // R3: the PATH the launch's own program is looked up in keeps the WindowsApps entries the child's PATH loses.
      let rootProgramPath: string | undefined;
      if (path) {
        const entries = path.value.split(delimiter);
        const { outsideInstall, retained } = filterPathEntries(entries, installRoots, request.workingDirectory, platform);
        if (retained.length !== entries.length) setEnvironment(environment, path.name, retained.join(delimiter));
        if (outsideInstall.length !== entries.length) decisions.push({ kind: "removed_runner_path", name: path.name, count: entries.length - outsideInstall.length });
        if (retained.length !== outsideInstall.length) {
          decisions.push({ kind: "removed_packaged_alias_path", name: path.name, count: outsideInstall.length - retained.length });
          rootProgramPath = outsideInstall.join(delimiter);
        }
      }
      const prepend = runner?.pathPrepend ?? [];
      if (prepend.some((entry) => typeof entry !== "string" || !isAbsolute(entry) || entry.includes(delimiter))) {
        throw new Error("Runner process environment is invalid.");
      }
      if (prepend.length > 0) {
        const current = environment.get("PATH");
        const name = current?.name ?? (process.platform === "win32" ? "Path" : "PATH");
        setEnvironment(environment, name, [...prepend, ...(current?.value ? [current.value] : [])].join(delimiter));
        if (rootProgramPath !== undefined) rootProgramPath = [...prepend, ...(rootProgramPath ? [rootProgramPath] : [])].join(delimiter);
        decisions.push({ kind: "applied_runner", name });
      }
      const capability = Object.freeze({}) as ChildEnvironmentCapability;
      const raw = createRawEnvironment(environment);
      environments.set(capability, raw);
      if (rootProgramPath !== undefined) {
        const pathName = environment.get("PATH")!.name;
        rootProgramEnvironments.set(capability, Object.freeze({ ...raw, [pathName]: rootProgramPath }));
      }
      return Object.freeze({
        capability,
        audit: freezeAudit(inheritedNames, removedNames, explicitSafeNames, grantedNames, decisions),
      });
    },

    withChildEnvironment<T>(
      capability: ChildEnvironmentCapability,
      trustedSpawn: (environment: Readonly<Record<string, string>>, rootProgramEnvironment?: Readonly<Record<string, string>>) => T,
    ): T {
      if (!capability || typeof capability !== "object") throw invalidGrant();
      const environment = environments.get(capability);
      if (!environment) throw invalidGrant();
      environments.delete(capability);
      const rootProgramEnvironment = rootProgramEnvironments.get(capability) ?? environment;
      rootProgramEnvironments.delete(capability);
      return trustedSpawn(environment, rootProgramEnvironment);
    },
  });
}

function snapshotPrepareChildEnvironmentInput(
  input: PrepareChildEnvironmentInput,
): PrepareChildEnvironmentSnapshot {
  return Object.freeze({
    workingDirectory: input.workingDirectory,
    ambient: input.ambient,
    explicitOverrides: input.explicitOverrides,
    runId: input.runId,
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    credentialGrantId: input.credentialGrantId,
  });
}

function reserveCredentialGrantId(grantId: string, redeemedGrantIds: Set<string>): void {
  if (!nonEmpty(grantId)) throw invalidGrant();
  const canonical = grantId.trim().toUpperCase();
  if (redeemedGrantIds.has(canonical)) throw consumedGrant();
  redeemedGrantIds.add(canonical);
}

function consumeAndValidateGrant(
  resolver: RunnerOwnedChildEnvironmentCredentialResolver,
  input: PrepareChildEnvironmentSnapshot,
  now: () => Date,
): { names: readonly string[]; values: ReadonlyMap<string, string> } {
  if (!nonEmpty(input.credentialGrantId)) throw invalidGrant();
  let grant: RunnerOwnedChildEnvironmentCredentialGrant;
  try { grant = resolver.consume(input.credentialGrantId); }
  catch { throw consumedGrant(); }
  try {
    if (!grant || typeof grant !== "object" || grant.grantId !== input.credentialGrantId) throw invalidGrant();
    if (!nonEmpty(input.runId) || grant.runId !== input.runId) throw invalidGrant();
    if (!nonEmpty(input.invocationId) || grant.invocationId !== input.invocationId) throw invalidGrant();
    if (grant.expiresAt !== undefined && (!nonEmpty(grant.expiresAt) || Number.isNaN(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now().getTime())) throw invalidGrant();
    if (!Array.isArray(grant.names) || grant.names.length === 0 || !grant.values || typeof grant.values !== "object") throw invalidGrant();
    const names = new Set<string>();
    for (const name of grant.names) {
      if (!isCredentialGrantName(name) || names.has(canonicalName(name))) throw invalidGrant();
      names.add(canonicalName(name));
    }
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(grant.values)) {
      if (!isEnvironmentName(name) || typeof value !== "string" || values.has(canonicalName(name))) throw invalidGrant();
      values.set(canonicalName(name), value);
    }
    if (values.size !== names.size || [...names].some((name) => !values.has(name))) throw invalidGrant();
    return { names: Object.freeze([...grant.names]), values };
  } catch (error) {
    if (error instanceof Error && error.message === "Child environment credential grant is invalid.") throw error;
    throw invalidGrant();
  }
}

function createRawEnvironment(environment: Map<string, EnvironmentEntry>): Readonly<Record<string, string>> {
  const raw = Object.create(null) as Record<string, string>;
  for (const { name, value } of environment.values()) raw[name] = value;
  return Object.freeze(raw);
}

function freezeAudit(
  inheritedNames: readonly string[], removedNames: readonly string[], explicitSafeNames: readonly string[],
  grantedNames: readonly string[], decisions: readonly ChildEnvironmentDecision[],
): ChildEnvironmentAudit {
  return Object.freeze({
    inheritedNames: Object.freeze(sortNames(inheritedNames)),
    removedNames: Object.freeze(sortNames(removedNames)),
    explicitSafeNames: Object.freeze(sortNames(explicitSafeNames)),
    grantedNames: Object.freeze(sortNames(grantedNames)),
    decisions: Object.freeze(decisions.map((decision) => Object.freeze({ ...decision }))),
  });
}

function isCredentialGrantName(name: string): boolean {
  return isEnvironmentName(name) && isSensitiveKey(name) && !isRunnerName(name) && canonicalName(name) !== "AIBOARD_MCP_DEPTH" && !canonicalName(name).startsWith("NPM_") && canonicalName(name) !== "INIT_CWD" && !isNodeTestRunnerInternalName(name);
}

function isForbiddenChildEnvironmentName(name: string): boolean {
  const canonical = canonicalName(name);
  return isSensitiveKey(name) || isRunnerName(name) || canonical === "AIBOARD_MCP_DEPTH" || canonical.startsWith("NPM_") || canonical === "INIT_CWD" || isNodeTestRunnerInternalName(name);
}

/**
 * Node's test runner marks its children with these coordination variables
 * (runner.js sets NODE_TEST_CONTEXT=child-v8 and NODE_TEST_WORKER_ID per
 * worker). A nested `node --test` inheriting them believes it is a reporter
 * child and misbehaves, so user/project subprocesses must never inherit them.
 */
function isNodeTestRunnerInternalName(name: string): boolean {
  const canonical = canonicalName(name);
  return canonical === "NODE_TEST_CONTEXT" || canonical === "NODE_TEST_WORKER_ID";
}

function isRunnerName(name: string): boolean {
  const canonical = canonicalName(name);
  return canonical.startsWith("RUNNER_") || canonical.startsWith("AIBOARD_RUNNER_");
}

function sortedEntries(source: Readonly<Record<string, string | undefined>>): Array<[string, string | undefined]> {
  return Object.entries(source).sort(([left], [right]) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function setEnvironment(target: Map<string, EnvironmentEntry>, name: string, value: string): void {
  target.set(canonicalName(name), { name, value });
}

function names(target: Map<string, EnvironmentEntry>): string[] {
  return [...target.values()].map(({ name }) => name);
}

function assertEnvironmentEntry(name: string, value: string): void {
  if (!isEnvironmentName(name) || typeof value !== "string") throw new Error("Child environment input is invalid.");
}

function isEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function canonicalName(name: string): string { return name.toUpperCase(); }

function sortNames(values: readonly string[]): string[] {
  return [...values].sort((left, right) => canonicalName(left).localeCompare(canonicalName(right)) || left.localeCompare(right));
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function invalidGrant(): Error { return new Error("Child environment credential grant is invalid."); }
function consumedGrant(): Error { return new Error("Child environment credential grant could not be consumed."); }

/** The Runner's installation and its node_modules: a launch removes every PATH entry inside them. */
function runnerInstallRoots(runnerInstallRoot?: string): string[] {
  const installRoot = canonicalPath(runnerInstallRoot ?? defaultRunnerInstallRoot());
  return [installRoot, canonicalPath(resolve(installRoot, "node_modules"))];
}

/**
 * VF4b: the PATH a launch in `workingDirectory` searches before the owner's folders are put first: the same entries
 * `prepare` keeps (outside the Runner's own installation and, on Windows, outside WindowsApps), so a check's tool
 * lookup never finds a tool the launch cannot find.
 */
export function withoutRunnerInstallPath(path: string, options: {
  readonly workingDirectory?: string; readonly runnerInstallRoot?: string; readonly delimiter?: string; readonly platform?: NodeJS.Platform;
  /** "root_program": the PATH a launch's own program is looked up in, which keeps the WindowsApps folders (R3). */
  readonly purpose?: "child" | "root_program";
} = {}): string {
  const separator = options.delimiter ?? delimiter;
  const installRoots = runnerInstallRoots(options.runnerInstallRoot);
  const { outsideInstall, retained } = filterPathEntries(path.split(separator), installRoots, options.workingDirectory, options.platform ?? process.platform);
  return (options.purpose === "root_program" ? outsideInstall : retained).join(separator);
}

/** Both PATH filters with each entry's real path resolved once: the Runner's installation, then WindowsApps (win32). */
function filterPathEntries(entries: readonly string[], installRoots: readonly string[], workingDirectory: string | undefined, platform: NodeJS.Platform): { outsideInstall: string[]; retained: string[] } {
  const outsideInstall: string[] = [], retained: string[] = [];
  for (const entry of entries) {
    const candidate = pathEntryCandidate(entry, workingDirectory);
    if (candidate !== undefined && installRoots.some((root) => insideInstall(root, candidate))) continue;
    outsideInstall.push(entry);
    if (platform === "win32" && (isWindowsAppsPathEntry(entry) || (candidate !== undefined && isWindowsAppsPathEntry(candidate)))) continue;
    retained.push(entry);
  }
  return { outsideInstall, retained };
}

/**
 * R3: a Windows folder of packaged (MSIX / Microsoft Store) programs: %LOCALAPPDATA%\Microsoft\WindowsApps, which holds
 * the app execution aliases (pwsh.exe, python3.exe, py.exe, ...), its per-package folders, and the packages' own install
 * folders (%ProgramFiles%\WindowsApps\<package>, which a Store pwsh puts on its children's PATH). A program started from
 * any of them runs packaged, and Windows creates a packaged program's children outside the Runner's Job unless the program
 * is the Job's root (PR #167; measured 2026-11-18: the Store pwsh has its package identity whether CreateProcess names
 * the alias or the package's own pwsh.exe). So a managed child's PATH never holds them, and `pwsh`, `python3` or `py`
 * typed in a worker's shell does not resolve to a packaged program. This is defense in depth, not proof: an explicit
 * path still starts one, and the Job host's membership watch (managed-process-job-host.ps1) is what keeps the stop
 * honest. The Runner's own shells are found from its own PATH (shell-inventory.ts) and started as the Job's root.
 */
export function isWindowsAppsPathEntry(entry: string): boolean {
  const value = normalizeWindowsPathEntry(entry);
  // Anchored to the folders Windows uses, never any folder that happens to be named WindowsApps: a user's
  // %LOCALAPPDATA%\Microsoft\WindowsApps (as the Runner sees it, and under any profile), the Program Files package root,
  // and a package's folder on another volume's package root (<drive>:\WindowsApps\<Name>_<Version>_<Arch>_<Res>_<PublisherId>).
  const localAppData = process.env.LOCALAPPDATA ? normalizeWindowsPathEntry(process.env.LOCALAPPDATA) : undefined;
  if (localAppData && (value === `${localAppData}\\microsoft\\windowsapps` || value.startsWith(`${localAppData}\\microsoft\\windowsapps\\`))) return true;
  // A drive, a UNC share, or a driveless rooted path (the current drive's root).
  const root = String.raw`^(?:[a-z]:|\\\\[^\\]+\\[^\\]+)?`;
  return new RegExp(`${root}\\\\users\\\\[^\\\\]+\\\\appdata\\\\local\\\\microsoft\\\\windowsapps(?:\\\\|$)`, "u").test(value) ||
    new RegExp(`${root}\\\\program files\\\\windowsapps(?:\\\\|$)`, "u").test(value) ||
    new RegExp(`${root}\\\\windowsapps\\\\[^\\\\]+_[a-z0-9]{13}(?:\\\\|$)`, "u").test(value);
}

function normalizeWindowsPathEntry(entry: string): string {
  return entry.trim().replace(/^"(.*)"$/u, "$1").replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
}

function defaultRunnerInstallRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  // Source and packaged entry points find the nearest package installation.
  while (dirname(directory) !== directory) {
    if (existsSync(resolve(directory, "node_modules"))) return directory;
    directory = dirname(directory);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch { return absolute; }
}
/** The canonical path a PATH entry names, resolved once per entry; undefined when a relative entry has no directory to resolve against. */
function pathEntryCandidate(entry: string, workingDirectory?: string): string | undefined {
  const value = entry.trim().replace(/^"(.*)"$/, "$1");
  if (!isAbsolute(value) && !workingDirectory) return undefined;
  return canonicalPath(isAbsolute(value) ? value : resolve(workingDirectory!, value));
}
function insideInstall(root: string, candidate: string): boolean {
  const fold = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const traversal = relative(fold(root), fold(candidate));
  return traversal === "" || (traversal !== ".." && !traversal.startsWith(`..${sep}`) && !isAbsolute(traversal));
}
