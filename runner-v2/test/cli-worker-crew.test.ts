import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import { CLI_CREW_PROVIDER_IDS, isCliRuntimeId, nativeBuildCliCrewRefusal } from "../src/cli-crew-policy.js";
import { CLI_WORKER_PROVIDER_IDS, type CliWorkerProviderId } from "../src/cli-worker-config.js";
import {
  assertCliCrewRules,
  checkCliWorkers,
  CLI_CMD_HOST_REFUSED_REASON,
  CliCrewRuleError,
  parseCliWorkersChecked,
  type CheckCliWorkersInput,
  type CliCrewHost,
  type CliWorkerFreeCheck,
} from "../src/cli-worker-crew.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { selectRuntimeCandidates } from "../src/native-build-factory.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const WINDOWS: CliCrewHost = { platform: "win32", isRoot: false };

function apiConfig(runtimeId: string): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":") as [string, string];
  return { runtimeId, providerId, modelId, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority: 1 };
}

function cliConfig(providerId: CliWorkerProviderId, modelId = "default"): RunnerProviderConfig {
  return { runtimeId: `${providerId}:${modelId}`, providerId, modelId, transport: "cli", secret: "", capabilities: ["*"], priority: 2, billingBasis: "account_not_metered" };
}

const CONFIGS = [apiConfig("openai:sol"), apiConfig("google:gemini"), cliConfig("codex-cli"), cliConfig("claude-code"), cliConfig("agy")];

function spec(crew: Partial<NativeBuildSpec> = {}): NativeBuildSpec {
  return {
    version: 2,
    runId: "run_cw4",
    projectId: "cw4",
    objective: "Exercise the CLI crew rules.",
    architectRuntimeId: "openai:sol",
    workerRuntimeIds: ["google:gemini"],
    verifierRuntimeIds: ["openai:sol", "google:gemini"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-11-18T00:00:00.000Z",
    idempotencyKey: "cw4",
    ...crew,
  };
}

function refusal(run: () => void): { code: string; message: string; runtimeId: string } {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CliCrewRuleError, String(error));
    return { code: error.code, message: error.message, runtimeId: error.runtimeId };
  }
  assert.fail("expected a CLI crew refusal");
}

test("CW4 the web's CLI provider list is CW1's", () => {
  assert.deepEqual([...CLI_CREW_PROVIDER_IDS], [...CLI_WORKER_PROVIDER_IDS]);
  assert.equal(isCliRuntimeId("claude-code:default"), true);
  assert.equal(isCliRuntimeId("agy:gemini-3-pro"), true);
  assert.equal(isCliRuntimeId("anthropic:claude-code"), false);
  assert.equal(isCliRuntimeId("codex-cli"), false);
});

test("CW4 a CLI is refused as Architect, reviewer or verifier, before any host fact is read", () => {
  const cases: [Partial<NativeBuildSpec>, string, string][] = [
    [{ architectRuntimeId: "claude-code:default" }, "Architect", "claude-code:default"],
    [{ reviewerRuntimeId: "agy:default" }, "the reviewer", "agy:default"],
    [{ workerRuntimeIds: ["agy:default"], verifierRuntimeIds: ["openai:sol", "agy:default"] }, "a verifier", "agy:default"],
  ];
  for (const [crew, role, runtimeId] of cases) {
    const refused = refusal(() => assertCliCrewRules(CONFIGS, spec(crew), WINDOWS));
    assert.equal(refused.code, "cli_runtime_role_refused");
    assert.equal(refused.runtimeId, runtimeId);
    assert.match(refused.message, new RegExp(`cannot be ${role === "Architect" ? "the Architect" : role}: CLI runtimes are workers only`));
  }
});

