import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { AiboardHomeError, aiboardHomeStatePaths, resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import {
  applyHomeBatch,
  BROWSER_ONLY_SETTINGS_FIELDS,
  BROWSER_ONLY_TOOL_RUNTIME_FIELDS,
  CUSTOM_MODEL_HOME_FIELDS,
  CUSTOM_MODEL_NOT_STORED_FIELDS,
  CUSTOM_MODEL_SECRET_FIELDS,
  DROPPED_SETTINGS_FIELDS,
  HOME_SETTINGS_FIELDS,
  HOME_TOOL_RUNTIME_FIELDS,
  HOME_TOP_LEVEL_SETTINGS_FIELDS,
  homeOpsFromWebState,
  PROVIDER_KEY_HOME_FIELDS,
  PROVIDER_KEY_NOT_STORED_FIELDS,
  PROVIDER_KEY_SECRET_FIELDS,
  readAiboardHome,
  REMOTE_MCP_SERVER_HOME_FIELDS,
  REMOTE_MCP_SERVER_SECRET_FIELDS,
  resetHomeCredentials,
  type HomeBatch,
  type HomeConflictDetails,
} from "../src/aiboard-home-store.js";
import { acquireLockFile } from "../src/launcher-instance.js";
import { userStatePaths } from "../src/self-update.js";

// Stub values only: no real provider key appears in this file.
const SECRET_A = "test-secret-aaaa-0001";
const SECRET_B = "test-secret-bbbb-0002";

interface Fixture { root: string; location: AiboardHomeLocation; environment: NodeJS.ProcessEnv; userHome: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-home-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
  return { root, environment, userHome, location: resolveAiboardHome({ platform: process.platform, environment, home: userHome }) };
}

function cleanup(fx: Fixture): void { rmSync(fx.root, { recursive: true, force: true }); }

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<AiboardHomeError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof AiboardHomeError, `expected AiboardHomeError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function write(fx: Fixture, ops: HomeBatch["ops"], baseRevision?: number) {
  const current = baseRevision ?? (await readAiboardHome(fx.location, { credentials: false })).revision;
  return await applyHomeBatch(fx.location, { baseRevision: current, ops });
}

const provider = (baseUrl: string | null = null) => ({ enabled: true, baseUrl, models: null, enabledModelIds: ["openai:gpt-test"], defaultModel: "openai:gpt-test", lastValidationSucceeded: true, lastValidatedAt: "2026-11-12T00:00:00.000Z" });

// ------------------------------------------------------------------ round trip

test("home round-trips settings, providers, custom models and keys", async () => {
  const fx = fixture();
  try {
    const result = await write(fx, [
      { path: "settings.defaultMode", op: "set", value: "chat" },
      { path: "settings.modelPricingOverrides.openai:gpt-5.1", op: "set", value: { inputUsdPer1M: 1, outputUsdPer1M: 2, updatedAt: "2026-11-12" } },
      { path: "openAIConnectionMode", op: "set", value: "subscription" },
      { path: "providers.openai", op: "set", value: provider() },
      { path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } },
      { path: "customModels.local-1", op: "set", value: { label: "Local", baseURL: "http://127.0.0.1:11434/v1/", model: "gemma" } },
      { path: "credentials.customModels.local-1", op: "set", value: { secret: SECRET_B } },
    ], 0);
    assert.equal(result.revision, 1);
    const home = await readAiboardHome(fx.location);
    assert.equal(home.exists, true);
    assert.equal(home.revision, 1);
    assert.equal(home.writable, true);
    assert.equal(home.config.contractVersion, "aiboard.home.v1");
    assert.equal(home.config.settings.defaultMode, "chat");
    assert.deepEqual((home.config.settings.modelPricingOverrides as Record<string, unknown>)["openai:gpt-5.1"], { inputUsdPer1M: 1, outputUsdPer1M: 2, updatedAt: "2026-11-12" });
    assert.equal(home.config.openAIConnectionMode, "subscription");
    assert.deepEqual(home.config.providers.openai, provider());
    assert.equal(home.config.customModels[0]?.model, "gemma");
    assert.equal(home.secret("credentials.providers.openai"), SECRET_A);
    assert.equal(home.secret("credentials.customModels.local-1"), SECRET_B);
    assert.deepEqual(home.credentials?.providers.openai, { keyHint: "test...0001" });
    assert.equal(home.config.pathRevisions["providers.openai"], 1);
    assert.equal(home.config.pathRevisions["credentials.providers.openai"], 1);
    const config = readFileSync(fx.location.configPath, "utf8");
    const credentials = readFileSync(fx.location.credentialsPath, "utf8");
    for (const text of [config, credentials]) {
      assert.ok(!text.includes(SECRET_A) && !text.includes(SECRET_B), "no secret in either file's bytes");
    }
    assert.match(JSON.parse(credentials).keyId, /^[0-9a-f]{16}$/);
    assert.ok(existsSync(fx.location.keyPath), "the home key is created in the user data root");
    assert.ok(!fx.location.keyPath.startsWith(fx.location.home), "the home key sits outside the home");
    // Removing a key and a provider round-trips too.
    await write(fx, [{ path: "credentials.providers.openai", op: "remove" }, { path: "customModels.local-1", op: "remove" }]);
    const after = await readAiboardHome(fx.location);
    assert.equal(after.secret("credentials.providers.openai"), undefined);
    assert.equal(after.config.customModels.length, 0);
    assert.equal(after.secret("credentials.customModels.local-1"), undefined, "a removed custom model takes its key with it");
  } finally { cleanup(fx); }
});

test("an empty home reads as defaults without creating any file", async () => {
  const fx = fixture();
  try {
    const home = await readAiboardHome(fx.location);
    assert.equal(home.exists, false);
    assert.equal(home.revision, 0);
    assert.deepEqual(home.credentials, { providers: {}, customModels: {} });
    assert.equal(existsSync(fx.location.home), false);
    assert.equal(existsSync(fx.location.keyPath), false);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ key errors

test("a missing or corrupt home key gives home_unreadable, never a partial read", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }, { path: "credentials.providers.anthropic", op: "set", value: { secret: SECRET_B } }], 0);
    const key = readFileSync(fx.location.keyPath);
    rmSync(fx.location.keyPath);
    await rejectsWith(readAiboardHome(fx.location), "home_unreadable");
    await rejectsWith(write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_B } }]), "home_unreadable");
    writeFileSync(fx.location.keyPath, key.subarray(0, 16), { mode: 0o600 });
    await rejectsWith(readAiboardHome(fx.location), "home_unreadable");
    // The right length but the wrong bytes with the same keyId cannot happen; a damaged envelope can.
    writeFileSync(fx.location.keyPath, key, { mode: 0o600 });
    const envelope = JSON.parse(readFileSync(fx.location.credentialsPath, "utf8"));
    envelope.tag = Buffer.alloc(16, 1).toString("base64");
    writeFileSync(fx.location.credentialsPath, JSON.stringify(envelope), { mode: 0o600 });
    const error = await rejectsWith(readAiboardHome(fx.location), "home_unreadable");
    assert.match(error.message, /keys reset/);
    // Settings alone stay readable.
    assert.equal((await readAiboardHome(fx.location, { credentials: false })).revision, 1);
  } finally { cleanup(fx); }
});

test("a different keyId gives home_key_mismatch, refuses credential writes, and keys reset recovers", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "providers.openai", op: "set", value: provider() }, { path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }], 0);
    // Another computer's key: same length, different bytes, so a different keyId.
    writeFileSync(fx.location.keyPath, randomBytes(32), { mode: 0o600 });
    const error = await rejectsWith(readAiboardHome(fx.location), "home_key_mismatch");
    assert.match(error.message, /another computer/);
    const before = readFileSync(fx.location.credentialsPath, "utf8");
    await rejectsWith(write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_B } }]), "home_key_mismatch");
    assert.equal(readFileSync(fx.location.credentialsPath, "utf8"), before, "a refused write leaves credentials.json untouched");
    // A settings-only write still lands and never rewrites the foreign credentials.
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "panel" }]);
    assert.equal(readFileSync(fx.location.credentialsPath, "utf8"), before);
    await resetHomeCredentials(fx.location);
    const home = await readAiboardHome(fx.location);
    assert.deepEqual(home.credentials, { providers: {}, customModels: {} });
    assert.equal(home.config.settings.defaultMode, "panel", "reset keeps settings");
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_B } }]);
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.openai"), SECRET_B);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ concurrency

test("two writers changing different sections, two entries of one map included, both land", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }], 0);
    const base = 1;
    const results = await Promise.all([
      applyHomeBatch(fx.location, { baseRevision: base, ops: [{ path: "settings.modelPricingOverrides.openai:a", op: "set", value: { inputUsdPer1M: 1, outputUsdPer1M: 1, updatedAt: "x" } }] }),
      applyHomeBatch(fx.location, { baseRevision: base, ops: [{ path: "settings.modelPricingOverrides.openai:b", op: "set", value: { inputUsdPer1M: 2, outputUsdPer1M: 2, updatedAt: "y" } }] }),
      applyHomeBatch(fx.location, { baseRevision: base, ops: [{ path: "providers.anthropic", op: "set", value: provider() }] }),
      applyHomeBatch(fx.location, { baseRevision: base, ops: [{ path: "credentials.providers.google", op: "set", value: { secret: SECRET_A } }] }),
    ]);
    assert.deepEqual(results.map((result) => result.revision).sort(), [2, 3, 4, 5]);
    const home = await readAiboardHome(fx.location);
    const overrides = home.config.settings.modelPricingOverrides as Record<string, unknown>;
    assert.deepEqual(Object.keys(overrides).sort(), ["openai:a", "openai:b"]);
    assert.ok(home.config.providers.anthropic);
    assert.equal(home.secret("credentials.providers.google"), SECRET_A);
    assert.equal(home.config.settings.defaultMode, "chat");
  } finally { cleanup(fx); }
});

test("a stale baseRevision on the same section gets home_conflict with the current revision and values", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "providers.openai", op: "set", value: provider() }, { path: "settings.modelPricingOverrides.m1", op: "set", value: { inputUsdPer1M: 1, outputUsdPer1M: 1, updatedAt: "a" } }], 0);
    await write(fx, [{ path: "providers.openai", op: "merge", value: { defaultModel: "openai:newer" } }], 1);
    const conflict = await rejectsWith(write(fx, [{ path: "providers.openai", op: "merge", value: { enabled: false } }, { path: "settings.defaultMode", op: "set", value: "panel" }], 1), "home_conflict");
    const details = conflict.details as HomeConflictDetails;
    assert.equal(details.currentRevision, 2);
    assert.deepEqual(Object.keys(details.sections), ["providers.openai"]);
    assert.equal((details.sections["providers.openai"] as { defaultModel: string }).defaultModel, "openai:newer");
    const home = await readAiboardHome(fx.location);
    assert.equal(home.revision, 2, "a refused batch writes nothing, all or nothing");
    assert.equal(home.config.settings.defaultMode, undefined);
    // A whole map overlaps each of its entries.
    await write(fx, [{ path: "settings.modelPricingOverrides.m2", op: "set", value: { inputUsdPer1M: 2, outputUsdPer1M: 2, updatedAt: "b" } }], 2);
    await rejectsWith(write(fx, [{ path: "settings.modelPricingOverrides", op: "set", value: {} }], 2), "home_conflict");
    // A credential conflict shows only whether a key is saved.
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }]);
    const keyConflict = await rejectsWith(write(fx, [{ path: "credentials.providers.openai", op: "remove" }], 2), "home_conflict");
    assert.deepEqual((keyConflict.details as HomeConflictDetails).sections["credentials.providers.openai"], { hasKey: true, keyHint: "test...0001" });
    assert.ok(!JSON.stringify(keyConflict.details).includes(SECRET_A));
  } finally { cleanup(fx); }
});

test("a held write lock gives home_busy after the wait", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }], 0);
    const release = await acquireLockFile(fx.location.lockPath, 1_000);
    assert.ok(release);
    try {
      assert.equal(await acquireLockFile(fx.location.lockPath, 100), null, "a second holder waits, then gets null");
      await rejectsWith(applyHomeBatch(fx.location, { baseRevision: 1, ops: [{ path: "settings.defaultMode", op: "set", value: "panel" }] }, { lockWaitMs: 200 }), "home_busy");
    } finally { release(); }
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "panel" }]);
  } finally { cleanup(fx); }
});

const READER_SCRIPT = `
const { readFileSync } = require("node:fs");
const [config, credentials, ms] = process.argv.slice(1);
const deadline = Date.now() + Number(ms);
let reads = 0, torn = 0, busy = 0, revisions = new Set();
while (Date.now() < deadline) {
  for (const file of [config, credentials]) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") busy++; continue; }
    try { const value = JSON.parse(text); if (file === config) revisions.add(value.revision); reads++; } catch { torn++; }
  }
}
process.stdout.write(JSON.stringify({ reads, torn, busy, revisions: revisions.size }));
`;

test("a reader in another process never sees a torn file", { timeout: 60_000 }, async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }], 0);
    const child = spawn(process.execPath, ["-e", READER_SCRIPT, fx.location.configPath, fx.location.credentialsPath, "3000"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
    const stopAt = Date.now() + 2_500;
    for (let index = 0; Date.now() < stopAt; index += 1) {
      await write(fx, [
        { path: "settings.discoveredModelMetadata", op: "set", value: { padding: { note: "x".repeat(1_000 + (index % 7) * 50_000) } } },
        { path: "credentials.providers.openai", op: "set", value: { secret: index % 2 ? SECRET_A : SECRET_B } },
      ]);
    }
    assert.equal(await exited, 0);
    const report = JSON.parse(output) as { reads: number; torn: number; busy: number; revisions: number };
    assert.equal(report.torn, 0, JSON.stringify(report));
    assert.ok(report.reads > 0 && report.revisions > 1, JSON.stringify(report));
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ upstream binding

test("a pause between the two renames never pairs a key with a new upstream", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "providers.azure", op: "set", value: provider("https://old.example.test/openai") }, { path: "credentials.providers.azure", op: "set", value: { secret: SECRET_A } }], 0);
    const observed: Array<string | undefined> = [];
    // The URL changes and a new key is entered in one batch: credentials.json lands first.
    await applyHomeBatch(fx.location, { baseRevision: 1, ops: [
      { path: "providers.azure", op: "merge", value: { baseUrl: "https://new.example.test/openai" } },
      { path: "credentials.providers.azure", op: "set", value: { secret: SECRET_B } },
    ] }, { afterCredentialsWrite: async () => {
      const between = await readAiboardHome(fx.location);
      assert.equal(between.config.providers.azure?.baseUrl, "https://old.example.test/openai", "config.json is still the old one");
      observed.push(between.secret("credentials.providers.azure"));
    } });
    assert.deepEqual(observed, [undefined], "between the renames the new key is bound to the new URL, so the old config gets no key");
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.azure"), SECRET_B);
    // The URL changes alone: the key goes, and between the renames the old config sees no key either.
    const observedAlone: Array<string | undefined> = [];
    await applyHomeBatch(fx.location, { baseRevision: 2, ops: [{ path: "providers.azure", op: "merge", value: { baseUrl: "https://third.example.test/openai" } }] }, {
      afterCredentialsWrite: async () => { observedAlone.push((await readAiboardHome(fx.location)).secret("credentials.providers.azure")); },
    });
    assert.deepEqual(observedAlone, [undefined]);
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.azure"), undefined);
  } finally { cleanup(fx); }
});

test("changing a base URL removes that key, for providers, custom models and the remote MCP server", async () => {
  const fx = fixture();
  try {
    await write(fx, [
      { path: "providers.azure", op: "set", value: provider("https://a.example.test/v1") },
      { path: "credentials.providers.azure", op: "set", value: { secret: SECRET_A } },
      { path: "providers.openai", op: "set", value: provider() },
      { path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } },
      { path: "customModels.cm", op: "set", value: { label: "cm", baseURL: "http://127.0.0.1:1234/v1", model: "m" } },
      { path: "credentials.customModels.cm", op: "set", value: { secret: SECRET_B } },
      { path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "docs", url: "https://mcp.example.test/mcp" } } },
      { path: "credentials.remoteMcpAuthorizationToken", op: "set", value: { secret: SECRET_B } },
    ], 0);
    // Spelling changes that normalize to the same upstream keep the key.
    const same = await write(fx, [{ path: "providers.azure", op: "merge", value: { baseUrl: "HTTPS://A.EXAMPLE.TEST:443/v1/" } }]);
    assert.deepEqual(same.removedCredentials, []);
    const result = await write(fx, [
      { path: "providers.azure", op: "merge", value: { baseUrl: "https://b.example.test/v1" } },
      { path: "providers.openai", op: "merge", value: { baseUrl: "https://gateway.example.test/v1" } },
      { path: "customModels.cm", op: "merge", value: { baseURL: "http://127.0.0.1:9999/v1" } },
      { path: "settings.toolRuntime", op: "merge", value: { remoteMcpServer: { enabled: true, name: "docs", url: "https://other.example.test/mcp" } } },
    ]);
    assert.deepEqual(result.removedCredentials.sort(), ["credentials.customModels.cm", "credentials.providers.azure", "credentials.providers.openai", "credentials.remoteMcpAuthorizationToken"]);
    const home = await readAiboardHome(fx.location);
    assert.deepEqual(home.credentials, { providers: {}, customModels: {} });
    for (const path of result.removedCredentials) assert.equal(home.config.pathRevisions[path], result.revision);
    // A key whose config was edited by hand behind the store's back is never returned.
    await write(fx, [{ path: "credentials.providers.azure", op: "set", value: { secret: SECRET_A } }]);
    const config = JSON.parse(readFileSync(fx.location.configPath, "utf8"));
    config.providers.azure.baseUrl = "https://evil.example.test/v1";
    writeFileSync(fx.location.configPath, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.azure"), undefined);
    // A URL with credentials in it is refused.
    await rejectsWith(write(fx, [{ path: "providers.azure", op: "merge", value: { baseUrl: "https://user:pass@x.example.test" } }]), "home_invalid_op");
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ canary and field lists

interface SchemaInterface { name: string; members: Map<string, ts.TypeNode> }

function schemaFile(): { interfaces: Map<string, SchemaInterface>; aliases: Map<string, ts.TypeNode> } {
  const path = fileURLToPath(new URL("../../lib/db/schema.ts", import.meta.url));
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const interfaces = new Map<string, SchemaInterface>();
  const aliases = new Map<string, ts.TypeNode>();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      const members = new Map<string, ts.TypeNode>();
      for (const member of statement.members) {
        if (ts.isPropertySignature(member) && member.type && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) members.set(member.name.text, member.type);
      }
      interfaces.set(statement.name.text, { name: statement.name.text, members });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      aliases.set(statement.name.text, statement.type);
    }
  }
  return { interfaces, aliases };
}

/** Imported types the schema names without defining them: their JSON shape, for the canary builder. */
const IMPORTED_OBJECT_TYPES = new Set(["ModelContextOverrides", "ModelMetadataDetails", "CapabilityEvidence", "ToolCapabilityDescriptor"]);

class CanaryBuilder {
  readonly canaries = new Map<string, string>();
  private counter = 0;
  constructor(private readonly schema: ReturnType<typeof schemaFile>) {}

  build(type: ts.TypeNode, path: string): unknown {
    if (ts.isParenthesizedTypeNode(type)) return this.build(type.type, path);
    switch (type.kind) {
      case ts.SyntaxKind.StringKeyword: return this.canary(path);
      case ts.SyntaxKind.NumberKeyword: return 1;
      case ts.SyntaxKind.BooleanKeyword: return true;
      case ts.SyntaxKind.UnknownKeyword: return this.canary(path);
    }
    if (ts.isLiteralTypeNode(type)) {
      if (ts.isStringLiteral(type.literal)) return type.literal.text;
      if (type.literal.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (type.literal.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (ts.isNumericLiteral(type.literal)) return Number(type.literal.text);
      return null;
    }
    if (ts.isUnionTypeNode(type)) {
      const members = type.types.filter((member) => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) && member.kind !== ts.SyntaxKind.UndefinedKeyword);
      const string = members.find((member) => member.kind === ts.SyntaxKind.StringKeyword);
      return this.build(string ?? members[0]!, path);
    }
    if (ts.isArrayTypeNode(type)) return [this.build(type.elementType, `${path}[]`)];
    if (ts.isTypeLiteralNode(type)) {
      const value: Record<string, unknown> = {};
      for (const member of type.members) {
        if (ts.isPropertySignature(member) && member.type && ts.isIdentifier(member.name)) value[member.name.text] = this.build(member.type, `${path}.${member.name.text}`);
      }
      return value;
    }
    if (ts.isIntersectionTypeNode(type)) {
      return Object.assign({}, ...type.types.map((member) => this.build(member, path)).filter((part) => typeof part === "object" && part !== null));
    }
    if (ts.isTypeReferenceNode(type)) {
      const name = type.typeName.getText();
      if (name === "Record" && type.typeArguments?.[1]) return { "entry-1": this.build(type.typeArguments[1], `${path}.entry-1`) };
      if (name === "Array" && type.typeArguments?.[0]) return [this.build(type.typeArguments[0], `${path}[]`)];
      const local = this.schema.interfaces.get(name);
      if (local) return this.object(local, path);
      const alias = this.schema.aliases.get(name);
      if (alias) return this.build(alias, path);
      if (IMPORTED_OBJECT_TYPES.has(name)) return { field: this.canary(`${path}.field`) };
      return this.canary(path);
    }
    return this.canary(path);
  }

  object(definition: SchemaInterface, path: string): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    for (const [name, type] of definition.members) value[name] = this.build(type, `${path}.${name}`);
    return value;
  }

  private canary(path: string): string {
    this.counter += 1;
    const token = `cnry${this.counter}x${randomBytes(3).toString("hex")}`;
    const field = path.split(".").at(-1) ?? "";
    const value = /url/i.test(field) ? `https://${token}.example.test/v1` : token;
    this.canaries.set(path, token);
    return value;
  }
}

