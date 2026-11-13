import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { CheckToolLookup } from "./check-tool-lookup.js";
import type { FinalVerificationExecutionProfile } from "./final-verification-profile.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";

/**
 * VF1: the tool inventory. Before planning, and again on resume, the Runner
 * records what this machine has: Git and Node, each executable a detected or
 * project-declared check would launch, and a browser the Playwright CLI can
 * use. It is a record of facts. Nothing here decides what a project needs or
 * whether a check runs; VF2's lookup at launch stays the only authority for
 * `not_run: tool_missing`.
 */
export const ENVIRONMENT_INVENTORY_EVENT_TYPE = "environment.inventory_recorded";
export const ENVIRONMENT_INVENTORY_VERSION = 1;
/** Git, Node and the check tools together; the rest are counted in `toolsOmitted`. */
export const MAX_INVENTORY_TOOLS = 24;
export const MAX_INVENTORY_NAME_LENGTH = 120;
export const MAX_INVENTORY_PATH_LENGTH = 400;
export const MAX_INVENTORY_VERSION_LENGTH = 160;
export const MAX_INVENTORY_NOTE_LENGTH = 300;
export const MAX_INVENTORY_USED_BY = 6;
export const MAX_INVENTORY_LABEL_LENGTH = 80;
export const MAX_INVENTORY_NOTES = 6;
export const MAX_INVENTORY_MISSING_LIBRARIES = 8;
/** A version probe is a short command: a tool that does not answer in this time is recorded as such. */
export const INVENTORY_VERSION_PROBE_TIMEOUT_MS = 8_000;
const PROBE_CONCURRENCY = 4;

export type InventoryTrigger = "planning" | "resume";
export type InventoryStatus = "found" | "missing" | "unknown";
export type PlaywrightBrowserId = "chrome" | "msedge" | "chromium";

export interface InventoryToolRecord {
  /** The command as a check names it (`dotnet`, `pytest`), or the tool a Node script is (`npm`). */
  name: string;
  status: InventoryStatus;
  /** The resolved path when found. */
  path?: string;
  /** The first line of the tool's version output, truncated. */
  version?: string;
  /** Why a found tool has no version line: it timed out, exited non-zero, printed nothing. */
  versionNote?: string;
  /** Why the lookup could not decide (status `unknown`). */
  note?: string;
  /** Which checks launch it: `runner`, `build: package build`, `tier fast: lint`. */
  usedBy: string[];
}

export interface InventoryBrowserRecord {
  id: PlaywrightBrowserId;
  status: InventoryStatus;
  path?: string;
  /** Playwright's Chromium only: the version its registry pins. */
  version?: string;
  /** Linux, Playwright's Chromium: shared libraries it cannot load (from ldd; no browser launch). */
  missingLibraries?: string[];
  note?: string;
}

export interface EnvironmentInventory {
  version: 1;
  trigger: InventoryTrigger;
  platform: string;
  arch: string;
  /** The Runner's own Node, `process.version`. */
  runnerNode: string;
  /** The revision whose checks were read. */
  revision?: string;
  tools: InventoryToolRecord[];
  toolsOmitted: number;
  browsers: InventoryBrowserRecord[];
  /**
   * The `--browser` value for the Playwright CLI, whose default is the `chrome`
   * channel with no fallback (VF7a §6): installed Chrome first, then Edge, then
   * Playwright's own Chromium. Null when none of them is usable.
   */
  playwrightBrowser: PlaywrightBrowserId | null;
  /** Parts that could not be inspected, such as the checks of a revision that has no readable profile. */
  notes: string[];
  /**
   * VF4: the checks aiboard-validation.json marks mandatory, with the tools they launch and
   * which of those the lookup found missing. Absent when the project declares none.
   */
  mandatoryChecks?: InventoryMandatoryCheck[];
  /** VF4: why the project's aiboard-validation.json could not be read, when it is present but malformed. */
  projectConfigError?: string;
}

/** VF4: the pause while a mandatory check's tool is missing. */
export const MANDATORY_CHECK_TOOL_MISSING_PAUSE = "mandatory_check_tool_missing";
/** VF4: the pause while the project's aiboard-validation.json is malformed. */
export const PROJECT_VALIDATION_CONFIG_INVALID_PAUSE = "project_validation_config_invalid";
/** The pre-planning verification gate's pauses (VF4); the scheduler lets them through pending guidance. */
export const VERIFICATION_GATE_PAUSE_REASONS: ReadonlySet<string> = new Set([
  MANDATORY_CHECK_TOOL_MISSING_PAUSE,
  PROJECT_VALIDATION_CONFIG_INVALID_PAUSE,
]);
export const MAX_INVENTORY_CONFIG_ERROR_LENGTH = 1_000;

/** VF4: a mandatory check and the tools it needs, as the inventory found them. */
export interface InventoryMandatoryCheck {
  checkId: string;
  label: string;
  /** The line of the check's id in aiboard-validation.json. */
  configLine?: number;
  /** The inventory names of the tools it launches (provisioning included). */
  tools: string[];
  /** Those of them the Runner's lookup found missing. */
  missing: string[];
}