test("CW4 a Build with a CLI worker under project or guarded access is refused; under full it passes", () => {
  for (const permissionProfile of ["project", "guarded"] as const) {
    const refused = refusal(() => assertCliCrewRules(CONFIGS, spec({ workerRuntimeIds: ["google:gemini", "claude-code:default"], permissionProfile }), WINDOWS));
    assert.equal(refused.code, "cli_workers_require_full_access");
    assert.equal(refused.runtimeId, "claude-code:default");
    assert.match(refused.message, /need Full access/);
  }
  assert.doesNotThrow(() => assertCliCrewRules(CONFIGS, spec({ workerRuntimeIds: ["google:gemini", "claude-code:default", "agy:default"] }), WINDOWS));
  // A crew of only CLI workers is allowed: the Architect is an API model (§3.13).
  assert.doesNotThrow(() => assertCliCrewRules(CONFIGS, spec({ workerRuntimeIds: ["claude-code:default"], verifierRuntimeIds: ["openai:sol"] }), WINDOWS));
});

test("CW4 a CLI refused on this OS or under root is refused with the refusal's reason", () => {
  const cases: [CliWorkerProviderId, CliCrewHost, string, RegExp][] = [
    // On Windows, Codex waits for CW0b's fix (CWD-11).
    ["codex-cli", WINDOWS, "cli_worker_platform_refused", /Codex CLI workers are not available on Windows yet/],
    ["codex-cli", { platform: "linux", isRoot: false }, "cli_worker_platform_refused", /not available on Linux/],
    ["claude-code", { platform: "linux", isRoot: false }, "cli_worker_platform_refused", /Claude Code workers are not available on Linux/],
    ["claude-code", { platform: "darwin", isRoot: false }, "cli_worker_platform_refused", /not available on macOS/],
    ["agy", { platform: "linux", isRoot: false }, "cli_worker_platform_refused", /agy workers are not available on Linux yet/],
    ["agy", { platform: "freebsd", isRoot: false }, "cli_worker_platform_refused", /not available on freebsd/],
    ["claude-code", { platform: "win32", isRoot: true }, "cli_worker_root_refused", /when AIBoard runs as root/],
  ];
  for (const [providerId, host, code, message] of cases) {
    const runtimeId = `${providerId}:default`;
    const refused = refusal(() => assertCliCrewRules(CONFIGS, spec({ workerRuntimeIds: ["google:gemini", runtimeId] }), host));
    assert.equal(refused.code, code, `${providerId} on ${host.platform}`);
    assert.equal(refused.runtimeId, runtimeId);
    assert.match(refused.message, message);
  }
  // agy runs as root (only Claude Code refuses it), and API-only crews pass on every host.
  assert.doesNotThrow(() => assertCliCrewRules(CONFIGS, spec({ workerRuntimeIds: ["agy:default"] }), { platform: "win32", isRoot: true }));
  for (const platform of ["win32", "linux", "darwin", "freebsd"] as const) {
    assert.doesNotThrow(() => assertCliCrewRules(CONFIGS, spec(), { platform, isRoot: true }));
  }
});

test("CW4 selectRuntimeCandidates applies the rules and marks CLI runtimes worker-only", () => {
  const selected = selectRuntimeCandidates(CONFIGS, spec({ workerRuntimeIds: ["google:gemini", "agy:default"] }), WINDOWS);
  assert.deepEqual(selected.all.map((candidate) => [candidate.runtimeId, candidate.workerOnly === true]), [
    ["openai:sol", false],
    ["google:gemini", false],
    ["agy:default", true],
  ]);
  assert.deepEqual(selected.workers.map((candidate) => candidate.runtimeId), ["google:gemini", "agy:default"]);
  // A crew change and a recovered spec go through the same function.
  assert.equal(refusal(() => selectRuntimeCandidates(CONFIGS, spec({ workerRuntimeIds: ["codex-cli:default"] }), WINDOWS)).code, "cli_worker_platform_refused");
  assert.equal(refusal(() => selectRuntimeCandidates(CONFIGS, spec({ reviewerRuntimeId: "agy:default" }), WINDOWS)).code, "cli_runtime_role_refused");
  // API-only selection is unchanged: no candidate is marked.
  assert.equal(selectRuntimeCandidates(CONFIGS, spec(), WINDOWS).all.some((candidate) => "workerOnly" in candidate), false);
});

