/**
 * CLI worker adapters (docs/plans/2026-11-14-cli-workers.md §3.2, §3.4, §3.5, §3.8, packet CW2): everything that
 * differs between Codex CLI (`codex-cli`), Claude Code (`claude-code`) and agy (`agy`), behind one interface.
 *
 * - Lookup: the executable from the home's `executablePath` or the PATH lookup VF2 uses for checks.
 * - Free checks (no prompt, no quota): their arguments and parsers. A parser keeps only the fields it names, so an
 *   account field (e-mail, organization, login expiry) never leaves it.
 * - Model lists (CWD-9): one `listModels()` per CLI, each offering "CLI default" first.
 * - Launch: the arguments of §3.5 exactly, Runner-built and charset-checked. The prompt never goes in argv: it goes
 *   on stdin (agy: as one stream-json line).
 * - Reading a run: an incremental stream reader that sees the end of the turn (Claude Code's and agy's `result`
 *   event; Codex's turn events, though its `-o` file is complete only at exit), the session id, usage, and the
 *   outcome: the CLI's result, a classified provider failure (§3.8), or the Runner's own stop.
 * - Facts CW3 and CW4 enforce (per-OS refusals §3.11, root §3.12, `.cmd` argument safety §3.2); nothing here
 *   enforces them.
 *
 * Pure apart from the lookup's file inspection (a read). It spawns nothing and writes nothing.
 */

import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { CheckToolLookup } from "./check-tool-lookup.js";
import {
  CLI_DEFAULT_MODEL_ID,
  isCliArgumentValue,
  isCliVersion,
  type CliWorkerProviderId,
} from "./cli-worker-config.js";
import {
  classifyCliFailureText,
  cliProviderFailure,
  statedResetFromIso,
  statedResetFromText,
  statedResetFromUnixSeconds,
  type CliFailureKind,
  type LocalClock,
  type StatedReset,
} from "./cli-worker-failures.js";
import { cliWorkerResultSchemaJson, parseCliWorkerResult, parseCliWorkerResultText, type CliWorkerResultV1 } from "./cli-worker-result.js";
import { MODEL_CATALOG_SNAPSHOT } from "./generated/model-catalog.js";
import type { ProviderFailure } from "./provider-health.js";

// ---------------------------------------------------------------------------------------------------------------
// Facts

export type CliPlatform = "win32" | "linux" | "darwin";

/**
 * Where each CLI may run as a worker in v1 (§3.11, CWD-10, CWD-11). CW3 reports these in the free checks and CW4
 * refuses them as crew rules; this table only states them. An OS not listed is refused: nothing was measured there.
 */
export const CLI_WORKER_PLATFORM_REFUSALS: Readonly<Record<CliWorkerProviderId, Readonly<Partial<Record<CliPlatform, string>>>>> = Object.freeze({
  "codex-cli": Object.freeze({
    win32: "Codex CLI workers are not available on Windows yet: in AIBoard's tests some processes Codex started ran outside the job AIBoard stops, and that is still being traced.",
    linux: "Codex CLI workers are not available on Linux: Codex runs its commands outside the process group AIBoard can stop.",
    darwin: "Codex CLI workers are not available on macOS: Codex's commands were not measured there, and on Linux they leave the process group AIBoard can stop.",
  }),
  "claude-code": Object.freeze({
    linux: "Claude Code workers are not available on Linux: Claude Code runs its commands outside the process group AIBoard can stop.",
    darwin: "Claude Code workers are not available on macOS: Claude Code's commands were not measured there, and on Linux they leave the process group AIBoard can stop.",
  }),
  agy: Object.freeze({
    linux: "agy workers are not available on Linux yet: whether agy's commands stay in the process group AIBoard can stop was not measured.",
    darwin: "agy workers are not available on macOS yet: whether agy's commands stay in the process group AIBoard can stop was not measured.",
  }),
});

/** The refusal for this CLI on this OS (§3.11), or undefined when it may run there. */
export function cliWorkerPlatformRefusal(providerId: CliWorkerProviderId, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin")
    return `${CLI_WORKER_DISPLAY_NAMES[providerId]} workers are not available on ${platform}: AIBoard has not measured how its commands run there.`;
  return CLI_WORKER_PLATFORM_REFUSALS[providerId][platform];
}

/** §3.12: Claude Code refuses `--dangerously-skip-permissions` as root, so it is never launched to find out. */
export function cliWorkerRootRefusal(providerId: CliWorkerProviderId): string | undefined {
  return providerId === "claude-code"
    ? "Claude Code can't run as a worker when AIBoard runs as root: it refuses to skip its permission prompts as root."
    : undefined;
}

export const CLI_WORKER_DISPLAY_NAMES: Readonly<Record<CliWorkerProviderId, string>> = Object.freeze({
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  agy: "agy",
});

/**
 * The characters both Windows launchers refuse in an argument to a `.cmd` or `.bat` shim, before the batch-argv
 * probe matters: the Job host's `BuildBatchLaunch` (managed-process-job-host.ps1) and the portable child's
 * `resolveWindowsArgvLaunch` (portable-process-child.mjs). A test pins this copy to both.
 */
