import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_ATTEMPT_MINUTES_DEFAULT,
  CLI_WORKER_PROVIDER_IDS,
  cliAttemptLimitMinutes,
  isCliArgumentValue,
  isCliAttemptMinutes,
  isCliVersion,
  isIsoTimestamp,
  scrubCliMessage,
} from "../src/cli-worker-config.js";
import { CLI_WORKER_HOME_FIELDS } from "../src/aiboard-home-store.js";
import { CLI_WORKER_CONFIGS_FILE, EncryptedProviderConfigStore, openEncryptedJson } from "../src/encrypted-provider-config-store.js";
import { takesKeyFromHome } from "../src/home-provider-configs.js";
import { createProviderModel } from "../src/native-build-factory.js";
import {
  cloneProviderConfigs,
  HOME_SECRET_PLACEHOLDER,
  providerUsageConfig,
  resolvedProviderBillingBasis,
  validateProviderConfigs,
  type RunnerProviderConfig,
} from "../src/provider-config-store.js";
import { isSensitiveKey } from "../src/sensitive-redaction.js";

// CLI workers plan §3.1 and §3.3, packet CW1. A CLI signs in with its own login: no config or home field holds a key.

function cliConfig(overrides: Partial<RunnerProviderConfig> = {}): RunnerProviderConfig {
  return {
    runtimeId: "codex-cli:gpt-test-codex",
    providerId: "codex-cli",
    modelId: "gpt-test-codex",
    transport: "cli",
    secret: "",
    capabilities: ["code"],
    priority: 0,
    ...overrides,
  };
}

function refused(config: RunnerProviderConfig, pattern: RegExp): void {
  assert.throws(() => validateProviderConfigs([config]), pattern, JSON.stringify(config));
}

test("a cli config with no secret, base URL, token or secret source is valid, unmetered, and takes no key from the home", () => {
  const plain = cliConfig({ cli: { reasoningEffort: "high" } });
  validateProviderConfigs([plain]);
  validateProviderConfigs([cliConfig({ runtimeId: "claude-code:default", providerId: "claude-code", modelId: "default" })]);
  validateProviderConfigs([cliConfig({ runtimeId: "agy:gemini/test-1.5", providerId: "agy", modelId: "gemini/test-1.5", billingBasis: "account_not_metered", supportsTools: false })]);
  assert.equal(takesKeyFromHome(plain), false, "a cli config passes through HM3 as pushed");
  assert.equal(resolvedProviderBillingBasis(plain), "account_not_metered");
  assert.equal(providerUsageConfig(plain).billingBasis, "account_not_metered");
  const [copy] = cloneProviderConfigs([plain]);
  assert.deepEqual(copy, plain);
  assert.notEqual(copy!.cli, plain.cli, "the cli block is copied, not shared");
});

test("a cli config with a secret, base URL, token or secret source is refused", () => {
  refused(cliConfig({ secret: "sk-stub-0000000000000000" }), /must not carry a secret/);
  refused(cliConfig({ secret: HOME_SECRET_PLACEHOLDER }), /must not carry a secret/);
  refused(cliConfig({ secret: undefined as unknown as string }), /needs an empty secret/);
  refused(cliConfig({ baseUrl: "https://example.test/v1" }), /must not have a base URL/);
  refused(cliConfig({ baseUrl: "" }), /must not have a base URL/);
  refused(cliConfig({ runnerToken: "runner-token-stub" }), /must not have a Runner token/);
  refused(cliConfig({ secretSource: "home" }), /must not name a secret source/);
});

test("a cli config names a CLI worker, its runtime id is <provider>:<model or default>, and it is never metered, tooled or visual", () => {
  refused(cliConfig({ providerId: "openai", runtimeId: "openai:gpt-test-codex" }), /not a CLI worker/);
  refused(cliConfig({ providerId: "opencode", runtimeId: "opencode:gpt-test-codex" }), /not a CLI worker/);
  refused(cliConfig({ runtimeId: "codex-cli:other" }), /must be named codex-cli:/);
  refused(cliConfig({ runtimeId: "claude-code:gpt-test-codex" }), /must be named codex-cli:/);
  refused(cliConfig({ billingBasis: "api_priced", inputCostMicrosPerMillion: 1, outputCostMicrosPerMillion: 1 }), /not metered/);
  refused(cliConfig({ billingBasis: "unknown" }), /not metered/);
  refused(cliConfig({ inputCostMicrosPerMillion: 1 }), /takes no pricing/);
  refused(cliConfig({ supportsTools: true }), /runs no AIBoard tools/);
  refused(cliConfig({ hostedTools: [{ type: "web_search" }] }), /no hosted tools/);
  refused(cliConfig({ protocol: "responses" }), /no protocol/);
  refused(cliConfig({ inputCapabilities: { image: true, document: false, audio: false, video: false } }), /text only/);
  validateProviderConfigs([cliConfig({ inputCapabilities: { image: false, document: false, audio: false, video: false } })]);
  refused(cliConfig({ reasoningEffort: "high" }), /cli\.reasoningEffort/);
  refused(cliConfig({ cli: { reasoningEffort: "high", extra: true } as never }), /invalid CLI block/);
  // The cli block belongs to cli configs only.
  assert.throws(() => validateProviderConfigs([{
    runtimeId: "openai:gpt-5", providerId: "openai", modelId: "gpt-5", transport: "openai-compatible",
    secret: "sk-stub-0000000000000000", capabilities: ["*"], priority: 0, cli: { reasoningEffort: "high" },
  }]), /not a CLI worker/);
});