function checkInput(overrides: Partial<CheckCliWorkersInput> & { results?: CliWorkerFreeCheck[] } = {}): CheckCliWorkersInput {
  const { results, ...rest } = overrides;
  const state = win32.join("C:\\", "Users", "owner", ".aiboard", "state");
  return {
    trigger: "planning",
    workers: [cliConfig("claude-code"), cliConfig("agy", "gemini-3-pro")],
    platform: "win32",
    windowsBatchArgv: "verified",
    launchFolders: { worktree: win32.join(state, "workspaces", "run_cw4", "task"), cliState: win32.join(state, "cli-workers", "run_cw4", "session") },
    ...(results ? { freeChecks: async () => results } : {}),
    ...rest,
  };
}

test("CW4 without CW3's free checks wired, the crew's CLIs are recorded unchecked and nothing is unhealthy", async () => {
  const { checked, failures } = await checkCliWorkers(checkInput());
  assert.deepEqual(checked, {
    version: 1,
    trigger: "planning",
    clis: [
      { providerId: "claude-code", runtimeIds: ["claude-code:default"], status: "unchecked", reason: "This Runner does not run CLI free checks yet." },
      { providerId: "agy", runtimeIds: ["agy:gemini-3-pro"], status: "unchecked", reason: "This Runner does not run CLI free checks yet." },
    ],
  });
  assert.deepEqual(failures, []);
});

test("CW4 a logged-out CLI and a spent agy quota are unhealthy with their §3.8 kinds; a ready one is not", async () => {
  const requested: string[][] = [];
  const results: CliWorkerFreeCheck[] = [
    { providerId: "claude-code", status: "unhealthy", executable: { path: "C:\\bin\\claude.exe", form: "exe" }, version: "2.1.326",
      failure: { kind: "authentication", message: "Claude Code is not logged in. Run claude auth login." } },
    { providerId: "agy", status: "unhealthy", executable: { path: "C:\\bin\\agy.exe", form: "exe" },
      failure: { kind: "usage_limit", message: "agy has no usage left until its stated reset.", retryAfterMs: 3_600_000 } },
  ];
  const { checked, failures } = await checkCliWorkers({ ...checkInput(), freeChecks: async (request) => { requested.push([...request.providerIds]); return results; } });
  assert.deepEqual(requested, [["claude-code", "agy"]], "one call, every CLI of the crew once");
  assert.deepEqual(failures, [
    { providerId: "claude-code", failure: { kind: "authentication", message: "Claude Code is not logged in. Run claude auth login." } },
    { providerId: "agy", failure: { kind: "usage_limit", message: "agy has no usage left until its stated reset.", retryAfterMs: 3_600_000 } },
  ]);
  assert.deepEqual(checked.clis[0], {
    providerId: "claude-code", runtimeIds: ["claude-code:default"], executableForm: "exe", version: "2.1.326",
    status: "unhealthy", failureKind: "authentication", reason: "Claude Code is not logged in. Run claude auth login.",
  });
  assert.equal(checked.clis[1]!.retryAfterMs, 3_600_000);

  const ready = await checkCliWorkers(checkInput({ results: [
    { providerId: "claude-code", status: "ready", executable: { path: "C:\\bin\\claude.exe", form: "exe" }, version: "2.1.326" },
    { providerId: "agy", status: "unknown", note: "agy models timed out after 8 s." },
  ] }));
  assert.deepEqual(ready.failures, []);
  assert.deepEqual(ready.checked.clis.map((cli) => [cli.status, cli.reason]), [["ready", undefined], ["unknown", "agy models timed out after 8 s."]]);
});

test("CW4 free checks that throw or skip a CLI record it unknown, never unhealthy", async () => {
  const thrown = await checkCliWorkers({ ...checkInput(), freeChecks: async () => { throw new Error("probe host gone"); } });
  assert.deepEqual(thrown.failures, []);
  assert.deepEqual(thrown.checked.clis.map((cli) => [cli.status, cli.reason]), [
    ["unknown", "The free checks could not run: probe host gone"],
    ["unknown", "The free checks could not run: probe host gone"],
  ]);
  const skipped = await checkCliWorkers(checkInput({ results: [{ providerId: "claude-code", status: "ready", executable: { path: "C:\\bin\\claude.exe", form: "exe" } }] }));
  assert.deepEqual(skipped.checked.clis.map((cli) => cli.status), ["ready", "unknown"]);
});

