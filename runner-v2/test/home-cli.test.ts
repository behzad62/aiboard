import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AiboardHomeError, resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHome } from "../src/aiboard-home-store.js";
import { cleanKeyInput, nearestCatalogIds, parseHomeCommand, runHomeCommand, type HomeCliInput, type HomeCliRuntime } from "../src/home-cli.js";
import { HomeModelError } from "../src/home-runtime.js";
import { parseLauncherArguments } from "../src/launcher.js";

// Packet HM5 (Simple Build plan §6.6). Stub keys only; credential files are never printed.
const CANARY = `stub-canary-${randomBytes(12).toString("hex")}`;
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const BIN = fileURLToPath(new URL("../bin/aiboard.mjs", import.meta.url));

interface Fixture { root: string; userHome: string; environment: NodeJS.ProcessEnv; location: AiboardHomeLocation }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-home-cli-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
  return { root, userHome, environment, location: resolveAiboardHome({ platform: process.platform, environment, home: userHome }) };
}

function cleanup(fx: Fixture): void { rmSync(fx.root, { recursive: true, force: true }); }

/** A non-terminal stdin that yields `text` once read. */
class PipeInput extends EventEmitter implements HomeCliInput {
  isTTY = false;
  reads = 0;
  constructor(private readonly text: string | null) { super(); }
  resume() {
    this.reads += 1;
    if (this.text !== null) setImmediate(() => { this.emit("data", Buffer.from(this.text!, "utf8")); this.emit("end"); });
    return this;
  }
  pause() { return this; }
}

/** A fake terminal: records raw-mode switches; the test types into it with `type`. */
class FakeTty extends EventEmitter implements HomeCliInput {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = false;
  setRawMode(mode: boolean) { this.rawModes.push(mode); return this; }
  resume() { this.resumed = true; this.emit("resumed"); return this; }
  pause() { return this; }
  async type(...chunks: string[]) {
    if (!this.resumed) await new Promise((resolve) => this.once("resumed", resolve));
    for (const chunk of chunks) { this.emit("data", Buffer.from(chunk, "utf8")); await new Promise((resolve) => setImmediate(resolve)); }
  }
}

interface Captured { out: string[]; err: string[] }

function runtimeFor(fx: Fixture, extra: Partial<HomeCliRuntime> = {}): HomeCliRuntime & { captured: Captured } {
  const captured: Captured = { out: [], err: [] };
  return {
    environment: fx.environment, home: fx.userHome, platform: process.platform,
    stdin: new PipeInput(null),
    write: (text) => { captured.out.push(text); },
    writeError: (text) => { captured.err.push(text); },
    ...extra, captured,
  };
}

async function cli(fx: Fixture, argv: string[], extra: Partial<HomeCliRuntime> = {}) {
  const runtime = runtimeFor(fx, extra);
  const parsed = parseLauncherArguments(argv);
  assert.ok(parsed.home, `${argv.join(" ")} is a home command`);
  await runHomeCommand(parsed.home, runtime);
  return runtime.captured;
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<Error> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`^${code}:`), error.message);
    if (error instanceof AiboardHomeError || error instanceof HomeModelError) assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const providerEntry = (patch: Record<string, unknown> = {}) => ({
  enabled: true, baseUrl: null, models: null, enabledModelIds: null, defaultModel: null,
  lastValidationSucceeded: null, lastValidatedAt: null, ...patch,
});

async function seed(fx: Fixture, ops: Parameters<typeof applyHomeBatch>[1]["ops"]) {
  const revision = (await readAiboardHome(fx.location, { credentials: false })).revision;
  return await applyHomeBatch(fx.location, { baseRevision: revision, ops });
}

// ------------------------------------------------------------------ keys never from argv