export const MAX_INVENTORY_MANDATORY_CHECKS = 32;
const MAX_INVENTORY_MANDATORY_TOOLS = 10;

/** The projection keeps the latest inventory with the sequence that recorded it. */
export interface EnvironmentInventoryProjection extends EnvironmentInventory {
  sequence: number;
  recordedAt: string;
}

export interface InventoryCheckCommand {
  /** `build: package build`, `tier fast: lint`. */
  label: string;
  executable: string;
  args: readonly string[];
}

export interface InventoryProbeRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface InventoryProbeResult {
  outcome: "exited" | "timed_out" | "cancelled" | "launch_failed" | "cleanup_failed";
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export type InventoryCommandRunner = (request: InventoryProbeRequest) => Promise<InventoryProbeResult>;

/**
 * Environment for every probe: no tool may download anything to answer its
 * version (a Go toolchain, a Rust toolchain, a Corepack package manager), and
 * no first-run banner or update check.
 */
export const INVENTORY_PROBE_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({
  GOTOOLCHAIN: "local",
  RUSTUP_AUTO_INSTALL: "0",
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false",
  npm_config_offline: "true",
  CHECKPOINT_DISABLE: "1",
  NODE_TEST_CONTEXT: undefined,
});

/** Tools whose version is not `--version`. */
const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  go: ["version"],
  zig: ["version"],
  adb: ["version"],
  java: ["-version"],
  javac: ["-version"],
  msbuild: ["-version"],
  xcodebuild: ["-version"],
});
/** Shells with no version flag that would not start an interactive session; recorded, never run. */
const NO_VERSION_PROBE = new Set(["cmd", "powershell", "start"]);

export function inventoryVersionArgs(name: string): readonly string[] | undefined {
  const normalized = normalizedToolName(name);
  if (NO_VERSION_PROBE.has(normalized)) return undefined;
  return VERSION_ARGS[normalized] ?? ["--version"];
}

/** Every command a check of this profile would launch, labeled by the check. */
export function inventoryCheckCommands(profile: FinalVerificationExecutionProfile): InventoryCheckCommand[] {
  const commands: InventoryCheckCommand[] = [];
  const add = (label: string, command: { executable: string; args: readonly string[] }) => {
    commands.push({ label, executable: command.executable, args: [...command.args] });
  };
  // VF4: the project's declared checks first, mandatory ones before the rest, so the tool cap
  // never drops a tool a mandatory check needs.
  const declared = [...(profile.projectChecks ?? [])].sort((left, right) => Number(right.mandatory) - Number(left.mandatory));
  for (const check of declared) {
    for (const command of projectCheckCommands(check)) add(command.label, command);
  }
  if (profile.provisioning) add("provisioning", profile.provisioning.command);
  for (const command of profile.commands.build ?? []) add(`build: ${command.label}`, command);
  for (const command of profile.commands.tests ?? []) add(`tests: ${command.label}`, command);
  const smokes = [profile.runtimeSmoke, profile.browser?.server].filter((smoke) => smoke !== undefined);
  const seenSmoke = new Set<string>();
  for (const smoke of smokes) {
    const key = JSON.stringify([smoke.label, smoke.executable, smoke.args]);
    if (seenSmoke.has(key)) continue;
    seenSmoke.add(key);
    add(`start: ${smoke.label}`, smoke);
    for (const step of smoke.steps ?? []) add(`start step: ${step.label}`, step);
  }
  for (const [tier, tierCommands] of Object.entries(profile.tiers ?? {})) {
    for (const command of tierCommands ?? []) add(`tier ${tier}: ${command.label}`, command);
  }
  return commands;
}

type ProjectCheck = NonNullable<FinalVerificationExecutionProfile["projectChecks"]>[number];

function projectCheckCommands(check: ProjectCheck): InventoryCheckCommand[] {
  const label = `check ${check.id}${check.mandatory ? " (mandatory)" : ""}: ${check.label}`;
  if (check.run) return [{ label, executable: check.run.executable, args: [...check.run.args] }];
  if (!check.start) return [];
  return [
    { label, executable: check.start.executable, args: [...check.start.args] },
    ...(check.start.steps ?? []).map((step) => ({ label: `check ${check.id} step: ${step.label}`, executable: step.executable, args: [...step.args] })),
  ];
}

/** VF4: the mandatory checks a missing tool keeps from running. */
export function mandatoryChecksMissingTools(inventory: Pick<EnvironmentInventory, "mandatoryChecks">): InventoryMandatoryCheck[] {
  return (inventory.mandatoryChecks ?? []).filter((check) => check.missing.length > 0);
}

/** VF4: the owner's pause text for a malformed aiboard-validation.json. */
export function projectConfigInvalidDetail(error: string): string {
  return `${error} The Build reads its checks from this file, so it cannot plan until the file is valid. Fix aiboard-validation.json in the project, then resume: the resume reads it again.`;
}