test("CW4 a .cmd CLI is unhealthy before planning when the host refuses .cmd launches, and Claude Code's shim always", async () => {
  const cmd = (providerId: CliWorkerProviderId): CliWorkerFreeCheck => ({ providerId, status: "ready", executable: { path: `C:\\npm\\${providerId}.cmd`, form: "cmd" } });
  // A host whose batch-argv fact is not verified (GitHub's Windows image) refuses every .cmd launch.
  for (const fact of ["unavailable", "partial", undefined] as const) {
    const { failures, checked } = await checkCliWorkers(checkInput({ windowsBatchArgv: fact, results: [cmd("claude-code"), cmd("agy")] }));
    assert.deepEqual(failures.map((entry) => entry.providerId), ["claude-code", "agy"], String(fact));
    for (const entry of failures) {
      assert.equal(entry.failure.kind, "authentication");
      assert.ok(entry.failure.message.includes(CLI_CMD_HOST_REFUSED_REASON), entry.failure.message);
    }
    assert.deepEqual(checked.clis.map((cli) => [cli.status, cli.executableForm]), [["unhealthy", "cmd"], ["unhealthy", "cmd"]]);
  }
  // On a verified host, Claude Code's inline schema still can't pass a .cmd shim (§3.5 open point); agy's can.
  const verified = await checkCliWorkers(checkInput({ results: [cmd("claude-code"), cmd("agy")] }));
  assert.deepEqual(verified.failures, [{ providerId: "claude-code", failure: { kind: "authentication", message: "Claude Code's npm shim can't carry its result schema; install the native claude.exe." } }]);
  assert.equal(verified.checked.clis[1]!.status, "ready");
  // An .exe, and every POSIX form, are untouched by the .cmd rules.
  const exe = await checkCliWorkers(checkInput({ windowsBatchArgv: "unavailable", results: [
    { providerId: "claude-code", status: "ready", executable: { path: "C:\\bin\\claude.exe", form: "exe" } },
    { providerId: "agy", status: "ready", executable: { path: "C:\\bin\\agy.exe", form: "exe" } },
  ] }));
  assert.deepEqual(exe.failures, []);
  const posix = await checkCliWorkers(checkInput({ platform: "linux", windowsBatchArgv: undefined, launchFolders: { worktree: "/state/workspaces/run/task", cliState: "/state/cli-workers/run/session" }, results: [
    { providerId: "claude-code", status: "ready", executable: { path: "/usr/bin/claude", form: "native" } },
    { providerId: "agy", status: "ready", executable: { path: "/usr/bin/agy", form: "native" } },
  ] }));
  assert.deepEqual(posix.failures, []);
});