test("every UserSettings, ProviderKey and CustomModel field is in exactly one home list", () => {
  const { interfaces } = schemaFile();
  const check = (name: string, lists: Record<string, readonly string[]>) => {
    const definition = interfaces.get(name);
    assert.ok(definition, `${name} is in lib/db/schema.ts`);
    for (const field of definition.members.keys()) {
      const homes = Object.entries(lists).filter(([, fields]) => fields.includes(field)).map(([list]) => list);
      assert.equal(homes.length, 1, `${name}.${field} must be named in exactly one list (found ${homes.join(", ") || "none"}); a new field stays per browser until it is named`);
    }
  };
  check("UserSettings", { home: HOME_SETTINGS_FIELDS, topLevel: HOME_TOP_LEVEL_SETTINGS_FIELDS, browser: BROWSER_ONLY_SETTINGS_FIELDS, dropped: DROPPED_SETTINGS_FIELDS });
  check("ToolRuntimeSettings", { home: HOME_TOOL_RUNTIME_FIELDS, browser: BROWSER_ONLY_TOOL_RUNTIME_FIELDS });
  check("RemoteMcpServerSettings", { home: REMOTE_MCP_SERVER_HOME_FIELDS, secret: REMOTE_MCP_SERVER_SECRET_FIELDS });
  check("ProviderKey", { home: Object.keys(PROVIDER_KEY_HOME_FIELDS), secret: PROVIDER_KEY_SECRET_FIELDS, notStored: PROVIDER_KEY_NOT_STORED_FIELDS });
  check("CustomModel", { home: CUSTOM_MODEL_HOME_FIELDS, secret: CUSTOM_MODEL_SECRET_FIELDS, notStored: CUSTOM_MODEL_NOT_STORED_FIELDS });
});

