import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSelectedExecutionCoherence,
  boundaryWouldClosePhaseWithTestsGate,
  evaluatePhaseAcceptance,
  type DeliveryBoundaryScope,
  type PhaseAcceptanceInputs,
} from "../src/delivery-acceptance.js";
import { splitAndChain as deliverySplitAndChain } from "../src/delivery-execution.js";
import {
  deriveSelectedTestsCommand,
  splitAndChain as profileSplitAndChain,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import type { FinalVerificationCommand } from "../src/final-verification-runtime.js";
import {
  assessPacketReadiness,
  decideTestExecutionScope,
  finalSuiteVerified,
  packetCriteriaForTask,
  resolveExecutionMandates,
} from "../src/task-validation-policy.js";
import { testIntegrityBaselineFindings, type TestIntegrityPin } from "../src/test-integrity.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import type { PacketCriterion, ValidationMandate } from "../src/validation-policy.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { fingerprintChildEnvironment } from "../src/command-evidence-identity.js";
import { commandReuseKey, findReusableCommand } from "../src/command-evidence-reuse.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type { CommandEvidenceFact } from "../src/evidence-store.js";

/**
 * IV-2 (CD-23/EP16) pure scope/policy matrix: safe selective command
 * derivation, the one execution-scope decision, record coherence, EP16
 * mandate wiring, scope-aware test integrity, V2 reuse identity, and the
 * final-verification full-profile guard. No processes, no stores beyond a
 * temp-dir reuse check.
 */

function packageCommand(args: string[], label = "package tests"): FinalVerificationCommand {
  return { label, executable: process.execPath, args };
}

function checkoutWithScript(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "iv2-select-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "iv2", scripts: { test: script } }));
  return root;
}

test("IV-2: bare node --test through npm narrows with the -- separator and preserves the label", () => {
  const root = checkoutWithScript("node --test");
  try {
    const command = packageCommand(["/x/npm-cli.js", "run", "test"]);
    const before = structuredClone(command);
    const derived = deriveSelectedTestsCommand({
      checkoutPath: root,
      command,
      selectedTests: ["packages/a/test/a.test.mjs", "packages/a/test/c.test.mjs"],
    });
    assert.ok(derived.selectable);
    assert.deepEqual(derived.command.args, [
      "/x/npm-cli.js", "run", "test", "--",
      "packages/a/test/a.test.mjs", "packages/a/test/c.test.mjs",
    ]);
    assert.equal(derived.command.label, "package tests");
    assert.equal(derived.runnerFamily, "node-test");
    assert.deepEqual(command, before, "derivation never mutates its input command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2: pnpm and yarn forward selected paths without a separator", () => {
  const root = checkoutWithScript("node --test");
  try {
    for (const manager of ["pnpm.js", "yarn.js"]) {
      const derived = deriveSelectedTestsCommand({
        checkoutPath: root,
        command: packageCommand([`/corepack/${manager}`, "run", "test"]),
        selectedTests: ["test/a.test.mjs"],
      });
      assert.ok(derived.selectable);
      assert.deepEqual(derived.command.args.at(-1), "test/a.test.mjs");
      assert.ok(!derived.command.args.includes("--"), `no npm separator for ${manager}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2: tsx and node.exe bare invocations are selectable; npx prefix is tolerated like the planner", () => {
  const root = checkoutWithScript("tsx --test");
  const exe = checkoutWithScript("node.exe --test");
  const npx = checkoutWithScript("npx pytest");
  try {
    for (const checkout of [root, exe, npx]) {
      const derived = deriveSelectedTestsCommand({
        checkoutPath: checkout,
        command: packageCommand(["/x/npm-cli.js", "run", "test"]),
        selectedTests: ["test/a.test.mjs"],
      });
      assert.ok(derived.selectable, checkout);
    }
  } finally {
    for (const checkout of [root, exe, npx]) rmSync(checkout, { recursive: true, force: true });
  }
});

test("IV-2: scripts with positional patterns, extra flags, chains, or shell syntax refuse selection (fail safe)", () => {
  const scripts = [
    "node --test test/",
    "node --test --test-concurrency=1",
    "node --test --test-name-pattern=foo",
    "lint && node --test",
    "node --test || echo done",
    "node --test; echo done",
    "node --test $FLAGS",
    "mocha",
    "jest",
    "vitest run",
    "dotnet test",
    "go test ./...",
  ];
  for (const script of scripts) {
    const root = checkoutWithScript(script);
    try {
      const derived = deriveSelectedTestsCommand({
        checkoutPath: root,
        command: packageCommand(["/x/npm-cli.js", "run", "test"]),
        selectedTests: ["test/a.test.mjs"],
      });
      assert.ok(!derived.selectable, script);
      assert.ok(derived.reason.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("IV-2: bare pytest through npm appends paths after the runner-owned junitxml flag without a second --", () => {
  const root = checkoutWithScript("pytest");
  try {
    const derived = deriveSelectedTestsCommand({
      checkoutPath: root,
      command: packageCommand(["/x/npm-cli.js", "run", "test", "--", "--junitxml=.aiboard-report-x.xml"]),
      selectedTests: ["t/a.py", "t/b.py"],
    });
    assert.ok(derived.selectable);
    assert.deepEqual(derived.command.args, [
      "/x/npm-cli.js", "run", "test", "--", "--junitxml=.aiboard-report-x.xml", "t/a.py", "t/b.py",
    ]);
    assert.equal(derived.runnerFamily, "pytest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2: pytest with filters and python -m bare shapes", () => {
  const filtered = checkoutWithScript("pytest -k fast");
  const moduleRoot = checkoutWithScript("python -m pytest");
  try {
    const refused = deriveSelectedTestsCommand({
      checkoutPath: filtered,
      command: packageCommand(["/x/npm-cli.js", "run", "test"]),
      selectedTests: ["t/a.py"],
    });
    assert.ok(!refused.selectable);
    const allowed = deriveSelectedTestsCommand({
      checkoutPath: moduleRoot,
      command: packageCommand(["/x/npm-cli.js", "run", "test"]),
      selectedTests: ["t/a.py"],
    });
    assert.ok(allowed.selectable);
    assert.deepEqual(allowed.command.args.at(-1), "t/a.py");
  } finally {
    rmSync(filtered, { recursive: true, force: true });
    rmSync(moduleRoot, { recursive: true, force: true });
  }
});

test("IV-2: direct family commands — pytest selectable, dotnet/ctest/maven refused with reasons", () => {
  const root = mkdtempSync(join(tmpdir(), "iv2-direct-"));
  try {
    const direct = (executable: string, args: string[]): FinalVerificationCommand =>
      ({ label: "direct", executable, args });
    const pytest = deriveSelectedTestsCommand({
      checkoutPath: root, command: direct("pytest", ["--junitxml=r.xml"]), selectedTests: ["t/a.py"],
    });
    assert.ok(pytest.selectable);
    assert.deepEqual(pytest.command.args, ["--junitxml=r.xml", "t/a.py"]);
    const pytestFiltered = deriveSelectedTestsCommand({
      checkoutPath: root, command: direct("pytest", ["-k", "fast"]), selectedTests: ["t/a.py"],
    });
    assert.ok(!pytestFiltered.selectable);
    for (const [executable, args, pattern] of [
      ["dotnet", ["test", "--disable-build-servers"], /project\/filter/],
      ["ctest", ["--test-dir", "build"], /build directory/],
      ["mvn", ["-B", "test"], /class/],
    ] as const) {
      const refused = deriveSelectedTestsCommand({
        checkoutPath: root, command: direct(executable, [...args]), selectedTests: ["t/a.py"],
      });
      assert.ok(!refused.selectable, executable);
      assert.match(refused.reason, pattern);
    }
    const node = deriveSelectedTestsCommand({
      checkoutPath: root, command: direct("/usr/bin/node", ["--test"]), selectedTests: ["t/a.mjs"],
    });
    assert.ok(node.selectable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2: empty, absolute, escaping, or missing-manifest selections refuse selection", () => {
  const root = checkoutWithScript("node --test");
  const empty = mkdtempSync(join(tmpdir(), "iv2-empty-"));
  try {
    const command = packageCommand(["/x/npm-cli.js", "run", "test"]);
    assert.ok(!deriveSelectedTestsCommand({ checkoutPath: root, command, selectedTests: [] }).selectable);
    for (const unsafe of ["/abs/x.mjs", "../escape.mjs", "a/../../b.mjs", "", "C:\\win\\x.mjs"]) {
      const refused = deriveSelectedTestsCommand({ checkoutPath: root, command, selectedTests: [unsafe] });
      assert.ok(!refused.selectable, unsafe);
    }
    const noManifest = deriveSelectedTestsCommand({ checkoutPath: empty, command, selectedTests: ["t/a.mjs"] });
    assert.ok(!noManifest.selectable);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("IV-2: the splitAndChain twins agree on every script shape", () => {
  for (const script of [
    "node --test", "a && b", "a || b", "a; b", "a | b", "a & b",
    "echo 'a&&b' && node --test", 'echo "x" && y', "x\ny", "", "  ",
    "cd test && node --test", "a && b && c",
  ]) {
    assert.deepEqual(profileSplitAndChain(script), deliverySplitAndChain(script), JSON.stringify(script));
  }
});

test("IV-2: scope decision — mandates, rung, widening, emptiness, and underivable shapes stay full", () => {
  const safe = { selectable: true as const, command: packageCommand([]), runnerFamily: "node-test" as const };
  const unsafe = { selectable: false as const, reason: "no safe shape" };
  const narrow = { rung: "module_graph", widened: false, tests: ["t/a.mjs"] };
  assert.equal(decideTestExecutionScope({ selection: narrow, forceFullSuite: true, selectiveCommand: safe }).scope, "full_test_script");
  for (const rung of ["full_suite", "no_tests_required", "seed", ""]) {
    const decision = decideTestExecutionScope({ selection: { ...narrow, rung }, forceFullSuite: false, selectiveCommand: safe });
    assert.equal(decision.scope, "full_test_script", rung);
  }
  assert.equal(decideTestExecutionScope({ selection: { ...narrow, widened: true }, forceFullSuite: false, selectiveCommand: safe }).scope, "full_test_script");
  assert.equal(decideTestExecutionScope({ selection: { ...narrow, tests: [] }, forceFullSuite: false, selectiveCommand: safe }).scope, "full_test_script");
  const underivable = decideTestExecutionScope({ selection: narrow, forceFullSuite: false, selectiveCommand: unsafe });
  assert.equal(underivable.scope, "full_test_script");
  assert.match(underivable.reason, /No safe selective command/);
  for (const rung of ["impact_tool", "lsp_references", "module_graph"]) {
    const decision = decideTestExecutionScope({ selection: { ...narrow, rung }, forceFullSuite: false, selectiveCommand: safe });
    assert.equal(decision.scope, "selected", rung);
  }
});

test("IV-2: coherence — full records pass untouched; selected requires rung, unwidened, tests, and narrowing argv", () => {
  const full = { executedScope: "full_test_script", rung: "seed", widened: true, wideningReasons: ["x"], selectedTests: [], args: [] as string[] };
  assert.doesNotThrow(() => assertSelectedExecutionCoherence("X", full));
  for (const scope of ["bogus", undefined, null, 0]) {
    assert.throws(() => assertSelectedExecutionCoherence("X", { ...full, executedScope: scope }), /invalid/);
  }
  const selected = { executedScope: "selected", rung: "module_graph", widened: false, wideningReasons: [] as unknown, selectedTests: ["t/a.mjs"], args: ["run", "test", "--", "t/a.mjs"] };
  assert.doesNotThrow(() => assertSelectedExecutionCoherence("X", selected));
  assert.doesNotThrow(() => assertSelectedExecutionCoherence("X", { ...selected, wideningReasons: undefined }));
  for (const rung of ["full_suite", "no_tests_required", "seed", ""]) {
    assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, rung }), /rung/, String(rung));
  }
  assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, widened: true }), /widen/);
  assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, widened: undefined }), /widen/);
  assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, wideningReasons: ["lockfile x"] }), /widen/);
  assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, selectedTests: [] }), /no selected tests/);
  assert.throws(() => assertSelectedExecutionCoherence("X", { ...selected, args: ["run", "test"] }), /does not name/);
});

function fullSuiteMandate(scope: ValidationMandate["scope"]): ValidationMandate {
  return { id: "mandate_full", gate: "full_suite", scope, source: "source", description: "Release gate requires the full suite." };
}

test("IV-2: default full suite belongs to the final candidate; explicit mandates force full now; conflicts fail closed", () => {
  const packet = resolveExecutionMandates({ isFinalCandidate: false });
  assert.equal(packet.forceFullSuite, false);
  assert.deepEqual(packet.resolution.required, []);
  const explicit = resolveExecutionMandates({
    mandates: { sourceMandates: [fullSuiteMandate("affected")], projectMandates: [] },
    isFinalCandidate: false,
  });
  assert.equal(explicit.forceFullSuite, true);
  assert.ok(explicit.resolution.required.some((mandate) => mandate.id === "mandate_full"));
  const deferred = resolveExecutionMandates({
    mandates: { sourceMandates: [fullSuiteMandate("final")], projectMandates: [] },
    isFinalCandidate: false,
  });
  assert.equal(deferred.forceFullSuite, false);
  assert.equal(deferred.resolution.deferredToFinal.length, 1);
  const final = resolveExecutionMandates({ isFinalCandidate: true });
  assert.equal(final.forceFullSuite, true);
  assert.ok(final.resolution.required.some((mandate) => mandate.id === "default_full_suite"));
  assert.throws(() => resolveExecutionMandates({
    mandates: {
      sourceMandates: [{ id: "dup", gate: "g", scope: "affected", source: "source", description: "d" }],
      projectMandates: [{ id: "dup", gate: "g", scope: "final", source: "project", description: "d" }],
    },
    isFinalCandidate: false,
  }), /conflict/);
});

test("IV-2: packet criteria gate acceptance; final-only pending criteria never block", () => {
  const boundary = {
    checks: [
      { checkId: "build", outcome: "passed" },
      { checkId: "tests", outcome: "passed" },
    ],
  } as unknown as DeliveryBoundaryScope;
  const ready = assessPacketReadiness(packetCriteriaForTask({ boundary, finalVerified: false }));
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(ready.finalGatePending.map((criterion) => criterion.id), ["final_full_suite"]);
  const failed = { checks: [{ checkId: "tests", outcome: "failed" }] } as unknown as DeliveryBoundaryScope;
  const blocked = assessPacketReadiness(packetCriteriaForTask({ boundary: failed, finalVerified: false }));
  assert.equal(blocked.ready, false);
  assert.match(blocked.blockers.join(" "), /failed/);
  const unknown = { checks: [{ checkId: "tests", outcome: "unknown" }] } as unknown as DeliveryBoundaryScope;
  const pendingCriteria: PacketCriterion[] = packetCriteriaForTask({ boundary: unknown, finalVerified: false });
  assert.equal(pendingCriteria.find((criterion) => criterion.id === "boundary:tests")?.status, "pending");
  assert.equal(assessPacketReadiness(pendingCriteria).ready, false);
  const verified = assessPacketReadiness(packetCriteriaForTask({ boundary, finalVerified: true }));
  assert.equal(verified.finalGatePending.length, 0);
});

test("IV-2: finalSuiteVerified reads only durable green final submissions at the current revision", () => {
  const generation = (overrides: Record<string, unknown>) => ({
    taskId: "F", generationId: "g", targetRevision: "r".repeat(40), planVersion: 1,
    plan: {}, executionProfile: {}, state: "current", ...overrides,
  });
  const submission = { kind: "final_verification_submission" };
  const projection = (finalVerification: unknown) => ({
    integrationRevision: "r".repeat(40), finalVerification,
  }) as unknown as SchedulerProjection;
  assert.equal(finalSuiteVerified(projection(undefined)), false);
  assert.equal(finalSuiteVerified(projection({ history: [] })), false);
  assert.equal(finalSuiteVerified(projection({ current: generation({}), history: [] })), false);
  assert.equal(finalSuiteVerified(projection({ current: generation({ submissionResult: submission }), history: [] })), true);
  assert.equal(finalSuiteVerified(projection({ history: [generation({ submissionResult: submission })] })), true);
  assert.equal(finalSuiteVerified(projection({ current: generation({ submissionResult: submission, state: "invalidated" }), history: [] })), false);
  assert.equal(finalSuiteVerified(projection({ current: generation({ submissionResult: submission, targetRevision: "s".repeat(40) }), history: [] })), false);
});

test("IV-2: selected runs skip the count comparison but keep every profile/config guard", () => {
  const pin = (revision: string, overrides: Partial<TestIntegrityPin> = {}): TestIntegrityPin =>
    ({ revision, commands: [], configDigest: "c", ...overrides });
  const baseline = { kind: "executed_report" as const, pin: pin("a".repeat(40)), executed: 10 };
  const candidate = pin("b".repeat(40));
  assert.ok(testIntegrityBaselineFindings(baseline, candidate, 4).some((finding) => finding.code === "suite_shrank"));
  assert.ok(testIntegrityBaselineFindings(baseline, candidate, 4, { executedScope: "full_test_script" }).some((finding) => finding.code === "suite_shrank"));
  assert.deepEqual(testIntegrityBaselineFindings(baseline, candidate, 4, { executedScope: "selected" }), []);
  assert.deepEqual(testIntegrityBaselineFindings(baseline, candidate, 10, { executedScope: "selected" }), []);
  const changedConfig = pin("b".repeat(40), { configDigest: "changed" });
  const configFindings = testIntegrityBaselineFindings(baseline, changedConfig, 4, { executedScope: "selected" });
  assert.ok(configFindings.some((finding) => finding.code === "test_config_changed"));
  assert.ok(!configFindings.some((finding) => finding.code === "suite_shrank"));
  const changedCommands = pin("b".repeat(40), { commands: [{ executable: "npm", args: ["run", "other"] }] });
  const commandFindings = testIntegrityBaselineFindings(baseline, changedCommands, 4, { executedScope: "selected" });
  assert.ok(commandFindings.some((finding) => finding.code === "test_command_changed"));
});

test("IV-2: V2 reuse — identical selected commands share identity; a changed selected set does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "iv2-reuse-"));
  try {
    const tree = { status: "known" as const, treeId: "a".repeat(40) };
    const environment = await fingerprintChildEnvironment({ environment: {}, executable: process.execPath, cwd: root });
    const context = { requiredLifecycleScope: "process_group", implementationDigest: "b".repeat(64), configDigest: "c".repeat(64) };
    const selected = { executable: process.execPath, arguments: ["npm-cli.js", "run", "test", "--", "packages/a/test/a.test.mjs"], workingDirectory: root, timeoutMs: 1000 };
    const key = commandReuseKey(selected, tree, environment, context);
    assert.ok(key);
    assert.equal(commandReuseKey({ ...selected }, { ...tree }, environment, context), key);
    const changedSet = { ...selected, arguments: ["npm-cli.js", "run", "test", "--", "packages/a/test/other.test.mjs"] };
    assert.notEqual(commandReuseKey(changedSet, tree, environment, context), key);
    const full = { ...selected, arguments: ["npm-cli.js", "run", "test"] };
    assert.notEqual(commandReuseKey(full, tree, environment, context), key);
    // Through the real SQLite reuse lookup: same selected tuple reuses, a changed set misses.
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    try {
      const stdout = await artifacts.put(Buffer.from("tests 1\npass 1\n"), "text/plain");
      const stderr = await artifacts.put(Buffer.alloc(0), "text/plain");
      const startedAt = "2026-10-05T00:00:00.000Z";
      const finishedAt = "2026-10-05T00:00:01.000Z";
      const fact: CommandEvidenceFact = {
        kind: "command", label: "selected tests", command: selected.executable, args: [...selected.arguments],
        cwd: root, startedAt, finishedAt, exitCode: 0, signal: null, timedOut: false, cancelled: false,
        outputTruncated: false, outputLossy: false, cleanup: { state: "verified_empty", verifiedAt: finishedAt },
        workingTreeIdentity: tree, childEnvironmentIdentity: environment,
        stdoutArtifactHash: stdout.hash, stderrArtifactHash: stderr.hash,
        executionSnapshot: {
          key: key!,
          process: {
            logicalProcessId: "iv2-selected-reuse", outcome: "exited", exitCode: 0, startedAt, finishedAt,
            cleanup: { state: "verified_empty", verifiedAt: finishedAt },
            output: [
              { stream: "stdout", tail: "tests 1\npass 1\n", totalBytes: 15, truncated: false, spillBytes: 0, lossyBytes: 0 },
              { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            ],
          },
        },
      };
      const record = store.record({ runId: "run", taskId: "task", actor: { role: "worker", id: "worker" }, fact, createdAt: finishedAt, idempotencyKey: "original" });
      assert.equal((await findReusableCommand(store, artifacts, "run", key!))?.id, record.id);
      assert.equal(await findReusableCommand(store, artifacts, "run", commandReuseKey(changedSet, tree, environment, context)!), undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2 F1: a selected test beginning with - is never forwarded as argv (fail safe to full)", () => {
  const root = checkoutWithScript("node --test");
  const pytestRoot = checkoutWithScript("pytest");
  const directRoot = mkdtempSync(join(tmpdir(), "iv2-dash-"));
  try {
    for (const selectedTests of [["--evil.mjs"], ["-e", "t/a.py"]] as const) {
      const paths = [...selectedTests];
      const node = deriveSelectedTestsCommand({
        checkoutPath: directRoot,
        command: { label: "direct", executable: "/usr/bin/node", args: ["--test"] },
        selectedTests: paths,
      });
      assert.ok(!node.selectable, `direct node ${paths}`);
      const pytest = deriveSelectedTestsCommand({
        checkoutPath: directRoot,
        command: { label: "direct", executable: "pytest", args: [] },
        selectedTests: paths,
      });
      assert.ok(!pytest.selectable, `direct pytest ${paths}`);
      const npm = deriveSelectedTestsCommand({
        checkoutPath: root,
        command: packageCommand(["/x/npm-cli.js", "run", "test"]),
        selectedTests: paths,
      });
      assert.ok(!npm.selectable, `npm package ${paths}`);
      const pytestNpm = deriveSelectedTestsCommand({
        checkoutPath: pytestRoot,
        command: packageCommand(["/x/npm-cli.js", "run", "test"]),
        selectedTests: paths,
      });
      assert.ok(!pytestNpm.selectable, `npm pytest package ${paths}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(pytestRoot, { recursive: true, force: true });
    rmSync(directRoot, { recursive: true, force: true });
  }
});

test("IV-2 F1: only supported npm/pnpm/yarn invocations take the package path; unknown run test shapes fail safe", () => {
  const root = checkoutWithScript("node --test");
  try {
    const selectedTests = ["test/a.test.mjs"];
    // Unknown or direct commands carrying `run test` are not
    // package-manager invocations and must fail safe to the whole script,
    // even with a narrowable test script on disk.
    for (const executable of ["evil-runner", "npm", "npx", "/usr/local/bin/yarn", "node"]) {
      const refused = deriveSelectedTestsCommand({
        checkoutPath: root,
        command: { label: "package tests", executable, args: ["run", "test"] },
        selectedTests,
      });
      assert.ok(!refused.selectable, executable);
      assert.match(refused.reason, /not a supported npm\/pnpm\/yarn invocation|no safe file-path selection/);
    }
    // node without a supported CLI entry is not a package invocation either.
    const bare = deriveSelectedTestsCommand({
      checkoutPath: root,
      command: packageCommand(["run", "test"]),
      selectedTests,
    });
    assert.ok(!bare.selectable);
    // npx-cli.js does not implement npm-script semantics; it fails safe too.
    const npxCli = deriveSelectedTestsCommand({
      checkoutPath: root,
      command: packageCommand(["/x/npx-cli.js", "run", "test"]),
      selectedTests,
    });
    assert.ok(!npxCli.selectable);
    // The supported profile shapes still narrow.
    for (const cli of ["/x/npm-cli.js", "C:\\node\\npm-cli.js", "/corepack/pnpm.js", "pnpm.cjs", "/corepack/yarn.js"]) {
      const allowed = deriveSelectedTestsCommand({
        checkoutPath: root,
        command: packageCommand([cli, "run", "test"]),
        selectedTests,
      });
      assert.ok(allowed.selectable, cli);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IV-2 F4: a tests exit check backed only by selected boundaries stays not-ready", () => {
  const revision = "r".repeat(40);
  const selectedBoundary = {
    taskId: "T1",
    boundaryId: "boundary:T1:1",
    generation: 1,
    attempt: 1,
    integrationRevision: revision,
    changedFiles: ["src/a.ts"],
    executedScope: "selected",
    selection: { rung: "module_graph", selectedTests: ["t/a.mjs"], widened: false, wideningReasons: [] },
    checks: [
      { checkId: "build", evidenceIds: ["e1"], exitCode: 0, outcome: "passed" },
      { checkId: "tests", command: "npm", args: ["run", "test", "--", "t/a.mjs"], evidenceIds: ["e2"], exitCode: 0, outcome: "passed" },
    ],
    passed: true,
    sequence: 9,
  } as unknown as DeliveryBoundaryScope;
  const input = {
    phase: { id: "P1", requirementIds: ["REQ-1"], contributingTaskIds: ["T1"], requiredCombinedValidation: ["tests"] },
    requirements: [{ id: "REQ-1", contributingTaskIds: ["T1"], applicability: { status: "applicable" } }],
    taskStatuses: new Map([["T1", "integrated"]]),
    state: {
      taskAcceptances: { T1: { taskId: "T1" } },
      boundaries: { T1: [selectedBoundary] },
    },
    integrationRevision: revision,
  } as unknown as PhaseAcceptanceInputs;
  const selectedOnly = evaluatePhaseAcceptance(input);
  assert.equal(selectedOnly.ready, false, "a selected tests run cannot satisfy a milestone exit check");
  assert.match(selectedOnly.issues.join(" "), /no passed tests run/);
  const fullBoundary = { ...selectedBoundary, executedScope: "full_test_script" } as DeliveryBoundaryScope;
  const full = evaluatePhaseAcceptance({
    ...input,
    state: { ...input.state, boundaries: { T1: [fullBoundary] } },
  } as unknown as PhaseAcceptanceInputs);
  assert.equal(full.ready, true);
  assert.deepEqual(full.exitChecks, [{ validation: "tests", checkId: "tests", boundaryId: "boundary:T1:1" }]);
});

test("IV-2 F4: the phase-close helper fires only for the last task of a tests-gated phase", () => {
  const projectionFor = (options: {
    accepted?: string[];
    validations?: string[];
    phaseAccepted?: boolean;
    readiness?: string;
    conditionalPending?: boolean;
  }) => ({
    planningPolicyVersion: 1,
    planning: {
      readiness: options.readiness ?? "ready",
      plan: {
        currentRevisionId: "revision_1",
        currentDigest: "d".repeat(64),
        revisionsById: {
          revision_1: {
            revisionId: "revision_1",
            phases: [{
              id: "BP1",
              requirementIds: ["REQ-MANDATORY", "REQ-COMPAT", "REQ-SECURITY"],
              contributingTaskIds: ["T1", "T2", "T4"],
              requiredCombinedValidation: options.validations ?? ["typecheck", "targeted-tests"],
            }],
            requirements: [
              { id: "REQ-MANDATORY", contributingTaskIds: ["T1"], applicability: { status: "applicable" } },
              { id: "REQ-COMPAT", contributingTaskIds: ["T2"], applicability: { status: options.conditionalPending === true ? "conditional_pending" : "applicable" } },
              { id: "REQ-SECURITY", contributingTaskIds: ["T4"], applicability: { status: "applicable" } },
            ],
          },
        },
      },
    },
    tasks: {
      T1: { status: "integrated" },
      T2: { status: "integrated" },
      T4: { status: "integrated" },
    },
    delivery: {
      taskAcceptances: Object.fromEntries((options.accepted ?? []).map((id): [string, { taskId: string }] => [id, { taskId: id }])),
      phaseAcceptances: options.phaseAccepted === true ? { "revision_1:BP1": { phaseId: "BP1" } } : {},
    },
  });
  // Ordinary tasks with outstanding contributors never force full.
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({}), taskId: "T1" }), false);
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1"] }), taskId: "T2" }), false);
  // The last outstanding contributor of a tests-gated phase forces full.
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"] }), taskId: "T4" }), true);
  // No tests gate, no forcing — even for the last contributor.
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"], validations: ["typecheck"] }), taskId: "T4" }), false);
  // An already-accepted phase, a non-contributor, an unready plan, and a
  // blocked requirement never force full.
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"], phaseAccepted: true }), taskId: "T4" }), false);
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"] }), taskId: "T9" }), false);
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"], readiness: "draft" }), taskId: "T4" }), false);
  assert.equal(boundaryWouldClosePhaseWithTestsGate({ projection: projectionFor({ accepted: ["T1", "T2"], conditionalPending: true }), taskId: "T4" }), false);
});

test("IV-2: final verification stays full — the final runtime path cannot import selection derivation", () => {
  const runtimeSource = readFileSync(new URL("../src/final-verification-runtime.ts", import.meta.url), "utf8");
  assert.ok(!runtimeSource.includes("deriveSelectedTestsCommand"), "final verification never derives selective commands");
  assert.ok(!runtimeSource.includes("task-validation-policy"), "final verification keeps its own full mandate");
  const profile: FinalVerificationExecutionProfile = {
    version: 1,
    targetRevision: "t",
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "tests", source: "package.json#scripts.test", detail: "node --test" }],
    commands: { tests: [{ label: "package tests", executable: process.execPath, args: ["/x/npm-cli.js", "run", "test"] }] },
  };
  const root = checkoutWithScript("node --test");
  try {
    const before = structuredClone(profile);
    const derived = deriveSelectedTestsCommand({
      checkoutPath: root,
      command: profile.commands.tests![0]!,
      selectedTests: ["test/a.test.mjs"],
    });
    assert.ok(derived.selectable);
    assert.deepEqual(profile, before, "derivation leaves the full profile untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
