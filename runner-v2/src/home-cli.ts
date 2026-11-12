import { homedir } from "node:os";

import { AiboardHomeError, resolveAiboardHome, type AiboardHomeLocation } from "./aiboard-home-paths.js";
import {
  applyHomeBatch,
  readAiboardHome,
  resetHomeCredentials,
  type AiboardHomeConfigV1,
  type AiboardHomeSnapshot,
  type HomeOp,
  type HomeWriteOptions,
} from "./aiboard-home-store.js";
import { MODEL_CATALOG_SNAPSHOT } from "./generated/model-catalog.js";
import { formatFullModelId, migrateFullModelId, snapshotCatalogModel, snapshotProvider, snapshotProviderIds } from "./home-model-policy.js";
import { checkHomeModelId, HomeModelError, listHomeEnabledModels, listHomeProviderModelIds, type HomeModelIdCheck } from "./home-runtime.js";

/**
 * The AIBoard home from a terminal (Simple Build plan §6.6, packet HM5): `aiboard config`, `aiboard
 * keys` and `aiboard models`. They start no Runner, make no network call, and write only through
 * `applyHomeBatch`: read the home, then one batch at that revision; on `home_conflict` read again and
 * retry once, so a concurrent edit from the web is never dropped.
 *
 * Keys never come from argv. At a terminal the prompt switches the terminal to raw mode and echoes
 * nothing; a stdin that is not a terminal is read only with `--stdin`. The home-writing commands
 * refuse inside an AIBoard task or a Runner's child (§11.4), so a task cannot rewrite the user's home.
 */

// ------------------------------------------------------------------ arguments

export type HomeCommand =
  | { command: "config"; action: "show"; json: boolean }
  | { command: "config"; action: "set"; key: string; value: string }
  | { command: "keys"; action: "set"; provider: string; stdin: boolean }
  | { command: "keys"; action: "remove"; provider: string }
  | { command: "keys"; action: "reset"; yes: boolean }
  | { command: "models"; action: "list"; json: boolean }
  | { command: "models"; action: "enable" | "disable"; id: string };

export const HOME_COMMANDS = ["config", "keys", "models"] as const;
export type HomeCommandName = typeof HOME_COMMANDS[number];

const KEY_ON_ARGV =
  "aiboard keys set takes no key on the command line, where it would stay in your shell history and process list. " +
  "Answer the prompt, or pipe the key: `<command printing the key> | aiboard keys set <provider> --stdin`.";

function invalid(message: string): Error {
  return new Error(`invalid_arguments: ${message}`);
}

function noMore(rest: string[], usage: string): void {
  if (rest.length > 0) throw invalid(`Unexpected ${rest[0]!.startsWith("-") ? "option" : "argument"}. Usage: ${usage}`);
}

/** Parses `aiboard config|keys|models …` (argv after the command name). Never echoes a value that could be a key. */
export function parseHomeCommand(name: HomeCommandName, raw: readonly string[]): HomeCommand {
  const args = [...raw];
  if (name === "config") {
    if (args[0] === "set") {
      const [, key, value, ...rest] = args;
      if (!key || value === undefined) throw invalid("Usage: aiboard config set <key> <value>.");
      noMore(rest, "aiboard config set <key> <value>");
      return { command: "config", action: "set", key, value };
    }
    const json = takeFlag(args, "--json");
    noMore(args, "aiboard config [--json] | aiboard config set <key> <value>");
    return { command: "config", action: "show", json };
  }
  if (name === "keys") {
    const action = args.shift();
    if (action === "set") {
      const stdin = takeFlag(args, "--stdin");
      const provider = args.shift();
      if (!provider || provider.startsWith("-")) throw invalid("Usage: aiboard keys set <provider> [--stdin].");
      // Anything after the provider may be the key itself: refuse without repeating it.
      if (args.length > 0) throw invalid(KEY_ON_ARGV);
      return { command: "keys", action: "set", provider, stdin };
    }
    if (action === "remove") {
      const provider = args.shift();
      if (!provider || provider.startsWith("-")) throw invalid("Usage: aiboard keys remove <provider>.");
      noMore(args, "aiboard keys remove <provider>");
      return { command: "keys", action: "remove", provider };
    }
    if (action === "reset") {
      const yes = takeFlag(args, "--yes");
      noMore(args, "aiboard keys reset [--yes]");
      return { command: "keys", action: "reset", yes };
    }
    throw invalid("Usage: aiboard keys set <provider> [--stdin] | keys remove <provider> | keys reset [--yes].");
  }
  if (args[0] === "enable" || args[0] === "disable") {
    const [action, id, ...rest] = args as ["enable" | "disable", string | undefined, ...string[]];
    if (!id || id.startsWith("-")) throw invalid(`Usage: aiboard models ${action} <provider:model>.`);
    noMore(rest, `aiboard models ${action} <provider:model>`);
    return { command: "models", action, id };
  }
  const json = takeFlag(args, "--json");
  noMore(args, "aiboard models [--json] | models enable <id> | models disable <id>");
  return { command: "models", action: "list", json };
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  if (args.includes(flag)) throw invalid(`Duplicate option ${flag}.`);
  return true;
}