export const WINDOWS_BATCH_SHIM_UNSAFE_ARGUMENT = /["%!^&|<>()\r\n]/;

/**
 * The arguments a `.cmd` shim launch of this argv would be refused for, by index. Claude Code's inline
 * `--json-schema` value always has quotes, so a `.cmd` Claude Code can never be launched with it (§3.5's open
 * point): CW3 and CW4 refuse that shim with a reason. Codex and agy take their schema as a file.
 */
export function windowsBatchShimRefusedArguments(args: readonly string[]): number[] {
  return args.flatMap((arg, index) => (WINDOWS_BATCH_SHIM_UNSAFE_ARGUMENT.test(arg) ? [index] : []));
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup

export type CliExecutableForm = "exe" | "cmd" | "native";

export type CliExecutableResolution =
  | { status: "found"; path: string; source: "home" | "path"; form: CliExecutableForm }
  | { status: "missing"; source: "home" | "path" }
  | { status: "refused"; source: "home" | "path"; path: string; reason: string }
  | { status: "unknown"; source: "home" | "path"; reason: string };

export interface CliExecutableLookupInput {
  providerId: CliWorkerProviderId;
  /** The home's `executablePath`, which overrides the PATH lookup (§3.2). */
  executablePath?: string;
  /** VF2's lookup (check-tool-lookup.ts), so a CLI is found where a launch would find it. */
  lookup: CheckToolLookup;
  /**
   * The folder the lookup runs from. On Windows VF2's lookup searches it before PATH, so it must be a Runner-owned
   * folder (the Runner's state folder), never a worktree or project folder: a `claude.cmd` or `codex.exe` committed
   * at a repository's root would otherwise shadow the real CLI and run with the bypass flags. Passing the state folder
   * is the protection. As a backstop, a CLI found in this folder itself is refused; that catches the Windows
   * first-folder search, not a relative PATH entry (`.` or `bin`), which resolves under this folder's subfolders on
   * POSIX and Windows alike and which only a Runner-owned folder keeps harmless.
   */
  cwd: string;
  platform?: NodeJS.Platform;
  /** Test seam: what is at a path. */
  inspect?: (path: string) => Promise<"file" | "absent" | "unknown">;
}

/**
 * Resolves a CLI's executable once (§3.2). On Windows only an `.exe` or a `.cmd` shim is launched: any other path
 * is refused. Whether this host can launch a `.cmd` at all is the batch-argv fact, which CW3 combines with `form`.
 */
export async function resolveCliExecutable(input: CliExecutableLookupInput): Promise<CliExecutableResolution> {
  const platform = input.platform ?? process.platform;
  const override = input.executablePath;
  if (override !== undefined) {
    const absolute = platform === "win32" ? win32.isAbsolute(override) : posix.isAbsolute(override);
    if (!override.trim() || override.includes("\0") || /[\r\n]/.test(override) || !absolute)
      return { status: "refused", source: "home", path: override, reason: "The executable path must be an absolute path." };
    const form = executableForm(override, platform);
    if (!form) return { status: "refused", source: "home", path: override, reason: windowsFormReason(override) };
    const state = await (input.inspect ?? inspectPath)(override);
    if (state === "absent") return { status: "missing", source: "home" };
    if (state === "unknown") return { status: "unknown", source: "home", reason: `${override} could not be inspected.` };
    return { status: "found", path: override, source: "home", form };
  }
  const found = await input.lookup(CLI_WORKER_EXECUTABLES[input.providerId], { cwd: input.cwd });
  if (found.status === "missing") return { status: "missing", source: "path" };
  if (found.status === "unknown") return { status: "unknown", source: "path", reason: found.reason };
  const paths = platform === "win32" ? win32 : posix;
  const folder = (path: string) => (platform === "win32" ? paths.resolve(path).toLowerCase() : paths.resolve(path));
  if (folder(paths.dirname(found.path)) === folder(input.cwd))
    return { status: "refused", source: "path", path: found.path, reason: `${paths.basename(found.path)} was found in the lookup's own folder, not on PATH; AIBoard does not launch it.` };
  const form = executableForm(found.path, platform);
  if (!form) return { status: "refused", source: "path", path: found.path, reason: windowsFormReason(found.path) };
  return { status: "found", path: found.path, source: "path", form };
}

/** The command each CLI installs on PATH. */
export const CLI_WORKER_EXECUTABLES: Readonly<Record<CliWorkerProviderId, string>> = Object.freeze({
  "codex-cli": "codex",
  "claude-code": "claude",
  agy: "agy",
});

function executableForm(path: string, platform: NodeJS.Platform): CliExecutableForm | undefined {
  if (platform !== "win32") return "native";
  const extension = win32.extname(path).toLowerCase();
  return extension === ".exe" ? "exe" : extension === ".cmd" ? "cmd" : undefined;
}

function windowsFormReason(path: string): string {
  return `${win32.basename(path)} is neither an .exe nor a .cmd file; AIBoard launches only those on Windows.`;
}

async function inspectPath(path: string): Promise<"file" | "absent" | "unknown"> {
  try {
    return (await stat(path)).isFile() ? "file" : "absent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Free checks

/** What a free probe printed. The caller runs it (8 s, §3.2) and cuts its output to CLI_PROBE_OUTPUT_MAX_CHARS. */
export interface CliProbeOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type CliProbeRunner = (args: readonly string[]) => Promise<CliProbeOutput>;

/** A probe's output is cut to this many characters before it is parsed; `codex debug models` is the largest. */
export const CLI_PROBE_OUTPUT_MAX_CHARS = 4 * 1024 * 1024;

export interface CliLoginState {
  status: "logged_in" | "logged_out" | "unknown";
  /** How the CLI is logged in, as a short token (`chatgpt`, `api_key`, `claude.ai`); never a credential. */
  method?: string;
  /** Claude Code's subscription type (`pro`, `max`). */
  subscription?: string;
}

/** The version a `--version` probe printed (`codex-cli 0.169.0`, `2.1.326 (Claude Code)`, `1.5.10`). */
export function parseCliVersionOutput(stdout: string): string | undefined {
  for (const token of stdout.split(/\s+/)) {
    const candidate = token.replace(/^v(?=\d)/, "");
    if (/^\d+\.\d+/.test(candidate) && isCliVersion(candidate)) return candidate;
  }
  return undefined;
}

/** `codex login status`: exit 0 "Logged in using ChatGPT", exit 1 "Not logged in" (both on stderr, CW0). */
export function parseCodexLoginStatus(output: CliProbeOutput): CliLoginState {
  const text = `${output.stdout}\n${output.stderr}`;
  if (output.exitCode === 0 && /\blogged in\b/i.test(text) && !/\bnot logged in\b/i.test(text)) {
    const method = /\busing chatgpt\b/i.test(text) ? "chatgpt" : /\bapi key\b/i.test(text) ? "api_key" : undefined;
    return { status: "logged_in", ...(method ? { method } : {}) };
  }
  if (/\bnot logged in\b/i.test(text)) return { status: "logged_out" };
  return { status: "unknown" };
}

const SHORT_TOKEN = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * `claude auth status`: JSON with `loggedIn`, `authMethod` and `subscriptionType`, and account fields (e-mail,
 * organization, login expiry) that this parser never reads further.
 */
export function parseClaudeAuthStatus(output: CliProbeOutput): CliLoginState {
  const value = parseJsonObject(output.stdout);
  if (!value || typeof value.loggedIn !== "boolean") return { status: "unknown" };
  if (!value.loggedIn) return { status: "logged_out" };
  const method = typeof value.authMethod === "string" && SHORT_TOKEN.test(value.authMethod) ? value.authMethod : undefined;
  const subscription = typeof value.subscriptionType === "string" && SHORT_TOKEN.test(value.subscriptionType) ? value.subscriptionType : undefined;
  return { status: "logged_in", ...(method ? { method } : {}), ...(subscription ? { subscription } : {}) };
}

/** agy has no status command: `agy models` exits 0 only when logged in (§3.2). */
export function parseAgyModelsLogin(output: CliProbeOutput): CliLoginState {
  if (output.exitCode === 0) return { status: "logged_in" };
  const text = `${output.stdout}\n${output.stderr}`;
  return classifyCliFailureText(text, { includeModel: false }) === "authentication" ? { status: "logged_out" } : { status: "unknown" };
}

export interface AgyQuotaBucket {
  id: string;
  window: string;
  remainingFraction: number;
  /** Only from the `reset_time` agy stated. */
  resetsAt?: string;
}

export interface AgyQuotaGroup {
  name: string;
  /** The model names the group's description lists ("Models within this group: …"). */
  models: string[];
  buckets: AgyQuotaBucket[];
}

/** `agy --output-format json -p=/quota` (free, CW0): only the groups' names, models and buckets are kept. */
export function parseAgyQuota(stdout: string, now: number): AgyQuotaGroup[] | undefined {
  const value = parseJsonObject(stdout);
  const command = isRecord(value?.command) ? value.command : undefined;
  const data = isRecord(command?.data) ? command.data : undefined;
  if (!data || !Array.isArray(data.groups)) return undefined;
  const groups: AgyQuotaGroup[] = [];
  for (const group of data.groups.slice(0, 32)) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const name = displayText(group.name);
    if (!name) continue;
    const listed = typeof group.description === "string" ? /models within this group:\s*([^\n]*)/i.exec(group.description)?.[1] : undefined;
    const models = (listed ?? "").split(",").map((entry) => displayText(entry.replace(/\.$/, ""))).filter((entry): entry is string => Boolean(entry)).slice(0, 32);
    const buckets: AgyQuotaBucket[] = [];
    for (const bucket of group.buckets.slice(0, 16)) {
      if (!isRecord(bucket)) continue;
      const id = typeof bucket.id === "string" && SHORT_TOKEN.test(bucket.id) ? bucket.id : undefined;
      const window = typeof bucket.window === "string" && SHORT_TOKEN.test(bucket.window) ? bucket.window : undefined;
      const fraction = bucket.remaining_fraction;
      if (!id || !window || typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const reset = statedResetFromIso(bucket.reset_time, now);
      buckets.push({ id, window, remainingFraction: fraction, ...(reset ? { resetsAt: reset.resetsAt } : {}) });
    }
    groups.push({ name, models, buckets });
  }
  return groups;
}

/**
 * A usage limit `/quota` states for a model (§3.8): a bucket at 0 remaining in a group that lists the model. With
 * no model name (the CLI default) or a model no group lists, only every group having an empty bucket counts. The
 * reset is the latest `reset_time` among the empty buckets that count, since the group is usable only when all
 * have refreshed; with none stated, the failure has no `retryAfterMs`.
 *
 * `modelName` is the model's display name from `agy models`, not its id: CW3 maps the id through that list
 * (`claude-opus-5-5-low` → "Claude Opus 5.5 (Low)"). A trailing parenthetical (the effort) is dropped, and the rest
 * must equal a name the group lists, ignoring case: "Claude Opus 5" never matches "Claude Opus 5.5".
 */
export function agyQuotaFailure(groups: readonly AgyQuotaGroup[], now: number, modelName?: string): ProviderFailure | undefined {
  const name = modelName?.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase();
  const matched = name ? groups.filter((group) => group.models.some((model) => model.toLowerCase() === name)) : [];
  const empty = (group: AgyQuotaGroup) => group.buckets.filter((bucket) => bucket.remainingFraction <= 0);
  const exhausted = matched.length
    ? matched.filter((group) => empty(group).length > 0)
    : groups.length && groups.every((group) => empty(group).length > 0) ? [...groups] : [];
  if (!exhausted.length) return undefined;
  const resets = exhausted.flatMap(empty).map((bucket) => bucket.resetsAt).filter((at): at is string => Boolean(at));
  const latest = resets.length ? resets.map((at) => Date.parse(at)).reduce((a, b) => Math.max(a, b)) : undefined;
  const reset = latest === undefined ? undefined : statedResetFromUnixSeconds(latest / 1_000, now);
  const names = exhausted.map((group) => group.name).join(", ");
  return cliProviderFailure("usage_limit", `agy reports no usage left for ${names}.`, now, reset);
}

// ---------------------------------------------------------------------------------------------------------------
// Model lists (CWD-9)

export interface CliModelChoice {
  /** null is "CLI default": no model flag. */
  id: string | null;
  name: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  /** cli: the CLI listed it; catalog: AIBoard's catalog; alias: a name the CLI's `--model` accepts; default: no flag. */
  source: "cli" | "catalog" | "alias" | "default";
}

export interface CliModelList {
  models: CliModelChoice[];
  /** Where the listed models (after "CLI default") came from. */
  source: "cli" | "catalog";
  /** Why the CLI's own list was not used, when it fell back to the catalog or listed nothing. */
  note?: string;
  /** agy: whether listing showed a login (agy models is its login check). */
  login?: CliLoginState;
}

export const CLI_DEFAULT_MODEL_CHOICE: Readonly<CliModelChoice> = Object.freeze({ id: null, name: "CLI default", source: "default" });

/** Claude Code's `--effort` levels (`claude --help`, 2.1.326) and agy's (`agy --help`, 1.5.10). */
export const CLAUDE_CODE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const CLAUDE_CODE_MODEL_ALIASES = Object.freeze([
  { id: "opus", name: "Opus (Claude Code alias)" },
  { id: "sonnet", name: "Sonnet (Claude Code alias)" },
  { id: "haiku", name: "Haiku (Claude Code alias)" },
]);

/**
 * `codex debug models` (§3.2): only `visibility: "list"` entries, with their reasoning efforts. A debug command's
 * shape may change: undefined when the output does not parse or lists nothing usable, so the caller falls back.
 */
export function parseCodexDebugModels(stdout: string): CliModelChoice[] | undefined {
  const value = parseJsonObject(stdout);
  if (!value || !Array.isArray(value.models)) return undefined;
  const models: CliModelChoice[] = [];
  for (const entry of value.models) {
    if (!isRecord(entry) || entry.visibility !== "list" || !isCliArgumentValue(entry.slug)) continue;
    if (models.some((model) => model.id === entry.slug)) continue;
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((level) => isRecord(level) ? level.effort : undefined).filter(isCliArgumentValue)
      : [];
    const preferred = isCliArgumentValue(entry.default_reasoning_level) && efforts.includes(entry.default_reasoning_level)
      ? entry.default_reasoning_level : undefined;
    models.push({
      id: entry.slug,
      name: displayText(entry.display_name) ?? entry.slug,
      ...(efforts.length ? { reasoningEfforts: [...new Set(efforts)] } : {}),
      ...(preferred ? { defaultReasoningEffort: preferred } : {}),
      source: "cli",
    });
  }
  return models.length ? models : undefined;
}

/** `agy models`: a "Fetching available models..." line, then `id<TAB>name` per model (CW0). */
export function parseAgyModels(stdout: string): CliModelChoice[] {
  const models: CliModelChoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    if (!isCliArgumentValue(id) || models.some((model) => model.id === id)) continue;
    models.push({ id, name: displayText(line.slice(tab + 1)) ?? id, source: "cli" });
  }
  return models;
}

function catalogModels(providerId: "openai" | "anthropic", efforts?: readonly string[]): CliModelChoice[] {
  return MODEL_CATALOG_SNAPSHOT.models
    .filter((entry) => entry.providerId === providerId && isCliArgumentValue(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name, ...(efforts ? { reasoningEfforts: [...efforts] } : {}), source: "catalog" as const }));
}

// ---------------------------------------------------------------------------------------------------------------
// Launch (§3.5) and the Test button's form (§3.4)

interface CliLaunchCommon {
  /**
   * worker: Full access, the §3.5 form. test: the Settings Test button's most restricted form (§3.4), never with a
   * bypass flag. CW0 did not run the test forms; CW3 confirms each with a free probe or its first Test.
   */
  mode: "worker" | "test";
  /** null or absent: the CLI's default model (no flag). */
  model?: string | null;
  reasoningEffort?: string;
}

export interface CodexLaunchSpec extends CliLaunchCommon {
  /** The strict-mode schema file (cliWorkerResultSchemaJson) in the Runner-owned folder. */
  schemaPath: string;
  /** Codex's `-o` file in the Runner-owned folder. */
  outputPath: string;
  /** The task's worktree; also the process's cwd. `exec resume` has no `-C`, so the cwd carries it then. */
  worktree: string;
  /** The thread id from `thread.started`, to resume that session. */
  resumeThreadId?: string;
}

export interface ClaudeCodeLaunchSpec extends CliLaunchCommon {
  /** The schema as one line of JSON (cliWorkerResultSchemaJson); Claude Code takes it inline. */
  schemaJson: string;
  /** The session id the Runner chose (a UUID); with `resume`, the session to resume. */
  sessionId: string;
  resume?: boolean;
}

export interface AgyLaunchSpec extends CliLaunchCommon {
  schemaPath: string;
  /** The conversation id from `init`, to resume that conversation. */
  resumeConversationId?: string;
}

export type CliLaunchSpec =
  | ({ providerId: "codex-cli" } & CodexLaunchSpec)
  | ({ providerId: "claude-code" } & ClaudeCodeLaunchSpec)
  | ({ providerId: "agy" } & AgyLaunchSpec);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codex (§3.5): `exec --json --output-schema <file> -o <file> [-m <model>] [-c model_reasoning_effort=<e>] --dangerously-bypass-approvals-and-sandbox -C <worktree> -`. */
export function buildCodexArgs(spec: CodexLaunchSpec): string[] {
  const schema = runnerPath(spec.schemaPath, "schemaPath");
  const output = runnerPath(spec.outputPath, "outputPath");
  const worktree = runnerPath(spec.worktree, "worktree");
  const choice = [...modelArgs("-m", spec.model), ...(spec.reasoningEffort !== undefined ? ["-c", `model_reasoning_effort=${argumentValue(spec.reasoningEffort, "reasoningEffort")}`] : [])];
  if (spec.mode === "test") {
    if (spec.resumeThreadId !== undefined) throw new Error("A Test launch never resumes a session.");
    return ["exec", "--json", "--output-schema", schema, "-o", output, ...choice, "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", worktree, "-"];
  }
  if (spec.resumeThreadId !== undefined) {
    // CW0: `exec resume <threadId> -` takes these flags but has no `-C`; the process's cwd is the worktree.
    return ["exec", "resume", sessionValue(spec.resumeThreadId, "resumeThreadId"), "--json", "--output-schema", schema, "-o", output, ...choice,
      "--dangerously-bypass-approvals-and-sandbox", "-"];
  }
  return ["exec", "--json", "--output-schema", schema, "-o", output, ...choice, "--dangerously-bypass-approvals-and-sandbox", "-C", worktree, "-"];
}

/** Claude Code (§3.5): `-p --output-format stream-json --verbose --json-schema <schema> [--model <m>] [--effort <e>] --dangerously-skip-permissions --session-id <uuid>`. */
export function buildClaudeCodeArgs(spec: ClaudeCodeLaunchSpec): string[] {
  const schema = inlineSchema(spec.schemaJson);
  const choice = [...modelArgs("--model", spec.model), ...(spec.reasoningEffort !== undefined ? ["--effort", argumentValue(spec.reasoningEffort, "reasoningEffort")] : [])];
  const session = sessionValue(spec.sessionId, "sessionId");
  const head = ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", schema, ...choice];
  if (spec.mode === "test") {
    if (spec.resume) throw new Error("A Test launch never resumes a session.");
    return [...head, "--permission-mode", "plan", "--no-session-persistence"];
  }
  // CW0: `--resume <uuid>` in place of `--session-id`, from the same cwd (sessions are stored per project folder).
  return [...head, "--dangerously-skip-permissions", ...(spec.resume ? ["--resume", session] : ["--session-id", session])];
}

/** agy (§3.5, amended after CW0): `--input-format stream-json --output-format stream-json --json-schema <file> [--model <m>] [--effort <e>] --dangerously-skip-permissions --print-timeout 0 -p=`. */
export function buildAgyArgs(spec: AgyLaunchSpec): string[] {
  const schema = runnerPath(spec.schemaPath, "schemaPath");
  const conversation = spec.resumeConversationId !== undefined ? ["--conversation", sessionValue(spec.resumeConversationId, "resumeConversationId")] : [];
  if (spec.mode === "test" && conversation.length) throw new Error("A Test launch never resumes a session.");
  const choice = [...modelArgs("--model", spec.model), ...(spec.reasoningEffort !== undefined ? ["--effort", argumentValue(spec.reasoningEffort, "reasoningEffort")] : [])];
  // `-p` takes the next argument as its prompt, so its empty value is attached and last (CW0).
  return ["--input-format", "stream-json", "--output-format", "stream-json", "--json-schema", schema, ...conversation, ...choice,
    ...(spec.mode === "test" ? ["--mode", "plan"] : ["--dangerously-skip-permissions"]), "--print-timeout", "0", "-p="];
}

export function buildCliWorkerArgs(spec: CliLaunchSpec): string[] {
  switch (spec.providerId) {
    case "codex-cli": return buildCodexArgs(spec);
    case "claude-code": return buildClaudeCodeArgs(spec);
    case "agy": return buildAgyArgs(spec);
  }
}

/**
 * What goes on the CLI's stdin, which is then closed (§3.5 step 2). Codex (`-`) and Claude Code read the prompt as
 * text; agy reads one stream-json line, `{"event":"user","message":{"content":…}}`, then EOF (CW0).
 */
export function buildCliWorkerStdin(providerId: CliWorkerProviderId, prompt: string): string {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A CLI worker's prompt must not be empty.");
  if (providerId === "agy") return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
  return prompt.endsWith("\n") ? prompt : `${prompt}\n`;
}

function modelArgs(flag: string, model: string | null | undefined): string[] {
  if (model === undefined || model === null) return [];
  if (model === CLI_DEFAULT_MODEL_ID) throw new Error(`The model "${CLI_DEFAULT_MODEL_ID}" is the CLI default: pass null.`);
  return [flag, argumentValue(model, "model")];
}

function argumentValue(value: string, name: string): string {
  if (!isCliArgumentValue(value)) throw new Error(`${name} must be 1 to 128 of A-Z a-z 0-9 . _ : / - and not start with -.`);
  return value;
}

function sessionValue(value: string, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${name} must be a UUID.`);
  return value;
}

/** A path the Runner built: absolute on either platform's rules, one line, never read as a flag. */
function runnerPath(value: string, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/.test(value) || value.startsWith("-") ||
      !(win32.isAbsolute(value) || posix.isAbsolute(value)))
    throw new Error(`${name} must be an absolute path on one line.`);
  return value;
}

function inlineSchema(value: string): string {
  if (typeof value !== "string" || !value.startsWith("{") || /[\0\r\n]/.test(value)) throw new Error("schemaJson must be one line of JSON.");
  try {
    if (!isRecord(JSON.parse(value))) throw new Error("not an object");
  } catch {
    throw new Error("schemaJson must be one line of JSON.");
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// The prompt (§3.5 step 1)

export interface CliWorkerPromptInput {
  /** The same context pack text an API worker gets. */
  taskContext: string;
  /** "Earlier work on this task" (§3.9), when another worker worked on this attempt before. */
  earlierWork?: string;
  /** One line about the browser: the running Playwright CLI session and its skill file, or why there is none (§3.10). */
  browserNote?: string;
}

/**
 * The CLI's prompt: the context pack, then the preamble that restates the worker rules for a CLI, then any handoff
 * section. It goes on stdin (buildCliWorkerStdin), never in argv.
 */
export function buildCliWorkerPrompt(input: CliWorkerPromptInput): string {
  if (!input.taskContext.trim()) throw new Error("A CLI worker's prompt needs the task context.");
  const rules = [
    "- Work only in this folder, the task's worktree. Do not commit, push, create branches or tags, install packages globally, or change Git config: AIBoard commits your work itself.",
    "- Files under docs/project/ belong to the Architect. Do not change them.",
    "- Verify by impact, narrowest check first. Never weaken, skip or delete a test to make it pass. Run each check as its own command: one program and its arguments, without &&, pipes or redirection.",
    ...(input.browserNote?.trim() ? [`- ${input.browserNote.trim()}`] : []),
    "- End your turn with the JSON result the schema describes. outcome is \"done\" when the task is complete, \"needs_decision\" with a question when you need the Architect to decide something, or \"cannot_do\" with replanReason when the task cannot be done as planned.",
    "- List every check you ran in checks, as its executable and arguments, with the acceptance criterion ids it supports. AIBoard runs each listed check again itself; only those runs count as evidence. Put checks you could not run in notRun, with why.",
  ];
  return [
    input.taskContext.trim(),
    "",
    "## How to work here (AIBoard CLI worker)",
    ...rules,
    ...(input.earlierWork?.trim() ? ["", "## Earlier work on this task", input.earlierWork.trim()] : []),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a run

export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from cache, as the CLI reports them. */
  cacheReadTokens?: number;
  /** Input tokens written to cache (Codex, Claude Code). */
  cacheWriteTokens?: number;
  /** Reasoning or thinking tokens, when reported apart from output. */
  reasoningTokens?: number;
  /** Every input token, cached or not, so the CLIs compare: Codex's input already includes its cached tokens. */
  totalInputTokens: number;
}

export interface CliRateLimitWindow {
  /** `five_hour`, `seven_day`, … */
  window: string;
  status: string;
  utilization?: number;
  resetsAt?: string;
}

export interface CliRunInput {
  stdout: string;
  stderr?: string;
  /** null when the process was signalled or is still running. */
  exitCode: number | null;
  /** Codex's `-o` file as read after exit; null or undefined when it could not be read. */
  outputFile?: string | Uint8Array | null;
  /**
   * The Runner stopped the CLI mid-turn: its attempt deadline, or the Build was cancelled. Then any reading other than
   * a result is `stopped`, never a provider failure (§3.8): what the CLI printed while it was being stopped ("Request
   * was aborted.", "Turn interrupted", a reconnect notice) says nothing about its provider.
   *
   * The contract: the caller sets it only when the reader's `turnEnded` was false at the moment the deadline or
   * cancel signal was sent. A turn that had already ended carries the CLI's own outcome: a failure it delivered
   * before the stop (Claude Code's `is_error` usage-limit result while a background task kept the process up) is read
   * by itself, so its cooldown is set. A caller with the live stream reader calls `noteRunnerStop` when it sends the
   * signal instead; that records the stop only while the turn has not ended, and wins over this field.
   */
  stoppedBy?: "deadline" | "cancelled";
  /** The time stated resets are measured from. */
  now?: number;
  /** The zone a stated clock time is read in; this machine's by default. */
  localClock?: LocalClock;
}

export type CliRunOutcome =
  | { type: "result"; result: CliWorkerResultV1 }
  | { type: "failure"; failure: ProviderFailure; reason: "cli_error" | "no_result" | "unreadable_result" }
  | { type: "stopped"; reason: "deadline" | "cancelled" };

export interface CliRunReading {
  outcome: CliRunOutcome;
  /** Codex's thread id, Claude Code's session id, agy's conversation id: the resume key. */
  sessionId?: string;
  /** The CLI ended its turn (a `result` event, or Codex's `turn.completed` / `turn.failed`). */
  turnEnded: boolean;
  usage?: CliUsage;
  /** The model the CLI reported using, when it did (Claude Code's `modelUsage` key or `init.model`). */
  model?: string;
  /** Claude Code's last `rate_limit_event` per window. */
  rateLimits?: CliRateLimitWindow[];
}

/** An incremental reader of a CLI's stdout: LF or CRLF lines, any chunking. It keeps only the fields it reads. */
export interface CliStreamReader {
  push(chunk: string): void;
  /** Reads a last line that has no newline. */
  end(): void;
  readonly turnEnded: boolean;
  readonly sessionId: string | undefined;
  /**
   * The Runner is sending its deadline or cancel signal now. Recorded only while the turn has not ended (returns
   * false, recording nothing, once it has), so a failure the CLI delivered first is still read as that failure.
   */
  noteRunnerStop(reason: "deadline" | "cancelled"): boolean;
  /**
   * Classifies the run once the CLI exited, delivered its result, or was stopped. In this order: a result the CLI
   * delivered; the Runner's own stop; the CLI's decisive failure (Codex `turn.failed`, Claude Code's `is_error`
   * result, agy's `ERROR` result), read by itself; then, with none of those, a failure stderr names; else no result.
   */
  read(input: Omit<CliRunInput, "stdout">): CliRunReading;
}

/** A line longer than this is dropped unread (and a result it held is then missing, which reads as no result). */
export const CLI_STREAM_LINE_MAX_CHARS = 16 * 1024 * 1024;
const TEXT_KEEP = 8_000;
const SIDE_MESSAGES_KEEP = 8;

abstract class JsonLineReader implements CliStreamReader {
  /** The unfinished line's pieces; each chunk is scanned for a newline once, so reading is linear in the output. */
  private pending: string[] = [];
  private pendingLength = 0;
  /** The unfinished line is over the cap: its pieces are discarded until its newline. */
  private dropping = false;
  /** The Runner's stop, recorded by noteRunnerStop while the turn had not ended. */
  private runnerStop: "deadline" | "cancelled" | undefined;
  abstract readonly turnEnded: boolean;
  abstract readonly sessionId: string | undefined;

  noteRunnerStop(reason: "deadline" | "cancelled"): boolean {
    if (this.turnEnded) return false;
    this.runnerStop ??= reason;
    return true;
  }

  /** The stop to read the run as: the one noted on the live reader, else the caller's (CliRunInput.stoppedBy). */
  protected runnerStopFor(input: Omit<CliRunInput, "stdout">): "deadline" | "cancelled" | undefined {
    return this.runnerStop ?? input.stoppedBy;
  }

  push(chunk: string): void {
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline >= 0) {
      this.take(chunk.slice(start, newline));
      this.finishLine();
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) this.take(chunk.slice(start));
  }

  end(): void {
    this.finishLine();
  }

  private take(piece: string): void {
    if (this.dropping) return;
    if (this.pendingLength + piece.length > CLI_STREAM_LINE_MAX_CHARS) {
      this.dropping = true;
      this.pending = [];
      this.pendingLength = 0;
      return;
    }
    this.pending.push(piece);
    this.pendingLength += piece.length;
  }

  private finishLine(): void {
    const line = this.dropping ? "" : this.pending.join("");
    this.pending = [];
    this.pendingLength = 0;
    this.dropping = false;
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed.startsWith("{")) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (isRecord(value)) this.event(value);
  }

  protected abstract event(value: Record<string, unknown>): void;
  abstract read(input: Omit<CliRunInput, "stdout">): CliRunReading;
}

/**
 * Codex's notices that it is retrying a connection. A retry that later succeeds says nothing about the run, so they
 * are never side messages: a recovered 401 must not cool Codex down for a day.
 */
const CODEX_RETRY_NOTICE = /^\s*(?:Reconnecting\.\.\.|Falling back from WebSockets)/i;

/**
 * Codex `exec --json`: thread id, usage, `turn.completed` and `turn.failed`. Its `error` events and items are never
 * fatal on their own (CW0): only `turn.failed` ends a turn as a failure.
 */
class CodexStreamReader extends JsonLineReader {
  private threadId: string | undefined;
  private completed = false;
  private failedMessage: string | undefined;
  private readonly sideMessages: string[] = [];
  private usage: CliUsage | undefined;

  get turnEnded(): boolean { return this.completed || this.failedMessage !== undefined; }
  get sessionId(): string | undefined { return this.threadId; }

  protected event(value: Record<string, unknown>): void {
    switch (value.type) {
      case "thread.started":
        if (typeof value.thread_id === "string" && UUID.test(value.thread_id)) this.threadId = value.thread_id;
        return;
      case "turn.completed":
        this.completed = true;
        this.usage = addUsage(this.usage, codexUsage(value.usage));
        return;
      case "turn.failed": {
        const error = isRecord(value.error) ? value.error : undefined;
        this.failedMessage = keep(typeof error?.message === "string" ? error.message : "The Codex turn failed.");
        return;
      }
      case "error":
        if (typeof value.message === "string") this.side(value.message);
        return;
      case "item.completed": {
        const item = isRecord(value.item) ? value.item : undefined;
        if (item?.type === "error" && typeof item.message === "string") this.side(item.message);
        return;
      }
    }
  }

  private side(message: string): void {
    if (CODEX_RETRY_NOTICE.test(message)) return;
    this.sideMessages.push(keep(message));
    if (this.sideMessages.length > SIDE_MESSAGES_KEEP) this.sideMessages.shift();
  }

  read(input: Omit<CliRunInput, "stdout">): CliRunReading {
    const now = input.now ?? Date.now();
    const base = { ...(this.threadId ? { sessionId: this.threadId } : {}), turnEnded: this.turnEnded, ...(this.usage ? { usage: this.usage } : {}) };
    // A result is this run's: the turn completed, Codex exited 0, and the -o file parses. The file exists even when a
    // run failed or was killed (0 bytes, CW0), and one left by an earlier attempt has no turn.completed in this stream.
    const completedRun = this.completed && this.failedMessage === undefined && input.exitCode === 0;
    const fileText = input.outputFile === undefined || input.outputFile === null ? "" : typeof input.outputFile === "string"
      ? input.outputFile : Buffer.from(input.outputFile).toString("utf8");
    const parsed = completedRun && fileText.trim() ? parseCliWorkerResultText(fileText) : undefined;
    if (parsed?.ok) return { ...base, outcome: { type: "result", result: parsed.result } };
    const stoppedBy = this.runnerStopFor(input);
    if (stoppedBy) return { ...base, outcome: { type: "stopped", reason: stoppedBy } };
    if (this.failedMessage !== undefined)
      return { ...base, outcome: failure(classifyCliFailureText(this.failedMessage), this.failedMessage, now, "cli_error", undefined, input.localClock) };
    if (parsed) return { ...base, outcome: failure("transient", `Codex's result could not be read: ${parsed.reason}`, now, "unreadable_result") };
    if (completedRun) return { ...base, outcome: failure("transient", "Codex completed its turn but wrote no result.", now, "no_result") };
    const side = sideFailure([...this.sideMessages].reverse(), input.stderr, now, input.localClock);
    if (side) return { ...base, outcome: side };
    return { ...base, outcome: failure("transient", noResultMessage("Codex", input.exitCode), now, "no_result") };
  }
}

function codexUsage(value: unknown): CliUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input_tokens), output = count(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = count(value.cached_input_tokens), written = count(value.cache_write_input_tokens), reasoning = count(value.reasoning_output_tokens);
  return {
    inputTokens: input, outputTokens: output,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalInputTokens: input,
  };
}

