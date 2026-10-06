import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import { FINAL_VERIFICATION_CATEGORIES, type FinalVerificationDetectedSignal, type FinalVerificationPlanPrefill } from "./final-verification-contracts.js";
import { detectLanguageFamilies, languageReportDescriptors, listLanguageInventoryFiles } from "./language-execution-profile.js";
import { assertFinalVerificationBrowserPolicy } from "./final-verification-browser-policy.js";
import type {
  FinalVerificationBrowserInput,
  FinalVerificationCommand,
  FinalVerificationRuntimeSmokeInput,
} from "./final-verification-runtime.js";
import { unavailableGitRunner, type GitCommandOptions } from "./git-command.js";
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

export interface FinalVerificationReportDescriptor {
  /** Exact label of the `commands.tests` entry this report belongs to. */
  commandLabel: string;
  /** Wired test runner identity; must match the report plan at runtime. */
  runner: "pytest" | "dotnet test" | "ctest" | "maven test";
  format: "junit" | "trx";
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
  /**
   * V3 (AR-R26): trusted report descriptors for detected non-package.json
   * tests commands. Additive: absent on older profiles, preserved by
   * clone/validator/digest/archive, consumed by the runtime.
   */
  reports?: FinalVerificationReportDescriptor[];
  /** V3: true when the bounded file walk hit a cap or error, so marker absence proves nothing. Consumers fail closed. */
  inventoryIncomplete?: boolean;
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
    ambientEnvironment?: Readonly<Record<string, string | undefined>>;
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
        ambientEnvironment: this.options.ambientEnvironment ?? {},
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

/**
 * W3: build the runner-owned plan prefill from the authoritative execution
 * profile. Every detected category is already required; non-detected
 * categories carry no invented rationale or inspection.
 */
export function buildFinalVerificationPlanPrefill(runId: string, profile: FinalVerificationExecutionProfile): FinalVerificationPlanPrefill {
  const digest = finalVerificationProfileDigest(runId, profile);
  const detected = new Set(profile.detectedSignals.map((signal) => signal.category));
  return {
    targetRevision: profile.targetRevision,
    profileDigest: digest,
    required: FINAL_VERIFICATION_CATEGORIES.filter((category) => detected.has(category)),
    undetected: FINAL_VERIFICATION_CATEGORIES.filter((category) => !detected.has(category)),
    detectedSignals: profile.detectedSignals.map((signal) => ({ ...signal })),
  };
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
  ambientEnvironment?: Readonly<Record<string, string | undefined>>;
}): Promise<FinalVerificationExecutionProfile> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const execute = options.execute ?? unavailableGitRunner;
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
  const packageExecution = packageExecutionProfile(repositoryRoot, manifest, dependencies, options.ambientEnvironment ?? {});
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

  const profileInspectedPaths: string[] = manifest
    ? ["package.json", ...(packageExecution.lockfile ? [packageExecution.lockfile] : [])]
    : [];
  const profileReports: FinalVerificationReportDescriptor[] = [];
  let languageInventoryIncomplete = false;
  // V3 (AR-R26): non-package.json families fill only categories the
  // package manifest did not already claim. Each family signal agrees
  // with its exact commands; nothing detected stays a clean inventory.
  if (!commands.build || !commands.tests) {
    const languageInventory = await listLanguageInventoryFiles({
      repositoryRoot,
      readdir: async (path) => (await readdir(path, { withFileTypes: true }))
        .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() })),
    });
    const contents = new Map<string, string>();
    const unavailableContents: string[] = [];
    for (const file of languageInventory.files) {
      const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
      // V3 F5: the .NET single-result qualification reads the relevant
      // property closure (the test project, automatically imported
      // Directory.Build files, and transitively imported property files),
      // so those contents participate in the same bounded/unreadable rules.
      if (!/\.(?:cs|fs|vb)proj$/.test(base) && base !== "cmakelists.txt" && base !== "pyproject.toml" &&
        base !== "directory.build.props" && base !== "directory.build.targets" && !/\.(?:props|targets)$/.test(base)) continue;
      if (contents.size >= 40) {
        unavailableContents.push(file);
        continue;
      }
      try {
        const text = await readFile(join(repositoryRoot, ...file.split("/")), "utf8");
        if (text.length <= 131072) {
          contents.set(file, text);
        } else {
          unavailableContents.push(file);
        }
      } catch {
        unavailableContents.push(file);
      }
    }
    const detections = detectLanguageFamilies({ files: languageInventory.files, readFile: (path) => contents.get(path), unreadable: unavailableContents });
    languageInventoryIncomplete = languageInventory.incomplete;
    const inspected = new Set<string>();
    for (const detection of detections) {
      if (!commands.build && detection.build) {
        detectedSignals.push({ category: "build", source: detection.source, detail: detection.detail });
        commands.build = detection.build.map((command) => ({ label: command.label, executable: command.executable, args: [...command.args] }));
        inspected.add(detection.source);
      }
      if (!commands.tests && detection.tests) {
        detectedSignals.push({ category: "tests", source: detection.source, detail: detection.detail });
        commands.tests = [{ label: detection.tests.label, executable: detection.tests.executable, args: [...detection.tests.args] }];
        inspected.add(detection.source);
        const projectArg = detection.tests.args[1];
        if (typeof projectArg === "string" && !projectArg.startsWith("-")) inspected.add(projectArg);
        profileReports.push(...languageReportDescriptors([detection]));
      }
    }
    for (const path of [...inspected].sort()) {
      if (!profileInspectedPaths.includes(path)) profileInspectedPaths.push(path);
    }
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
    inspectedPaths: profileInspectedPaths,
    detectedSignals,
    commands,
    ...(profileReports.length > 0 ? { reports: profileReports } : {}),
    ...(languageInventoryIncomplete ? { inventoryIncomplete: true as const } : {}),
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
    ...(profile.reports ? { reports: profile.reports.map((report) => ({ ...report })) } : {}),
    ...(profile.inventoryIncomplete !== undefined ? { inventoryIncomplete: profile.inventoryIncomplete } : {}),
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
  if (profile.reports !== undefined) {
    if (!Array.isArray(profile.reports) || profile.reports.some((report) => !validReportDescriptor(report))) {
      throw new Error("Final verification execution report descriptors are invalid.");
    }
    const labels = new Set((profile.commands.tests ?? []).map((command) => command.label));
    for (const report of profile.reports) {
      if (!labels.has(report.commandLabel)) {
        throw new Error("Final verification execution report descriptor names an unknown tests command.");
      }
    }
  }
  if (profile.inventoryIncomplete !== undefined && profile.inventoryIncomplete !== true) {
    throw new Error("Final verification execution inventory completeness flag is invalid.");
  }
  if (profile.portLease !== undefined && !validPortLease(profile.portLease, targetRevision)) {
    throw new Error("Final verification port lease profile is invalid.");
  }
  if (profile.runtimeSmoke !== undefined && !validSmoke(profile.runtimeSmoke)) throw new Error("Final verification runtime smoke profile is invalid.");
  if (profile.browser !== undefined) {
    if (!validBrowser(profile.browser)) throw new Error("Final verification browser profile is invalid.");
    assertFinalVerificationBrowserPolicy(profile.browser.policy);
  }
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

function environmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const matches = Object.entries(environment).filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string").map(([, value]) => value!);
  return new Set(matches).size === 1 ? matches[0] : undefined;
}

function npmInvocation(environment: Readonly<Record<string, string | undefined>>): { executable: string; args: string[] } {
  const npmCli = environmentValue(environment, "npm_execpath")?.trim();
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

function packageManagerInvocation(
  manager: FinalVerificationPackageManager,
  environment: Readonly<Record<string, string | undefined>>,
): {
  executable: string;
  args: string[];
} {
  if (manager === "npm") return npmInvocation(environment);
  const activeCli = environmentValue(environment, "npm_execpath")?.trim();
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
  environment: Readonly<Record<string, string | undefined>>,
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
  const invocation = packageManagerInvocation(manager, environment);
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
    (command.timeoutMs === undefined || (Number.isSafeInteger(command.timeoutMs) && (command.timeoutMs as number) > 0)) &&
    validCommandEnvironment(command.environment);
}
/** T6a: an optional map of environment names to strings, or `undefined` for a removal. */
function validCommandEnvironment(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([name, entry]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && (entry === undefined || typeof entry === "string"));
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
  return browser.policy !== undefined &&
    (browser.server === undefined || validSmoke(browser.server));
}
function validReportDescriptor(value: unknown): value is FinalVerificationReportDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return typeof report.commandLabel === "string" && report.commandLabel.trim().length > 0 &&
    ((report.runner === "pytest" && report.format === "junit") ||
      (report.runner === "dotnet test" && report.format === "trx") ||
      (report.runner === "ctest" && report.format === "junit") ||
      (report.runner === "maven test" && report.format === "junit"));
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
function cloneCommand(command: FinalVerificationCommand): FinalVerificationCommand {
  return { ...command, args: [...command.args], ...(command.environment ? { environment: { ...command.environment } } : {}) };
}
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
/** Splits a shell script on `&&` only; any other separator outside quotes is reported. Twin of delivery-execution.ts (importing back would cycle); iv2-selected-scope.test.ts asserts parity. */
export function splitAndChain(script: string): { segments: string[] } | { separator: string } {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (pair === "||") return { separator: "||" };
    if (char === "|" || char === "&" || char === ";" || char === "\n") {
      return { separator: char === "\n" ? "newline" : char };
    }
    current += char;
  }
  segments.push(current.trim());
  return { segments: segments.filter(Boolean) };
}