// ------------------------------------------------------------------ runtime

/** A readable stdin; a terminal also has `isTTY` and `setRawMode`. */
export interface HomeCliInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface HomeCliRuntime {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The user's home folder, for the default `~/.aiboard`. */
  home?: string;
  stdin?: HomeCliInput;
  /** Command output (stdout). */
  write?: (text: string) => void;
  /** Prompts, warnings and notes (stderr), so `--json` output stays parseable. */
  writeError?: (text: string) => void;
  /** Tests: runs after the first read of a write, before its batch (a concurrent edit lands here). */
  afterRead?: () => Promise<void>;
  /** Tests: the lock wait (default 5 s, §5.8). */
  lockWaitMs?: number;
}

interface Io {
  location: AiboardHomeLocation;
  environment: NodeJS.ProcessEnv;
  stdin: HomeCliInput;
  write: (text: string) => void;
  writeError: (text: string) => void;
  afterRead?: () => Promise<void>;
  writeOptions: HomeWriteOptions;
}

export async function runHomeCommand(command: HomeCommand, runtime: HomeCliRuntime = {}): Promise<void> {
  const environment = runtime.environment ?? process.env;
  const io: Io = {
    location: resolveAiboardHome({ platform: runtime.platform ?? process.platform, environment, home: runtime.home ?? homedir() }),
    environment,
    stdin: runtime.stdin ?? (process.stdin as unknown as HomeCliInput),
    write: runtime.write ?? ((text) => { process.stdout.write(text); }),
    writeError: runtime.writeError ?? ((text) => { process.stderr.write(text); }),
    ...(runtime.afterRead ? { afterRead: runtime.afterRead } : {}),
    writeOptions: runtime.lockWaitMs === undefined ? {} : { lockWaitMs: runtime.lockWaitMs },
  };
  if (writesHome(command)) assertHomeWritable(environment);
  switch (command.command) {
    case "config":
      if (command.action === "show") return await showConfig(io, command.json);
      return await setConfig(io, command.key, command.value);
    case "keys":
      if (command.action === "set") return await setKey(io, command.provider, command.stdin);
      if (command.action === "remove") return await removeKey(io, command.provider);
      return await resetKeys(io, command.yes);
    case "models":
      if (command.action === "list") return await listModels(io, command.json);
      return await toggleModel(io, command.id, command.action === "enable");
  }
}

export function writesHome(command: HomeCommand): boolean {
  return command.command === "keys" || (command.command === "config" && command.action === "set") ||
    (command.command === "models" && command.action !== "list");
}

/**
 * §11.4: the home-writing commands refuse inside an AIBoard task (`AIBOARD_TASK_ID`) or any child of a
 * Runner (`AIBOARD_MCP_DEPTH` of 1 or more). A malformed depth is refused too, failing closed.
 */