/** VF4: the owner's pause text: each mandatory check that cannot run, its missing tools and its config line. */
export function mandatoryToolMissingDetail(blocked: readonly InventoryMandatoryCheck[]): string {
  const lines = blocked.map((check) =>
    `${check.missing.join(", ")} (needed by mandatory check "${check.checkId}", aiboard-validation.json${check.configLine !== undefined ? ` line ${check.configLine}` : ""})`);
  return `A mandatory check cannot run because a tool is missing on this machine: ${lines.join("; ")}. Install it so the Runner finds it on PATH, then resume. The project's aiboard-validation.json makes the check mandatory; a Build cannot finish without it.`;
}

export interface CollectEnvironmentInventoryInput {
  trigger: InventoryTrigger;
  revision?: string;
  /** A Runner-owned folder: the disposable checkout of `revision`. Lookups and probes run here, never in the project. */
  cwd: string;
  checks: readonly InventoryCheckCommand[];
  /** Why the checks could not be read, when they could not. */
  checksNote?: string;
  lookup: CheckToolLookup;
  run: InventoryCommandRunner;
  /** Defaults to the Playwright registry the Runner ships. */
  browsers?: () => Promise<{ browsers: InventoryBrowserRecord[]; notes: string[] }>;
  platform?: NodeJS.Platform;
  arch?: string;
  runnerNode?: string;
  /** The Runner's Node: a check that runs a Node script (npm-cli.js) is recorded as that script's tool. */
  nodeExecPath?: string;
  /** VF4: why aiboard-validation.json could not be read (a ProjectValidationConfigError). */
  projectConfigError?: string;
  /**
   * VF4: the mandatory checks with their tools, decided by the final check's own lookup
   * (mandatoryProjectCheckTools in check-tool-lookup.ts); recorded as given.
   */
  mandatoryChecks?: readonly InventoryMandatoryCheck[];
}

interface ToolTarget {
  key: string;
  name: string;
  /** A Node script the check runs with the Runner's Node: npm, pnpm, yarn. */
  script?: string;
  /** The executable exactly as the check names it. */
  executable: string;
  usedBy: string[];
}

export async function collectEnvironmentInventory(input: CollectEnvironmentInventoryInput): Promise<EnvironmentInventory> {
  const platform = input.platform ?? process.platform;
  const nodeExecPath = input.nodeExecPath ?? process.execPath;
  const notes: string[] = [];
  if (input.checksNote) notes.push(input.checksNote);
  const targets: ToolTarget[] = [];
  const byKey = new Map<string, ToolTarget>();
  const identity = (executable: string, args: readonly string[]) => {
    const script = nodeScriptOf(executable, args, nodeExecPath, platform);
    const name = script ? scriptToolName(script) : isBareCommand(executable) ? executable : basename(executable) || executable;
    const key = `${script ? "script" : isBareCommand(executable) ? "command" : "path"}:${platform === "win32" ? normalizedToolName(name) : name}`;
    return { script, name, key };
  };
  const addTarget = (executable: string, args: readonly string[], label: string) => {
    const { script, name, key } = identity(executable, args);
    let target = byKey.get(key);
    if (!target) {
      target = { key, name, executable, usedBy: [], ...(script ? { script } : {}) };
      byKey.set(key, target);
      targets.push(target);
    }
    if (!target.usedBy.includes(label)) target.usedBy.push(label);
  };
  addTarget("git", [], "runner");
  addTarget("node", [], "runner");
  for (const check of input.checks) addTarget(check.executable, check.args, check.label);
  const kept = targets.slice(0, MAX_INVENTORY_TOOLS);
  const tools = await mapConcurrent(kept, PROBE_CONCURRENCY, async (target) => await inventoryTool(target, input, nodeExecPath));
  const mandatoryChecks = (input.mandatoryChecks ?? []).map((check): InventoryMandatoryCheck => ({
    checkId: check.checkId,
    label: check.label,
    ...(check.configLine !== undefined ? { configLine: check.configLine } : {}),
    tools: [...check.tools],
    missing: [...check.missing],
  }));
  let browserPart: { browsers: InventoryBrowserRecord[]; notes: string[] };
  try {
    browserPart = await (input.browsers ?? (() => playwrightBrowserInventory({
      platform,
      cwd: input.cwd,
      lookup: input.lookup,
      run: input.run,
    })))();
  } catch (error) {
    browserPart = {
      browsers: PLAYWRIGHT_BROWSER_ORDER.map((id) => ({ id, status: "unknown" as const, note: "The browser lookup failed." })),
      notes: [`The browser lookup failed: ${errorMessage(error)}`],
    };
  }
  notes.push(...browserPart.notes);
  return boundEnvironmentInventory({
    version: 1,
    trigger: input.trigger,
    platform,
    arch: input.arch ?? process.arch,
    runnerNode: input.runnerNode ?? process.version,
    ...(input.revision ? { revision: input.revision } : {}),
    tools,
    toolsOmitted: targets.length - kept.length,
    browsers: browserPart.browsers,
    playwrightBrowser: selectPlaywrightBrowser(browserPart.browsers),
    notes,
    ...(mandatoryChecks.length ? { mandatoryChecks } : {}),
    ...(input.projectConfigError ? { projectConfigError: input.projectConfigError } : {}),
  });
}

