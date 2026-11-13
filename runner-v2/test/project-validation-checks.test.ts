/**
 * VF4 tests that run in memory (no process, no checkout): aiboard-validation.json version 2
 * with `checks` and `mandatory`, project checks as suggestions, environment overrides a changed
 * tier suggestion keeps, the inventory's mandatory-check record, and the final check refusing a
 * mandatory check that could not run. Required PR CI runs this file (Portable contract job);
 * the start checks that launch processes are in verification-plan-v2.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuildRuntime, MANDATORY_CHECK_TOOL_MISSING_PAUSE } from "../src/build-runtime.js";
import {
  verificationSuggestionsForProfile,
  withResolvedVerificationPlan,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import type { FinalVerificationPortLease } from "../src/final-verification-port-authority.js";
import {
  parseProjectValidationConfig,
  parseProjectValidationConfigText,
} from "../src/project-validation-config.js";
import { buildCompletionReadiness, rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  collectEnvironmentInventory,
  inventoryCheckCommands,
  inventoryMandatoryChecks,
  mandatoryChecksMissingTools,
  mandatoryToolMissingDetail,
  parseEnvironmentInventory,
} from "../src/verification-inventory.js";
import {
  completeVerificationPlanV2,
  resolveVerificationPlanV2,
  verificationPlanNeedsPort,
  type ProjectVerificationCheck,
  type VerificationCheckV2,
  type VerificationPlanV2,
} from "../src/verification-plan-v2.js";
import { acceptFinalVerificationProfile, emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import { WHEN, appendCheck, seedTasks, seedV2Run } from "./support/verification-plan-v2-fixtures.js";

const TYPECHECK: ProjectVerificationCheck = {
  id: "typecheck",
  label: "Type-check",
  kind: "build",
  mandatory: true,
  run: { executable: "tsc", args: ["--noEmit"] },
};
const SERVER: ProjectVerificationCheck = {
  id: "server",
  label: "Server answers",
  kind: "start",
  mandatory: false,
  start: { executable: "node", args: ["server.js", "--port", "{port}"], ready: { http: { path: "/healthz", status: 200 } } },
};
const CLI: ProjectVerificationCheck = {
  id: "cli",
  label: "CLI prints its help",
  kind: "start",
  mandatory: false,
  start: { executable: "node", args: ["cli.js", "--help"], ready: { exitCode: 0 } },
};
const DESKTOP: ProjectVerificationCheck = {
  id: "desktop",
  label: "Desktop app self-test",
  kind: "start",
  mandatory: false,
  start: {
    executable: "app",
    args: ["--self-test"],
    ready: { outputLine: "SELF-TEST READY" },
    steps: [{ label: "drive it", executable: "node", args: ["drive.js"], outputs: ["out/shot.png"] }],
  },
};

const lease = (revision: string, port = 43_210): FinalVerificationPortLease => ({ version: 1, runId: "run", targetRevision: revision, port, leaseId: "lease-1" });

/** The plan input an Architect sends to keep a suggestion as it is. */
const keep = (check: VerificationCheckV2) => ({
  id: check.id,
  label: check.label,
  kind: check.kind,
  ...(check.run ? { run: check.run } : {}),
  ...(check.start ? { start: check.start } : {}),
  ...(check.outputs ? { outputs: check.outputs } : {}),
});

function issuesOf(result: ReturnType<typeof completeVerificationPlanV2>): string {
  return result.ok ? "" : result.issues.join(" ");
}

test("a version-1 file reads exactly as before; unknown keys still fail closed", () => {
  const v1 = { version: 1, validationBudgetMs: 1000, tiers: { fast: [{ label: "lint", executable: "npm", args: ["run", "lint"], environment: { CI: "1" } }] } };
  assert.deepEqual(parseProjectValidationConfig(v1), v1);
  assert.throws(() => parseProjectValidationConfig({ ...v1, checks: [TYPECHECK] }), /checks need version 2/);
  assert.throws(() => parseProjectValidationConfig({ version: 2, extra: true }), /unknown field "extra"/);
  // A file without checks offers the detected checks, as before.
  const profile: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile("a".repeat(40)),
    detectedSignals: [{ category: "build", source: "package.json#scripts.build", detail: "build" }],
    commands: { build: [{ label: "package build", executable: "npm", args: ["run", "build"] }] },
  };
  assert.deepEqual(verificationSuggestionsForProfile(profile).map((suggestion) => [suggestion.check.id, suggestion.check.origin]), [["build", "detected"]]);
});