/** Claude Code `--output-format stream-json --verbose`: its `result` event ends the turn (CW0); json mode's one object reads the same. */
class ClaudeCodeStreamReader extends JsonLineReader {
  private session: string | undefined;
  private initModel: string | undefined;
  private assistantError: string | undefined;
  private result: Record<string, unknown> | undefined;
  private readonly windows = new Map<string, CliRateLimitWindow & { resetSeconds?: number }>();

  get turnEnded(): boolean { return this.result !== undefined; }
  get sessionId(): string | undefined { return this.session; }

  protected event(value: Record<string, unknown>): void {
    if (typeof value.session_id === "string" && UUID.test(value.session_id)) this.session ??= value.session_id;
    switch (value.type) {
      case "system":
        if (value.subtype === "init" && isCliArgumentValue(value.model)) this.initModel = value.model;
        return;
      case "assistant":
        if (typeof value.error === "string" && SHORT_TOKEN.test(value.error)) this.assistantError = value.error;
        return;
      case "rate_limit_event":
        this.rateLimit(value.rate_limit_info);
        return;
      case "result":
        // Only the fields the reader uses are kept; `credential_expires_at` and the rest are left behind.
        this.result = pick(value, ["is_error", "subtype", "result", "structured_output", "api_error_status", "api_error_type", "terminal_reason", "usage", "modelUsage", "session_id"]);
        if (typeof value.session_id === "string" && UUID.test(value.session_id)) this.session = value.session_id;
        return;
    }
  }