test("a model id or effort outside the CLI argument charset is refused", () => {
  const badValues = ["gpt test", "gpt;rm", "gpt$(x)", "gpt`x`", "-c", "--model", "gpt\nx", "gpt'x", "gpt\"x", "a".repeat(129), "", "gpt=x", "gpt\\x", "gpt*"];
  for (const value of badValues) {
    assert.equal(isCliArgumentValue(value), false, JSON.stringify(value));
    refused(cliConfig({ modelId: value, runtimeId: `codex-cli:${value}` }), /model id outside the CLI argument charset/);
    refused(cliConfig({ cli: { reasoningEffort: value } }), /effort outside the CLI argument charset/);
  }
  for (const value of ["gpt-5.1-codex", "claude-opus-4-1", "sonnet", "models/gemini-2.5-pro", "o3:high", "a".repeat(128), "x_y"]) {
    assert.equal(isCliArgumentValue(value), true, value);
    validateProviderConfigs([cliConfig({ modelId: value, runtimeId: `codex-cli:${value}`, cli: { reasoningEffort: value } })]);
  }
  assert.equal(isCliArgumentValue(5), false);
});

test("CWD-6: one CLI attempt defaults to 90 minutes and may be set from 5 to 240", () => {
  assert.equal(CLI_ATTEMPT_MINUTES_DEFAULT, 90);
  assert.equal(cliAttemptLimitMinutes(undefined), 90);
  assert.equal(cliAttemptLimitMinutes({}), 90);
  for (const minutes of [5, 30, 90, 240]) assert.equal(cliAttemptLimitMinutes({ maxMinutesPerAttempt: minutes }), minutes);
  for (const minutes of [4, 241, 0, -1, 90.5, Number.NaN, "90", null]) {
    assert.equal(isCliAttemptMinutes(minutes), false, String(minutes));
    assert.equal(cliAttemptLimitMinutes({ maxMinutesPerAttempt: minutes }), 90, "a value outside the bounds never reaches a deadline");
  }
});

test("the home's CLI entry has no field that could hold a secret, and the CLI ids are fixed", () => {
  assert.deepEqual([...CLI_WORKER_PROVIDER_IDS], ["codex-cli", "claude-code", "agy"]);
  assert.deepEqual([...CLI_WORKER_HOME_FIELDS].sort(), ["consentedAt", "enabled", "executablePath", "lastTest", "maxMinutesPerAttempt", "models"]);
  for (const field of CLI_WORKER_HOME_FIELDS) {
    assert.equal(isSensitiveKey(field), false, field);
    assert.doesNotMatch(field, /secret|key|token|password|credential|auth/i, field);
  }
});

test("a cli runtime never becomes a provider model", () => {
  assert.throws(() => createProviderModel(cliConfig()), /is a CLI worker and has no model/);
});

// ------------------------------------------------------------------ the sidecar: a rolled-back Runner never meets `cli`

/** The transports every Runner before CW1 accepts when it validates the envelope on load. */
const PRE_CW1_TRANSPORTS = ["account-runner", "openai-compatible", "anthropic", "google"];

const keyedConfig = (): RunnerProviderConfig => ({
  runtimeId: "openai:gpt-test", providerId: "openai", modelId: "gpt-test", transport: "openai-compatible",
  secret: "sk-stub-envelope-0000000000000001", baseUrl: "https://api.example.test/v1", capabilities: ["*"], priority: 0,
});

function storeFixture(): { root: string; path: string; key: Buffer; sidecar: string } {
  const root = mkdtempSync(join(tmpdir(), "aiboard-provider-store-"));
  return { root, path: join(root, "gen", "provider-configs.enc"), key: randomBytes(32), sidecar: join(root, "gen", CLI_WORKER_CONFIGS_FILE) };
}