async function inventoryTool(target: ToolTarget, input: CollectEnvironmentInventoryInput, nodeExecPath: string): Promise<InventoryToolRecord> {
  const base = { name: target.name, usedBy: target.usedBy };
  let launch: { executable: string; prefix: string[]; path: string };
  if (target.script) {
    // The profile resolved this script itself (npmInvocation, Corepack); there is no PATH lookup to make.
    if (!existsSync(target.script)) return { ...base, status: "missing", path: target.script };
    launch = { executable: nodeExecPath, prefix: [target.script], path: target.script };
  } else {
    // VF2's lookup, the one the check makes before it launches: a second resolver would disagree with it.
    const looked = await input.lookup(target.executable, { cwd: input.cwd });
    if (looked.status === "missing") return { ...base, status: "missing" };
    if (looked.status === "unknown") return { ...base, status: "unknown", note: looked.reason };
    launch = { executable: looked.path, prefix: [], path: looked.path };
  }
  const versionArgs = inventoryVersionArgs(target.name);
  if (!versionArgs) return { ...base, status: "found", path: launch.path, versionNote: "No version flag is probed for this tool." };
  if (inside(input.cwd, launch.path)) {
    // A project file the Windows launcher finds in the working folder first: recorded, never run here.
    return { ...base, status: "found", path: launch.path, versionNote: "A file of the project; its version is not probed." };
  }
  let result: InventoryProbeResult;
  try {
    result = await input.run({
      executable: launch.executable,
      args: [...launch.prefix, ...versionArgs],
      cwd: input.cwd,
      timeoutMs: INVENTORY_VERSION_PROBE_TIMEOUT_MS,
      environment: INVENTORY_PROBE_ENVIRONMENT,
    });
  } catch (error) {
    return { ...base, status: "found", path: launch.path, versionNote: `The version probe could not run: ${errorMessage(error)}` };
  }
  const line = firstVersionLine(result.stdout, result.stderr);
  if (result.outcome === "timed_out") {
    return { ...base, status: "found", path: launch.path, versionNote: `The version probe timed out after ${INVENTORY_VERSION_PROBE_TIMEOUT_MS / 1000} s.` };
  }
  if (result.outcome !== "exited") {
    return { ...base, status: "found", path: launch.path, versionNote: `The version probe ended as ${result.outcome}.` };
  }
  if (result.exitCode !== 0) {
    return { ...base, status: "found", path: launch.path, versionNote: `The version probe exited ${result.exitCode ?? "without a code"}${line ? `: ${line}` : "."}` };
  }
  if (!line) return { ...base, status: "found", path: launch.path, versionNote: "The version probe printed nothing." };
  return { ...base, status: "found", path: launch.path, version: line };
}

/** The first line with a letter or digit, ANSI colors removed: stdout first, then stderr (java -version). */
export function firstVersionLine(stdout: string, stderr: string): string | undefined {
  for (const stream of [stdout, stderr]) {
    for (const raw of stream.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
      const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
      if (/[A-Za-z0-9]/.test(line)) return truncate(line, MAX_INVENTORY_VERSION_LENGTH);
    }
  }
  return undefined;
}

export const PLAYWRIGHT_BROWSER_ORDER: readonly PlaywrightBrowserId[] = Object.freeze(["chrome", "msedge", "chromium"]);

export function selectPlaywrightBrowser(browsers: readonly InventoryBrowserRecord[]): PlaywrightBrowserId | null {
  for (const id of PLAYWRIGHT_BROWSER_ORDER) {
    const browser = browsers.find((entry) => entry.id === id);
    // A Chromium that cannot load its libraries cannot start: the CLI could not use it.
    if (browser?.status === "found" && !(browser.missingLibraries && browser.missingLibraries.length > 0)) return id;
  }
  return null;
}

/** The part of Playwright's registry the inventory reads; it never launches or downloads anything. */
export interface PlaywrightRegistryLike {
  findExecutable(name: string): {
    executablePath(sdkLanguage?: string): string | undefined;
    browserVersion?: unknown;
  } | undefined;
}

/**
 * The registry of the playwright-core that the Runner's bundled `playwright`
 * package depends on: the same one the Playwright CLI resolves browsers with
 * (`_createChromiumChannel` for chrome and msedge, the cached download for
 * chromium). Loading it starts no browser.
 */