// ---------------------------------------------------------------------------
// IV-2 (CD-23/EP16): safe selective test commands
// ---------------------------------------------------------------------------

/**
 * Test-runner families whose argv selects test FILES by appended relative
 * path. `node --test <paths>` and `pytest <paths>` run exactly the named
 * files; every other family Runner V2 understands selects differently
 * (dotnet by project/filter, ctest by `-R` name regex, maven by `-Dtest`
 * class, mocha/jest/vitest through config-shaped argv the runner cannot
 * prove), so only these two families are ever selectable here.
 */
export type SelectableTestRunnerFamily = "node-test" | "pytest";

export interface SelectedTestsCommandInput {
  /** Workspace root holding package.json (package-script shapes are proven against its test script). */
  checkoutPath: string;
  /** The planned FULL tests command (report wiring already applied by the report planner). */
  command: FinalVerificationCommand;
  /** Selected test paths (relative posix paths from computeAffectedTests). */
  selectedTests: readonly string[];
  /** Script-shell rules differ (cmd.exe does not treat `'` as a quote). */
  platform?: NodeJS.Platform;
}

export type SelectedTestsCommandResult =
  | { selectable: true; command: FinalVerificationCommand; runnerFamily: SelectableTestRunnerFamily }
  | { selectable: false; reason: string };

function selectedExecutableName(executable: string): string {
  const normalized = executable.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") || base.endsWith(".cmd") || base.endsWith(".bat")
    ? base.slice(0, base.lastIndexOf("."))
    : base;
}

function isSafeSelectedTestPath(path: string): boolean {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) return false;
  // The path is forwarded verbatim as argv to node/pytest or through the
  // package script to the runner; a leading `-` would parse as a flag, not
  // a test path. Fail safe to the whole script instead of reinterpreting it.
  if (path.startsWith("-")) return false;
  // Relative only: no posix root, no drive letter, no UNC/backslash root.
  if (/^([A-Za-z]:)?[\\/]/.test(path) || path.startsWith("/")) return false;
  return !path.split(/[\\/]/).includes("..");
}