export function assertHomeWritable(environment: NodeJS.ProcessEnv): void {
  const refuse = (why: string) => new Error(`depth_exceeded: ${why}, so it cannot change your AIBoard home. Run the command in your own terminal.`);
  if (environment.AIBOARD_TASK_ID !== undefined) throw refuse("This command runs inside an AIBoard task (AIBOARD_TASK_ID is set)");
  const depth = environment.AIBOARD_MCP_DEPTH;
  if (depth === undefined) return;
  if (!/^(0|[1-9][0-9]{0,5})$/.test(depth)) throw refuse("AIBOARD_MCP_DEPTH is malformed");
  if (Number(depth) >= 1) throw refuse("This command runs as a child of an AIBoard Runner (AIBOARD_MCP_DEPTH is 1 or more)");
}

// ------------------------------------------------------------------ writes

/**
 * Reads the home, builds one batch from that read, and applies it at the read's revision. A
 * `home_conflict` means another writer changed a touched section in between: read again, rebuild
 * from the fresh values and retry once. A second conflict is reported, never forced.
 */
async function writeHome(io: Io, build: (home: AiboardHomeSnapshot) => HomeOp[] | null, options: { credentials?: boolean } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const home = await readAiboardHome(io.location, { credentials: options.credentials ?? false });
    if (!home.writable) throw new AiboardHomeError("home_newer", "The AIBoard home was saved by a newer AI Board; update AI Board to change it.");
    const ops = build(home);
    if (!ops || ops.length === 0) return { home, result: undefined };
    if (attempt === 0) await io.afterRead?.();
    try {
      return { home, result: await applyHomeBatch(io.location, { baseRevision: home.revision, ops }, io.writeOptions) };
    } catch (error) {
      if (error instanceof AiboardHomeError && error.code === "home_conflict" && attempt === 0) continue;
      throw error;
    }
  }
}

// ------------------------------------------------------------------ config

const REASONING_EFFORTS = ["default", "none", "low", "medium", "high", "xhigh", "max"] as const;

/** `aiboard config set` keys (§6.6). The four `exec.*` keys arrive with DX1 (OD-33). */
const CONFIG_KEYS: Readonly<Record<string, { path: string; convert: (value: string) => unknown; describe: string }>> = {
  "defaults.reasoningEffort": {
    path: "settings.defaultReasoningEffort",
    describe: `one of ${REASONING_EFFORTS.join(", ")}`,
    convert: (value) => {
      const effort = value.trim().toLowerCase();
      if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
        throw invalid(`defaults.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}.`);
      }
      return effort;
    },
  },
};

async function setConfig(io: Io, key: string, value: string): Promise<void> {
  const entry = Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key]! : undefined;
  if (!entry) {
    throw invalid(`Unknown setting ${key}. aiboard config set takes: ${Object.entries(CONFIG_KEYS).map(([name, item]) => `${name} (${item.describe})`).join("; ")}. Other settings are edited in the web.`);
  }
  const converted = entry.convert(value);
  await writeHome(io, () => [{ path: entry.path, op: "set", value: converted }]);
  io.write(`Set ${key} to ${String(converted)}.\n`);
}

const DEFAULT_SETTING_LABELS: ReadonlyArray<[string, string]> = [
  ["defaultReasoningEffort", "reasoning effort (defaults.reasoningEffort)"],
  ["defaultEffort", "discussion effort"],
  ["defaultMode", "mode"],
  ["judgeModelId", "judge model"],
  ["defaultVerbosity", "verbosity"],
  ["defaultBuildRunPolicy", "Build run policy"],
  ["defaultBuildSkillMode", "Build skill mode"],
  ["defaultBuildBudgetUsd", "Build budget (USD)"],
  ["defaultBuildTimeLimitMinutes", "Build time limit (minutes)"],
  ["defaultBuildAlwaysRequireIndependentVerifier", "Build independent verifier"],
];