export function loadPlaywrightRegistry(): PlaywrightRegistryLike {
  const requireFromRunner = createRequire(import.meta.url);
  const playwrightManifest = requireFromRunner.resolve("playwright/package.json");
  const core = createRequire(playwrightManifest)("playwright-core/lib/coreBundle") as { registry?: { registry?: unknown } };
  const registry = core.registry?.registry as PlaywrightRegistryLike | undefined;
  if (!registry || typeof registry.findExecutable !== "function") {
    throw new Error("The bundled Playwright has no browser registry.");
  }
  return registry;
}

export async function playwrightBrowserInventory(options: {
  platform: NodeJS.Platform;
  cwd: string;
  lookup: CheckToolLookup;
  run: InventoryCommandRunner;
  registry?: () => PlaywrightRegistryLike;
  /** Test seam; the registry's own path checks are used for chrome and msedge. */
  exists?: (path: string) => boolean;
}): Promise<{ browsers: InventoryBrowserRecord[]; notes: string[] }> {
  const notes: string[] = [];
  let registry: PlaywrightRegistryLike;
  try {
    registry = (options.registry ?? loadPlaywrightRegistry)();
  } catch (error) {
    return {
      browsers: PLAYWRIGHT_BROWSER_ORDER.map((id) => ({ id, status: "unknown" as const, note: "Playwright's registry could not be read." })),
      notes: [`Playwright's browser registry could not be read: ${errorMessage(error)}`],
    };
  }
  const exists = options.exists ?? existsSync;
  const browsers: InventoryBrowserRecord[] = [];
  for (const id of PLAYWRIGHT_BROWSER_ORDER) {
    const executable = registry.findExecutable(id);
    if (!executable) {
      browsers.push({ id, status: "unknown", note: `Playwright's registry does not know ${id}.` });
      continue;
    }
    let path: string | undefined;
    try {
      path = executable.executablePath("javascript") || undefined;
    } catch (error) {
      browsers.push({ id, status: "unknown", note: errorMessage(error) });
      continue;
    }
    const version = id === "chromium" && typeof executable.browserVersion === "string" ? executable.browserVersion : undefined;
    // The channels return a path only when the file is there; the download's path is where it would be.
    if (!path || !exists(path)) {
      browsers.push({ id, status: "missing", ...(version ? { version } : {}) });
      continue;
    }
    const record: InventoryBrowserRecord = { id, status: "found", path, ...(version ? { version } : {}) };
    if (id === "chromium" && options.platform === "linux") {
      const libraries = await linuxMissingLibraries(path, options);
      if (libraries.status === "checked" && libraries.missing.length > 0) record.missingLibraries = libraries.missing;
      if (libraries.status === "not_checked") notes.push(libraries.note);
    }
    browsers.push(record);
  }
  return { browsers, notes };
}

/**
 * Linux: `ldd` on Playwright's Chromium names the shared libraries it cannot
 * load (VF7a §6: `libnspr4.so` and others before `install-deps`). It runs
 * through the Runner's command path like any probe and starts no browser.
 */
async function linuxMissingLibraries(
  executablePath: string,
  options: { cwd: string; lookup: CheckToolLookup; run: InventoryCommandRunner },
): Promise<{ status: "checked"; missing: string[] } | { status: "not_checked"; note: string }> {
  const ldd = await options.lookup("ldd", { cwd: options.cwd });
  if (ldd.status !== "found") {
    return { status: "not_checked", note: "ldd is not on PATH, so the shared libraries of Playwright's Chromium were not checked." };
  }
  let result: InventoryProbeResult;
  try {
    result = await options.run({
      executable: ldd.path,
      args: [executablePath],
      cwd: options.cwd,
      timeoutMs: INVENTORY_VERSION_PROBE_TIMEOUT_MS,
      environment: INVENTORY_PROBE_ENVIRONMENT,
    });
  } catch (error) {
    return { status: "not_checked", note: `ldd could not run on Playwright's Chromium: ${errorMessage(error)}` };
  }
  if (result.outcome !== "exited") {
    return { status: "not_checked", note: `ldd on Playwright's Chromium ended as ${result.outcome}.` };
  }
  return { status: "checked", missing: parseLddMissingLibraries(`${result.stdout}\n${result.stderr}`) };
}

/** `libnspr4.so => not found` lines of ldd output. */
export function parseLddMissingLibraries(output: string): string[] {
  const missing: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line);
    if (match && !missing.includes(match[1]!)) missing.push(match[1]!);
  }
  return missing.slice(0, MAX_INVENTORY_MISSING_LIBRARIES).map((name) => truncate(name, MAX_INVENTORY_LABEL_LENGTH));
}

/**
 * Runs each probe as a Runner-internal one-shot command, so it is owned,
 * contained and cleaned up like every command the Runner starts. No new
 * process path: the same executor the checks themselves use.
 */