/**
 * Derive the command that runs exactly `selectedTests` from the planned
 * full tests command. Pure shape proof: the project test script (for
 * package invocations) or the direct command must be a BARE runner
 * invocation with no positional patterns, filters, or extra flags — extra
 * argv could already select tests (appending would broaden, not narrow) or
 * change path resolution (a `cd` chain). Anything unproven returns
 * `selectable: false` and the caller runs the whole test script (fail safe).
 *
 * Report instrumentation is preserved: derivation only appends path argv to
 * the already report-wired command (the node `--test` reporter travels in
 * NODE_OPTIONS, the pytest `--junitxml` flag stays in place), the label is
 * unchanged so the trusted-descriptor gate still applies, and inputs are
 * never mutated. Callers must run the result through the same
 * FinalVerificationRuntime path so evidence identity and reuse apply.
 */
export function deriveSelectedTestsCommand(
  input: SelectedTestsCommandInput,
): SelectedTestsCommandResult {
  if (input.selectedTests.length === 0) {
    return { selectable: false, reason: "No selected tests to execute." };
  }
  for (const test of input.selectedTests) {
    if (!isSafeSelectedTestPath(test)) {
      return { selectable: false, reason: `Selected test ${JSON.stringify(test)} is not a safe workspace-relative path.` };
    }
  }
  const args = input.command.args;
  const runIndex = args.lastIndexOf("run");
  if (runIndex >= 0 && args[runIndex + 1] === "test") {
    // F1: `run test` inside argv never proves a package-manager invocation
    // on its own. Only the profile's own shape — node launching a supported
    // npm/pnpm/yarn CLI — may take the package-script path; every other
    // executable fails safe to the whole script.
    if (selectedExecutableName(input.command.executable) !== "node" || !isSupportedPackageManagerCli(args[0])) {
      return { selectable: false, reason: `The test command ${JSON.stringify(input.command.executable)} is not a supported npm/pnpm/yarn invocation the runner can narrow by file path.` };
    }
    return deriveSelectedPackageCommand(input, runIndex);
  }
  return deriveSelectedDirectCommand(input);
}

/**
 * F1: the CLI entry points `packageManagerInvocation` actually launches
 * (bundled npm-cli.js, an active npm/pnpm/yarn CLI, or a corepack
 * pnpm/yarn entry). Anything else carrying `run test` is unknown and
 * fails safe to the whole script.
 */
function isSupportedPackageManagerCli(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  const normalized = entry.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base === "npm-cli.js" ||
    base === "pnpm" || base === "pnpm.js" || base === "pnpm.cjs" ||
    base === "yarn" || base === "yarn.js" || base === "yarn.cjs";
}