interface ConfigView {
  home: string;
  homeSource: AiboardHomeLocation["source"];
  homeKey: string;
  exists: boolean;
  revision: number;
  keys: { readable: true } | { readable: false; error: string };
  providers: Array<{ id: string; name: string; enabled: boolean; baseUrl: string | null; key: string | null; validated: boolean | null }>;
  customModels: Array<{ id: string; label: string; baseUrl: string; model: string; key: string | null }>;
  enabledModels: string[];
  defaults: Record<string, unknown>;
  openAIConnectionMode: string;
}

async function readForDisplay(io: Io): Promise<{ home: AiboardHomeSnapshot; keysError?: string }> {
  try {
    return { home: await readAiboardHome(io.location) };
  } catch (error) {
    // Unreadable keys (another computer's, or a lost home key) leave the settings readable.
    if (error instanceof AiboardHomeError && (error.code === "home_key_mismatch" || error.code === "home_unreadable")) {
      const home = await readAiboardHome(io.location, { credentials: false });
      return { home, keysError: error.message };
    }
    throw error;
  }
}

function providerIdsIn(config: AiboardHomeConfigV1): string[] {
  const known = snapshotProviderIds() as string[];
  return [...known.filter((id) => Object.hasOwn(config.providers, id)), ...Object.keys(config.providers).filter((id) => !known.includes(id)).sort()];
}

async function configView(io: Io): Promise<ConfigView> {
  const { home, keysError } = await readForDisplay(io);
  const config = home.config;
  const credentials = home.credentials;
  const defaults: Record<string, unknown> = {};
  for (const [field] of DEFAULT_SETTING_LABELS) if (config.settings[field] !== undefined) defaults[field] = config.settings[field];
  return {
    home: io.location.home,
    homeSource: io.location.source,
    homeKey: io.location.keyPath,
    exists: home.exists,
    revision: home.revision,
    keys: keysError ? { readable: false, error: keysError } : { readable: true },
    providers: providerIdsIn(config).map((id) => {
      const entry = config.providers[id]!;
      const provider = snapshotProvider(id);
      return {
        id,
        name: provider?.name ?? id,
        enabled: entry.enabled === true,
        baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : null,
        key: credentials?.providers[id]?.keyHint ?? null,
        validated: typeof entry.lastValidationSucceeded === "boolean" ? entry.lastValidationSucceeded : null,
      };
    }),
    customModels: config.customModels.map((model) => ({
      id: model.id, label: model.label, baseUrl: model.baseURL, model: model.model, key: credentials?.customModels[model.id]?.keyHint ?? null,
    })),
    enabledModels: keysError ? [] : listHomeEnabledModels(home).map((model) => model.id),
    defaults,
    openAIConnectionMode: config.openAIConnectionMode,
  };
}

async function showConfig(io: Io, json: boolean): Promise<void> {
  const view = await configView(io);
  if (json) { io.write(`${JSON.stringify(view, null, 2)}\n`); return; }
  const lines = [
    `AIBoard home: ${view.home}${view.homeSource === "AIBOARD_HOME" ? " (from AIBOARD_HOME)" : ""}${view.exists ? "" : " (not created yet)"}`,
    `Home key:     ${view.homeKey}`,
    `Revision:     ${view.revision}`,
    "",
    "Providers:",
  ];
  if (!view.keys.readable) lines.push(`  Saved keys cannot be read: ${view.keys.error}`);
  if (view.providers.length === 0) lines.push("  none saved. Add a key with `aiboard keys set <provider>`.");
  const accountBacked = (id: string) => snapshotProvider(id)?.accountBacked === true;
  for (const provider of view.providers) {
    const key = accountBacked(provider.id)
      ? "signs in through the account runner"
      : provider.key ? `key ${provider.key}, ${provider.validated === true ? "validated" : provider.validated === false ? "failed validation" : "not validated"}` : "no key";
    lines.push(`  ${provider.id.padEnd(15)} ${provider.enabled ? "enabled " : "disabled"}  ${key}${provider.baseUrl ? `  base URL ${provider.baseUrl}` : ""}`);
  }
  if (view.customModels.length > 0) {
    lines.push("", "Custom models:");
    for (const model of view.customModels) lines.push(`  custom:${model.id.padEnd(8)} ${model.label} (${model.model} at ${model.baseUrl})${model.key ? `  key ${model.key}` : ""}`);
  }
  lines.push("", "Enabled models:");
  if (view.enabledModels.length === 0) lines.push(view.keys.readable ? "  none. Enable one with `aiboard models enable <provider:model>`." : "  unknown until the saved keys can be read.");
  for (const id of view.enabledModels) lines.push(`  ${id}`);
  lines.push("", "Defaults:");
  lines.push(`  OpenAI connection: ${view.openAIConnectionMode}`);
  for (const [field, label] of DEFAULT_SETTING_LABELS) {
    if (view.defaults[field] !== undefined) lines.push(`  ${label}: ${String(view.defaults[field])}`);
  }
  if (view.defaults.defaultReasoningEffort === undefined) lines.push("  reasoning effort (defaults.reasoningEffort): not set");
  lines.push("", "Keys are checked with the provider only when the web validates them.");
  io.write(`${lines.join("\n")}\n`);
}