export function oneShotInventoryRunner(execution: OneShotCommandExecutor, identity: { runId: string }): InventoryCommandRunner {
  return async (request) => {
    const executed = await execution.execute({
      executable: request.executable,
      arguments: request.args,
      workingDirectory: request.cwd,
      timeoutMs: request.timeoutMs,
      explicitEnvironment: request.environment,
      // A version is a fact of this moment: never answered from an earlier command's evidence.
      freshExecution: true,
      context: {
        runId: identity.runId,
        sessionId: "environment-inventory",
        actor: { role: "runner_internal", id: "environment-inventory" },
        callId: `environment-inventory-${randomUUID()}`,
        toolName: "environment.inventory",
        runnerInternal: true,
      },
    });
    return {
      outcome: executed.process.outcome,
      ...(executed.process.exitCode !== undefined ? { exitCode: executed.process.exitCode } : {}),
      // outputFor's reading, kept local so the store's replay parse imports no process code.
      stdout: executed.process.output.find((entry) => entry.stream === "stdout")?.tail ?? "",
      stderr: executed.process.output.find((entry) => entry.stream === "stderr")?.tail ?? "",
    };
  };
}

/** Caps every list and string so the event stays small whatever a machine reports. */
export function boundEnvironmentInventory(inventory: EnvironmentInventory): EnvironmentInventory {
  const tools = inventory.tools.slice(0, MAX_INVENTORY_TOOLS);
  return {
    version: 1,
    trigger: inventory.trigger,
    platform: truncate(inventory.platform, 40),
    arch: truncate(inventory.arch, 40),
    runnerNode: truncate(inventory.runnerNode, 40),
    ...(inventory.revision ? { revision: truncate(inventory.revision, 80) } : {}),
    tools: tools.map((tool) => ({
      name: truncate(tool.name, MAX_INVENTORY_NAME_LENGTH),
      status: tool.status,
      ...(tool.path ? { path: truncate(tool.path, MAX_INVENTORY_PATH_LENGTH) } : {}),
      ...(tool.version ? { version: truncate(tool.version, MAX_INVENTORY_VERSION_LENGTH) } : {}),
      ...(tool.versionNote ? { versionNote: truncate(tool.versionNote, MAX_INVENTORY_NOTE_LENGTH) } : {}),
      ...(tool.note ? { note: truncate(tool.note, MAX_INVENTORY_NOTE_LENGTH) } : {}),
      usedBy: tool.usedBy.slice(0, MAX_INVENTORY_USED_BY).map((label) => truncate(label, MAX_INVENTORY_LABEL_LENGTH)),
    })),
    toolsOmitted: inventory.toolsOmitted + Math.max(0, inventory.tools.length - tools.length),
    browsers: inventory.browsers.slice(0, PLAYWRIGHT_BROWSER_ORDER.length).map((browser) => ({
      id: browser.id,
      status: browser.status,
      ...(browser.path ? { path: truncate(browser.path, MAX_INVENTORY_PATH_LENGTH) } : {}),
      ...(browser.version ? { version: truncate(browser.version, MAX_INVENTORY_VERSION_LENGTH) } : {}),
      ...(browser.missingLibraries && browser.missingLibraries.length > 0
        ? { missingLibraries: browser.missingLibraries.slice(0, MAX_INVENTORY_MISSING_LIBRARIES).map((name) => truncate(name, MAX_INVENTORY_LABEL_LENGTH)) }
        : {}),
      ...(browser.note ? { note: truncate(browser.note, MAX_INVENTORY_NOTE_LENGTH) } : {}),
    })),
    playwrightBrowser: inventory.playwrightBrowser,
    notes: inventory.notes.slice(0, MAX_INVENTORY_NOTES).map((note) => truncate(note, MAX_INVENTORY_NOTE_LENGTH)),
    ...(inventory.mandatoryChecks?.length ? {
      mandatoryChecks: inventory.mandatoryChecks.slice(0, MAX_INVENTORY_MANDATORY_CHECKS).map((check) => ({
        checkId: truncate(check.checkId, 64),
        label: truncate(check.label, MAX_INVENTORY_LABEL_LENGTH),
        ...(check.configLine !== undefined ? { configLine: check.configLine } : {}),
        // Missing tools first, so the cap never keeps a missing tool out of the list it belongs to.
        tools: [...new Set([...check.missing, ...check.tools])].slice(0, MAX_INVENTORY_MANDATORY_TOOLS).map((name) => truncate(name, MAX_INVENTORY_NAME_LENGTH)),
        missing: check.missing.slice(0, MAX_INVENTORY_MANDATORY_TOOLS).map((name) => truncate(name, MAX_INVENTORY_NAME_LENGTH)),
      })),
    } : {}),
    ...(inventory.projectConfigError ? { projectConfigError: truncate(inventory.projectConfigError, MAX_INVENTORY_CONFIG_ERROR_LENGTH) } : {}),
  };
}

/** An inventory that says only that nothing could be inspected; it keeps the epoch from probing again every step. */
export function unavailableEnvironmentInventory(trigger: InventoryTrigger, reason: string): EnvironmentInventory {
  return boundEnvironmentInventory({
    version: 1,
    trigger,
    platform: process.platform,
    arch: process.arch,
    runnerNode: process.version,
    tools: [],
    toolsOmitted: 0,
    browsers: [],
    playwrightBrowser: null,
    notes: [`The inventory could not be taken: ${reason}`],
  });
}