  private rateLimit(info: unknown): void {
    if (!isRecord(info)) return;
    const record = (window: string, entry: Record<string, unknown>) => {
      if (!SHORT_TOKEN.test(window) || typeof entry.status !== "string" || !SHORT_TOKEN.test(entry.status)) return;
      const seconds = typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt) ? entry.resetsAt : undefined;
      const utilization = typeof entry.utilization === "number" && Number.isFinite(entry.utilization) ? entry.utilization : undefined;
      this.windows.set(window, {
        window, status: entry.status,
        ...(utilization !== undefined ? { utilization } : {}),
        ...(seconds !== undefined ? { resetSeconds: seconds, resetsAt: new Date(seconds * 1_000).toISOString() } : {}),
      });
    };
    const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : undefined;
    if (unified) for (const [window, entry] of Object.entries(unified)) if (isRecord(entry)) record(window, entry);
    if (typeof info.rateLimitType === "string") record(info.rateLimitType, info);
  }

  read(input: Omit<CliRunInput, "stdout">): CliRunReading {
    const now = input.now ?? Date.now();
    const result = this.result;
    const usage = result ? claudeUsage(result.usage) : undefined;
    const model = result && isRecord(result.modelUsage) ? Object.keys(result.modelUsage).find(isCliArgumentValue) : undefined;
    const rateLimits = [...this.windows.values()].map(({ resetSeconds: _seconds, ...window }) => window);
    const base = {
      ...(this.session ? { sessionId: this.session } : {}),
      turnEnded: this.turnEnded,
      ...(usage ? { usage } : {}),
      ...((model ?? this.initModel) ? { model: (model ?? this.initModel)! } : {}),
      ...(rateLimits.length ? { rateLimits } : {}),
    };
    const text = result && typeof result.result === "string" ? keep(result.result) : "";
    const parsed = result && result.is_error !== true
      ? result.structured_output !== undefined && result.structured_output !== null
        ? parseCliWorkerResult(result.structured_output) : parseCliWorkerResultText(text)
      : undefined;
    if (parsed?.ok) return { ...base, outcome: { type: "result", result: parsed.result } };
    const stoppedBy = this.runnerStopFor(input);
    if (stoppedBy) return { ...base, outcome: { type: "stopped", reason: stoppedBy } };
    const rejected = [...this.windows.values()].filter((window) => window.status === "rejected");
    const rejectedReset = rejected
      .map((window) => statedResetFromUnixSeconds(window.resetSeconds, now))
      .filter((reset): reset is StatedReset => reset !== undefined)
      .sort((a, b) => b.retryAfterMs - a.retryAfterMs)[0];
    if (result?.is_error === true) return { ...base, outcome: this.errorOutcome(result, text, rejected.length > 0, rejectedReset, now, input.localClock) };
    if (parsed) return { ...base, outcome: failure("transient", `Claude Code's result could not be read: ${parsed.reason}`, now, "unreadable_result") };
    if (rejected.length) return { ...base, outcome: failure("usage_limit", "Claude Code's usage limit was reached.", now, "cli_error", rejectedReset) };
    const stderr = input.stderr ?? "";
    // As root, Claude Code refuses the bypass flag before any request (§3.12). CW4 refuses that launch first; if one
    // happens anyway, it is a setup the owner must change, like a missing executable, so it is `authentication`.
    if (/cannot be used with root\/sudo privileges/i.test(stderr))
      return { ...base, outcome: failure("authentication", stderr, now, "cli_error") };
    const side = sideFailure([], stderr, now, input.localClock);
    if (side) return { ...base, outcome: side };
    return { ...base, outcome: failure("transient", noResultMessage("Claude Code", input.exitCode), now, "no_result") };
  }

  private errorOutcome(result: Record<string, unknown>, text: string, rejected: boolean, reset: StatedReset | undefined, now: number, clock?: LocalClock): CliRunOutcome {
    const status = typeof result.api_error_status === "number" ? result.api_error_status : undefined;
    const type = typeof result.api_error_type === "string" ? result.api_error_type : "";
    const textKind = classifyCliFailureText(text);
    let kind: CliFailureKind;
    if (status === 401 || status === 403 || this.assistantError === "authentication_failed" || (status === 404 && type === "not_found_error")) kind = "authentication";
    else if (textKind === "authentication" || textKind === "usage_limit") kind = textKind;
    else if (rejected || this.assistantError === "billing_error") kind = "usage_limit";
    else if (status === 429 || this.assistantError === "rate_limit") kind = "rate_limit";
    else if ((status !== undefined && status >= 500) || type === "overloaded_error" || type === "api_error" || this.assistantError === "server_error") kind = "provider_unavailable";
    else kind = textKind;
    const detail = text || [status, type].filter(Boolean).join(" ") || "Claude Code reported an error.";
    return failure(kind, detail, now, "cli_error", kind === "usage_limit" ? reset : undefined, clock);
  }
}

