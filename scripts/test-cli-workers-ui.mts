/**
 * CLI workers on the web (docs/plans/2026-11-14-cli-workers.md packet CW9). Run: npx tsx scripts/test-cli-workers-ui.mts
 *
 * - Settings: the free checks, model and effort, the Full-access note, Test with its reasons and the reset time.
 * - The crew picker: CLI rows are workers only, Full access only, and a CLI refused here can't be picked.
 * - The config a Build pushes for a CLI worker passes the Runner's own validator.
 * - Run details: the CLI attempt card (version, outcome, replaced commits, re-runs, live tail).
 * - No account field (e-mail, organization, subscription, login method) reaches the page.
 * Stub fetches only: nothing here talks to a Runner or starts a CLI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CliWorkerFreeChecks, CliWorkerLastTest, CliWorkerPanel } from "../components/CliWorkersSettings";
import { BuildCrewPicker } from "../components/build/BuildCrewPicker";
import { CliAttemptCard, CliAttemptsPanel } from "../components/build/CliAttemptsPanel";
import { buildCrewCliRefusal, selectBuildCrewRuntimes, type BuildCrew } from "../lib/client/build-crew";
import {
  CLI_ATTEMPT_MINUTES,
  CLI_LIVE_TURN_BASE,
  CLI_TEST_OUTCOMES,
  CLI_WORKERS_FULL_ACCESS_REASON,
  CLI_WORKER_CONSENT_NOTE,
  CliWorkersUnsupportedError,
  cliAttemptViews,
  cliLiveTails,
  cliNativeProviderConfig,
  cliResetText,
  cliWorkerCrewOptions,
  cliWorkerHealth,
  fetchCliWorkerChecks,
  isCliArgumentValue,
  parseCliWorkerCheck,
  parseCliWorkerChecks,
  runCliWorkerTest,
} from "../lib/client/cli-workers";
import type { HomeCliWorkerEntry } from "../lib/client/home-client";
import type { NativeBuildEvent, NativeBuildObservability } from "../lib/client/runner-v2";
import { CLI_WORKER_DISPLAY_NAMES } from "../lib/providers/cli-workers";
import { getModelDisplayName } from "../lib/providers/catalog";
import { CLI_WORKER_DISPLAY_NAMES as RUNNER_DISPLAY_NAMES } from "../runner-v2/src/cli-worker-adapters";
import {
  CLI_ATTEMPT_MINUTES_DEFAULT,
  CLI_ATTEMPT_MINUTES_MAX,
  CLI_ATTEMPT_MINUTES_MIN,
  CLI_TEST_OUTCOMES as RUNNER_TEST_OUTCOMES,
  isCliArgumentValue as runnerIsCliArgumentValue,
} from "../runner-v2/src/cli-worker-config";
import { CLI_COLLECT_PENDING_PREFIX as RUNNER_COLLECT, PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX as RUNNER_REPEATED } from "../runner-v2/src/cli-worker-runtime";
import { validateProviderConfigs } from "../runner-v2/src/provider-config-store";
import { CLI_COLLECT_PENDING_PREFIX, PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX } from "../lib/client/discussion-live-state";

let checks = 0;
function pass(name: string): void {
  checks += 1;
  console.log(`PASS ${name}`);
}

const CANARY_EMAIL = "canary.owner@example.invalid";
const CANARY_ORG = "Canary Org 7f3a";
const NOW = Date.UTC(2026, 10, 18, 12, 0);

// A raw `GET /v2/cli-workers` answer, with every account field a CLI's status command can print planted in it.
const RAW_CHECKS = {
  checkedAt: "2026-11-18T12:00:00.000Z",
  platform: "win32",
  account: { email: CANARY_EMAIL },
  workers: [
    {
      providerId: "claude-code", displayName: "Claude Code", status: "ready", checkedAt: "2026-11-18T12:00:00.000Z",
      executable: { path: "C:\\Tools\\claude.exe", source: "path", form: "exe" }, version: "2.1.326",
      login: { status: "logged_in", method: "claude.ai", subscription: "canary-plan-91", email: CANARY_EMAIL, organization: CANARY_ORG },
      models: [
        { id: null, name: "CLI default", source: "default" },
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], source: "catalog" },
        { id: "opus", name: "Opus (Claude Code alias)", source: "alias" },
      ],
      modelsSource: "catalog",
      email: CANARY_EMAIL,
    },
    {
      providerId: "codex-cli", displayName: "Codex CLI", status: "refused", code: "platform_refused", checkedAt: "2026-11-18T12:00:00.000Z",
      reason: "Codex CLI workers are not available on Windows yet: Codex can start programs outside the Job object AIBoard stops.",
    },
    {
      providerId: "agy", displayName: "agy", status: "unavailable", code: "usage_limit", checkedAt: "2026-11-18T12:00:00.000Z",
      reason: "agy is out of usage until it resets.", failure: { kind: "usage_limit", message: "spent" },
      executable: { path: "C:\\Tools\\agy.exe", source: "home", form: "exe" }, version: "1.5.10",
      login: { status: "logged_in", method: "google", accountEmail: CANARY_EMAIL },
      models: [{ id: null, name: "CLI default", source: "default" }, { id: "gemini-4-pro", name: "Gemini 4 Pro", source: "cli" }],
      quota: [{ name: "Pro models", models: ["Gemini 4 Pro"], buckets: [{ id: "b1", window: "5h", remainingFraction: 0, resetsAt: "2026-11-18T15:30:00.000Z" }] }],
    },
    { providerId: "gemini-cli", status: "ready" },
  ],
};

// ------------------------------------------------------------------ names and constants match the Runner's
{
  assert.deepEqual({ ...CLI_WORKER_DISPLAY_NAMES }, { ...RUNNER_DISPLAY_NAMES });
  assert.deepEqual(CLI_ATTEMPT_MINUTES, { default: CLI_ATTEMPT_MINUTES_DEFAULT, min: CLI_ATTEMPT_MINUTES_MIN, max: CLI_ATTEMPT_MINUTES_MAX });
  assert.deepEqual(Object.keys(CLI_TEST_OUTCOMES).sort(), [...RUNNER_TEST_OUTCOMES].sort(), "every Test outcome has its words");
  for (const value of ["gpt-6-codex", "claude-opus-5-5", "a/b:c.d_e", "-rf", "", "x".repeat(129), "a b", "a;b", "é"]) {
    assert.equal(isCliArgumentValue(value), runnerIsCliArgumentValue(value), value);
  }
  assert.equal(CLI_COLLECT_PENDING_PREFIX, RUNNER_COLLECT);
  assert.equal(PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX, RUNNER_REPEATED);
  assert.equal(getModelDisplayName("claude-code:default"), "Claude Code · CLI default");
  assert.equal(getModelDisplayName("codex-cli:gpt-6-codex"), "Codex CLI · gpt-6-codex");
  assert.equal(getModelDisplayName("agy:gemini-4-pro"), "agy · gemini-4-pro");
  pass("names, outcomes, the attempt-minute bounds, the argument charset and the pause prefixes match the Runner's");
}

// ------------------------------------------------------------------ the free checks: only the named fields
const parsed = parseCliWorkerChecks(RAW_CHECKS);
{
  assert.equal(parsed.workers.length, 3, "an unknown CLI is left out");
  const serialized = JSON.stringify(parsed);
  for (const canary of [CANARY_EMAIL, CANARY_ORG, "subscription", "canary-plan-91", "claude.ai", "google", "accountEmail", "organization"]) {
    assert.ok(!serialized.includes(canary), `the parsed checks hold no ${canary}`);
  }
  const claude = parsed.workers.find((check) => check.providerId === "claude-code")!;
  assert.equal(claude.login, "logged_in", "logged in or not, and nothing else of the login");
  assert.equal(claude.models.length, 3);
  assert.deepEqual(claude.models[1]!.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseCliWorkerCheck({ providerId: "claude-code", status: "weird" })?.status, "unknown");
  pass("a check keeps only the named fields: no e-mail, organization, subscription or login method reaches the page");
}

// ------------------------------------------------------------------ health
{
  const [claude, codex, agy] = ["claude-code", "codex-cli", "agy"].map((id) => parsed.workers.find((check) => check.providerId === id));
  assert.deepEqual(cliWorkerHealth(claude), { state: "ready", label: "Ready", pickable: true });
  const refused = cliWorkerHealth(codex);
  assert.equal(refused.state, "refused");
  assert.equal(refused.pickable, false, "a CLI refused on this OS can't be picked");
  assert.match(refused.reason!, /not available on Windows/);
  const spent = cliWorkerHealth(agy);
  assert.equal(spent.label, "Out of usage");
  assert.equal(spent.pickable, true, "an unhealthy CLI stays pickable: the Build hands its tasks to the others");
  assert.equal(cliWorkerHealth({ ...codex!, code: "root_refused", reason: "Claude Code can't run as a worker when AIBoard runs as root." }).pickable, false);
  assert.equal(cliWorkerHealth(undefined).state, "unchecked");
  pass("health: ready, refused (never pickable, with its reason), unavailable with its label, unchecked");
}

// ------------------------------------------------------------------ the crew picker's CLI rows
const ENTRIES: Partial<Record<"codex-cli" | "claude-code" | "agy", HomeCliWorkerEntry>> = {
  "claude-code": { enabled: true, consentedAt: "2026-11-18T11:00:00.000Z", models: [{ id: null }, { id: "claude-opus-5-5", reasoningEffort: "high" }] },
  "codex-cli": { enabled: true, consentedAt: "2026-11-18T11:00:00.000Z", models: [{ id: null }] },
  agy: { enabled: true, models: [{ id: null }] },
};
{
  const full = cliWorkerCrewOptions(ENTRIES, parsed, "full");
  assert.deepEqual(full.map((option) => option.runtimeId), ["codex-cli:default", "claude-code:default", "claude-code:claude-opus-5-5"],
    "every model of every CLI turned on with its consent; agy has no consent yet");
  assert.equal(full.find((option) => option.runtimeId === "claude-code:claude-opus-5-5")?.reasoningEffort, "high");
  assert.equal(full.find((option) => option.providerId === "claude-code")?.disabledReason, undefined);
  assert.match(full.find((option) => option.providerId === "codex-cli")!.disabledReason!, /not available on Windows/, "refused: its reason");
  for (const access of ["project", "ask", null] as const) {
    const options = cliWorkerCrewOptions(ENTRIES, parsed, access);
    assert.ok(options.every((option) => option.disabledReason), `nothing is pickable at ${access ?? "no"} access`);
    assert.equal(options.find((option) => option.providerId === "claude-code")?.disabledReason, CLI_WORKERS_FULL_ACCESS_REASON);
  }
  assert.deepEqual(cliWorkerCrewOptions({ "claude-code": { ...ENTRIES["claude-code"]!, enabled: false } }, parsed, "full"), [], "a CLI turned off is not offered");

  // Workers only: a CLI as Architect or reviewer is refused; as a worker it needs Full access.
  const api = { modelId: "anthropic:claude-opus-5-5", reasoningEffort: "high" as const };
  const cli = { modelId: "claude-code:default", reasoningEffort: "default" as const };
  const asWorker: BuildCrew = { architect: api, reviewer: null, workers: [cli] };
  assert.equal(buildCrewCliRefusal(asWorker, "full"), null);
  assert.equal(buildCrewCliRefusal(asWorker, "project")?.code, "cli_workers_require_full_access");
  assert.equal(buildCrewCliRefusal(asWorker, "ask")?.code, "cli_workers_require_full_access");
  assert.equal(buildCrewCliRefusal({ architect: cli, reviewer: null, workers: [api] }, "full")?.code, "cli_runtime_role_refused");
  const reviewer = buildCrewCliRefusal({ architect: api, reviewer: cli, workers: [] }, "full");
  assert.equal(reviewer?.code, "cli_runtime_role_refused");
  assert.equal(reviewer?.role, "reviewer");
  assert.deepEqual(selectBuildCrewRuntimes(asWorker).verifierRuntimeIds, ["anthropic:claude-opus-5-5"], "never a verifier");
  pass("the crew picker offers CLI rows as workers only, at Full access only, and never a refused CLI");
}

// The picker itself: a CLI worker row shows its health and effort; below Full access it says what to change.
{
  const crew: BuildCrew = {
    architect: { modelId: "anthropic:claude-opus-5-5", reasoningEffort: "high" },
    reviewer: null,
    workers: [{ modelId: "claude-code:claude-opus-5-5", reasoningEffort: "default" }],
  };
  const render = (access: "project" | "full") => renderToStaticMarkup(createElement(BuildCrewPicker, {
    models: [{ fullId: "anthropic:claude-opus-5-5", name: "Claude Opus 5.5" }, { fullId: "claude-code:default", name: "should never be offered as Architect" }],
    value: crew,
    onChange() {},
    planning: { evidenceGatedPlanning: false, answerReview: false, alwaysRequireIndependentVerifier: false, runPolicy: "finish" },
    cliWorkers: cliWorkerCrewOptions(ENTRIES, parsed, access),
    access,
  }));
  const project = render("project");
  assert.match(project, /Claude Code · claude-opus-5-5/);
  assert.match(project, /CLI · Ready/);
  assert.match(project, /high effort, set in Settings/);
  assert.match(project, /CLI workers need Full access/);
  assert.match(project, /remove the CLI workers, to start this Build/);
  assert.match(project, /not available on Windows/, "the refused CLI's reason is shown");
  assert.match(project, /isn&#x27;t counted toward a USD budget/);
  const full = render("full");
  assert.doesNotMatch(full, /CLI workers need Full access/);
  for (const markup of [project, full]) assert.ok(!markup.includes(CANARY_EMAIL));
  pass("the crew picker shows each CLI row's health and Settings effort, and the Full-access and refusal reasons");
}

// ------------------------------------------------------------------ the config a Build pushes passes the Runner's validator
{
  const config = cliNativeProviderConfig("claude-code:claude-opus-5-5", 2, ENTRIES);
  assert.deepEqual(config, {
    runtimeId: "claude-code:claude-opus-5-5", providerId: "claude-code", modelId: "claude-opus-5-5",
    displayName: "Claude Code · claude-opus-5-5", billingBasis: "account_not_metered", transport: "cli", secret: "",
    capabilities: ["*"], priority: 2, cli: { reasoningEffort: "high" },
  });
  const byDefault = cliNativeProviderConfig("claude-code:default", 3, ENTRIES);
  assert.equal(byDefault.cli, undefined, "the CLI's own effort: no flag");
  assert.doesNotThrow(() => validateProviderConfigs([config, byDefault] as never), "the Runner accepts what the page pushes");
  assert.throws(() => cliNativeProviderConfig("claude-code:sonnet", 0, ENTRIES), /not one of Claude Code's models/);
  assert.throws(() => cliNativeProviderConfig("agy:default", 0, { agy: { enabled: false, models: [{ id: null }] } }), /not turned on/);
  assert.throws(() => cliNativeProviderConfig("openai:gpt-6", 0, ENTRIES), /not a CLI worker/);
  pass("a CLI worker's pushed config has no secret, base URL, token or secret source, is unmetered, and passes the Runner's validator");
}

// ------------------------------------------------------------------ the Runner's routes (stub fetch)
{
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = (status: number, body: unknown): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const connection = { url: "http://127.0.0.1:8787/", token: "stub-token" };

  const view = await fetchCliWorkerChecks(connection, { refresh: true, fetchImpl: stub(200, RAW_CHECKS) });
  assert.equal(calls.at(-1)!.url, "http://127.0.0.1:8787/v2/cli-workers?refresh=1");
  assert.ok(!JSON.stringify(view).includes(CANARY_EMAIL));
  await assert.rejects(fetchCliWorkerChecks(connection, { fetchImpl: stub(404, { code: "not_found" }) }), CliWorkersUnsupportedError,
    "a Runner from before CW3: the page offers no CLI worker and says to update");

  const tested = await runCliWorkerTest(connection, "agy", { model: "gemini-4-pro" }, { fetchImpl: stub(200, {
    lastTest: { at: "2026-11-18T12:00:00.000Z", cliVersion: "1.5.10", modelId: "gemini-4-pro", outcome: "usage_limit", resetsAt: "2026-11-18T15:30:00.000Z", message: "Resets in 3h30m" },
    stopVerified: true, launched: true, endedCooldownIn: [],
  }) });
  assert.equal(calls.at(-1)!.url, "http://127.0.0.1:8787/v2/cli-workers/agy/test");
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { model: "gemini-4-pro" }, "exactly the keys the Runner takes");
  assert.equal(tested.kind, "tested");
  assert.equal(tested.kind === "tested" && tested.lastTest.resetsAt, "2026-11-18T15:30:00.000Z");
  await runCliWorkerTest(connection, "claude-code", { model: null, reasoningEffort: "high" }, { fetchImpl: stub(200, {}) });
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { model: null, reasoningEffort: "high" });

  const refused = await runCliWorkerTest(connection, "codex-cli", { model: null }, { fetchImpl: stub(409, {
    code: "platform_refused", error: "Codex CLI workers are not available on Windows yet.", check: RAW_CHECKS.workers[1],
  }) });
  assert.equal(refused.kind, "refused");
  assert.equal(refused.kind === "refused" && refused.check?.status, "refused");
  const busy = await runCliWorkerTest(connection, "agy", { model: null }, { fetchImpl: stub(409, { code: "cli_worker_test_running", error: "A test of agy is already running." }) });
  assert.deepEqual(busy, { kind: "not_run", code: "cli_worker_test_running", message: "A test of agy is already running." });
  const shutting = await runCliWorkerTest(connection, "agy", { model: null }, { fetchImpl: stub(503, { code: "runner_shutting_down", error: "AIBoard is shutting down." }) });
  assert.equal(shutting.kind, "not_run");
  await assert.rejects(runCliWorkerTest(connection, "agy", { model: null }, { fetchImpl: stub(404, {}) }), CliWorkersUnsupportedError);
  pass("the free checks and Test routes: refresh, a refused Test with its check, a busy or interrupted Test, and an older Runner");
}

// ------------------------------------------------------------------ Settings: free checks, consent note, Test reasons and the reset time
{
  const agy = parsed.workers.find((check) => check.providerId === "agy")!;
  const lastTest = {
    at: "2026-11-18T11:58:00.000Z", cliVersion: "1.5.10", modelId: "gemini-4-pro", outcome: "usage_limit" as const,
    resetsAt: "2026-11-18T15:30:00.000Z", message: "Resets in 3h30m",
  };
  const panel = (props: Partial<Parameters<typeof CliWorkerPanel>[0]>) => renderToStaticMarkup(createElement(CliWorkerPanel, {
    providerId: "agy", entry: { enabled: true, consentedAt: "2026-11-18T11:00:00.000Z", models: [{ id: null }], lastTest },
    check: agy, canSave: true, onSave: async () => {}, onTest: async () => null, now: NOW, ...props,
  }));
  const spent = panel({});
  assert.match(spent, /Out of usage/);
  assert.match(spent, new RegExp(CLI_TEST_OUTCOMES.usage_limit.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#x27;")));
  assert.match(spent, /Usage resets .* \(in 3 h 30 min\)\./, "the reset time the CLI stated");
  assert.match(spent, /Resets in 3h30m/, "the Test's own message");
  assert.match(spent, /Pro models<\/span>: 0% left \(5h\)/, "agy's stated usage");
  assert.match(spent, /Test CLI default/);
  assert.match(spent, /uses a tiny amount of agy&#x27;s usage/);
  assert.match(spent, /Installed · 1\.5\.10/);
  assert.match(spent, /path set here/);
  assert.match(spent, /Logged in/);
  assert.match(spent, /Time limit per attempt/);

  const codex = parsed.workers.find((check) => check.providerId === "codex-cli")!;
  const refused = panel({ providerId: "codex-cli", entry: undefined, check: codex });
  assert.match(refused, /Not available here/);
  assert.match(refused, /not available on Windows/, "a refused CLI shows its reason in Settings");
  assert.match(refused, /role="switch"[^>]*disabled=""[^>]*id="cli-codex-cli-enabled"/, "and can't be turned on");
  assert.match(refused, /<button[^>]*disabled=""><svg[^>]*lucide-refresh-cw[^]*?Test CLI default<\/button>/, "nor tested");
  assert.match(spent, /<button[^>]*type="button"><svg[^>]*lucide-refresh-cw[^]*?Test CLI default<\/button>/, "a CLI that isn't refused can be tested");

  for (const outcome of Object.keys(CLI_TEST_OUTCOMES) as (keyof typeof CLI_TEST_OUTCOMES)[]) {
    const markup = renderToStaticMarkup(createElement(CliWorkerLastTest, { lastTest: { ...lastTest, outcome, resetsAt: undefined }, now: NOW }));
    assert.ok(markup.includes(CLI_TEST_OUTCOMES[outcome].label), outcome);
  }
  assert.match(renderToStaticMarkup(createElement(CliWorkerLastTest, { lastTest: undefined })), /Not tested yet/);
  assert.equal(cliResetText(undefined, NOW), null, "no reset unless the CLI stated one");
  assert.match(cliResetText("2026-11-18T11:00:00.000Z", NOW)!, /^Usage was due to reset/);
  assert.match(cliResetText("2026-11-20T12:00:00.000Z", NOW)!, /\(in 48 h\)|\(in 2 days\)/);

  const checksOnly = renderToStaticMarkup(createElement(CliWorkerFreeChecks, { check: parsed.workers[0], now: NOW }));
  assert.match(checksOnly, /3 models listed|2 models listed/);
  assert.match(checksOnly, /From AI Board&#x27;s catalog/);
  for (const markup of [spent, refused, checksOnly]) {
    for (const canary of [CANARY_EMAIL, CANARY_ORG, "subscription"]) assert.ok(!markup.includes(canary), canary);
  }
  assert.match(CLI_WORKER_CONSENT_NOTE, /runs any command as you, in the task's worktree, with its own permission prompts turned off/);
  pass("Settings shows the free checks, agy's stated usage, each Test reason and the stated reset time; a refused CLI can't be turned on or tested");
}

// ------------------------------------------------------------------ Settings writes go through the home client only
{
  const settings = readFileSync("components/CliWorkersSettings.tsx", "utf8");
  assert.match(settings, /saveHome\(\(\) => cliWorkerOps\(providerId, patch\)\)/, "every change is one home batch built by cliWorkerOps");
  assert.ok(!/["'`]cliWorkers\./.test(settings) && !/["'`]cliWorkers\./.test(readFileSync("lib/client/cli-workers.ts", "utf8")), "no other module builds a cliWorkers op path");
  assert.ok(!/fetch\([^)]*\/v2\/home/.test(settings), "Settings never posts to the home itself");
  pass("Settings saves CLI worker settings only through home-client.ts (cliWorkerOps + saveHome)");
}

// ------------------------------------------------------------------ Full access is reachable with an `aiboard` session
{
  // Before CW9 the access ceiling showed only for a pasted token, so a Build started through `aiboard` (the normal
  // path) was always Guarded and could never take a CLI worker.
  const setup = readFileSync("components/RunnerSetup.tsx", "utf8");
  assert.match(setup, /\{\(token\.trim\(\) \|\| launcher\) && \(\s*<div[^>]*>\s*<Label[^>]*>Access ceiling/, "the access ceiling shows for a launcher session");
  assert.match(setup, /launcher \? \{ url: launcher\.url, token: launcher\.token, access: selection\.access, source: "launcher" as const \}/,
    "choosing an access keeps the launcher connection and never persists its token");
  pass("the access ceiling (and so Full access) can be chosen for a Build connected through aiboard");
}

// ------------------------------------------------------------------ Run details: the CLI attempt card
{
  const event = (sequence: number, payload: Record<string, unknown>): NativeBuildEvent => ({
    sequence, type: "worker.cli_attempt_recorded", occurredAt: `2026-11-18T12:0${sequence}:00.000Z`,
    actor: { role: "runner", id: "native-worker-driver" }, payload,
  });
  const base = {
    version: 1, taskId: "task-1", attempt: 1, workerId: "worker-1", sessionId: "session-1", runtimeId: "claude-code:default",
    providerId: "claude-code", exitCode: 0,
  };
  const events: NativeBuildEvent[] = [
    { sequence: 1, type: "task.assigned", occurredAt: "2026-11-18T12:00:00.000Z", actor: { role: "runner", id: "scheduler" }, payload: { taskId: "task-1" } },
    event(2, { ...base, cliVersion: "2.1.326", reportedModel: "claude-opus-5-5", outcome: "done", summary: "Added the form and ran its tests.",
      collected: true, replacedCliCommits: 2, restoredProjectDocs: ["docs/project/plan.md"], projectChangedDuringAttempt: ["status"],
      usage: { inputTokens: 1200, outputTokens: 340, totalInputTokens: 1200 } }),
    event(5, { ...base, attempt: 2, outcome: "failure", failureKind: "usage_limit", summary: "You've hit your usage limit.", collected: true, exitCode: 1 }),
    event(7, { ...base, attempt: 3, outcome: "done", collected: false, resultDigest: "a".repeat(64), worktree: { head: "b".repeat(40) }, exitCode: null,
      stopFailure: "A program it started is still running." }),
  ];
  const evidence = [
    { id: "ev-1", runId: "r", taskId: "task-1", actor: { role: "worker", id: "worker-1" }, status: "observed", createdAt: "2026-11-18T12:03:00.000Z", idempotencyKey: "k1",
      fact: { kind: "command", source: "runner_rerun_of_cli_claim", label: "unit tests", command: "npx", args: ["vitest", "run", "form"], exitCode: 0, timedOut: false } },
    { id: "ev-2", runId: "r", taskId: "task-1", actor: { role: "worker", id: "worker-1" }, status: "observed", createdAt: "2026-11-18T12:04:00.000Z", idempotencyKey: "k2",
      fact: { kind: "command", source: "runner_rerun_of_cli_claim", label: "lint", command: "npm", args: ["run", "lint"], exitCode: 1, timedOut: false } },
    { id: "ev-3", runId: "r", taskId: "task-1", actor: { role: "worker", id: "worker-1" }, status: "observed", createdAt: "2026-11-18T12:04:30.000Z", idempotencyKey: "k3",
      fact: { kind: "command", label: "an API worker's own check", command: "npm", args: ["test"], exitCode: 0, timedOut: false } },
  ] as unknown as NativeBuildObservability["evidence"];
  const views = cliAttemptViews(events, { taskTitles: { "task-1": "Add the login form" }, evidence });
  assert.deepEqual(views.map((view) => view.attempt), [3, 2, 1], "newest first; other events are ignored");
  const done = views[2]!;
  assert.equal(done.outcomeLabel, "Done");
  assert.equal(done.replacedCliCommits, 2);
  assert.deepEqual(done.reruns.map((rerun) => [rerun.label, rerun.passed]), [["unit tests", true], ["lint", false]],
    "the Runner's re-runs of the CLI's checks, not the worker's own evidence");
  assert.equal(views[1]!.outcomeLabel, "Failed: out of usage");
  assert.equal(views[0]!.collected, false);

  const card = renderToStaticMarkup(createElement(CliAttemptCard, { attempt: done }));
  for (const expected of ["Claude Code", "Add the login form", "attempt 1", "2.1.326", "claude-opus-5-5", "Done", "Commits replaced",
    "the Runner undid those commits", "unit tests", "lint", "exit 1", "docs/project/plan.md", "Your project folder changed", "1,200 in"]) {
    assert.ok(card.includes(expected), `the card shows ${expected}`);
  }
  const pending = renderToStaticMarkup(createElement(CliAttemptCard, { attempt: views[0]! }));
  assert.match(pending, /Not collected yet/);
  assert.match(pending, /could not be proven stopped yet/);
  assert.match(pending, /A program it started is still running\./);

  const tails = cliLiveTails([
    { sessionId: "session-1", actor: { role: "worker", id: "worker-1" }, turn: CLI_LIVE_TURN_BASE + 4, streaming: true,
      segments: [{ channel: "tool", text: "{\"type\":\"assistant\"" }, { channel: "tool", text: ",\"text\":\"Running the tests\"}" }] },
    { sessionId: "session-2", actor: { role: "worker", id: "worker-2" }, turn: 3, streaming: true, segments: [{ channel: "text", text: "an API turn" }] },
  ]);
  assert.equal(tails.length, 1, "only a CLI run's turns are its live tail");
  assert.match(tails[0]!.text, /Running the tests/);
  const panel = renderToStaticMarkup(createElement(CliAttemptsPanel, { attempts: views, tails: [{ ...tails[0]!, name: "Worker · Claude Code · CLI default", taskTitle: "Add the login form" }] }));
  assert.match(panel, /CLI workers/);
  assert.match(panel, /Live output/);
  assert.match(panel, /Running the tests/);
  assert.match(panel, /Running/);
  assert.equal(renderToStaticMarkup(createElement(CliAttemptsPanel, { attempts: [] })), "", "nothing for a Build without CLI workers");
  pass("Run details' CLI card shows the live tail, version, outcome, replaced commits, re-runs and an uncollected run");
}

console.log(`PASS CLI workers UI (${checks} checks)`);