test("a key on argv is refused, with the hint, and never repeated", () => {
  for (const argv of [["keys", "set", "openai", CANARY], ["keys", "set", "openai", "--stdin", CANARY], ["keys", "set", "--stdin", "openai", CANARY]]) {
    assert.throws(() => parseLauncherArguments(argv), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^invalid_arguments: aiboard keys set takes no key on the command line/);
      assert.match(error.message, /--stdin/);
      assert.ok(!error.message.includes(CANARY), "the refusal never repeats the key");
      return true;
    });
  }
  assert.deepEqual(parseHomeCommand("keys", ["set", "openai", "--stdin"]), { command: "keys", action: "set", provider: "openai", stdin: true });
  assert.throws(() => parseHomeCommand("keys", ["set"]), /invalid_arguments/);
  assert.throws(() => parseHomeCommand("keys", ["rotate"]), /invalid_arguments/);
  assert.throws(() => parseHomeCommand("config", ["--json", "--json"]), /Duplicate option/);
});

test("a key typed where the provider goes is never repeated by keys set or keys remove", { timeout: 120_000 }, async () => {
  const fx = fixture();
  try {
    for (const argv of [["keys", "set", CANARY, "--stdin"], ["keys", "set", CANARY], ["keys", "remove", CANARY]]) {
      const runtime = runtimeFor(fx, { stdin: new PipeInput("stub-key-0001\n") });
      const error = await rejectsCode(runHomeCommand(parseHomeCommand("keys", argv.slice(1)), runtime), "unknown_provider");
      assert.match(error.message, /That is not a provider AI Board knows\. Providers: openai/);
      for (const text of [error.message, ...runtime.captured.out, ...runtime.captured.err]) assert.ok(!text.includes(CANARY), `keys ${argv[1]} repeated the argument`);
      const run = await runBin(fx, argv, "stub-key-0001\n");
      assert.notEqual(run.code, 0, `aiboard keys ${argv[1]} exits non-zero`);
      assert.match(run.stderr, /unknown_provider/);
      assert.ok(!run.stdout.includes(CANARY) && !run.stderr.includes(CANARY), `aiboard keys ${argv[1]} printed the argument`);
    }
    assert.equal(existsSync(fx.location.configPath), false, "nothing was saved");
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ the prompt

test("the key prompt switches to raw mode and echoes nothing (fake TTY)", async () => {
  const fx = fixture();
  try {
    const tty = new FakeTty();
    const runtime = runtimeFor(fx, { stdin: tty });
    const done = runHomeCommand(parseHomeCommand("keys", ["set", "openai"]), runtime);
    // Typed in pieces, with a Backspace, an arrow key and a paste ending in Enter.
    await tty.type(CANARY.slice(0, 5), "X\u007f", "\u001b[D", `${CANARY.slice(5)}\r`);
    await done;
    assert.deepEqual(tty.rawModes, [true, false], "raw mode on for the prompt, off afterwards");
    const output = [...runtime.captured.out, ...runtime.captured.err].join("");
    assert.match(runtime.captured.err.join(""), /input hidden/);
    assert.ok(!output.includes(CANARY.slice(0, 5)) && !output.includes(CANARY.slice(5)), "no part of the key is echoed");
    assert.doesNotMatch(output, /\*{3}/, "not even a mask");
    const home = await readAiboardHome(fx.location);
    assert.ok(home.secret("credentials.providers.openai") === CANARY, "the typed key is saved (value not printed)");
  } finally { cleanup(fx); }
});

test("Ctrl+C at the prompt saves nothing", async () => {
  const fx = fixture();
  try {
    const tty = new FakeTty();
    const done = runHomeCommand(parseHomeCommand("keys", ["set", "openai"]), runtimeFor(fx, { stdin: tty }));
    const refused = rejectsCode(done, "cancelled");
    await tty.type("partial", "\u0003");
    await refused;
    assert.deepEqual(tty.rawModes, [true, false]);
    assert.equal(existsSync(fx.location.configPath), false);
  } finally { cleanup(fx); }
});

test("a stdin that is not a terminal is read only with --stdin", async () => {
  const fx = fixture();
  try {
    const pipe = new PipeInput(`${CANARY}\n`);
    await rejectsCode(runHomeCommand(parseHomeCommand("keys", ["set", "openai"]), runtimeFor(fx, { stdin: pipe })), "invalid_arguments")
      .then((error) => assert.match(error.message, /not a terminal[\s\S]*--stdin/));
    assert.equal(pipe.reads, 0, "a non-terminal stdin is never read without --stdin");
    assert.equal(existsSync(fx.location.configPath), false);

    const tty = new FakeTty();
    await rejectsCode(runHomeCommand(parseHomeCommand("keys", ["set", "openai", "--stdin"]), runtimeFor(fx, { stdin: tty })), "invalid_arguments")
      .then((error) => assert.match(error.message, /from a pipe/));
    assert.deepEqual(tty.rawModes, [], "--stdin at a terminal is refused, never read with echo on");

    const captured = await cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput(`﻿${CANARY}\r\n`) });
    assert.ok((await readAiboardHome(fx.location)).secret("credentials.providers.openai") === CANARY, "the BOM and the trailing CR LF are stripped");
    assert.match(captured.out.join(""), /not validated/);
  } finally { cleanup(fx); }
});

test("cleanKeyInput strips a leading BOM and trailing CR or LF only", () => {
  assert.equal(cleanKeyInput("﻿abc\r\n"), "abc");
  assert.equal(cleanKeyInput("abc\n"), "abc");
  assert.equal(cleanKeyInput("abc\r"), "abc");
  assert.equal(cleanKeyInput("abc\r\n\r\n"), "abc");
  assert.equal(cleanKeyInput(" a b "), " a b ", "other characters are the key's");
  assert.equal(cleanKeyInput("a﻿"), "a﻿");
});

// ------------------------------------------------------------------ the lock and concurrent edits

const STORE_URL = new URL("../src/aiboard-home-store.ts", import.meta.url).href;
const PATHS_URL = new URL("../src/aiboard-home-paths.ts", import.meta.url).href;

/** Another process that writes a key and holds the home lock until told to go on. */
function holdLockInAnotherProcess(fx: Fixture) {
  const script = join(fx.root, "hold-lock.mts");
  writeFileSync(script, [
    `import { resolveAiboardHome } from ${JSON.stringify(PATHS_URL)};`,
    `import { applyHomeBatch, readAiboardHome } from ${JSON.stringify(STORE_URL)};`,
    "const location = resolveAiboardHome({ platform: process.platform, environment: process.env, home: process.argv[2] });",
    "const revision = (await readAiboardHome(location, { credentials: false })).revision;",
    "await applyHomeBatch(location, { baseRevision: revision, ops: [{ path: \"providers.anthropic\", op: \"set\", value: { enabled: true } }] }, {",
    "  afterCredentialsWrite: async () => { process.stdout.write(\"holding\\n\"); await new Promise((resolve) => process.stdin.once(\"data\", resolve)); },",
    "  lockWaitMs: 30000,",
    "});",
    "process.stdout.write(\"done\\n\");",
    "",
  ].join("\n"));
  // The batch must write credentials for afterCredentialsWrite to run: seed the key first in the parent.
  const child = spawn(process.execPath, [TSX_CLI, script, fx.userHome], { env: { ...process.env, ...fx.environment, HOME: fx.userHome, USERPROFILE: fx.userHome }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const waitFor = (text: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if (output.includes(text)) { clearInterval(timer); resolve(); } };
    const timer = setInterval(check, 20);
    child.once("exit", (code) => { clearInterval(timer); if (!output.includes(text)) reject(new Error(`lock holder exited ${code}: ${errors}`)); });
  });
  return { child, waitFor, release: () => child.stdin.end("go\n"), exited: new Promise<number | null>((resolve) => child.once("exit", resolve)) };
}

test("writes take the home lock, and wait for another process's writer", { timeout: 90_000 }, async () => {
  const fx = fixture();
  try {
    // The holder's batch removes the anthropic key bound to the default upstream when it rewrites the entry,
    // so it writes credentials and pauses there, holding the lock.
    await seed(fx, [
      { path: "providers.anthropic", op: "set", value: providerEntry({ baseUrl: "https://a.example.test" }) },
      { path: "credentials.providers.anthropic", op: "set", value: { secret: "stub-key-holder-0001" } },
    ]);
    const holder = holdLockInAnotherProcess(fx);
    await holder.waitFor("holding");
    // A lock held past the wait gives home_busy and changes nothing.
    await rejectsCode(cli(fx, ["config", "set", "defaults.reasoningEffort", "low"], { lockWaitMs: 300 }), "home_busy");
    let settled = false;
    const write = cli(fx, ["config", "set", "defaults.reasoningEffort", "high"], { lockWaitMs: 30_000 }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false, "the CLI waits while another process holds the lock");
    assert.equal((await readAiboardHome(fx.location, { credentials: false })).config.settings.defaultReasoningEffort, undefined);
    holder.release();
    await write;
    assert.equal(await holder.exited, 0);
    const home = await readAiboardHome(fx.location, { credentials: false });
    assert.equal(home.config.settings.defaultReasoningEffort, "high");
    assert.equal(home.config.providers.anthropic?.baseUrl, null, "the other writer's batch landed too");
  } finally { cleanup(fx); }
});

test("a concurrent web edit of the same section is never dropped: the CLI re-reads and retries once", async () => {
  const fx = fixture();
  try {
    await seed(fx, [
      { path: "providers.openai", op: "set", value: providerEntry({ enabledModelIds: ["gpt-5.5"] }) },
      { path: "credentials.providers.openai", op: "set", value: { secret: "stub-key-openai-0001" } },
    ]);
    // Between the CLI's read and its batch, the web enables another model in the same section.
    const webEdit = async () => {
      const current = await readAiboardHome(fx.location, { credentials: false });
      await applyHomeBatch(fx.location, { baseRevision: current.revision, ops: [{ path: "providers.openai", op: "merge", value: { enabledModelIds: ["gpt-5.5", "gpt-5.4"], defaultModel: "gpt-5.4" } }] });
    };
    await cli(fx, ["models", "enable", "openai:gpt-5.6-sol"], { afterRead: webEdit });
    let entry = (await readAiboardHome(fx.location, { credentials: false })).config.providers.openai!;
    assert.deepEqual(entry.enabledModelIds, ["gpt-5.5", "gpt-5.4", "gpt-5.6-sol"], "the web's edit and the CLI's both land");
    assert.equal(entry.defaultModel, "gpt-5.4");

    // A key saved while the web edits the provider: the key lands and the web's edit stays.
    const webValidates = async () => {
      const current = await readAiboardHome(fx.location, { credentials: false });
      await applyHomeBatch(fx.location, { baseRevision: current.revision, ops: [{ path: "providers.openai", op: "merge", value: { enabledModelIds: ["gpt-5.4"] } }] });
    };
    await cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput(`${CANARY}\n`), afterRead: webValidates });
    const home = await readAiboardHome(fx.location);
    entry = home.config.providers.openai!;
    assert.deepEqual(entry.enabledModelIds, ["gpt-5.4"]);
    assert.equal(entry.lastValidationSucceeded, null, "a new key is not validated");
    assert.ok(home.secret("credentials.providers.openai") === CANARY);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ config set

test("config set defaults.reasoningEffort maps to settings.defaultReasoningEffort, converts and validates", async () => {
  const fx = fixture();
  try {
    await seed(fx, [{ path: "settings.defaultEffort", op: "set", value: "balanced" }]);
    const captured = await cli(fx, ["config", "set", "defaults.reasoningEffort", " XHigh "]);
    assert.match(captured.out.join(""), /Set defaults\.reasoningEffort to xhigh/);
    let settings = (await readAiboardHome(fx.location, { credentials: false })).config.settings;
    assert.equal(settings.defaultReasoningEffort, "xhigh");
    assert.equal(settings.defaultEffort, "balanced", "the discussion effort is a different setting and is untouched");
    for (const effort of ["default", "none", "low", "medium", "high", "max"]) {
      await cli(fx, ["config", "set", "defaults.reasoningEffort", effort]);
      assert.equal((await readAiboardHome(fx.location, { credentials: false })).config.settings.defaultReasoningEffort, effort);
    }
    await rejectsCode(cli(fx, ["config", "set", "defaults.reasoningEffort", "extreme"]), "invalid_arguments");
    await rejectsCode(cli(fx, ["config", "set", "defaults.effort", "high"]), "invalid_arguments");
    // The exec.* keys arrive with DX1 (OD-33).
    await rejectsCode(cli(fx, ["config", "set", "exec.defaultModel", "openai:gpt-5.5"]), "invalid_arguments")
      .then((error) => assert.match(error.message, /defaults\.reasoningEffort/));
    settings = (await readAiboardHome(fx.location, { credentials: false })).config.settings;
    assert.equal(settings.defaultReasoningEffort, "max", "a refused value changes nothing");
    assert.equal("exec" in (await readAiboardHome(fx.location, { credentials: false })).config, false);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ recursion

test("home-writing commands refuse under AIBOARD_TASK_ID or a Runner depth; reading commands still work", async () => {
  const fx = fixture();
  try {
    await seed(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }]);
    const before = readFileSync(fx.location.configPath, "utf8");
    const writing = [
      ["config", "set", "defaults.reasoningEffort", "high"],
      ["keys", "set", "openai", "--stdin"],
      ["keys", "remove", "openai"],
      ["keys", "reset", "--yes"],
      ["models", "enable", "openai:gpt-5.5"],
      ["models", "disable", "openai:gpt-5.5"],
    ];
    for (const ambient of [{ AIBOARD_TASK_ID: "task-1" }, { AIBOARD_TASK_ID: "" }, { AIBOARD_MCP_DEPTH: "1" }, { AIBOARD_MCP_DEPTH: "2" }, { AIBOARD_MCP_DEPTH: "x" }, { AIBOARD_MCP_DEPTH: "-1" }, { AIBOARD_MCP_DEPTH: "01" }]) {
      const environment = { ...fx.environment, ...ambient };
      for (const argv of writing) {
        const pipe = new PipeInput(`${CANARY}\n`);
        await rejectsCode(cli({ ...fx, environment }, argv, { stdin: pipe }), "depth_exceeded");
        assert.equal(pipe.reads, 0, `${argv.join(" ")} reads no key before refusing`);
      }
      await cli({ ...fx, environment }, ["config"]);
      await cli({ ...fx, environment }, ["models", "--json"]);
    }
    assert.equal(readFileSync(fx.location.configPath, "utf8"), before, "nothing was written");
    // Depth 0 is the user's own terminal.
    await cli({ ...fx, environment: { ...fx.environment, AIBOARD_MCP_DEPTH: "0" } }, ["config", "set", "defaults.reasoningEffort", "low"]);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ secrets in output

function cleanEnvironment(fx: Fixture): NodeJS.ProcessEnv {
  // The child's own home folder too: on macOS the home key's folder comes only from it, so an inherited
  // HOME would put a key in the developer's real data root.
  const environment: NodeJS.ProcessEnv = { ...process.env, ...fx.environment, HOME: fx.userHome, USERPROFILE: fx.userHome, NO_COLOR: "1" };
  delete environment.AIBOARD_TASK_ID;
  delete environment.AIBOARD_MCP_DEPTH;
  return environment;
}

function runBin(fx: Fixture, argv: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string; argv: string[] }> {
  const args = [BIN, ...argv];
  const child = spawn(process.execPath, args, { env: cleanEnvironment(fx), cwd: fx.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input ?? "");
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr, argv: args })));
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("a canary secret in the home never appears in config output, argv, stdout, stderr or logs", { timeout: 120_000 }, async () => {
  const fx = fixture();
  try {
    const saved = await runBin(fx, ["keys", "set", "openai", "--stdin"], `﻿${CANARY}\r\n`);
    assert.equal(saved.code, 0, saved.stderr);
    assert.ok(existsSync(fx.location.keyPath), "the child's home key is in the fixture's data root, never the real one");
    await seed(fx, [
      { path: "providers.openai", op: "merge", value: { enabledModelIds: ["gpt-5.5"] } },
      { path: "customModels.local-a", op: "set", value: { label: "Local", baseURL: "http://127.0.0.1:11434/v1", model: "gemma", createdAt: "2026-11-12T00:00:00.000Z" } },
      { path: "credentials.customModels.local-a", op: "set", value: { secret: `${CANARY}-custom` } },
      { path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "remote", url: "https://mcp.example.test" } } },
      { path: "credentials.remoteMcpAuthorizationToken", op: "set", value: { secret: `${CANARY}-mcp` } },
    ]);
    const runs = [
      saved,
      await runBin(fx, ["config"]),
      await runBin(fx, ["config", "--json"]),
      await runBin(fx, ["models"]),
      await runBin(fx, ["models", "--json"]),
      await runBin(fx, ["models", "enable", "openai:gpt-5.4"]),
      await runBin(fx, ["keys", "set", "openai", CANARY]),
    ];
    for (const run of runs) {
      for (const text of [run.stdout, run.stderr, run.argv.slice(0, -1).join(" ")]) assert.ok(!text.includes(CANARY), `the canary leaked from: aiboard ${run.argv.slice(1).join(" ").replace(CANARY, "<canary>")}`);
    }
    assert.notEqual(runs.at(-1)!.code, 0, "a key on argv exits non-zero");
    const config = JSON.parse(runs[2]!.stdout) as { providers: Array<{ id: string; key: string | null; validated: boolean | null }>; enabledModels: string[]; keys: { readable: boolean } };
    const openai = config.providers.find((provider) => provider.id === "openai")!;
    assert.match(openai.key ?? "", /^stub\.\.\.[0-9a-f]{4}$/, "config shows a key hint, never the key");
    assert.equal(openai.validated, null, "not validated until the web validates it");
    assert.deepEqual(config.enabledModels, ["openai:gpt-5.5", "custom:local-a"]);
    assert.match(runs[1]!.stdout, /key stub\.\.\.[0-9a-f]{4}, not validated/);
    // No log file: only the home's own files, and none holds the canary in plain text.
    const written = [...filesUnder(fx.location.home), ...filesUnder(fx.location.keyDirectory)];
    for (const file of written) {
      assert.match(file, /(config\.json|credentials\.json|home-lock\.sqlite[^\\/]*|home-key)$/, `unexpected file ${file}`);
      assert.ok(!readFileSync(file).includes(Buffer.from(CANARY)), `${file} holds the canary in plain text`);
    }
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ models

test("models enable refuses an unknown provider and names the nearest catalog ids; an uncatalogued id is accepted with a warning", async () => {
  const fx = fixture();
  try {
    await rejectsCode(cli(fx, ["models", "enable", "openia:gpt-5.5"]), "unknown_provider")
      .then((error) => assert.match(error.message, /Nearest catalog ids: [^.]*openai:gpt-5\.5/));
    assert.deepEqual(nearestCatalogIds("anthropc:claude-opus-5", 1).map((id) => id.split(":")[0]), ["anthropic"]);

    const captured = await cli(fx, ["models", "enable", "openai:gpt-from-the-future"]);
    assert.match(captured.err.join(""), /^warning: openai:gpt-from-the-future is not in AI Board's model catalog/m);
    assert.match(captured.out.join(""), /Enabled openai:gpt-from-the-future \(and turned OpenAI on\)\. It is not usable until a key is saved: aiboard keys set openai/);
    await cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput("stub-key-openai-0002\n") });
    await cli(fx, ["models", "enable", "openai:gpt-5.5"]);
    let listed = JSON.parse((await cli(fx, ["models", "--json"])).out.join("")) as Array<{ id: string; inCatalog: boolean }>;
    assert.deepEqual(listed.map((model) => [model.id, model.inCatalog]), [["openai:gpt-from-the-future", false], ["openai:gpt-5.5", true]]);
    assert.match((await cli(fx, ["models"])).out.join(""), /gpt-from-the-future .*not in AI Board's catalog/);

    // Disable with every listed model enabled keeps the others enabled.
    assert.match((await cli(fx, ["models", "disable", "openai:gpt-from-the-future"])).out.join(""), /Disabled openai:gpt-from-the-future/);
    listed = JSON.parse((await cli(fx, ["models", "--json"])).out.join("")) as Array<{ id: string; inCatalog: boolean }>;
    assert.deepEqual(listed.map((model) => model.id), ["openai:gpt-5.5"]);
    assert.match((await cli(fx, ["models", "disable", "openai:gpt-from-the-future"])).out.join(""), /is not enabled/);
    assert.match((await cli(fx, ["models", "enable", "openai:gpt-5.5"])).out.join(""), /Already enabled/);
    // Re-enabling after a disable goes through the explicit list.
    await cli(fx, ["models", "enable", "openai:gpt-from-the-future"]);
    listed = JSON.parse((await cli(fx, ["models", "--json"])).out.join("")) as Array<{ id: string; inCatalog: boolean }>;
    assert.deepEqual(listed.map((model) => model.id).sort(), ["openai:gpt-5.5", "openai:gpt-from-the-future"]);

    // A renamed id is migrated, with a note.
    assert.match((await cli(fx, ["models", "enable", "openai:gpt-5.6"])).err.join(""), /gpt-5\.6 was renamed; using openai:gpt-5\.6-terra/);

    // Azure AI Foundry does not discover: only saved deployments.
    await seed(fx, [{ path: "providers.foundry", op: "set", value: providerEntry({ baseUrl: "https://stub.services.ai.azure.com/anthropic/", models: ["claude-opus-4-5"] }) }]);
    await rejectsCode(cli(fx, ["models", "enable", "foundry:claude-other"]), "model_not_configured");
    assert.match((await cli(fx, ["models", "enable", "custom:missing"]).catch((error: Error) => ({ out: [error.message], err: [] }))).out.join(""), /model_not_configured/);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ keys remove and reset, account providers, typed errors

test("keys remove, keys reset with a confirmation, and account-backed providers", async () => {
  const fx = fixture();
  try {
    await cli(fx, ["keys", "set", "deepseek", "--stdin"], { stdin: new PipeInput("stub-key-deepseek-01\n") });
    assert.match((await cli(fx, ["keys", "remove", "deepseek"])).out.join(""), /Removed the DeepSeek key/);
    assert.match((await cli(fx, ["keys", "remove", "deepseek"])).out.join(""), /No DeepSeek key is saved/);
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.deepseek"), undefined);

    await rejectsCode(cli(fx, ["keys", "set", "chatgpt", "--stdin"], { stdin: new PipeInput("x\n") }), "invalid_arguments")
      .then((error) => assert.match(error.message, /signs in through the account runner/));
    await rejectsCode(cli(fx, ["keys", "set", "nonesuch", "--stdin"], { stdin: new PipeInput("x\n") }), "unknown_provider");
    await rejectsCode(cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput("\r\n") }), "invalid_arguments");

    await cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput("stub-key-openai-0003\n") });
    await rejectsCode(cli(fx, ["keys", "reset"]), "invalid_arguments").then((error) => assert.match(error.message, /--yes/));
    const declined = new FakeTty();
    const declining = cli(fx, ["keys", "reset"], { stdin: declined });
    await declined.type("no\r\n");
    assert.match((await declining).out.join(""), /Nothing was changed/);
    assert.ok((await readAiboardHome(fx.location)).secret("credentials.providers.openai"));
    const confirmed = new FakeTty();
    const confirming = cli(fx, ["keys", "reset"], { stdin: confirmed });
    await confirmed.type("yes\n");
    assert.match((await confirming).out.join(""), /Every saved key was removed/);
    const home = await readAiboardHome(fx.location);
    assert.equal(home.secret("credentials.providers.openai"), undefined);
    assert.equal(home.config.providers.openai?.enabled, true, "settings are kept");
  } finally { cleanup(fx); }
});

test("keys saved on another computer: config still shows the settings, writes give home_key_mismatch", async () => {
  const fx = fixture();
  try {
    await cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput("stub-key-openai-0004\n") });
    writeFileSync(fx.location.keyPath, randomBytes(32), { mode: 0o600 });
    const shown = await cli(fx, ["config"]);
    assert.match(shown.out.join(""), /Saved keys cannot be read: home_key_mismatch/);
    await rejectsCode(cli(fx, ["keys", "set", "openai", "--stdin"], { stdin: new PipeInput("stub-key-openai-0005\n") }), "home_key_mismatch");
    await rejectsCode(cli(fx, ["models"]), "home_key_mismatch");
    await cli(fx, ["keys", "reset", "--yes"]);
    assert.match((await cli(fx, ["config"])).out.join(""), /openai\s+enabled\s+no key/);
    if (process.platform !== "win32") assert.equal(statSync(fx.location.credentialsPath).mode & 0o777, 0o600);
  } finally { cleanup(fx); }
});