const TOP_KEYS = new Set(["version", "trigger", "platform", "arch", "runnerNode", "revision", "tools", "toolsOmitted", "browsers", "playwrightBrowser", "notes", "mandatoryChecks", "projectConfigError"]);
const MANDATORY_CHECK_KEYS = new Set(["checkId", "label", "configLine", "tools", "missing"]);
const TOOL_KEYS = new Set(["name", "status", "path", "version", "versionNote", "note", "usedBy"]);
const BROWSER_KEYS = new Set(["id", "status", "path", "version", "missingLibraries", "note"]);
const STATUSES = new Set<InventoryStatus>(["found", "missing", "unknown"]);

/**
 * Strict replay parse of an `environment.inventory_recorded` payload: closed
 * keys, known values and every bound the recorder applies. A payload that does
 * not parse is refused at append, so a stored one always replays.
 */
export function parseEnvironmentInventory(value: unknown): EnvironmentInventory {
  const record = closedRecord(value, TOP_KEYS, "Environment inventory");
  if (record.version !== 1) throw new Error("Environment inventory version is invalid.");
  if (record.trigger !== "planning" && record.trigger !== "resume") throw new Error("Environment inventory trigger is invalid.");
  const tools = boundedArray(record.tools, MAX_INVENTORY_TOOLS, "Environment inventory tools").map((entry) => {
    const tool = closedRecord(entry, TOOL_KEYS, "Environment inventory tool");
    const status = tool.status;
    if (typeof status !== "string" || !STATUSES.has(status as InventoryStatus)) throw new Error("Environment inventory tool status is invalid.");
    const usedBy = boundedArray(tool.usedBy, MAX_INVENTORY_USED_BY, "Environment inventory tool usedBy")
      .map((label) => boundedString(label, MAX_INVENTORY_LABEL_LENGTH, "Environment inventory tool usedBy"));
    return {
      name: boundedString(tool.name, MAX_INVENTORY_NAME_LENGTH, "Environment inventory tool name", true),
      status: status as InventoryStatus,
      ...optionalString(tool, "path", MAX_INVENTORY_PATH_LENGTH),
      ...optionalString(tool, "version", MAX_INVENTORY_VERSION_LENGTH),
      ...optionalString(tool, "versionNote", MAX_INVENTORY_NOTE_LENGTH),
      ...optionalString(tool, "note", MAX_INVENTORY_NOTE_LENGTH),
      usedBy,
    };
  });
  const browsers = boundedArray(record.browsers, PLAYWRIGHT_BROWSER_ORDER.length, "Environment inventory browsers").map((entry) => {
    const browser = closedRecord(entry, BROWSER_KEYS, "Environment inventory browser");
    if (!PLAYWRIGHT_BROWSER_ORDER.includes(browser.id as PlaywrightBrowserId)) throw new Error("Environment inventory browser id is invalid.");
    if (typeof browser.status !== "string" || !STATUSES.has(browser.status as InventoryStatus)) throw new Error("Environment inventory browser status is invalid.");
    const missingLibraries = browser.missingLibraries === undefined
      ? undefined
      : boundedArray(browser.missingLibraries, MAX_INVENTORY_MISSING_LIBRARIES, "Environment inventory missing libraries")
        .map((name) => boundedString(name, MAX_INVENTORY_LABEL_LENGTH, "Environment inventory missing library", true));
    return {
      id: browser.id as PlaywrightBrowserId,
      status: browser.status as InventoryStatus,
      ...optionalString(browser, "path", MAX_INVENTORY_PATH_LENGTH),
      ...optionalString(browser, "version", MAX_INVENTORY_VERSION_LENGTH),
      ...(missingLibraries ? { missingLibraries } : {}),
      ...optionalString(browser, "note", MAX_INVENTORY_NOTE_LENGTH),
    };
  });
  const selected = record.playwrightBrowser;
  if (selected !== null && !PLAYWRIGHT_BROWSER_ORDER.includes(selected as PlaywrightBrowserId)) {
    throw new Error("Environment inventory Playwright browser is invalid.");
  }
  const toolsOmitted = record.toolsOmitted;
  if (typeof toolsOmitted !== "number" || !Number.isSafeInteger(toolsOmitted) || toolsOmitted < 0) {
    throw new Error("Environment inventory toolsOmitted is invalid.");
  }
  return {
    version: 1,
    trigger: record.trigger,
    platform: boundedString(record.platform, 40, "Environment inventory platform", true),
    arch: boundedString(record.arch, 40, "Environment inventory arch", true),
    runnerNode: boundedString(record.runnerNode, 40, "Environment inventory runnerNode", true),
    ...optionalString(record, "revision", 80),
    tools,
    toolsOmitted,
    browsers,
    playwrightBrowser: selected as PlaywrightBrowserId | null,
    notes: boundedArray(record.notes, MAX_INVENTORY_NOTES, "Environment inventory notes")
      .map((note) => boundedString(note, MAX_INVENTORY_NOTE_LENGTH, "Environment inventory note")),
    ...(record.mandatoryChecks !== undefined ? {
      mandatoryChecks: boundedArray(record.mandatoryChecks, MAX_INVENTORY_MANDATORY_CHECKS, "Environment inventory mandatory checks").map((entry) => {
        const check = closedRecord(entry, MANDATORY_CHECK_KEYS, "Environment inventory mandatory check");
        const configLine = check.configLine;
        if (configLine !== undefined && (typeof configLine !== "number" || !Number.isSafeInteger(configLine) || configLine < 1)) {
          throw new Error("Environment inventory mandatory check configLine is invalid.");
        }
        const names = (value: unknown, label: string) => boundedArray(value, MAX_INVENTORY_MANDATORY_TOOLS, label)
          .map((name) => boundedString(name, MAX_INVENTORY_NAME_LENGTH, label, true));
        const tools = names(check.tools, "Environment inventory mandatory check tools");
        const missing = names(check.missing, "Environment inventory mandatory check missing tools");
        if (missing.some((name) => !tools.includes(name))) {
          throw new Error("Environment inventory mandatory check names a missing tool it does not use.");
        }
        return {
          checkId: boundedString(check.checkId, 64, "Environment inventory mandatory check id", true),
          label: boundedString(check.label, MAX_INVENTORY_LABEL_LENGTH, "Environment inventory mandatory check label", true),
          ...(configLine !== undefined ? { configLine: configLine as number } : {}),
          tools,
          missing,
        };
      }),
    } : {}),
    ...optionalString(record, "projectConfigError", MAX_INVENTORY_CONFIG_ERROR_LENGTH),
  };
}