// ------------------------------------------------------------------ keys

function keyProvider(id: string): { id: string; name: string } {
  const provider = snapshotProvider(id);
  if (!provider) {
    // Never repeat the argument: the likeliest mistake is a key typed where the provider goes.
    throw new HomeModelError("unknown_provider", `That is not a provider AI Board knows. Providers: ${(snapshotProviderIds() as string[]).filter((item) => !snapshotProvider(item)?.accountBacked).join(", ")}.`);
  }
  if (provider.accountBacked) {
    throw invalid(`${provider.name} takes no key: it signs in through the account runner that a plain \`aiboard\` start launches.`);
  }
  return { id, name: provider.name };
}

async function setKey(io: Io, providerId: string, fromStdin: boolean): Promise<void> {
  const provider = keyProvider(providerId);
  const secret = fromStdin ? await readKeyLine(io.stdin) : await promptForKey(io, `Enter the ${provider.name} key (input hidden): `);
  if (!secret) throw invalid("No key was entered; nothing was saved.");
  await writeHome(io, (home) => {
    const entry = home.config.providers[provider.id];
    return [
      entry
        // A new key is not validated yet (as the web's saveProviderKey does).
        ? { path: `providers.${provider.id}`, op: "merge", value: { lastValidationSucceeded: null, lastValidatedAt: null } }
        : { path: `providers.${provider.id}`, op: "set", value: { enabled: true } },
      { path: `credentials.providers.${provider.id}`, op: "set", value: { secret } },
    ];
  }, { credentials: true });
  io.write(`Saved the ${provider.name} key. It is not validated: AI Board checks it with ${provider.name} when the web validates it.\n`);
}

async function removeKey(io: Io, providerId: string): Promise<void> {
  const provider = keyProvider(providerId);
  const { result } = await writeHome(io, (current) => current.credentials?.providers[provider.id]
    ? [{ path: `credentials.providers.${provider.id}`, op: "remove" }]
    : null, { credentials: true });
  io.write(result ? `Removed the ${provider.name} key.
` : `No ${provider.name} key is saved.
`);
}

async function resetKeys(io: Io, yes: boolean): Promise<void> {
  const notice = "aiboard keys reset deletes every key saved in the AIBoard home (provider keys, custom model keys and the remote MCP token) and starts new ones under this computer's home key. Settings are kept.";
  if (!yes) {
    if (!io.stdin.isTTY) throw invalid(`${notice} Run it at a terminal to confirm, or pass --yes.`);
    io.writeError(`${notice}\nType yes to continue: `);
    const answer = (await readLine(io.stdin)).trim().toLowerCase();
    if (answer !== "yes") { io.write("Nothing was changed.\n"); return; }
  }
  await resetHomeCredentials(io.location, io.writeOptions);
  io.write("Every saved key was removed. Enter them again with `aiboard keys set <provider>` or in Settings.\n");
}