function claudeUsage(value: unknown): CliUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input_tokens), output = count(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const read = count(value.cache_read_input_tokens), written = count(value.cache_creation_input_tokens);
  return {
    inputTokens: input, outputTokens: output,
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    totalInputTokens: input + (read ?? 0) + (written ?? 0),
  };
}

/** agy stream-json: `init`, `step_update`s, then a `result` event that ends the turn. Its `retryable` is never read. */
class AgyStreamReader extends JsonLineReader {
  private conversation: string | undefined;
  private result: Record<string, unknown> | undefined;

  get turnEnded(): boolean { return this.result !== undefined; }
  get sessionId(): string | undefined { return this.conversation; }

  protected event(value: Record<string, unknown>): void {
    if (value.event === "init" && typeof value.conversation_id === "string" && UUID.test(value.conversation_id)) {
      this.conversation = value.conversation_id;
      return;
    }
    // `--output-format json` prints the result's fields as one object at the top level.
    const result = value.event === "result" && isRecord(value.result) ? value.result
      : value.event === undefined && typeof value.status === "string" && "conversation_id" in value ? value : undefined;
    if (!result) return;
    this.result = pick(result, ["status", "response", "structured_output", "error", "finished_reason", "usage", "conversation_id"]);
    if (typeof result.conversation_id === "string" && UUID.test(result.conversation_id)) this.conversation = result.conversation_id;
  }