/**
 * The Architect's compact planning-context lines: one per tool and one for
 * the browser. Facts only; the Architect decides what they mean for its plan.
 */
export function renderEnvironmentInventory(inventory: EnvironmentInventoryProjection): string {
  const lines = [
    `Tool inventory (recorded by the Runner at event ${inventory.sequence}, ${inventory.trigger === "resume" ? "on resume" : "before planning"}; ${inventory.platform} ${inventory.arch}, Runner Node ${inventory.runnerNode}). Facts about this machine, not requirements: a check whose tool is missing is recorded as not run.`,
  ];
  for (const tool of inventory.tools) {
    const where = tool.status === "found"
      ? `found${tool.path ? ` at ${tool.path}` : ""}; ${tool.version ?? tool.versionNote ?? "no version line"}`
      : tool.status === "missing" ? "missing" : `unknown (${tool.note ?? "the lookup could not decide"})`;
    lines.push(`- ${tool.name}: ${where} [used by: ${tool.usedBy.join(", ")}]`);
  }
  if (inventory.toolsOmitted > 0) lines.push(`- ${inventory.toolsOmitted} more tools were not recorded (cap ${MAX_INVENTORY_TOOLS}).`);
  const browsers = inventory.browsers.map((browser) => {
    const libraries = browser.missingLibraries?.length ? `, missing libraries ${browser.missingLibraries.join(", ")}` : "";
    return `${browser.id} ${browser.status}${browser.version ? ` ${browser.version}` : ""}${libraries}`;
  });
  lines.push(`- Browser for the Playwright CLI: ${inventory.playwrightBrowser ? `--browser=${inventory.playwrightBrowser}` : "none usable"}${browsers.length > 0 ? ` (${browsers.join("; ")})` : ""}.`);
  for (const note of inventory.notes) lines.push(`- Note: ${note}`);
  return lines.join("\n");
}

function nodeScriptOf(executable: string, args: readonly string[], nodeExecPath: string, platform: NodeJS.Platform): string | undefined {
  if (!isAbsolute(executable) || !samePath(executable, nodeExecPath, platform)) return undefined;
  const script = args[0];
  return typeof script === "string" && isAbsolute(script) && /\.(?:c|m)?js$/i.test(script) ? script : undefined;
}

/** `npm-cli.js` → npm, `pnpm.cjs` → pnpm. */
function scriptToolName(script: string): string {
  return basename(script).replace(/\.(?:c|m)?js$/i, "").replace(/-cli$/i, "") || basename(script);
}

function isBareCommand(executable: string): boolean {
  return !isAbsolute(executable) && !executable.includes("/") && !executable.includes("\\");
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "");
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function errorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 200);
}

function closedRecord(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${label} has an unknown field ${key}.`);
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > max) throw new Error(`${label} has more than ${max} entries.`);
  return value;
}

function boundedString(value: unknown, max: number, label: string, nonEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, max: number): Record<string, string> {
  if (record[key] === undefined) return {};
  return { [key]: boundedString(record[key], max, `Environment inventory ${key}`, true) };
}