test("a version-2 file declares checks with mandatory; a malformed one fails closed with a clear error", () => {
  const parsed = parseProjectValidationConfig({ version: 2, checks: [TYPECHECK, SERVER, CLI, DESKTOP] });
  assert.deepEqual(parsed.checks, [TYPECHECK, SERVER, CLI, DESKTOP]);

  const malformed: Array<[unknown, RegExp]> = [
    [{ version: 2, checks: [] }, /checks must be a list of 1 to 32 checks/],
    [{ version: 2, checks: [{ ...TYPECHECK, mandatory: undefined }] }, /checks\[0\]\.mandatory must be true or false/],
    [{ version: 2, checks: [{ ...TYPECHECK, mandatory: "yes" }] }, /mandatory must be true or false/],
    [{ version: 2, checks: [{ ...TYPECHECK, origin: "project" }] }, /unknown fields: origin \(the Runner records a declared check's origin as project\)/],
    [{ version: 2, checks: [{ ...TYPECHECK, shell: "tsc" }] }, /checks\[0\] has unknown fields: shell/],
    [{ version: 2, checks: [{ ...TYPECHECK, kind: "browser" }] }, /kind must be build, tests, start or other/],
    [{ version: 2, checks: [{ ...TYPECHECK, id: "Type:Check" }] }, /checks\[0\]\.id must be/],
    [{ version: 2, checks: [TYPECHECK, TYPECHECK] }, /Check id typecheck is declared more than once/],
    [{ version: 2, checks: [{ ...TYPECHECK, run: { executable: "tsc", args: "--noEmit" } }] }, /run\.args must be/],
    [{ version: 2, checks: [{ ...SERVER, start: { ...SERVER.start!, args: ["server.js"] } }] }, /must pass the Runner-leased port as \{port\}/],
    [{ version: 2, checks: [{ ...CLI, start: { ...CLI.start!, ready: { exitCode: 0, outputLine: "x" } } }] }, /exactly one of/],
    [{ version: 2, checks: [{ ...CLI, environment: { CI: "1" } }] }, /only a build, tests or other check can use/],
    [{ version: 2, checks: [{ ...TYPECHECK, environment: { "BAD NAME": "1" } }] }, /environment variable "BAD NAME"/],
  ];
  for (const [value, pattern] of malformed) {
    assert.throws(() => parseProjectValidationConfig(value), pattern, JSON.stringify(value));
  }
  // The file text: every error names the file; a declared check records the line of its id.
  assert.throws(() => parseProjectValidationConfigText("{ version: 2 }"), /aiboard-validation\.json is not valid JSON/);
  assert.throws(
    () => parseProjectValidationConfigText(JSON.stringify({ version: 2, checks: [{ ...TYPECHECK, mandatory: 1 }] })),
    /aiboard-validation\.json is malformed: .*mandatory must be true or false/,
  );
  const text = JSON.stringify({ version: 2, checks: [TYPECHECK, CLI] }, null, 2);
  const lines = text.split("\n");
  const withLines = parseProjectValidationConfigText(text).checks!;
  assert.equal(lines[withLines[0]!.line! - 1]!.trim(), '"id": "typecheck",');
  assert.equal(lines[withLines[1]!.line! - 1]!.trim(), '"id": "cli",');
});

test("declared checks are the suggestions, origin project, mandatory from the file; detection is only the fallback", () => {
  const revision = "b".repeat(40);
  const profile: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile(revision),
    detectedSignals: [{ category: "build", source: "package.json#scripts.build", detail: "build" }],
    commands: { build: [{ label: "package build", executable: "npm", args: ["run", "build"] }] },
    projectChecks: [{ ...TYPECHECK, line: 4 }, SERVER, CLI, DESKTOP],
  };
  const suggestions = verificationSuggestionsForProfile(profile).map((suggestion) => suggestion.check);
  assert.deepEqual(suggestions.map((check) => [check.id, check.origin, check.mandatory]), [
    ["typecheck", "project", true], ["server", "project", false], ["cli", "project", false], ["desktop", "project", false],
  ], "the detected build is not mixed in");
  assert.equal("line" in suggestions[0]!, false, "the config line is not part of the check");

  // The Architect keeps or skips them; a mandatory one can be neither skipped nor changed.
  const [typecheck, server, cli, desktop] = suggestions as [VerificationCheckV2, VerificationCheckV2, VerificationCheckV2, VerificationCheckV2];
  const skippedMandatory = completeVerificationPlanV2({ checks: [keep(server), keep(cli), keep(desktop)], skipped: [{ checkId: "typecheck", reason: "Slow." }] }, suggestions);
  assert.match(issuesOf(skippedMandatory), /typecheck is mandatory and cannot be skipped/);
  const changedMandatory = completeVerificationPlanV2({
    checks: [{ ...keep(typecheck), run: { executable: "tsc", args: ["-p", "."] } }, keep(server), keep(cli), keep(desktop)], skipped: [],
  }, suggestions);
  assert.match(issuesOf(changedMandatory), /typecheck is mandatory and cannot be changed/);
  const unflagged = completeVerificationPlanV2({ checks: [{ ...keep(typecheck), mandatory: false }, keep(server), keep(cli), keep(desktop)], skipped: [] }, suggestions);
  assert.match(issuesOf(unflagged), /mandatory is set only by the Runner, from aiboard-validation\.json/);
  const flagged = completeVerificationPlanV2({ checks: [keep(typecheck), { ...keep(server), mandatory: true }, keep(cli), keep(desktop)], skipped: [] }, suggestions);
  assert.match(issuesOf(flagged), /mandatory is set only by the Runner/);

  const planned = completeVerificationPlanV2({
    checks: [keep(typecheck), keep(server), keep(cli), keep(desktop)],
    skipped: [],
  }, suggestions);
  assert.equal(planned.ok, true, issuesOf(planned));
  const plan = (planned as { plan: VerificationPlanV2 }).plan;
  assert.deepEqual(plan.checks.map((check) => [check.origin, check.mandatory]), [["project", true], ["project", false], ["project", false], ["project", false]]);

  // A kept project check runs as written: {port} is the leased port, node the Runner's own Node.
  const resolution = verificationSuggestionsForProfile(profile);
  assert.equal(verificationPlanNeedsPort(plan, resolution), true, "a server ready on HTTP needs the leased port");
  const resolved = resolveVerificationPlanV2({ plan, suggestions: resolution, port: 43_210, nodeExecutable: "/runner/node" });
  const byId = new Map(resolved.map((check) => [check.checkId, check]));
  assert.deepEqual(byId.get("typecheck"), {
    checkId: "typecheck", label: "Type-check", kind: "build", origin: "project", mandatory: true, mode: "command",
    commands: [{ label: "Type-check", executable: "tsc", args: ["--noEmit"] }],
  });
  assert.equal(byId.get("server")?.mode, "program");
  assert.equal(byId.get("server")?.endpoint, "http://127.0.0.1:43210/healthz");
  assert.deepEqual(byId.get("server")?.commands[0]?.args, ["server.js", "--port", "43210"]);
  assert.equal(byId.get("server")?.commands[0]?.executable, "/runner/node");
  assert.deepEqual([byId.get("cli")?.mode, byId.get("cli")?.expectedExitCode], ["exit", 0], "a CLI is ready on its exit code");
  assert.deepEqual([byId.get("desktop")?.mode, byId.get("desktop")?.outputLine], ["program", "SELF-TEST READY"], "a desktop test mode is ready on a line of its output");
  assert.deepEqual(byId.get("desktop")?.commands.map((command) => command.label), ["Desktop app self-test", "Desktop app self-test › drive it"]);
  assert.deepEqual(byId.get("desktop")?.commands[1]?.outputs, ["out/shot.png"]);

  // The resolved plan is recorded in the execution profile and validates there.
  const recorded = withResolvedVerificationPlan(profile, plan, resolution, lease(revision));
  assert.deepEqual(recorded.verification?.checks, resolveVerificationPlanV2({ plan, suggestions: resolution, port: 43_210, nodeExecutable: process.execPath }));
  assert.deepEqual(recorded.projectChecks?.[0], { ...TYPECHECK, line: 4 });
});

test("a changed tier suggestion keeps its environment; the Architect can neither drop, change nor add one", () => {
  const profile: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile("c".repeat(40)),
    detectedSignals: [{ category: "tests", source: "package.json#scripts.test", detail: "test" }],
    commands: { tests: [{ label: "package tests", executable: "npm", args: ["run", "test"] }] },
    tiers: { release: [{ label: "release tests", executable: "npm", args: ["run", "test:release"], environment: { CI: "1", TZ: "UTC" } }] },
  };
  const resolution = verificationSuggestionsForProfile(profile);
  const suggestions = resolution.map((suggestion) => suggestion.check);
  const tests = suggestions[0]!;
  assert.deepEqual(tests.environment, { CI: "1", TZ: "UTC" }, "the Architect sees the overrides on the suggestion");

  // Kept unchanged, it runs exactly the tier command.
  const kept = completeVerificationPlanV2({ checks: [keep(tests)], skipped: [] }, suggestions);
  assert.equal(kept.ok, true, issuesOf(kept));
  const keptPlan = (kept as { plan: VerificationPlanV2 }).plan;
  assert.deepEqual(keptPlan.checks[0]!.environment, { CI: "1", TZ: "UTC" }, "the Runner fills it in");
  assert.deepEqual(resolveVerificationPlanV2({ plan: keptPlan, suggestions: resolution })[0]!.commands[0]!.environment, { CI: "1", TZ: "UTC" });

  // Changed, it keeps the overrides (the bug: they were dropped).
  const changed = completeVerificationPlanV2({ checks: [{ ...keep(tests), run: { executable: "npm", args: ["run", "test:release", "--", "--grep", "api"] } }], skipped: [] }, suggestions);
  assert.equal(changed.ok, true, issuesOf(changed));
  const changedPlan = (changed as { plan: VerificationPlanV2 }).plan;
  const [resolved] = resolveVerificationPlanV2({ plan: changedPlan, suggestions: resolution });
  assert.deepEqual(resolved!.commands[0], {
    label: "release tests", executable: "npm", args: ["run", "test:release", "--", "--grep", "api"], environment: { CI: "1", TZ: "UTC" },
  });

  const echoed = completeVerificationPlanV2({ checks: [{ ...keep(tests), environment: { CI: "1", TZ: "UTC" } }], skipped: [] }, suggestions);
  assert.equal(echoed.ok, true, "an unchanged echo is fine");
  const altered = completeVerificationPlanV2({ checks: [{ ...keep(tests), environment: { CI: "0" } }], skipped: [] }, suggestions);
  assert.match(issuesOf(altered), /environment is set by the Runner from aiboard-validation\.json/);
  const own = completeVerificationPlanV2({
    checks: [keep(tests), { id: "lint", label: "Lint", kind: "other", run: { executable: "npm", args: ["run", "lint"] }, environment: { CI: "1" } }],
    skipped: [],
  }, suggestions);
  assert.match(issuesOf(own), /environment cannot be set: only aiboard-validation\.json/);
  const restarted = completeVerificationPlanV2({
    checks: [{ id: tests.id, label: tests.label, kind: "start", start: { executable: "npm", args: ["start"], ready: { exitCode: 0 } } }],
    skipped: [],
  }, suggestions);
  assert.match(issuesOf(restarted), /only a build, tests or other check can use; keep it a run check, or skip it and add your own/);
});