  read(input: Omit<CliRunInput, "stdout">): CliRunReading {
    const now = input.now ?? Date.now();
    const result = this.result;
    const usage = result ? agyUsage(result.usage) : undefined;
    const base = { ...(this.conversation ? { sessionId: this.conversation } : {}), turnEnded: this.turnEnded, ...(usage ? { usage } : {}) };
    const stderr = input.stderr ?? "";
    const parsed = result && result.status === "SUCCESS"
      ? result.structured_output !== undefined && result.structured_output !== null
        ? parseCliWorkerResult(result.structured_output)
        : parseCliWorkerResultText(typeof result.response === "string" ? result.response : "")
      : undefined;
    if (parsed?.ok) return { ...base, outcome: { type: "result", result: parsed.result } };
    const stoppedBy = this.runnerStopFor(input);
    if (stoppedBy) return { ...base, outcome: { type: "stopped", reason: stoppedBy } };
    if (parsed) return { ...base, outcome: failure("transient", `agy's result could not be read: ${parsed.reason}`, now, "unreadable_result") };
    if (result) {
      const text = keep(typeof result.error === "string" && result.error.trim() ? result.error : stderr || "agy reported an error.");
      let kind = classifyCliFailureText(text);
      // Exit 3 is agy's model or agent error; with a stated reset it is the quota failure the owner's logs show.
      if (kind === "transient" && input.exitCode === 3 && statedResetFromText(text, now, input.localClock)) kind = "usage_limit";
      return { ...base, outcome: failure(kind, text, now, "cli_error", undefined, input.localClock) };
    }
    const side = sideFailure([], stderr, now, input.localClock, input.exitCode === 3);
    if (side) return { ...base, outcome: side };
    return { ...base, outcome: failure("transient", noResultMessage("agy", input.exitCode), now, "no_result") };
  }
}