/** Strips what PowerShell and Windows pipes add: a leading BOM and a trailing CR or LF. */
export function cleanKeyInput(value: string): string {
  return value.replace(/^﻿/, "").replace(/[\r\n]+$/, "");
}

/** `--stdin`: one line from a pipe. A terminal would echo the key, so a TTY stdin is refused. */
export async function readKeyLine(stdin: HomeCliInput): Promise<string> {
  if (stdin.isTTY) throw invalid("--stdin reads the key from a pipe. At a terminal, leave --stdin off and answer the prompt, which hides what you type.");
  return cleanKeyInput(await readLine(stdin));
}

function readLine(stdin: HomeCliInput): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (value: string) => { cleanup(); resolve(value); };
    const onData = (chunk: Buffer | string) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(buffered.slice(0, newline + 1));
    };
    const onEnd = () => finish(buffered);
    const onError = (error: unknown) => { cleanup(); reject(error); };
    const cleanup = () => {
      stdin.off("data", onData); stdin.off("end", onEnd); stdin.off("error", onError);
      stdin.pause();
    };
    stdin.on("data", onData); stdin.once("end", onEnd); stdin.once("error", onError);
    stdin.resume();
  });
}

/**
 * The hidden prompt: raw mode, nothing echoed (not even a mask), Enter ends the key, Backspace
 * deletes, Ctrl+C or Ctrl+D on an empty line cancels, and escape sequences (arrow keys) are ignored.
 * Without a terminal (Git Bash's mintty, a pipe), it refuses instead of reading a key that would echo.
 */
