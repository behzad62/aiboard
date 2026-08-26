import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import type { FinalVerificationDetectedSignal } from "./final-verification-contracts.js";
import type {
  FinalVerificationBrowserInput,
  FinalVerificationCommand,
  FinalVerificationRuntimeSmokeInput,
} from "./final-verification-runtime.js";
import { runGit, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import {
  FinalVerificationPortAuthority,
  type FinalVerificationPortLease,
} from "./final-verification-port-authority.js";

export type FinalVerificationPackageManager = "npm" | "pnpm" | "yarn";

export interface FinalVerificationDependencyProvisioning {
  manager: FinalVerificationPackageManager;
  lockfile: string;
  command: FinalVerificationCommand;
}

export interface FinalVerificationExecutionProfile {
  version: 1;
  targetRevision: string;
  inspectedPaths: string[];
  detectedSignals: FinalVerificationDetectedSignal[];
  commands: {
    build?: FinalVerificationCommand[];
    tests?: FinalVerificationCommand[];
  };
  provisioning?: FinalVerificationDependencyProvisioning;
  portLease?: FinalVerificationPortLease;
  runtimeSmoke?: FinalVerificationRuntimeSmokeInput;
  browser?: FinalVerificationBrowserInput;
}

interface FinalVerificationProfileArchive {
  version: 1;
  kind: "final-verification-execution-profile";
  runId: string;
  targetRevision: string;
  digest: string;
  profile: FinalVerificationExecutionProfile;
}

/** Runner-owned durable authority for exact-revision execution profiles. */
export class FinalVerificationProfileAuthority {
  private readonly stateDirectory: string;

  constructor(private readonly options: {
    stateDirectory: string;
    runId: string;
    portAuthority?: FinalVerificationPortAuthority;
  }) {
    this.stateDirectory = resolve(options.stateDirectory);
    if (!options.runId.trim()) throw new Error("Final verification profile authority requires a runId.");
  }

  async inspectAndPersist(input: {
    repositoryRoot: string;
    targetRevision: string;
    execute?: GitRunner;
  }): Promise<FinalVerificationExecutionProfile> {
    let newlyCreatedLease: FinalVerificationPortLease | undefined;
    try {
      const inspected = await inspectFinalVerificationExecutionProfile({
        ...input,
        ...(this.options.portAuthority ? {
          reservePort: async () => {
            const reservation = await this.options.portAuthority!.reserveDetailed(
              this.options.runId,
              input.targetRevision,
            );
            if (reservation.created) newlyCreatedLease = reservation.lease;
            return reservation.lease;
          },
        } : {}),
      });
      return await this.persistInspected(inspected);
    } catch (error) {
      if (newlyCreatedLease && this.options.portAuthority) {
        await this.options.portAuthority.release(
          newlyCreatedLease,
          this.options.runId,
          input.targetRevision,
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  private async persistInspected(
    profile: FinalVerificationExecutionProfile,
  ): Promise<FinalVerificationExecutionProfile> {
    const durable = cloneFinalVerificationExecutionProfile(profile);
    const digest = finalVerificationProfileDigest(this.options.runId, durable);
    const path = this.archivePath(digest);
    const archive: FinalVerificationProfileArchive = {
      version: 1,
      kind: "final-verification-execution-profile",
      runId: this.options.runId,
      targetRevision: durable.targetRevision,
      digest,
      profile: durable,
    };
    try {
      this.validate(durable, durable.targetRevision);
      return durable;
    } catch (error) {
      if (!isMissingArchiveError(error)) throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    try { await rename(temporary, path); }
    catch (error) {
      if (!fileExists(path)) throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    this.validate(durable, durable.targetRevision);
    return durable;
  }

  validate(profile: unknown, targetRevision: string): void {
    assertFinalVerificationExecutionProfile(profile, targetRevision);
    const durable = cloneFinalVerificationExecutionProfile(profile);
    if (this.options.portAuthority) {
      if ((durable.runtimeSmoke || durable.browser?.server) && !durable.portLease) {
        throw new Error("Runner-owned final verification port lease is required for a local application server.");
      }
      if (durable.portLease) {
        this.options.portAuthority.validateDurable(
          durable.portLease,
          this.options.runId,
          targetRevision,
        );
      }
    }
    const digest = finalVerificationProfileDigest(this.options.runId, durable);
    const path = this.archivePath(digest);
    let archive: unknown;
    try { archive = JSON.parse(readFileSync(path, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Runner-owned final verification execution profile archive is missing.", { cause: error });
      }
      throw new Error("Runner-owned final verification execution profile archive is invalid.", { cause: error });
    }
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
      throw new Error("Runner-owned final verification execution profile archive is malformed.");
    }
    const value = archive as Partial<FinalVerificationProfileArchive>;
    if (
      value.version !== 1 || value.kind !== "final-verification-execution-profile" ||
      value.runId !== this.options.runId || value.targetRevision !== targetRevision ||
      value.digest !== digest || stableJson(value.profile) !== stableJson(durable)
    ) {
      throw new Error("Runner-owned final verification execution profile archive conflicts with the scheduler event.");
    }
  }

  private archivePath(digest: string): string {
    return join(
      this.stateDirectory,
      "builds",
      safeSegment(this.options.runId),
      "audit",
      "final-verification-profiles",
      `${digest}.json`,
    );
  }
}

export function finalVerificationProfileDigest(
  runId: string,
  profile: FinalVerificationExecutionProfile,
): string {
  assertFinalVerificationExecutionProfile(profile, profile.targetRevision);
  return createHash("sha256")
    .update(stableJson({ runId, targetRevision: profile.targetRevision, profile }))
    .digest("hex");
}

export async function inspectFinalVerificationExecutionProfile(options: {
  repositoryRoot: string;
  targetRevision: string;
  execute?: GitRunner;
  reservePort?: () => Promise<FinalVerificationPortLease>;
}): Promise<FinalVerificationExecutionProfile> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const execute = options.execute ?? runGit;
  const git = async (args: readonly string[]) => await execute({ cwd: repositoryRoot, args } as GitCommandOptions);
  const [head, status] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD^{commit}"]),
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  if (head.stdout.trim() !== options.targetRevision) {
    throw new Error("Final verification inspection root is not at the exact integration revision.");
  }
  if (status.stdout.length > 0) {
    throw new Error("Final verification inspection root must be the clean runner-owned integration state.");
  }

  const packagePath = join(repositoryRoot, "package.json");
  let manifest: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("package.json must contain an object.");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const scripts = recordOfStrings(manifest?.scripts);
  const dependencies = {
    ...recordOfStrings(manifest?.dependencies),
    ...recordOfStrings(manifest?.devDependencies),
    ...recordOfStrings(manifest?.optionalDependencies),
  };
  const packageExecution = packageExecutionProfile(repositoryRoot, manifest, dependencies);
  const packageManager = packageExecution.invocation;
  const detectedSignals: FinalVerificationDetectedSignal[] = [];
  const commands: FinalVerificationExecutionProfile["commands"] = {};
  if (scripts.build) {
    detectedSignals.push({ category: "build", source: "package.json#scripts.build", detail: scripts.build });
    commands.build = [{ label: "package build", executable: packageManager.executable, args: [...packageManager.args, "run", "build"] }];
  }
  if (scripts.test) {
    detectedSignals.push({ category: "tests", source: "package.json#scripts.test", detail: scripts.test });
    commands.tests = [{ label: "package tests", executable: packageManager.executable, args: [...packageManager.args, "run", "test"] }];
  }

  const serverPortLease = serverSignal(scripts, dependencies)
    ? await (options.reservePort?.() ?? reserveUnownedPort(options.targetRevision))
    : undefined;
  const server = serverPortLease
    ? serverProfile(scripts, dependencies, packageManager, serverPortLease.port)
    : undefined;
  if (server) {
    detectedSignals.push({ category: "runtime_smoke", source: `package.json#scripts.${server.script}`, detail: scripts[server.script]! });
    detectedSignals.push({ category: "browser", source: "package.json and browser application signals", detail: `Serve the integrated UI with ${server.script}.` });
  }
  const profile: FinalVerificationExecutionProfile = {
    version: 1,
    targetRevision: options.targetRevision,
    inspectedPaths: manifest
      ? ["package.json", ...(packageExecution.lockfile ? [packageExecution.lockfile] : [])]
      : [],
    detectedSignals,
    commands,
    ...(packageExecution.provisioning ? { provisioning: packageExecution.provisioning } : {}),
    ...(serverPortLease ? { portLease: serverPortLease } : {}),
    ...(server ? {
      runtimeSmoke: server.smoke,
      browser: {
        label: "integrated application",
        url: server.smoke.endpoint!,
        timeoutMs: 120_000,
        policy: {
          consoleErrors: "fail",
          pageErrors: "fail",
          failedNetworkEvents: "fail",
        },
        server: server.smoke,
      },
    } : {}),
  };
  return cloneFinalVerificationExecutionProfile(profile);
}

export function cloneFinalVerificationExecutionProfile(
  profile: FinalVerificationExecutionProfile,
): FinalVerificationExecutionProfile {
  assertFinalVerificationExecutionProfile(profile, profile.targetRevision);
  return {
    version: 1,
    targetRevision: profile.targetRevision,
    inspectedPaths: [...profile.inspectedPaths],
    detectedSignals: profile.detectedSignals.map((signal) => ({ ...signal })),
    commands: {
      ...(profile.commands.build ? { build: profile.commands.build.map(cloneCommand) } : {}),
      ...(profile.commands.tests ? { tests: profile.commands.tests.map(cloneCommand) } : {}),
    },
    ...(profile.provisioning ? {
      provisioning: {
        ...profile.provisioning,
        command: cloneCommand(profile.provisioning.command),
      },
    } : {}),
    ...(profile.portLease ? { portLease: { ...profile.portLease } } : {}),
    ...(profile.runtimeSmoke ? { runtimeSmoke: cloneSmoke(profile.runtimeSmoke) } : {}),
    ...(profile.browser ? { browser: cloneBrowser(profile.browser) } : {}),
  };
}

export function assertFinalVerificationExecutionProfile(
  value: unknown,
  targetRevision: string,
): asserts value is FinalVerificationExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Final verification execution profile is required.");
  const profile = value as Partial<FinalVerificationExecutionProfile>;
  if (profile.version !== 1 || profile.targetRevision !== targetRevision) throw new Error("Final verification execution profile is stale or unsupported.");
  if (!Array.isArray(profile.inspectedPaths) || profile.inspectedPaths.some((path) => typeof path !== "string" || !path.trim())) throw new Error("Final verification execution profile inspected paths are invalid.");
  if (!Array.isArray(profile.detectedSignals) || profile.detectedSignals.some((signal) => !validSignal(signal))) throw new Error("Final verification execution profile signals are invalid.");
  if (!profile.commands || typeof profile.commands !== "object" || Array.isArray(profile.commands)) throw new Error("Final verification execution profile commands are invalid.");
  for (const [category, commands] of Object.entries(profile.commands)) {
    if (category !== "build" && category !== "tests") throw new Error(`Unsupported final verification execution command category ${category}.`);
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((command) => !validCommand(command))) throw new Error(`Final verification execution commands for ${category} are invalid.`);
  }
  if (profile.provisioning !== undefined && !validProvisioning(profile.provisioning)) {
    throw new Error("Final verification dependency provisioning profile is invalid.");
  }
  if (profile.portLease !== undefined && !validPortLease(profile.portLease, targetRevision)) {
    throw new Error("Final verification port lease profile is invalid.");
  }
  if (profile.runtimeSmoke !== undefined && !validSmoke(profile.runtimeSmoke)) throw new Error("Final verification runtime smoke profile is invalid.");
  if (profile.browser !== undefined && !validBrowser(profile.browser)) throw new Error("Final verification browser profile is invalid.");
  const detected = new Set(profile.detectedSignals.map((signal) => signal.category));
  if (detected.has("build") !== Boolean(profile.commands.build?.length)) throw new Error("Build signal and exact commands disagree.");
  if (detected.has("tests") !== Boolean(profile.commands.tests?.length)) throw new Error("Test signal and exact commands disagree.");
  if (detected.has("runtime_smoke") !== Boolean(profile.runtimeSmoke)) throw new Error("Runtime signal and exact smoke spec disagree.");
  if (detected.has("browser") !== Boolean(profile.browser)) throw new Error("Browser signal and exact browser spec disagree.");
  if (profile.portLease) {
    const smokeUrl = profile.runtimeSmoke?.endpoint ? new URL(profile.runtimeSmoke.endpoint) : undefined;
    const browserUrl = profile.browser?.server ? new URL(profile.browser.url) : undefined;
    if ((smokeUrl && (smokeUrl.hostname !== "127.0.0.1" || Number(smokeUrl.port) !== profile.portLease.port)) ||
      (browserUrl && (browserUrl.hostname !== "127.0.0.1" || Number(browserUrl.port) !== profile.portLease.port))) {
      throw new Error("Runtime/browser endpoints disagree with the owned port lease.");
    }
    if ((profile.runtimeSmoke && !profile.runtimeSmoke.args.includes(String(profile.portLease.port))) ||
      (profile.browser?.server && !profile.browser.server.args.includes(String(profile.portLease.port)))) {
      throw new Error("Runtime/browser argv disagree with the owned port lease.");
    }
  }
}

function npmInvocation(): { executable: string; args: string[] } {
  const npmCli = process.env.npm_execpath?.trim();
  if (npmCli && /(?:npm|npx)-cli\.js$/i.test(npmCli)) {
    if (!existsSync(resolve(npmCli))) throw new Error("Declared npm package manager is unavailable to Runner V2.");
    return { executable: process.execPath, args: [resolve(npmCli)] };
  }
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(bundled)) throw new Error("Declared npm package manager is unavailable to Runner V2.");
  return {
    executable: process.execPath,
    args: [bundled],
  };
}

function packageManagerInvocation(manager: FinalVerificationPackageManager): {
  executable: string;
  args: string[];
} {
  if (manager === "npm") return npmInvocation();
  const activeCli = process.env.npm_execpath?.trim();
  if (activeCli) {
    const activeName = basename(activeCli).toLowerCase();
    if (activeName === manager || activeName === `${manager}.js` || activeName === `${manager}.cjs`) {
      if (!existsSync(resolve(activeCli))) {
        throw new Error(`Declared ${manager} package manager is unavailable to Runner V2.`);
      }
      return { executable: process.execPath, args: [resolve(activeCli)] };
    }
  }
  const corepackCli = join(dirname(process.execPath), "node_modules", "corepack", "dist", `${manager}.js`);
  if (!existsSync(corepackCli)) {
    throw new Error(`Declared ${manager} package manager is unavailable to Runner V2.`);
  }
  return { executable: process.execPath, args: [corepackCli] };
}

function packageExecutionProfile(
  repositoryRoot: string,
  manifest: Record<string, unknown> | undefined,
  dependencies: Record<string, string>,
): {
  invocation: { executable: string; args: string[] };
  lockfile?: string;
  provisioning?: FinalVerificationDependencyProvisioning;
} {
  const declared = declaredPackageManager(manifest?.packageManager);
  const locks = [
    ["npm-shrinkwrap.json", "npm"],
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const;
  const present = locks.filter(([name]) => existsSync(join(repositoryRoot, name)));
  const managers = new Set(present.map(([, manager]) => manager));
  if (managers.size > 1) {
    throw new Error("Final verification found conflicting package-manager lockfiles.");
  }
  const lockedManager = present[0]?.[1];
  if (declared && lockedManager && declared.name !== lockedManager) {
    throw new Error("packageManager and lockfile disagree; final verification refuses to guess.");
  }
  const manager = declared?.name ?? lockedManager ?? "npm";
  const invocation = packageManagerInvocation(manager);
  if (Object.keys(dependencies).length === 0 && present.length === 0) return { invocation };
  const lockfile = preferredLockfile(present, manager);
  if (!lockfile) {
    throw new Error("Dependency provisioning requires one matching lockfile at the exact integration revision.");
  }
  const installArgs = manager === "npm"
    ? ["ci", "--no-audit", "--no-fund"]
    : manager === "pnpm"
      ? ["install", "--frozen-lockfile"]
      : declared && declared.major >= 2
        ? ["install", "--immutable"]
        : ["install", "--frozen-lockfile"];
  return {
    invocation,
    lockfile,
    provisioning: {
      manager,
      lockfile,
      command: {
        label: `${manager} dependency provisioning`,
        executable: invocation.executable,
        args: [...invocation.args, ...installArgs],
        timeoutMs: 600_000,
      },
    },
  };
}

function declaredPackageManager(value: unknown): {
  name: FinalVerificationPackageManager;
  major: number;
} | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("packageManager must be a supported name and version.");
  const match = /^(npm|pnpm|yarn)@(\d+)(?:\.|$)/.exec(value.trim());
  if (!match) throw new Error(`Unsupported or malformed packageManager ${JSON.stringify(value)}.`);
  return { name: match[1] as FinalVerificationPackageManager, major: Number(match[2]) };
}

function preferredLockfile(
  present: readonly (readonly [string, FinalVerificationPackageManager])[],
  manager: FinalVerificationPackageManager,
): string | undefined {
  const names = present.filter(([, candidate]) => candidate === manager).map(([name]) => name);
  if (manager === "npm" && names.includes("npm-shrinkwrap.json")) return "npm-shrinkwrap.json";
  return names[0];
}

async function reserveUnownedPort(targetRevision: string): Promise<FinalVerificationPortLease> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a final verification port.");
  return {
    version: 1,
    runId: `standalone-${createHash("sha256").update(targetRevision).digest("hex").slice(0, 16)}`,
    targetRevision,
    port: address.port,
    leaseId: randomUUID(),
  };
}

function serverProfile(
  scripts: Record<string, string>,
  dependencies: Record<string, string>,
  packageManager: { executable: string; args: string[] },
  port: number,
): { script: string; smoke: FinalVerificationRuntimeSmokeInput } | undefined {
  const endpoint = `http://127.0.0.1:${port}/`;
  if (scripts.preview && dependencies.vite) {
    return {
      script: "preview",
      smoke: {
        label: "package preview",
        executable: packageManager.executable,
        args: [...packageManager.args, "run", "preview", "--", "--host", "127.0.0.1", "--port", String(port)],
        endpoint,
        timeoutMs: 120_000,
        readiness: { timeoutMs: 120_000, pollIntervalMs: 100, expectedStatus: 200 },
      },
    };
  }
  if (scripts.start && dependencies.next) {
    return {
      script: "start",
      smoke: {
        label: "package start",
        executable: packageManager.executable,
        args: [...packageManager.args, "run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)],
        endpoint,
        timeoutMs: 120_000,
        readiness: { timeoutMs: 120_000, pollIntervalMs: 100, expectedStatus: 200 },
      },
    };
  }
  return undefined;
}

function serverSignal(scripts: Record<string, string>, dependencies: Record<string, string>): boolean {
  return Boolean((scripts.preview && dependencies.vite) || (scripts.start && dependencies.next));
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function validSignal(value: unknown): value is FinalVerificationDetectedSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signal = value as Record<string, unknown>;
  return (signal.category === "build" || signal.category === "tests" || signal.category === "runtime_smoke" || signal.category === "browser") &&
    (signal.source === undefined || (typeof signal.source === "string" && signal.source.trim().length > 0)) &&
    (signal.detail === undefined || (typeof signal.detail === "string" && signal.detail.trim().length > 0));
}
function validCommand(value: unknown): value is FinalVerificationCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return typeof command.label === "string" && command.label.trim().length > 0 &&
    typeof command.executable === "string" && command.executable.trim().length > 0 &&
    Array.isArray(command.args) && command.args.every((arg) => typeof arg === "string") &&
    (command.timeoutMs === undefined || (Number.isSafeInteger(command.timeoutMs) && (command.timeoutMs as number) > 0));
}
function validSmoke(value: unknown): value is FinalVerificationRuntimeSmokeInput {
  if (!validCommand(value)) return false;
  const smoke = value as unknown as Record<string, unknown>;
  if (!smoke.readiness || typeof smoke.readiness !== "object" || Array.isArray(smoke.readiness)) return false;
  if (typeof (smoke.readiness as Record<string, unknown>).healthCheck === "function" ||
    typeof smoke.releasePort === "function") return false;
  if (typeof smoke.endpoint !== "string") return false;
  try { const url = new URL(smoke.endpoint); return url.protocol === "http:" || url.protocol === "https:"; }
  catch { return false; }
}
function validBrowser(value: unknown): value is FinalVerificationBrowserInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const browser = value as Record<string, unknown>;
  if (typeof browser.label !== "string" || !browser.label.trim() || typeof browser.url !== "string") return false;
  try { const url = new URL(browser.url); if (url.protocol !== "http:" && url.protocol !== "https:") return false; }
  catch { return false; }
  return Boolean(browser.policy && typeof browser.policy === "object" && !Array.isArray(browser.policy)) &&
    (browser.server === undefined || validSmoke(browser.server));
}
function validProvisioning(value: unknown): value is FinalVerificationDependencyProvisioning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provisioning = value as Record<string, unknown>;
  return (provisioning.manager === "npm" || provisioning.manager === "pnpm" || provisioning.manager === "yarn") &&
    typeof provisioning.lockfile === "string" && Boolean(provisioning.lockfile.trim()) &&
    validCommand(provisioning.command);
}
function validPortLease(value: unknown, targetRevision: string): value is FinalVerificationPortLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return lease.version === 1 && typeof lease.runId === "string" && Boolean(lease.runId.trim()) &&
    lease.targetRevision === targetRevision && Number.isSafeInteger(lease.port) &&
    (lease.port as number) >= 1_024 && (lease.port as number) <= 65_535 &&
    typeof lease.leaseId === "string" && Boolean(lease.leaseId.trim());
}
function cloneCommand(command: FinalVerificationCommand): FinalVerificationCommand { return { ...command, args: [...command.args] }; }
function cloneSmoke(smoke: FinalVerificationRuntimeSmokeInput): FinalVerificationRuntimeSmokeInput {
  return { ...smoke, args: [...smoke.args], readiness: { ...smoke.readiness } };
}
function cloneBrowser(browser: FinalVerificationBrowserInput): FinalVerificationBrowserInput {
  return {
    ...browser,
    policy: {
      ...browser.policy,
      ...(browser.policy.allowedConsoleErrorPatterns ? { allowedConsoleErrorPatterns: [...browser.policy.allowedConsoleErrorPatterns] } : {}),
      ...(browser.policy.allowedPageErrorPatterns ? { allowedPageErrorPatterns: [...browser.policy.allowedPageErrorPatterns] } : {}),
      ...(browser.policy.allowedNetworkFailurePatterns ? { allowedNetworkFailurePatterns: [...browser.policy.allowedNetworkFailurePatterns] } : {}),
    },
    ...(browser.server ? { server: cloneSmoke(browser.server) } : {}),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function fileExists(path: string): boolean { return existsSync(path); }
function isMissingArchiveError(error: unknown): boolean {
  return error instanceof Error && /profile archive is missing/i.test(error.message);
}