function agyUsage(value: unknown): CliUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = count(value.input_tokens), output = count(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const read = count(value.cache_read_tokens), thinking = count(value.thinking_tokens);
  return {
    inputTokens: input, outputTokens: output,
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(thinking !== undefined ? { reasoningTokens: thinking } : {}),
    totalInputTokens: input + (read ?? 0),
  };
}

/**
 * A failure that side messages (Codex's non-retry `error` events, stderr) name, read only when the CLI delivered no
 * result and no decisive failure. The model rule is left out: a Codex warning that a model's metadata is unknown is
 * not a failure by itself.
 */
function sideFailure(messages: readonly string[], stderr: string | undefined, now: number, clock: LocalClock | undefined, agyExit3 = false): CliRunOutcome | undefined {
  for (const message of [...messages, stderr ?? ""]) {
    const text = keep(message);
    let kind = classifyCliFailureText(text, { includeModel: false });
    if (kind === "transient" && agyExit3 && statedResetFromText(text, now, clock)) kind = "usage_limit";
    if (kind !== "transient") return failure(kind, text, now, "cli_error", undefined, clock);
  }
  return undefined;
}

function failure(kind: CliFailureKind, text: string, now: number, reason: "cli_error" | "no_result" | "unreadable_result", reset?: StatedReset, clock?: LocalClock): CliRunOutcome {
  return { type: "failure", failure: cliProviderFailure(kind, text, now, reset, clock), reason };
}

function noResultMessage(name: string, exitCode: number | null): string {
  return exitCode === null ? `${name} stopped without a result.` : `${name} exited with code ${exitCode} without a result.`;
}