function deriveSelectedPackageCommand(
  input: SelectedTestsCommandInput,
  runIndex: number,
): SelectedTestsCommandResult {
  let manifest: { scripts?: Record<string, unknown> } = {};
  try {
    manifest = JSON.parse(readFileSync(join(input.checkoutPath, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return { selectable: false, reason: "The project has no readable package.json test script." };
  }
  const script = typeof manifest.scripts?.test === "string" ? manifest.scripts.test : "";
  if (!script.trim()) {
    return { selectable: false, reason: "The project has no package test script to narrow." };
  }
  // Same unmodeled-shell rule as the report planner: substitution,
  // escapes, comments, negation, grouping, redirection, and (on Windows)
  // `'` could hide a failing command or change path resolution.
  const platform = input.platform ?? process.platform;
  const unmodeled = /[$`\\#!()<>^%]/.exec(script) ?? (platform === "win32" ? /'/.exec(script) : null);
  if (unmodeled) {
    return { selectable: false, reason: `The test script uses the shell character "${unmodeled[0]}", which the runner cannot model safely.` };
  }
  const split = splitAndChain(script);
  if ("separator" in split) {
    return { selectable: false, reason: `The test script joins commands with "${split.separator}", which can hide a failing command.` };
  }
  // A forwarded path lands at the END of the script string, so only a
  // single-segment script provably delivers it to the test runner (a `cd`
  // or env-changing earlier segment would resolve it elsewhere).
  if (split.segments.length !== 1) {
    return { selectable: false, reason: "Only single-command test scripts are safely selectable." };
  }
  const tokens = split.segments[0]!.split(/\s+/).filter(Boolean);
  const head = tokens[0] === "npx" ? tokens.slice(1) : tokens;
  const family = bareSelectableFamily(head);
  if (!family) {
    return { selectable: false, reason: `The test command "${split.segments[0]}" is not a bare node --test or pytest invocation the runner can narrow by file path.` };
  }
  // npm needs `--` to forward arguments to the script; pnpm and yarn forward directly.
  const managerText = [input.command.executable, ...input.command.args].join(" ").toLowerCase();
  const afterTest = input.command.args.slice(runIndex + 2);
  const needsSeparator = !/pnpm|yarn/.test(managerText) && !afterTest.includes("--");
  return {
    selectable: true,
    command: {
      ...input.command,
      args: [...input.command.args, ...(needsSeparator ? ["--"] : []), ...input.selectedTests],
    },
    runnerFamily: family,
  };
}

/** A bare runner invocation: the verb plus its required test flag, and nothing else. */
function bareSelectableFamily(head: string[]): SelectableTestRunnerFamily | undefined {
  if (head.length === 2 && /^(node(\.exe)?|tsx(\.exe|\.cmd)?)$/i.test(head[0] ?? "") && head[1] === "--test") {
    return "node-test";
  }
  if (head.length === 1 && head[0] === "pytest") return "pytest";
  if (head.length === 3 && (head[0] ?? "").startsWith("python") && head[1] === "-m" && head[2] === "pytest") {
    return "pytest";
  }
  return undefined;
}

function deriveSelectedDirectCommand(
  input: SelectedTestsCommandInput,
): SelectedTestsCommandResult {
  const name = selectedExecutableName(input.command.executable);
  const args = input.command.args;
  if (name === "node" || name === "tsx") {
    if (args.length !== 1 || args[0] !== "--test") {
      return { selectable: false, reason: "Only a bare node --test invocation is safely selectable." };
    }
    return {
      selectable: true,
      command: { ...input.command, args: [...args, ...input.selectedTests] },
      runnerFamily: "node-test",
    };
  }
  if (name === "pytest" || name === "python" || name === "python3" || name === "py") {
    let rest = args;
    if (name !== "pytest") {
      if (!(args[0] === "-m" && args[1] === "pytest")) {
        return { selectable: false, reason: "Only a bare python -m pytest invocation is safely selectable." };
      }
      rest = args.slice(2);
    }
    // Only the runner's own --junitxml report flag may already be present;
    // any other argv (filters, deselects, config, positional patterns) could
    // already select tests, so appending would broaden, not narrow.
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === "--junitxml") {
        if (typeof rest[index + 1] !== "string" || rest[index + 1]!.trim() === "") {
          return { selectable: false, reason: "pytest carries an empty --junitxml flag." };
        }
        index += 1;
      } else if (token.startsWith("--junitxml=")) {
        if (token.slice("--junitxml=".length).trim() === "") {
          return { selectable: false, reason: "pytest carries an empty --junitxml flag." };
        }
      } else {
        return { selectable: false, reason: `pytest carries ${JSON.stringify(token)}, which selection cannot prove safe.` };
      }
    }
    return {
      selectable: true,
      command: { ...input.command, args: [...args, ...input.selectedTests] },
      runnerFamily: "pytest",
    };
  }
  if (name === "dotnet") {
    return { selectable: false, reason: "dotnet test selects by project/filter, not by test file path." };
  }
  if (name === "ctest") {
    return { selectable: false, reason: "ctest selects by test-name regex (-R), not by file path; positional args would retarget the build directory." };
  }
  if (name === "mvn") {
    return { selectable: false, reason: "maven test selects by class (-Dtest), not by file path." };
  }
  return { selectable: false, reason: `The test command ${JSON.stringify(input.command.executable)} has no safe file-path selection.` };
}

function isMissingArchiveError(error: unknown): boolean {
  return error instanceof Error && /profile archive is missing/i.test(error.message);
}