test("the inventory records which mandatory check a missing tool blocks, naming the tool and the config line", async () => {
  const revision = "d".repeat(40);
  const profile: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile(revision),
    projectChecks: [
      { id: "lint", label: "Lint", kind: "other", mandatory: false, run: { executable: "eslint", args: ["."] } },
      { ...TYPECHECK, line: 7 },
      { id: "selftest", label: "Self-test", kind: "start", mandatory: true, start: { executable: "node", args: ["selftest.js"], ready: { exitCode: 0 } }, line: 15 },
    ],
  };
  const mandatory = inventoryMandatoryChecks(profile);
  assert.deepEqual(mandatory, [
    { checkId: "typecheck", label: "Type-check", configLine: 7, commands: [{ executable: "tsc", args: ["--noEmit"] }] },
    { checkId: "selftest", label: "Self-test", configLine: 15, commands: [] },
  ], "node is the Runner's own Node, never looked up on PATH");
  const checks = inventoryCheckCommands(profile);
  assert.deepEqual(checks.slice(0, 2).map((check) => check.label), ["check typecheck (mandatory): Type-check", "check selftest (mandatory): Self-test"], "mandatory checks come first");

  const inventory = await collectEnvironmentInventory({
    trigger: "planning",
    revision,
    cwd: tmpdir(),
    checks,
    mandatoryChecks: mandatory,
    lookup: async (executable) => executable === "tsc" || executable === "eslint" ? { status: "missing" } : { status: "found", path: `/usr/bin/${executable}` },
    run: async () => ({ outcome: "exited", exitCode: 0, stdout: "1.0.0\n", stderr: "" }),
    browsers: async () => ({ browsers: [], notes: [] }),
    platform: "linux",
  });
  assert.deepEqual(inventory.mandatoryChecks, [
    { checkId: "typecheck", label: "Type-check", configLine: 7, tools: ["tsc"], missing: ["tsc"] },
    { checkId: "selftest", label: "Self-test", configLine: 15, tools: [], missing: [] },
  ]);
  assert.deepEqual(parseEnvironmentInventory(JSON.parse(JSON.stringify(inventory))), inventory, "the record replays");
  const blocked = mandatoryChecksMissingTools(inventory);
  assert.deepEqual(blocked.map((check) => check.checkId), ["typecheck"], "a missing tool of a non-mandatory check (eslint) blocks nothing");
  assert.match(mandatoryToolMissingDetail(blocked), /tsc \(needed by mandatory check "typecheck", aiboard-validation\.json line 7\)/);
  assert.throws(() => parseEnvironmentInventory({ ...JSON.parse(JSON.stringify(inventory)), mandatoryChecks: [{ checkId: "x", label: "X", tools: [], missing: ["tsc"] }] }), /names a missing tool it does not use/);
  // An inventory from before VF4 has no mandatory checks and blocks nothing.
  const { mandatoryChecks: _mandatory, ...older } = inventory;
  assert.deepEqual(mandatoryChecksMissingTools(parseEnvironmentInventory(JSON.parse(JSON.stringify(older)))), []);
});