function addUsage(previous: CliUsage | undefined, next: CliUsage | undefined): CliUsage | undefined {
  if (!previous || !next) return next ?? previous;
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const read = sum(previous.cacheReadTokens, next.cacheReadTokens), written = sum(previous.cacheWriteTokens, next.cacheWriteTokens);
  const reasoning = sum(previous.reasoningTokens, next.reasoningTokens);
  return {
    inputTokens: previous.inputTokens + next.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalInputTokens: previous.totalInputTokens + next.totalInputTokens,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The adapters

export interface CliFreeCheckArgs {
  version: readonly string[];
  /** Codex `login status`, Claude Code `auth status`, agy `models` (it exits 0 only when logged in). */
  login: readonly string[];
  /** The model list probe, when the CLI has one. */
  models?: readonly string[];
  /** agy's free `/quota`, passed as one argv entry so no shell rewrites it. */
  quota?: readonly string[];
}

export interface CliWorkerAdapter {
  readonly providerId: CliWorkerProviderId;
  readonly displayName: string;
  readonly executableName: string;
  /** When the result is complete: Codex at exit (its `-o` file); Claude Code and agy at their `result` event. */
  readonly resultDelivery: "exit_output_file" | "result_event";
  /** Codex and agy read the schema from a file; Claude Code takes it inline as one argument. */
  readonly schemaDelivery: "file" | "inline_argument";
  readonly freeChecks: CliFreeCheckArgs;
  parseLogin(output: CliProbeOutput): CliLoginState;
  /** The models Settings and the crew picker offer, "CLI default" first (CWD-9). */
  listModels(probe?: CliProbeRunner): Promise<CliModelList>;
  createStreamReader(): CliStreamReader;
  /** Reads a whole run at once: the stream reader over all of stdout. */
  readRun(input: CliRunInput): CliRunReading;
}

function readWith(reader: CliStreamReader, input: CliRunInput): CliRunReading {
  reader.push(input.stdout);
  reader.end();
  const { stdout: _stdout, ...rest } = input;
  return reader.read(rest);
}

const codexAdapter: CliWorkerAdapter = Object.freeze({
  providerId: "codex-cli",
  displayName: CLI_WORKER_DISPLAY_NAMES["codex-cli"],
  executableName: CLI_WORKER_EXECUTABLES["codex-cli"],
  resultDelivery: "exit_output_file",
  schemaDelivery: "file",
  freeChecks: Object.freeze({ version: ["--version"], login: ["login", "status"], models: ["debug", "models"] }),
  parseLogin: parseCodexLoginStatus,
  async listModels(probe?: CliProbeRunner): Promise<CliModelList> {
    const fallback = (note: string): CliModelList => ({ models: [{ ...CLI_DEFAULT_MODEL_CHOICE }, ...catalogModels("openai")], source: "catalog", note });
    if (!probe) return fallback("Codex's model list was not read; these are AIBoard's OpenAI models.");
    let output: CliProbeOutput;
    try {
      output = await probe(["debug", "models"]);
    } catch {
      return fallback("codex debug models could not be run; these are AIBoard's OpenAI models.");
    }
    const models = output.exitCode === 0 ? parseCodexDebugModels(output.stdout.slice(0, CLI_PROBE_OUTPUT_MAX_CHARS)) : undefined;
    if (!models) return fallback("codex debug models printed nothing AIBoard can read; these are AIBoard's OpenAI models.");
    return { models: [{ ...CLI_DEFAULT_MODEL_CHOICE }, ...models], source: "cli" };
  },
  createStreamReader: () => new CodexStreamReader(),
  readRun: (input: CliRunInput) => readWith(new CodexStreamReader(), input),
});

const claudeCodeAdapter: CliWorkerAdapter = Object.freeze({
  providerId: "claude-code",
  displayName: CLI_WORKER_DISPLAY_NAMES["claude-code"],
  executableName: CLI_WORKER_EXECUTABLES["claude-code"],
  resultDelivery: "result_event",
  schemaDelivery: "inline_argument",
  freeChecks: Object.freeze({ version: ["--version"], login: ["auth", "status"] }),
  parseLogin: parseClaudeAuthStatus,
  async listModels(): Promise<CliModelList> {
    // No list command: the catalog's Anthropic models, as the Anthropic provider lists them, plus the aliases `--model` accepts.
    const aliases = CLAUDE_CODE_MODEL_ALIASES.map((alias) => ({ ...alias, reasoningEfforts: [...CLAUDE_CODE_EFFORTS], source: "alias" as const }));
    return { models: [{ ...CLI_DEFAULT_MODEL_CHOICE }, ...catalogModels("anthropic", CLAUDE_CODE_EFFORTS), ...aliases], source: "catalog" };
  },
  createStreamReader: () => new ClaudeCodeStreamReader(),
  readRun: (input: CliRunInput) => readWith(new ClaudeCodeStreamReader(), input),
});

const agyAdapter: CliWorkerAdapter = Object.freeze({
  providerId: "agy",
  displayName: CLI_WORKER_DISPLAY_NAMES.agy,
  executableName: CLI_WORKER_EXECUTABLES.agy,
  resultDelivery: "result_event",
  schemaDelivery: "file",
  freeChecks: Object.freeze({ version: ["--version"], login: ["models"], models: ["models"], quota: ["--output-format", "json", "-p=/quota"] }),
  parseLogin: parseAgyModelsLogin,
  async listModels(probe?: CliProbeRunner): Promise<CliModelList> {
    const only = (note: string, login?: CliLoginState): CliModelList => ({ models: [{ ...CLI_DEFAULT_MODEL_CHOICE }], source: "cli", note, ...(login ? { login } : {}) });
    if (!probe) return only("agy's model list was not read.");
    let output: CliProbeOutput;
    try {
      output = await probe(["models"]);
    } catch {
      return only("agy models could not be run.");
    }
    const login = parseAgyModelsLogin(output);
    if (output.exitCode !== 0) return only(login.status === "logged_out" ? "agy is not logged in." : "agy models failed.", login);
    const models = parseAgyModels(output.stdout.slice(0, CLI_PROBE_OUTPUT_MAX_CHARS));
    return { models: [{ ...CLI_DEFAULT_MODEL_CHOICE }, ...models], source: "cli", login, ...(models.length ? {} : { note: "agy models listed no model." }) };
  },
  createStreamReader: () => new AgyStreamReader(),
  readRun: (input: CliRunInput) => readWith(new AgyStreamReader(), input),
});

export const CLI_WORKER_ADAPTERS: Readonly<Record<CliWorkerProviderId, CliWorkerAdapter>> = Object.freeze({
  "codex-cli": codexAdapter,
  "claude-code": claudeCodeAdapter,
  agy: agyAdapter,
});

/** The result schema each CLI is given, as file content or as Claude Code's inline value. */
export { cliWorkerResultSchemaJson };

/** The failure for a CLI whose executable is gone mid-Build (§3.8): the owner must fix the setup. */
export function cliExecutableMissingFailure(providerId: CliWorkerProviderId, now = Date.now()): ProviderFailure {
  return cliProviderFailure("authentication", `${CLI_WORKER_DISPLAY_NAMES[providerId]} is no longer installed where AIBoard found it.`, now);
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (key in value) picked[key] = value[key];
  return picked;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function keep(text: string): string {
  return text.length <= TEXT_KEEP ? text : text.slice(0, TEXT_KEEP);
}

/** A short display name: one line, printable, at most 100 characters. */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= 100 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