test("a canary secret in every string field of UserSettings, ProviderKey and CustomModel never reaches config.json", async () => {
  const fx = fixture();
  try {
    const schema = schemaFile();
    const builder = new CanaryBuilder(schema);
    const settings = builder.object(schema.interfaces.get("UserSettings")!, "UserSettings");
    const providerKey = { ...builder.object(schema.interfaces.get("ProviderKey")!, "ProviderKey"), providerId: "openai" };
    const customModel = { ...builder.object(schema.interfaces.get("CustomModel")!, "CustomModel"), id: "custom-1", compatibleTransports: ["chat_completions"] };
    const ops = homeOpsFromWebState({ settings, providerKeys: [providerKey], customModels: [customModel] });
    await applyHomeBatch(fx.location, { baseRevision: 0, ops });
    const config = readFileSync(fx.location.configPath, "utf8");
    const others = [readFileSync(fx.location.credentialsPath, "utf8"), ...["", ".identity"].map((suffix) => existsSync(fx.location.lockPath + suffix) ? readFileSync(fx.location.lockPath + suffix, "latin1") : "")];
    const secretPaths = [/^UserSettings\.toolRuntime\.remoteMcpServer\.authorizationToken$/, /^ProviderKey\.apiKey$/, /^CustomModel\.apiKey$/];
    const keptOut = [
      ...BROWSER_ONLY_SETTINGS_FIELDS.map((field) => `UserSettings.${field}`), ...DROPPED_SETTINGS_FIELDS.map((field) => `UserSettings.${field}`),
      ...BROWSER_ONLY_TOOL_RUNTIME_FIELDS.map((field) => `UserSettings.toolRuntime.${field}`),
      ...PROVIDER_KEY_NOT_STORED_FIELDS.filter((field) => field !== "providerId").map((field) => `ProviderKey.${field}`),
      ...CUSTOM_MODEL_NOT_STORED_FIELDS.map((field) => `CustomModel.${field}`),
    ];
    let secrets = 0, kept = 0, stored = 0;
    for (const [path, token] of builder.canaries) {
      const isSecret = secretPaths.some((pattern) => pattern.test(path));
      const isKeptOut = keptOut.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[]`));
      if (isSecret || isKeptOut) {
        assert.ok(!config.includes(token), `${path} reached config.json`);
        for (const text of others) assert.ok(!text.includes(token), `${path} appears in plain text in a home file`);
        if (isSecret) secrets += 1; else kept += 1;
      } else if (config.includes(token)) {
        stored += 1;
      }
    }
    assert.equal(secrets, 3, "the three secret fields carried canaries");
    assert.ok(kept >= 8, `browser-only and not-stored fields carried canaries (${kept})`);
    assert.ok(stored >= 10, `allow-listed settings still reach config.json (${stored})`);
    const home = await readAiboardHome(fx.location);
    assert.equal(home.secret("credentials.providers.openai"), builder.canaries.get("ProviderKey.apiKey"));
    assert.equal(home.secret("credentials.customModels.custom-1"), builder.canaries.get("CustomModel.apiKey"));
    assert.equal(home.secret("credentials.remoteMcpAuthorizationToken"), builder.canaries.get("UserSettings.toolRuntime.remoteMcpServer.authorizationToken"));
    // A secret sent in a settings op is refused, not stored.
    await rejectsWith(write(fx, [{ path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "x", url: "https://x.example.test", authorizationToken: "test-token" } } }]), "home_invalid_op");
    await rejectsWith(write(fx, [{ path: "providers.openai", op: "merge", value: { apiKey: "test-key" } }]), "home_invalid_op");
    await rejectsWith(write(fx, [{ path: "settings.toolRuntime", op: "set", value: { runner: { url: "http://127.0.0.1:1", token: "t", access: "full" } } }]), "home_invalid_op");
    await rejectsWith(write(fx, [{ path: "settings.benchmarkRunner", op: "set", value: { url: "http://127.0.0.1:1", token: "t" } }]), "home_invalid_op");
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ compatibility

test("unknown fields survive a write, and a newer contractVersion refuses writes with home_newer", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "providers.openai", op: "set", value: provider() }, { path: "customModels.cm", op: "set", value: { label: "cm", baseURL: "http://127.0.0.1:1/v1", model: "m" } }, { path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }], 0);
    const config = JSON.parse(readFileSync(fx.location.configPath, "utf8"));
    config.exec = { defaultModelId: "openai:gpt-test", ceilings: { maxWallClockMs: null, maxModelCalls: null, maxUsd: null } };
    config.futureTopLevel = [1, 2, 3];
    config.providers.openai.futureProviderField = "kept";
    config.customModels[0].futureModelField = { nested: true };
    config.settings.futureSetting = "kept too";
    writeFileSync(fx.location.configPath, JSON.stringify(config), { mode: 0o600 });
    await write(fx, [{ path: "providers.openai", op: "merge", value: { enabled: false } }, { path: "customModels.cm", op: "set", value: { label: "renamed", baseURL: "http://127.0.0.1:1/v1", model: "m" } }, { path: "settings.defaultMode", op: "set", value: "panel" }]);
    const after = JSON.parse(readFileSync(fx.location.configPath, "utf8"));
    assert.deepEqual(after.exec, config.exec, "DX1's exec section is kept verbatim by a writer that predates it");
    assert.deepEqual(after.futureTopLevel, [1, 2, 3]);
    assert.equal(after.providers.openai.futureProviderField, "kept");
    assert.equal(after.providers.openai.enabled, false);
    assert.deepEqual(after.customModels[0].futureModelField, { nested: true });
    assert.equal(after.customModels[0].label, "renamed");
    assert.equal(after.settings.futureSetting, "kept too");
    await rejectsWith(write(fx, [{ path: "exec", op: "set", value: {} }]), "home_invalid_op");

    // A newer config.json: readable with the fields this reader knows, never written.
    after.contractVersion = "aiboard.home.v2";
    writeFileSync(fx.location.configPath, JSON.stringify(after), { mode: 0o600 });
    const newer = await readAiboardHome(fx.location);
    assert.equal(newer.writable, false);
    assert.equal(newer.config.providers.openai?.defaultModel, "openai:gpt-test");
    assert.equal(newer.secret("credentials.providers.openai"), SECRET_A);
    const bytes = readFileSync(fx.location.configPath, "utf8");
    const refused = await rejectsWith(write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }]), "home_newer");
    assert.match(refused.message, /update AI Board/);
    assert.equal(readFileSync(fx.location.configPath, "utf8"), bytes);
  } finally { cleanup(fx); }
});

// ------------------------------------------------------------------ location and safety

test("a relative or unsafe AIBOARD_HOME is refused with home_unsafe", async () => {
  const base = { platform: process.platform, home: tmpdir() };
  const unsafe = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) => {
    assert.throws(() => resolveAiboardHome({ ...base, platform, environment: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ...environment } }), (error) => error instanceof AiboardHomeError && error.code === "home_unsafe");
  };
  unsafe({ AIBOARD_HOME: "relative/home" });
  unsafe({ AIBOARD_HOME: "./home" });
  unsafe({ AIBOARD_HOME: "\\\\server\\share\\aiboard" }, "win32");
  unsafe({ AIBOARD_HOME: "\\aiboard" }, "win32");
  unsafe({ AIBOARD_HOME: "/abs\0nul" }, "linux");
  assert.equal(resolveAiboardHome({ platform: "linux", home: "/home/u", environment: {} }).home, "/home/u/.aiboard");
  assert.equal(resolveAiboardHome({ platform: "linux", home: "/home/u", environment: { AIBOARD_HOME: "" } }).source, "default");
  assert.equal(resolveAiboardHome({ platform: "win32", home: "C:\\Users\\u", environment: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } }).keyPath, "C:\\Users\\u\\AppData\\Local\\AIBoard\\home-key");
  const fx = fixture();
  try {
    writeFileSync(fx.location.home, "not a folder");
    await rejectsWith(readAiboardHome(fx.location), "home_unsafe");
    await rejectsWith(write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }], 0), "home_unsafe");
  } finally { cleanup(fx); }
});

test("POSIX: a group- or world-writable home is refused, and the home is 0700 with 0600 files", { skip: process.platform === "win32" }, async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }], 0);
    assert.equal(statSync(fx.location.home).mode & 0o777, 0o700);
    for (const path of [fx.location.configPath, fx.location.credentialsPath, fx.location.lockPath, fx.location.keyPath]) assert.equal(statSync(path).mode & 0o777, 0o600, path);
    chmodSync(fx.location.home, 0o770);
    await rejectsWith(readAiboardHome(fx.location), "home_unsafe");
    chmodSync(fx.location.home, 0o700);
    chmodSync(fx.location.credentialsPath, 0o644);
    await rejectsWith(readAiboardHome(fx.location), "home_unsafe");
  } finally { cleanup(fx); }
});

test("userStatePaths lists the home's files, for the default home and AIBOARD_HOME", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const home = platform === "win32" ? "C:\\Users\\u" : "/home/u";
    const environment = platform === "win32" ? { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } : {};
    const paths = userStatePaths({ platform, environment, home, root: platform === "win32" ? "C:\\Users\\u\\AppData\\Local\\AIBoard" : "/home/u/.aiboard" });
    for (const file of aiboardHomeStatePaths({ platform, environment, home })) assert.ok(paths.includes(file), `${platform}: ${file}`);
    const homeFiles = aiboardHomeStatePaths({ platform, environment, home });
    for (const name of ["config.json", "credentials.json", "home-lock.sqlite", "home-key"]) assert.ok(homeFiles.some((file) => file.endsWith(name)), `${platform}: ${name}`);
    assert.ok(!paths.includes(platform === "win32" ? "C:\\Users\\u\\.aiboard" : "/home/u/.aiboard"), "the rest of ~/.aiboard is not deleted as a whole");
  }
  const custom = aiboardHomeStatePaths({ platform: "linux", environment: { AIBOARD_HOME: "/data/aiboard-home" }, home: "/home/u" });
  assert.ok(custom.includes("/data/aiboard-home/credentials.json"));
});

// ------------------------------------------------------------------ review fixes (PR 174)

const TSX_CLI = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const LAUNCHER_INSTANCE_URL = new URL("../src/launcher-instance.ts", import.meta.url).href;

/** acquireLockFile(lockPath, 0) in a separate process: "acquired" or "busy". */
async function probeLockFromAnotherProcess(root: string, lockPath: string): Promise<string> {
  const script = join(root, "probe-lock.mts");
  writeFileSync(script, [
    `import { acquireLockFile } from ${JSON.stringify(LAUNCHER_INSTANCE_URL)};`,
    "const release = await acquireLockFile(process.argv[2], 0);",
    "process.stdout.write(release ? \"acquired\" : \"busy\");",
    "release?.();",
    "",
  ].join("\n"));
  const child = spawn(process.execPath, [TSX_CLI, script, lockPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const code = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  assert.equal(code, 0, errors);
  return output;
}

test("a second writer in this process never releases the first one's lock to another process", { timeout: 60_000 }, async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }], 0);
    let paused!: () => void;
    const isPaused = new Promise<void>((resolvePaused) => { paused = resolvePaused; });
    let open!: () => void;
    const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
    const first = applyHomeBatch(fx.location, { baseRevision: 1, ops: [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }] }, {
      lockWaitMs: 30_000, afterCredentialsWrite: async () => { paused(); await gate; },
    });
    await isPaused;
    const second = applyHomeBatch(fx.location, { baseRevision: 1, ops: [{ path: "settings.modelPricingOverrides.m", op: "set", value: { inputUsdPer1M: 1, outputUsdPer1M: 1, updatedAt: "z" } }] }, { lockWaitMs: 30_000 });
    // A waiter that gives up in this process gets home_busy and does not break the queue.
    await rejectsWith(applyHomeBatch(fx.location, { baseRevision: 1, ops: [{ path: "settings.defaultVerbosity", op: "set", value: "brief" }] }, { lockWaitMs: 150 }), "home_busy");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300)); // a polling waiter would have probed the file several times
    assert.equal(await probeLockFromAnotherProcess(fx.root, fx.location.lockPath), "busy", "the first writer still holds the OS-level lock");
    open();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.revision), [2, 3]);
    const home = await readAiboardHome(fx.location);
    assert.equal(home.secret("credentials.providers.openai"), SECRET_A);
    assert.ok((home.config.settings.modelPricingOverrides as Record<string, unknown>).m);
    assert.equal(home.config.settings.defaultVerbosity, undefined);
    assert.equal(await probeLockFromAnotherProcess(fx.root, fx.location.lockPath), "acquired", "the lock is free afterwards");
  } finally { cleanup(fx); }
});

test("a key saved from a stale view of its base URL gets home_conflict with the new URL", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "providers.azure", op: "set", value: provider("https://a.example.test/v1") }, { path: "credentials.providers.azure", op: "set", value: { secret: SECRET_A } }], 0);
    await write(fx, [{ path: "providers.azure", op: "merge", value: { baseUrl: "https://b.example.test/v1" } }], 1);
    const conflict = await rejectsWith(write(fx, [{ path: "credentials.providers.azure", op: "set", value: { secret: SECRET_B } }], 1), "home_conflict");
    const details = conflict.details as HomeConflictDetails;
    assert.equal(details.currentRevision, 2);
    assert.equal((details.sections["providers.azure"] as { baseUrl: string }).baseUrl, "https://b.example.test/v1", "the conflict shows the new URL");
    assert.deepEqual(details.sections["credentials.providers.azure"], { hasKey: false });
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.azure"), undefined);
    await write(fx, [{ path: "credentials.providers.azure", op: "set", value: { secret: SECRET_B } }], 2);
    assert.equal((await readAiboardHome(fx.location)).secret("credentials.providers.azure"), SECRET_B, "at the current revision the key lands, bound to URL B");
    // The same rule for a custom model and the remote MCP server.
    await write(fx, [
      { path: "customModels.cm", op: "set", value: { label: "cm", baseURL: "http://127.0.0.1:1/v1", model: "m" } },
      { path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "d", url: "https://mcp-a.example.test" } } },
    ], 3);
    await write(fx, [
      { path: "customModels.cm", op: "merge", value: { baseURL: "http://127.0.0.1:2/v1" } },
      { path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "d", url: "https://mcp-b.example.test" } } },
    ], 4);
    const both = await rejectsWith(write(fx, [{ path: "credentials.customModels.cm", op: "set", value: { secret: SECRET_A } }, { path: "credentials.remoteMcpAuthorizationToken", op: "set", value: { secret: SECRET_A } }], 4), "home_conflict");
    assert.deepEqual(Object.keys((both.details as HomeConflictDetails).sections).sort(), ["credentials.customModels.cm", "credentials.remoteMcpAuthorizationToken", "customModels.cm", "settings.toolRuntime"]);
  } finally { cleanup(fx); }
});

test("a newer credentials envelope gives home_newer, and settings-only writes still land", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: SECRET_A } }], 0);
    const envelope = JSON.parse(readFileSync(fx.location.credentialsPath, "utf8"));
    envelope.version = 2;
    writeFileSync(fx.location.credentialsPath, JSON.stringify(envelope), { mode: 0o600 });
    const bytes = readFileSync(fx.location.credentialsPath, "utf8");
    const read = await rejectsWith(readAiboardHome(fx.location), "home_newer");
    assert.match(read.message, /update AI Board/);
    assert.doesNotMatch(read.message, /keys reset/);
    await rejectsWith(write(fx, [{ path: "credentials.providers.openai", op: "remove" }]), "home_newer");
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "panel" }]);
    assert.equal((await readAiboardHome(fx.location, { credentials: false })).config.settings.defaultMode, "panel");
    assert.equal(readFileSync(fx.location.credentialsPath, "utf8"), bytes, "the newer envelope is never rewritten");
  } finally { cleanup(fx); }
});

test("an unreadable config.json says to fix or remove that file, not to enter the keys again", async () => {
  const fx = fixture();
  try {
    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }], 0);
    writeFileSync(fx.location.configPath, "{ not json", { mode: 0o600 });
    const error = await rejectsWith(readAiboardHome(fx.location, { credentials: false }), "home_unreadable");
    assert.match(error.message, /Fix or remove/);
    assert.ok(error.message.includes(fx.location.configPath));
    assert.doesNotMatch(error.message, /keys reset/);
  } finally { cleanup(fx); }
});