test("CW4 a Codex or agy .cmd shim is unhealthy when this run's folders hold a character Windows refuses in a .cmd argument", async () => {
  for (const folder of ["C:\\Users\\a&b", "C:\\Program Files (x86)\\AIBoard", "C:\\Users\\100%", "C:\\Users\\hi!"]) {
    const state = win32.join(folder, ".aiboard", "state");
    const input = checkInput({
      workers: [cliConfig("codex-cli"), cliConfig("agy")],
      launchFolders: { worktree: win32.join(state, "workspaces", "run_cw4", "task"), cliState: win32.join(state, "cli-workers", "run_cw4", "session") },
      results: [
        { providerId: "codex-cli", status: "ready", executable: { path: "C:\\npm\\codex.cmd", form: "cmd" } },
        { providerId: "agy", status: "ready", executable: { path: "C:\\npm\\agy.cmd", form: "cmd" } },
      ],
    });
    const { failures } = await checkCliWorkers(input);
    assert.deepEqual(failures.map((entry) => entry.providerId), ["codex-cli", "agy"], folder);
    for (const entry of failures) {
      assert.equal(entry.failure.kind, "authentication");
      assert.match(entry.failure.message, /\.cmd shim, which can't be launched with .*: Windows refuses/);
      assert.ok(entry.failure.message.includes(folder), entry.failure.message);
    }
  }
});

test("CW4 the cli_workers.checked event replays, and a malformed or non-Runner record is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cw4-replay-"));
  const path = join(root, "scheduler.sqlite");
  const runId = "run_cw4_replay";
  try {
    let store = new SqliteSchedulerStore(path);
    store.append({ runId, type: "run.initialized", occurredAt: "2026-11-18T00:00:00.000Z", actor: { role: "runner", id: "test" }, idempotencyKey: "init", payload: { objective: "o" } });
    const older = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal("cliWorkersChecked" in older, false, "a run without CLI workers has no CLI checks");
    const { checked } = await checkCliWorkers(checkInput({ results: [
      { providerId: "claude-code", status: "unhealthy", executable: { path: "C:\\bin\\claude.exe", form: "exe" }, failure: { kind: "authentication", message: "Claude Code is not logged in." } },
      { providerId: "agy", status: "ready", version: "1.5.6" },
    ] }));
    const append = (payload: unknown, actor = { role: "runner" as const, id: "build-runtime" }, key = "cli-workers-checked:0") => store.append({
      runId, type: "cli_workers.checked", occurredAt: "2026-11-18T00:00:01.000Z", actor, idempotencyKey: key, payload: payload as Record<string, unknown>,
    });
    const first = checked.clis[0]!;
    assert.throws(() => append({ ...checked, extra: true }, undefined, "bad-1"), /unexpected fields/);
    assert.throws(() => append({ ...checked, clis: [{ ...first, email: "owner@example.com" }] }, undefined, "bad-2"), /a CLI entry/);
    assert.throws(() => append({ ...checked, clis: [{ ...first, reason: "r".repeat(301) }] }, undefined, "bad-3"), /reason/);
    assert.throws(() => append({ ...checked, clis: [{ ...first, failureKind: undefined }] }, undefined, "bad-4"), /failureKind and status/);
    assert.throws(() => append({ ...checked, clis: [{ ...first, providerId: "opencode" }] }, undefined, "bad-5"), /providerId/);
    assert.throws(() => append({ ...checked, clis: [first, first] }, undefined, "bad-6"), /listed twice/);
    assert.throws(() => append(checked, { role: "architect" as never, id: "architect" }, "bad-7"), /Only the build runtime/);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(runId)), older, "refused appends leave the run as it was");
    append(checked);
    const recorded = rebuildSchedulerProjection(store.readRun(runId)).cliWorkersChecked;
    assert.deepEqual(recorded, { ...checked, sequence: 2, recordedAt: "2026-11-18T00:00:01.000Z" });
    assert.deepEqual(parseCliWorkersChecked(JSON.parse(JSON.stringify(checked))), checked);
    store.close();
    store = new SqliteSchedulerStore(path);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(runId)).cliWorkersChecked, recorded, "the event replays after a reopen");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CW4 the pure crew rule matches the Runner's, by runtime id", () => {
  assert.equal(nativeBuildCliCrewRefusal({ architectRuntimeId: "openai:sol", workerRuntimeIds: ["claude-code:default"], verifierRuntimeIds: ["openai:sol"], permissionProfile: "full" }), null);
  assert.equal(nativeBuildCliCrewRefusal({ architectRuntimeId: "openai:sol", workerRuntimeIds: ["claude-code:default"], verifierRuntimeIds: ["openai:sol"], permissionProfile: "project" })?.code, "cli_workers_require_full_access");
  assert.equal(nativeBuildCliCrewRefusal({ architectRuntimeId: "agy:default", workerRuntimeIds: ["openai:sol"], verifierRuntimeIds: [], permissionProfile: "full" })?.role, "architect");
  assert.equal(nativeBuildCliCrewRefusal({ architectRuntimeId: "openai:sol", workerRuntimeIds: ["openai:sol"], verifierRuntimeIds: ["openai:sol"], permissionProfile: "guarded" }), null);
});