export async function promptForKey(io: Pick<Io, "stdin" | "writeError">, prompt: string): Promise<string> {
  const stdin = io.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw invalid("stdin is not a terminal, so the key prompt cannot hide what you type. Pipe the key with --stdin instead.");
  }
  io.writeError(prompt);
  stdin.setRawMode(true);
  try {
    return await new Promise<string>((resolve, reject) => {
      let key = "";
      let escape = false;
      const done = (error?: Error) => {
        stdin.off("data", onData); stdin.off("end", onEnd); stdin.off("error", onError);
        io.writeError("\n");
        if (error) reject(error); else resolve(cleanKeyInput(key));
      };
      const onData = (chunk: Buffer | string) => {
        for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
          if (escape) { if (/[A-Za-z~]/.test(char)) escape = false; continue; }
          if (char === "\u001b") { escape = true; continue; }
          if (char === "\r" || char === "\n") { done(); return; }
          if (char === "\u0003" || (char === "\u0004" && key.length === 0)) { done(new Error("cancelled: No key was saved.")); return; }
          if (char === "\u007f" || char === "\b") { key = [...key].slice(0, -1).join(""); continue; }
          if (char < " ") continue;
          key += char;
        }
      };
      const onEnd = () => done();
      const onError = (error: unknown) => done(error instanceof Error ? error : new Error(String(error)));
      stdin.on("data", onData); stdin.once("end", onEnd); stdin.once("error", onError);
      stdin.resume();
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

// ------------------------------------------------------------------ models

function modelName(providerId: string, modelId: string, config: AiboardHomeConfigV1): string {
  if (providerId === "custom") return config.customModels.find((model) => model.id === modelId)?.label ?? modelId;
  return snapshotCatalogModel(providerId, modelId)?.name ?? modelId;
}

async function listModels(io: Io, json: boolean): Promise<void> {
  const home = await readAiboardHome(io.location);
  const models = listHomeEnabledModels(home).map((model) => ({
    ...model,
    name: modelName(model.providerId, model.modelId, home.config),
    inCatalog: model.providerId !== "custom" && snapshotCatalogModel(model.providerId, model.modelId) !== undefined,
  }));
  if (json) { io.write(`${JSON.stringify(models, null, 2)}\n`); return; }
  if (models.length === 0) {
    io.write("No models are enabled. Save a key with `aiboard keys set <provider>`, then `aiboard models enable <provider:model>`.\n");
    return;
  }
  const width = Math.max(...models.map((model) => model.id.length));
  io.write(`${models.map((model) => `${model.id.padEnd(width)}  ${model.name}${model.inCatalog || model.providerId === "custom" ? "" : "  (not in AI Board's catalog)"}`).join("\n")}\n`);
}

/** The catalog ids nearest a mistyped one (edit distance), for an unknown-provider refusal. */
export function nearestCatalogIds(id: string, limit = 3): string[] {
  const candidates = MODEL_CATALOG_SNAPSHOT.models.map((model) => formatFullModelId(model.providerId, model.id));
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(id.toLowerCase(), candidate.toLowerCase()) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

function checkId(config: AiboardHomeConfigV1, id: string): HomeModelIdCheck {
  try {
    return checkHomeModelId(config, id);
  } catch (error) {
    if (error instanceof HomeModelError && error.code === "unknown_provider") {
      throw new HomeModelError("unknown_provider", `${error.message.replace(/^unknown_provider: /, "")} Nearest catalog ids: ${nearestCatalogIds(id).join(", ")}.`);
    }
    throw error;
  }
}

function sameList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function toggleModel(io: Io, rawId: string, enable: boolean): Promise<void> {
  const id = migrateFullModelId(rawId.trim());
  if (id !== rawId.trim()) io.writeError(`note: ${rawId.trim()} was renamed; using ${id}.
`);
  const first = checkId((await readAiboardHome(io.location, { credentials: false })).config, id);
  if (first.providerId === "custom") {
    io.write(enable ? `${id} is a custom model; custom models are always listed.
` : `${id} is a custom model; custom models are edited in the web.
`);
    return;
  }
  const provider = snapshotProvider(first.providerId)!;
  let warnings: HomeModelIdCheck["warnings"] = [];
  let turnedOn = false;
  const { result } = await writeHome(io, (current) => {
    const check = checkId(current.config, id);
    warnings = check.warnings;
    const entry = current.config.providers[check.providerId];
    const models = Array.isArray(entry?.models) ? entry.models : null;
    const enabledIds = Array.isArray(entry?.enabledModelIds) ? entry.enabledModelIds : null;
    const listed = listHomeProviderModelIds(current.config, check.providerId);
    let nextModels = models;
    let nextEnabled = enabledIds;
    if (enable) {
      // Foundry lists only its saved deployments; a discovering provider lists its models, enabled ids and default.
      const needsListing = enabledIds === null || provider.modelDiscovery === null;
      if (needsListing && !listed.includes(check.modelId)) nextModels = [...(models ?? []), check.modelId];
      if (enabledIds !== null && !enabledIds.includes(check.modelId)) nextEnabled = [...enabledIds, check.modelId];
    } else if (enabledIds === null) {
      // Every listed model is enabled: keep the others enabled and leave this one out.
      if (listed.includes(check.modelId)) nextEnabled = listed.filter((model) => model !== check.modelId);
    } else {
      nextEnabled = enabledIds.filter((model) => model !== check.modelId);
    }
    const value: Record<string, unknown> = {};
    if (!sameList(models, nextModels)) value.models = nextModels;
    if (!sameList(enabledIds, nextEnabled)) value.enabledModelIds = nextEnabled;
    turnedOn = enable && entry?.enabled !== true;
    if (turnedOn) value.enabled = true;
    if (Object.keys(value).length === 0) return null;
    return [{ path: `providers.${check.providerId}`, op: entry ? "merge" : "set", value }];
  });
  for (const warning of warnings) io.writeError(`warning: ${warning.message}
`);
  if (!enable) {
    io.write(result ? `Disabled ${id}.
` : `${id} is not enabled.
`);
    return;
  }
  const { home, keysError } = await readForDisplay(io);
  const usable = !keysError && listHomeEnabledModels(home).some((model) => model.id === id);
  const note = usable || provider.accountBacked ? "" : ` It is not usable until a key is saved: aiboard keys set ${first.providerId}.`;
  io.write(`${result ? "Enabled" : "Already enabled:"} ${id}${turnedOn ? ` (and turned ${provider.name} on)` : ""}.${note}
`);
}