test("a mandatory check that could not run is never recorded, and completion never accepts one", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 project checks scheduler "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const runId = "run-project-checks-mandatory";
  const revision = "e".repeat(40);
  try {
    const profile: FinalVerificationExecutionProfile = { ...emptyFinalVerificationProfile(revision), projectChecks: [TYPECHECK] };
    const suggestions = verificationSuggestionsForProfile(profile).map((suggestion) => suggestion.check);
    const planned = completeVerificationPlanV2({ checks: [keep(suggestions[0]!)], skipped: [] }, suggestions);
    assert.equal(planned.ok, true, issuesOf(planned));
    const plan = (planned as { plan: VerificationPlanV2 }).plan;
    seedV2Run(store, runId, revision, plan, withResolvedVerificationPlan(profile, plan));
    const notRun = {
      checkId: "typecheck", kind: "build", label: "Type-check", origin: "project", mandatory: true,
      outcome: "not_run", green: false, evidenceIds: [], facts: [], issues: [],
      notRun: { reason: "tool_missing", tool: "tsc", detail: "tsc was not found on PATH." },
    };
    assert.throws(() => appendCheck(store, runId, revision, "C:/verify", notRun), /Mandatory final verification check typecheck cannot be recorded as not run/);
    // Defense in depth: a projection that somehow holds one is not ready to complete.
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    const current = projection.finalVerification!.current!;
    current.completedChecks = [{ ...notRun, attempt: 1, workspacePath: "C:/verify", startedAt: WHEN, finishedAt: WHEN } as never];
    assert.ok(buildCompletionReadiness(projection).issues.some((issue) => /Mandatory final-verification check typecheck was not run/.test(issue)));
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the final check pauses for the owner when a mandatory check's tool is missing, and runs it again after the resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 project checks final pause "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const runId = "run-project-checks-final-pause";
  const revision = "f".repeat(40);
  const profileFor = async (targetRevision: string): Promise<FinalVerificationExecutionProfile> => ({
    ...emptyFinalVerificationProfile(targetRevision), projectChecks: [{ ...TYPECHECK, line: 3 }],
  });
  let executions = 0;
  let planned = false;
  try {
    store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
    seedTasks(store, runId, revision);
    const runtime = new BuildRuntime({
      runId,
      store,
      evidenceStore: evidence,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: revision }) },
      maxConcurrency: 1,
      workspaceFor: async (task) => `C:/repair/${task.id}`,
      finalVerificationProfileFor: profileFor,
      finalVerificationWithPlan: async (profile, plan) => withResolvedVerificationPlan(profile, plan),
      finalVerificationArchitectCommands: false,
      finalVerificationDriver: {
        executeCheck: async () => {
          executions += 1;
          return {
            workspacePath: "C:/verify", startedAt: WHEN, finishedAt: WHEN,
            check: {
              checkId: "typecheck", kind: "build", label: "Type-check", origin: "project", mandatory: true,
              outcome: "not_run", green: false, evidenceIds: [], facts: [], issues: [],
              notRun: { reason: "tool_missing", tool: "tsc", detail: "tsc was not found on PATH." },
            },
          };
        },
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/pause.json" }) },
      architectDriver: {
        run: async (request) => {
          if (request.reason.type !== "final_verification_plan_required") throw new Error(`Unexpected Architect reason ${request.reason.type}`);
          const prefill = request.reason.planPrefill as { suggestedChecks?: VerificationCheckV2[] } | undefined;
          assert.deepEqual(prefill?.suggestedChecks?.map((check) => [check.id, check.origin, check.mandatory]), [["typecheck", "project", true]]);
          const result = await request.tools.invoke({ type: "tool_call", callId: "plan", name: "plan_final_verification", arguments: {
            plan: { version: 2, checks: [keep(prefill!.suggestedChecks![0]!)], skipped: [] },
          } }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "");
          planned = true;
        },
      },
    });
    let last;
    for (let step = 0; step < 8; step += 1) {
      last = await runtime.step();
      if (last.status === "paused") break;
    }
    assert.equal(planned, true);
    assert.deepEqual(last, { status: "paused", action: MANDATORY_CHECK_TOOL_MISSING_PAUSE });
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.pauseReason?.reason, MANDATORY_CHECK_TOOL_MISSING_PAUSE);
    assert.match(projection.pauseReason?.detail ?? "", /tsc \(needed by mandatory check "typecheck", aiboard-validation\.json line 3\)/);
    assert.equal(projection.finalVerification?.current?.completedChecks?.length ?? 0, 0, "the check is not recorded as done");
    assert.equal(projection.repairIssues === undefined || Object.keys(projection.repairIssues).length === 0, true, "a missing tool opens no repair");

    // After the resume the same check runs again; still missing, the run pauses again.
    runtime.resume("owner-resume");
    const again = await runtime.step();
    assert.equal(executions, 2);
    assert.deepEqual(again, { status: "paused", action: MANDATORY_CHECK_TOOL_MISSING_PAUSE });
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});