test("the encrypted provider store keeps cli configs in a plain sidecar, and the envelope only holds what an older Runner reads", () => {
  const fx = storeFixture();
  try {
    const store = new EncryptedProviderConfigStore(fx.path, fx.key);
    store.save([keyedConfig()]);
    assert.equal(existsSync(fx.sidecar), false, "a store that never held a CLI worker gets no sidecar");

    const cli = cliConfig({ cli: { reasoningEffort: "high" } });
    store.save([keyedConfig(), cli]);
    assert.equal(store.cliConfigsPath(), fx.sidecar);
    assert.deepEqual(store.load(), [keyedConfig(), cli], "a round trip returns both");
    const envelope = openEncryptedJson(fx.key, readFileSync(fx.path, "utf8")) as RunnerProviderConfig[];
    assert.deepEqual(envelope, [keyedConfig()], "the envelope holds no cli config");
    assert.ok(envelope.every((config) => PRE_CW1_TRANSPORTS.includes(config.transport)), "a Runner from before CW1 validates the envelope");
    const sidecar = readFileSync(fx.sidecar, "utf8");
    assert.deepEqual(JSON.parse(sidecar), { version: 1, configs: [cli] });
    assert.ok(!sidecar.includes("sk-stub-envelope"), "no key ever reaches the sidecar");

    store.save([keyedConfig()]);
    assert.deepEqual(JSON.parse(readFileSync(fx.sidecar, "utf8")), { version: 1, configs: [] }, "the last CLI worker removed empties the sidecar");
    assert.deepEqual(new EncryptedProviderConfigStore(fx.path, fx.key).load(), [keyedConfig()]);
    store.close();
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an invalid sidecar entry is left out with a warning, and the keyed configs still load", (t) => {
  const fx = storeFixture();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  try {
    const store = new EncryptedProviderConfigStore(fx.path, fx.key);
    const good = cliConfig({ runtimeId: "agy:default", providerId: "agy", modelId: "default" });
    store.save([keyedConfig(), good]);
    writeFileSync(fx.sidecar, JSON.stringify({ version: 1, configs: [
      good,
      cliConfig({ cli: { reasoningEffort: "high", futureField: 1 } as never }),
      cliConfig({ runtimeId: "claude-code:default", providerId: "claude-code", modelId: "default", secret: "sk-stub-hand-edited-0000000001" }),
      { ...keyedConfig(), secret: "" },
      { ...good },
      "not a config",
    ] }));
    assert.deepEqual(store.load(), [keyedConfig(), good], "only the valid, unique cli entry joins the keyed configs");
    assert.equal(warnings.length, 5, warnings.join("\n"));
    assert.ok(warnings.every((line) => !line.includes("sk-stub-hand-edited")), "a warning never quotes a secret");

    for (const broken of ["{ not json", JSON.stringify({ version: 2, configs: [] }), JSON.stringify([good])]) {
      writeFileSync(fx.sidecar, broken);
      assert.deepEqual(store.load(), [keyedConfig()], `a sidecar this Runner cannot read loses only its CLI workers: ${broken}`);
    }
    store.close();
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ what a test result may carry

test("a test message is scrubbed of keys, tokens and e-mail addresses, with CRLF as LF", () => {
  const canaries = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGh",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "AKIAABCDEFGHIJKLMNOP",
    "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz012345678",
    "owner.name+cli@example-mail.test",
  ];
  for (const canary of canaries) {
    const scrubbed = scrubCliMessage(`Error: ${canary} was refused`);
    assert.ok(!scrubbed.includes(canary), `${canary} -> ${scrubbed}`);
    assert.match(scrubbed, /^Error: /);
  }
  assert.equal(scrubCliMessage("line one\r\nline two\rline three"), "line one\nline two\nline three");
  assert.equal(scrubCliMessage("You have hit your usage limit."), "You have hit your usage limit.");
  assert.ok(scrubCliMessage("x".repeat(400)).length <= 300);
});

test("times are ISO strings exactly as toISOString writes them, and a version is a version", () => {
  for (const value of ["2026-11-17T00:00:00.000Z", "1999-01-31T23:59:59.999Z"]) assert.equal(isIsoTimestamp(value), true, value);
  for (const value of ["hello 2020", "2026-11-14 (sk-AbCdEfGhIjKlMnOpQrStUvWx)", "2026-11-17", "2026-11-17T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-11-17T00:00:00.000+01:00", 1_700_000_000_000, null]) {
    assert.equal(isIsoTimestamp(value), false, String(value));
  }
  for (const value of ["0.167.1", "2.1.325", "1.5.6-beta.2", "1.0.0+build.7"]) assert.equal(isCliVersion(value), true, value);
  for (const value of ["2.1.325 (Claude Code)", "", "-1", "v".repeat(65), "1.0\n2", "user@example.test", 1]) assert.equal(isCliVersion(value), false, String(value));
});
