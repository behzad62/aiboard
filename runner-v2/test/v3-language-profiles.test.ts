import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { mock } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";

import {
  detectLanguageFamilies,
  languageReportDescriptors,
  languageReportFileName,
  languageReportFormat,
  listLanguageInventoryFiles,
  planLanguageTestReport,
  scanMavenSurefireReportFiles,
} from "../src/language-execution-profile.js";
import { planTestReport, runDeliveryCategory } from "../src/delivery-execution.js";
import { aggregateJUnitReportSet, outcomeFromReportReading, readBoundedReportBytes, readJUnitReport, readTrxReport } from "../src/test-report-readers.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { junitReportFileName } from "../src/final-verification-runtime.js";
import type { OneShotCommandExecutor, OneShotCommandResult } from "../src/one-shot-command-executor.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { testsOutcome } from "../src/delivery-acceptance.js";
import {
  assertFinalVerificationExecutionProfile,
  cloneFinalVerificationExecutionProfile,
  finalVerificationProfileDigest,
  inspectFinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { inspectTestIntegrityPin } from "../src/test-integrity-profile.js";
import { assertNoConfiguredTestSuite, knownTestSuitePath, testIntegrityPinDigest, testIntegrityProfileFindings } from "../src/test-integrity.js";
import { captureGitBaseline, FinalVerificationRuntime, IntegrationManager, runGit, VerificationWorkspaceManager } from "./support/git-fixture.js";

// V3 (AR-R26): language-neutral execution profiles for non-package.json
// projects. Detection is file-identity based; `unknown` only when nothing
// applies; a detected family with a missing SDK or missing/malformed
// report stays detected and fails closed (never a clean no-test
// inventory). Only V3-own fixtures run here.

const CSPROJ_TEST = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.9.3" />
  </ItemGroup>
</Project>
`;
const CSPROJ_LIB = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`;
const CMAKE_TESTS = `cmake_minimum_required(VERSION 3.20)
project(fixture NONE)
enable_testing()
add_test(NAME echo COMMAND \${CMAKE_COMMAND} -E echo hi)
`;
const CMAKE_LIB = `cmake_minimum_required(VERSION 3.20)
project(fixture NONE)
`;
const PYTEST_INI = `[pytest]
testpaths = tests
`;
const PYPROJECT_PYTEST = `[project]
name = "fixture"
[tool.pytest.ini_options]
testpaths = ["tests"]
`;
const PYPROJECT_BARE = `[project]
name = "fixture"
`;
const POM = `<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>`;
const GRADLE = `plugins { id 'java' }
`;
const CARGO = `[package]
name = "c"
version = "0.1.0"
`;
const GOMOD = `module example.com/fixture

go 1.22
`;

test("V3 detects the dotnet family with TRX tests only for a test project", () => {
  const files = ["Calc.Tests.csproj", "Calc.Tests.cs", "Calc.cs"];
  const read = (path: string) => (path === "Calc.Tests.csproj" ? CSPROJ_TEST : undefined);
  const [detection] = detectLanguageFamilies({ files, readFile: read });
  assert.equal(detection?.family, "dotnet");
  assert.equal(detection?.source, "Calc.Tests.csproj");
  assert.deepEqual(detection?.build, [{ label: "dotnet build", executable: "dotnet", args: ["build", "Calc.Tests.csproj", "--disable-build-servers"] }]);
  assert.deepEqual(detection?.tests, { label: "dotnet test", executable: "dotnet", args: ["test", "Calc.Tests.csproj", "--disable-build-servers"] });
  assert.deepEqual(languageReportDescriptors([detection!]), [
    { commandLabel: "dotnet test", runner: "dotnet test", format: "trx" },
  ]);
});

test("V3 detects dotnet build without tests for a library project", () => {
  const [detection] = detectLanguageFamilies({ files: ["Lib.csproj"], readFile: () => CSPROJ_LIB });
  assert.equal(detection?.family, "dotnet");
  assert.ok(detection?.build);
  assert.equal(detection?.tests, undefined);
  assert.deepEqual(languageReportDescriptors([detection!]), []);
});

test("V3 detects cmake with ctest only when tests are defined", () => {
  const withTests = detectLanguageFamilies({ files: ["CMakeLists.txt"], readFile: () => CMAKE_TESTS });
  assert.equal(withTests[0]?.family, "cmake");
  assert.deepEqual(withTests[0]?.build?.map((command) => command.label), ["cmake configure", "cmake build"]);
  assert.deepEqual(withTests[0]?.tests, { label: "ctest", executable: "ctest", args: ["--test-dir", ".aiboard-cmake-build"] });
  const libOnly = detectLanguageFamilies({ files: ["CMakeLists.txt"], readFile: () => CMAKE_LIB });
  assert.ok(libOnly[0]?.build);
  assert.equal(libOnly[0]?.tests, undefined);
});

test("V3 detects pytest from ini, toml section, and conftest; bare pyproject is not a signal", () => {
  for (const marker of ["pytest.ini", "tox.ini", "setup.cfg", "conftest.py"]) {
    const [detection] = detectLanguageFamilies({ files: [marker], readFile: () => "" });
    assert.equal(detection?.family, "pytest", marker);
    assert.deepEqual(detection?.tests, { label: "pytest", executable: "pytest", args: [] });
    assert.equal(detection?.build, undefined);
  }
  const [toml] = detectLanguageFamilies({ files: ["pyproject.toml"], readFile: () => PYPROJECT_PYTEST });
  assert.equal(toml?.family, "pytest");
  assert.deepEqual(detectLanguageFamilies({ files: ["pyproject.toml"], readFile: () => PYPROJECT_BARE }), []);
});

test("V3 detects maven with a wired report set; gradle, cargo, and go stay unsupported", () => {
  const detections = detectLanguageFamilies({
    files: ["pom.xml", "build.gradle", "Cargo.toml", "go.mod"],
    readFile: () => "",
  });
  assert.deepEqual(detections.map((detection) => detection.family), ["maven", "gradle", "cargo", "go"]);
  for (const detection of detections) {
    assert.ok(detection.build?.length, detection.family);
    assert.ok(detection.tests, detection.family);
  }
  assert.deepEqual(languageReportDescriptors(detections), [
    { commandLabel: "maven test", runner: "maven test", format: "junit" },
  ], "only the qualified maven collector is wired");
});

test("V3 detects nothing for an unknown-language project", () => {
  assert.deepEqual(detectLanguageFamilies({ files: ["README.md", "notes.txt"], readFile: () => "" }), []);
});

test("V3 pytest plan appends --junitxml and reuses an owned existing flag", () => {
  const fresh = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "pytest", executable: "pytest", args: [] },
    reportName: "abc",
  });
  assert.equal(fresh?.runner, "pytest");
  assert.equal(fresh?.format, "junit");
  assert.equal(fresh?.reportPath, ".aiboard-report-abc.xml");
  assert.deepEqual(fresh?.command?.args, ["--junitxml=.aiboard-report-abc.xml"]);
  const existing = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "pytest", executable: "pytest", args: ["--junitxml=owned.xml"] },
    reportName: "abc",
  });
  assert.equal(existing?.command, undefined, "an owned flag is reused, never rewritten");
  assert.equal(existing?.reportPath, "owned.xml");
  const outside = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "pytest", executable: "pytest", args: ["--junitxml=C:/other/out.xml"] },
    reportName: "abc",
  });
  assert.ok(outside?.unsupported, "a flag outside the owned workspace cannot be read");
  assert.equal(outside?.reportPath, undefined);
});

test("V3 python -m pytest plans; bare python does not", () => {
  const planned = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "pytest", executable: "python", args: ["-m", "pytest", "tests"] },
    reportName: "abc",
  });
  assert.equal(planned?.runner, "pytest");
  assert.deepEqual(planned?.command?.args.slice(0, 3), ["-m", "pytest", "tests"]);
  assert.equal(planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "run", executable: "python", args: ["script.py"] },
    reportName: "abc",
  }), undefined);
});

test("V3 dotnet plan appends an absolute TRX logger under the owned checkout", () => {
  const fresh = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] },
    reportName: "abc",
  });
  assert.equal(fresh?.runner, "dotnet test");
  assert.equal(fresh?.format, "trx");
  assert.equal(fresh?.reportPath, ".aiboard-report-abc.trx");
  assert.deepEqual(fresh?.command?.args, ["test", "--disable-build-servers", "--logger", "trx;LogFileName=C:/repo/.aiboard-report-abc.trx"]);
  const foreign = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "dotnet test", executable: "dotnet", args: ["test", "--logger", "console"] },
    reportName: "abc",
  });
  assert.ok(foreign?.unsupported, "a foreign logger cannot be read as TRX");
});

test("V3 ctest plan appends --output-junit and reuses an owned path", () => {
  const fresh = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "ctest", executable: "ctest", args: ["--test-dir", ".aiboard-cmake-build"] },
    reportName: "abc",
  });
  assert.equal(fresh?.runner, "ctest");
  assert.deepEqual(fresh?.command?.args.slice(-2), ["--output-junit", ".aiboard-report-abc.xml"]);
  const existing = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "ctest", executable: "ctest", args: ["--test-dir", "b", "--output-junit", "owned.xml"] },
    reportName: "abc",
  });
  assert.equal(existing?.command, undefined);
  assert.equal(existing?.reportPath, "owned.xml");
});

test("V3 maven plans an invocation-owned report set; gradle, cargo, and go stay unsupported", () => {
  const maven = planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
    reportName: "abc",
  });
  assert.equal(maven?.runner, "maven test");
  assert.equal(maven?.format, "junit");
  assert.deepEqual(maven?.reportSet, { kind: "maven-surefire-reports" });
  assert.equal(maven?.command, undefined, "surefire needs no appended flag");
  assert.equal(maven?.unsupported, undefined);
  for (const [executable, args, runner] of [
    ["gradle", ["test"], "gradle test"],
    ["cargo", ["test"], "cargo test"],
    ["go", ["test", "./..."], "go test"],
  ] as const) {
    const plan = planLanguageTestReport({
      checkoutPath: "C:/repo",
      command: { label: `${executable} tests`, executable, args: [...args] },
      reportName: "abc",
    });
    assert.equal(plan?.runner, runner);
    assert.ok(plan?.unsupported, runner);
    assert.equal(plan?.reportPath, undefined, `${runner}: no path, no counts`);
  }
  assert.equal(planLanguageTestReport({
    checkoutPath: "C:/repo",
    command: { label: "node tests", executable: "node", args: ["--test"] },
    reportName: "abc",
  }), undefined, "non-family commands are untouched");
});

test("V3 report filenames are bounded, owned, and format-typed", () => {
  assert.equal(languageReportFileName("abc", "junit"), ".aiboard-report-abc.xml");
  assert.equal(languageReportFileName("abc", "trx"), ".aiboard-report-abc.trx");
  assert.equal(languageReportFormat("pytest"), "junit");
  assert.equal(languageReportFormat("dotnet test"), "trx");
  assert.equal(languageReportFormat("ctest"), "junit");
  assert.equal(languageReportFormat("go test"), undefined);
});

const SUREFIRE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="3" failures="1" errors="0" skipped="1">
  <testcase classname="CalcTest" name="adds"/>
  <testcase classname="CalcTest" name="fails"><failure message="nope">trace</failure></testcase>
  <testcase classname="CalcTest" name="skips"><skipped/></testcase>
</testsuite>
`;
const CTEST_JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="3" failures="0" errors="0" skipped="1">
  <testcase name="t1"/>
  <testcase name="t2" status="notrun"><skipped/></testcase>
  <testcase name="t3"/>
</testsuite>
`;
const PYTEST_JUNIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuite tests="2" failures="0" errors="0" skipped="0">
  <testcase classname="test_calc" name="test_add"/>
  <testcase classname="test_calc" name="test_sub"/>
</testsuite>
`;
const TRX_FAILED = `<TestRun>
  <ResultSummary outcome="Failed">
    <Counters total="2" executed="2" passed="1" failed="1" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>
`;
const TRX_NOTHING_RAN = `<TestRun>
  <ResultSummary outcome="Completed">
    <Counters total="0" executed="0" passed="0" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>
`;

test("V3 readers count Maven surefire, ctest, and pytest JUnit shapes honestly", () => {
  assert.deepEqual(readJUnitReport(SUREFIRE_XML), {
    status: "ok", counts: { selected: 3, passed: 1, failed: 1, skipped: 1 },
  });
  assert.deepEqual(outcomeFromReportReading(readJUnitReport(SUREFIRE_XML)).outcome, "failed");
  assert.deepEqual(readJUnitReport(CTEST_JUNIT_XML), {
    status: "ok", counts: { selected: 3, passed: 2, failed: 0, skipped: 1 },
  });
  assert.deepEqual(outcomeFromReportReading(readJUnitReport(PYTEST_JUNIT_XML)).outcome, "passed");
});

test("V3 TRX reader counts a real failing run and refuses a nothing-ran report", () => {
  assert.deepEqual(readTrxReport(TRX_FAILED), {
    status: "ok", counts: { selected: 2, passed: 1, failed: 1, skipped: 0 },
  });
  assert.deepEqual(outcomeFromReportReading(readTrxReport(TRX_FAILED)).outcome, "failed");
  const nothing = readTrxReport(TRX_NOTHING_RAN);
  assert.equal(nothing.status, "unknown");
  assert.deepEqual(outcomeFromReportReading(nothing).outcome, "unknown");
});

test("V3 malformed reports and exit-only evidence never mint counts", () => {
  assert.equal(readJUnitReport("<testsuite><testcase>").status, "unknown", "truncated");
  assert.equal(readJUnitReport("").status, "unknown", "empty");
  assert.equal(readTrxReport(null).status, "unknown", "missing");
  assert.equal(testsOutcome(0, undefined), "unknown", "exit 0 without this run's report proves nothing");
  assert.equal(testsOutcome(null, undefined), "unknown", "missing SDK-launch evidence proves nothing");
  assert.equal(testsOutcome(1, undefined), "failed", "non-zero exit is failed, never counted");
});

test("V3 boundary planner wires family commands without a package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-v3-plan-"));
  try {
    const pytest = planTestReport({
      checkoutPath: root,
      command: { label: "pytest", executable: "pytest", args: [] },
      reportName: "v3plan",
    });
    assert.equal(pytest.runner, "pytest");
    assert.equal(pytest.format, "junit");
    assert.deepEqual(pytest.command?.args, ["--junitxml=.aiboard-report-v3plan.xml"]);
    const maven = planTestReport({
      checkoutPath: root,
      command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      reportName: "v3plan",
    });
    assert.equal(maven.runner, "maven test");
    assert.deepEqual(maven.reportSet, { kind: "maven-surefire-reports" });
    assert.equal(maven.command, undefined);
    const unknown = planTestReport({
      checkoutPath: root,
      command: { label: "make", executable: "make", args: ["test"] },
      reportName: "v3plan",
    });
    assert.equal(unknown.runner, "unknown", "no family and no package.json stays unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function v3WriteFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

async function v3Repo(files: Record<string, string>): Promise<{ root: string; revision: string }> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-v3-profile-"));
  await v3WriteFiles(root, files);
  await runGit({ cwd: root, args: ["init", "-b", "main"] });
  await runGit({ cwd: root, args: ["add", "-A"] });
  await runGit({ cwd: root, args: ["commit", "-m", "v3 fixture"] });
  const revision = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
  return { root, revision };
}

test("V3 profile inspects a dotnet project into exact commands and a trusted TRX descriptor", async () => {
  const outer = mkdtempSync(join(tmpdir(), "aiboard-v3-outer-"));
  const root = join(outer, "project");
  const state = join(outer, "state");
  mkdirSync(root, { recursive: true });
  mkdirSync(state, { recursive: true });
  await v3WriteFiles(root, { "Calc.Tests.csproj": CSPROJ_TEST, "Calc.Tests.cs": "using Xunit;\n" });
  const runId = "v3-dotnet-profile";
  try {
    const baseline = await captureGitBaseline({ projectPath: root, stateDirectory: state, runId });
    const integration = new IntegrationManager({ repositoryRoot: root, stateDirectory: state, runId, baselineRevision: baseline.revision });
    await integration.initialize();
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: integration.path,
      targetRevision: integration.revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands.build, [
      { label: "dotnet build", executable: "dotnet", args: ["build", "Calc.Tests.csproj", "--disable-build-servers"] },
    ]);
    assert.deepEqual(profile.commands.tests, [
      { label: "dotnet test", executable: "dotnet", args: ["test", "Calc.Tests.csproj", "--disable-build-servers"] },
    ]);
    assert.ok(profile.detectedSignals.some((signal) => signal.category === "tests" && signal.source === "Calc.Tests.csproj"));
    assert.ok(profile.inspectedPaths.includes("Calc.Tests.csproj"));
    assert.deepEqual(profile.reports, [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }]);
    const clone = cloneFinalVerificationExecutionProfile(profile);
    assert.deepEqual(clone, profile, "clone preserves the additive descriptor");
    assert.equal(finalVerificationProfileDigest(runId, clone), finalVerificationProfileDigest(runId, profile));
    const tampered = cloneFinalVerificationExecutionProfile(profile);
    tampered.reports = [{ commandLabel: "dotnet test", runner: "pytest", format: "trx" }];
    assert.throws(() => assertFinalVerificationExecutionProfile(tampered, profile.targetRevision), /descriptor/i);
    const relabeled = cloneFinalVerificationExecutionProfile(profile);
    relabeled.reports = [{ commandLabel: "nope", runner: "dotnet test", format: "trx" }];
    assert.throws(() => assertFinalVerificationExecutionProfile(relabeled, profile.targetRevision), /unknown tests command/);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("V3 profile leaves an unknown-language project without commands or descriptors", async () => {
  const { root, revision } = await v3Repo({ "README.md": "# fixture\n", "notes.txt": "plans\n" });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands, {});
    assert.deepEqual(profile.detectedSignals, []);
    assert.equal(profile.reports, undefined);
    assert.equal(profile.provisioning, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 profile keeps package.json authority when a manifest script exists", async () => {
  const { root, revision } = await v3Repo({
    "package.json": JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "node --test" } }),
    "package-lock.json": JSON.stringify({ name: "v3", lockfileVersion: 3, packages: {} }),
    "pytest.ini": PYTEST_INI,
  });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands.tests?.map((command) => command.label), ["package tests"]);
    assert.equal(profile.reports, undefined, "no family descriptor shadows the package command");
    assert.ok(!profile.detectedSignals.some((signal) => signal.source === "pytest.ini"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin covers the csproj identity and trips on its rewrite", async () => {
  const { root, revision } = await v3Repo({ "Calc.Tests.csproj": CSPROJ_TEST, "Calc.Tests.cs": "using Xunit;\n" });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    assert.ok(pin.configDigest.length === 64);
    writeFileSync(join(root, "Calc.Tests.csproj"), CSPROJ_TEST.replace("net10.0", "net9.0"));
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "retarget"] });
    const candidateRevision = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: candidateRevision, commands: [] });
    assert.ok(testIntegrityProfileFindings(pin, candidate).some((finding) => finding.code === "test_config_changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// V3 initial-review repairs (F1-F6). Boundary- and pin-facing regressions:
// helpers are exercised through the production profile, runtime, delivery,
// and pin entry points, never only as pure units.
// ---------------------------------------------------------------------------

const JUNIT_FAIL_1P1F = `<?xml version="1.0" encoding="utf-8"?>
<testsuite tests="2" failures="1" errors="0" skipped="0">
  <testcase classname="test_calc" name="test_add"/>
  <testcase classname="test_calc" name="test_sub"><failure message="nope">trace</failure></testcase>
</testsuite>
`;
const TRX_PASS = `<TestRun>
  <ResultSummary outcome="Completed">
    <Counters total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>
`;
const SUREFIRE_PASS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="2" failures="0" errors="0" skipped="0">
  <testcase classname="CalcTest" name="adds"/>
  <testcase classname="CalcTest" name="subtracts"/>
</testsuite>
`;

async function v3WriteTempFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

// ---- F1: the Maven Surefire fresh report-set collector ----

test("V3 maven scan collects only the invocation-owned fresh report set", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-v3-surefire-"));
  try {
    await v3WriteTempFiles(checkout, {
      "module-a/target/surefire-reports/TEST-a.xml": SUREFIRE_PASS,
      "module-a/target/surefire-reports/output.txt": "not xml",
      "module-a/target/surefire-reports/nested/TEST-deep.xml": SUREFIRE_PASS,
    });
    const before = (await scanMavenSurefireReportFiles({ checkoutPath: checkout })).snapshot;
    assert.equal(before.size, 1, "only flat *.xml reports snapshot; text and nested files are ignored");
    await v3WriteTempFiles(checkout, {
      "services/api/target/surefire-reports/TEST-b.xml": SUREFIRE_PASS,
      "module-a/target/surefire-reports/TEST-a2.xml": SUREFIRE_PASS,
    });
    const after = await scanMavenSurefireReportFiles({ checkoutPath: checkout, before });
    assert.deepEqual(after.fresh, [
      "module-a/target/surefire-reports/TEST-a2.xml",
      "services/api/target/surefire-reports/TEST-b.xml",
    ]);
    assert.equal(after.incomplete, false);
    const steady = await scanMavenSurefireReportFiles({ checkoutPath: checkout, before: after.snapshot });
    assert.deepEqual(steady.fresh, [], "an unchanged set collects nothing fresh");
    assert.equal(steady.incomplete, false);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("V3 maven scan flags truncation and failures instead of a partial set", async () => {
  const throwing = await scanMavenSurefireReportFiles({
    checkoutPath: "C:/repo",
    readdir: async () => { throw new Error("denied"); },
  });
  assert.equal(throwing.incomplete, true);
  assert.deepEqual(throwing.fresh, []);
  const many = Array.from({ length: 300 }, (_, index) => `TEST-${index}.xml`);
  const capped = await scanMavenSurefireReportFiles({
    checkoutPath: "C:/repo",
    before: new Map(),
    readdir: async (path) => {
      if (path === "C:/repo") return [{ name: "target", isDirectory: true, isSymbolicLink: false }];
      if (path === "C:/repo/target") return [{ name: "surefire-reports", isDirectory: true, isSymbolicLink: false }];
      return many.map((name) => ({ name, isDirectory: false, isSymbolicLink: false }));
    },
    stat: async () => ({ size: 100, mtimeMs: 1, isRegularFile: true }),
  });
  assert.equal(capped.incomplete, true, "the file cap is carried, not silently applied");
  assert.ok(capped.fresh.length <= 256);
});

test("V3 JUnit set aggregation sums honestly and refuses partial sets", () => {
  const pass = readJUnitReport(SUREFIRE_PASS);
  const mixed = readJUnitReport(SUREFIRE_XML);
  assert.deepEqual(aggregateJUnitReportSet([pass, mixed]), {
    status: "ok", counts: { selected: 5, passed: 3, failed: 1, skipped: 1 },
  });
  assert.equal(aggregateJUnitReportSet([]).status, "unknown", "empty set");
  assert.equal(aggregateJUnitReportSet([pass, readJUnitReport("<testsuite><testcase>")]).status, "unknown", "malformed member");
  assert.equal(aggregateJUnitReportSet([pass, readTrxReport(TRX_NOTHING_RAN)]).status, "unknown", "foreign shape member");
});

// ---- F5: ambiguous multi-result .NET execution never looks single-result ----

test("V3 several .NET test projects stay detected but ambiguous without a descriptor", () => {
  const [detection] = detectLanguageFamilies({
    files: ["A.Tests.csproj", "B.Tests.csproj", "A.Tests.cs", "B.Tests.cs"],
    readFile: () => CSPROJ_TEST,
  });
  assert.equal(detection?.family, "dotnet");
  assert.deepEqual(detection?.tests, { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] });
  assert.match(detection?.testsAmbiguous ?? "", /several/i);
  assert.deepEqual(languageReportDescriptors([detection!]), [], "no single-result descriptor for a shared TRX file");
});

test("V3 solution-only and multi-target .NET runs stay ambiguous", () => {
  const [solution] = detectLanguageFamilies({ files: ["App.sln"], readFile: () => undefined });
  assert.equal(solution?.family, "dotnet");
  assert.ok(solution?.tests, "solution-only keeps a detected tests state, never no-suite");
  assert.match(solution?.testsAmbiguous ?? "", /solution-only/);
  assert.deepEqual(languageReportDescriptors([solution!]), []);
  const multiTarget = CSPROJ_TEST.replace("<TargetFramework>net10.0</TargetFramework>", "<TargetFrameworks>net9.0;net10.0</TargetFrameworks>");
  const [targeted] = detectLanguageFamilies({
    files: ["Calc.Tests.csproj"],
    readFile: () => multiTarget,
  });
  assert.deepEqual(targeted?.tests, { label: "dotnet test", executable: "dotnet", args: ["test", "Calc.Tests.csproj", "--disable-build-servers"] });
  assert.match(targeted?.testsAmbiguous ?? "", /several frameworks/);
  assert.deepEqual(languageReportDescriptors([targeted!]), []);
});

test("V3 profile keeps ambiguous multi-project tests without a descriptor", async () => {
  const { root, revision } = await v3Repo({ "A.Tests.csproj": CSPROJ_TEST, "B.Tests.csproj": CSPROJ_TEST });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands.tests, [
      { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] },
    ]);
    assert.equal(profile.reports, undefined, "ambiguity issues no descriptor");
    assert.ok(profile.detectedSignals.some((signal) => signal.category === "tests"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 unreadable marker contents keep tests uncertain instead of absent", () => {
  const [dotnet] = detectLanguageFamilies({
    files: ["Lib.csproj"],
    readFile: () => undefined,
    unreadable: ["Lib.csproj"],
  });
  assert.ok(dotnet?.tests, "an unreadable project cannot prove it defines no tests");
  assert.match(dotnet?.testsAmbiguous ?? "", /unreadable/);
  assert.deepEqual(languageReportDescriptors([dotnet!]), []);
  const [cmake] = detectLanguageFamilies({
    files: ["CMakeLists.txt"],
    readFile: () => undefined,
    unreadable: ["CMakeLists.txt"],
  });
  assert.deepEqual(cmake?.tests, { label: "ctest", executable: "ctest", args: ["--test-dir", ".aiboard-cmake-build"] });
  assert.match(cmake?.testsAmbiguous ?? "", /unreadable/);
  assert.deepEqual(languageReportDescriptors([cmake!]), []);
  const [pytest] = detectLanguageFamilies({
    files: ["pyproject.toml"],
    readFile: () => undefined,
    unreadable: ["pyproject.toml"],
  });
  assert.equal(pytest?.family, "pytest");
  assert.match(pytest?.testsAmbiguous ?? "", /unreadable/);
  assert.deepEqual(languageReportDescriptors([pytest!]), []);
});

// ---- F2: incomplete inspection is carried explicitly and fails closed ----

test("V3 inventory walk reports readdir failures and the file cap explicitly", async () => {
  const failed = await listLanguageInventoryFiles({
    repositoryRoot: "C:/repo",
    readdir: async (path) => {
      if (path === "C:/repo/blocked") throw new Error("denied");
      return [
        { name: "pom.xml", isDirectory: false, isSymbolicLink: false },
        { name: "blocked", isDirectory: true, isSymbolicLink: false },
      ];
    },
  });
  assert.deepEqual(failed.files, ["pom.xml"]);
  assert.equal(failed.incomplete, true);
  const many = Array.from({ length: 4001 }, (_, index) => ({ name: `f${index}.txt`, isDirectory: false, isSymbolicLink: false }));
  const capped = await listLanguageInventoryFiles({
    repositoryRoot: "C:/repo",
    readdir: async () => many,
  });
  assert.equal(capped.files.length, 4000);
  assert.equal(capped.incomplete, true);
  const clean = await listLanguageInventoryFiles({
    repositoryRoot: "C:/repo",
    readdir: async () => [{ name: "README.md", isDirectory: false, isSymbolicLink: false }],
  });
  assert.deepEqual(clean.files, ["README.md"]);
  assert.equal(clean.incomplete, false);
});

test("V3 inventory walk reports depth truncation explicitly", async () => {
  const depth = 12;
  const chained: Record<string, Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>> = {};
  let path = "C:/repo";
  chained[path] = [{ name: "d0", isDirectory: true, isSymbolicLink: false }];
  for (let level = 0; level < depth; level += 1) {
    const next = `${path === "C:/repo" ? path : path}/d${level}`;
    chained[next] = level + 1 <= depth
      ? [{ name: `d${level + 1}`, isDirectory: true, isSymbolicLink: false }]
      : [];
    path = next;
  }
  const walked = await listLanguageInventoryFiles({
    repositoryRoot: "C:/repo",
    readdir: async (at) => chained[at] ?? [],
  });
  assert.equal(walked.incomplete, true);
});

test("V3 profile carries walk truncation and refuses a clean inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-v3-deep-"));
  try {
    let deep = root;
    for (let level = 0; level < 10; level += 1) {
      deep = join(deep, `d${level}`);
      mkdirSync(deep, { recursive: true });
    }
    writeFileSync(join(deep, "pom.xml"), "<project></project>");
    await runGit({ cwd: root, args: ["init", "-b", "main"] });
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "deep fixture"] });
    const revision = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.equal(profile.inventoryIncomplete, true);
    assert.deepEqual(profile.commands, {}, "the truncated marker is missed, and the miss is explicit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 profile keeps oversized-marker tests uncertain without a descriptor", async () => {
  const padded = `${CSPROJ_TEST}\n<!--${"x".repeat(140000)}-->\n`;
  assert.ok(Buffer.byteLength(padded, "utf8") > 131072);
  const { root, revision } = await v3Repo({ "Calc.Tests.csproj": padded });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands.tests, [
      { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] },
    ], "unreadable contents cannot prove the project defines no tests");
    assert.equal(profile.reports, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 incomplete flag is validated, cloned, and digested", () => {
  const revision = "abc123";
  const base = {
    version: 1 as const,
    targetRevision: revision,
    inspectedPaths: ["fixture"],
    detectedSignals: [],
    commands: {},
  };
  const flagged = { ...base, inventoryIncomplete: true as const };
  assertFinalVerificationExecutionProfile(flagged, revision);
  assert.throws(() => assertFinalVerificationExecutionProfile({ ...base, inventoryIncomplete: false }, revision), /completeness/);
  const clone = cloneFinalVerificationExecutionProfile(flagged);
  assert.deepEqual(clone, flagged);
  assert.notEqual(
    finalVerificationProfileDigest("run", flagged),
    finalVerificationProfileDigest("run", base),
    "the flag participates in the trusted digest",
  );
});

// ---- F4: the shared bounded confined report reader ----

test("V3 bounded report reader confines, refuses links, and bounds size", () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-v3-reader-"));
  try {
    writeFileSync(join(checkout, "ok.xml"), "<ok/>");
    assert.equal(readBoundedReportBytes({ checkoutPath: checkout, reportPath: "ok.xml" }).toString("utf8"), "<ok/>");
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "../evil.xml" }), /outside/);
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "C:/other/evil.xml" }), /outside/);
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "missing.xml" }), /missing/);
    mkdirSync(join(checkout, "sub"));
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "sub" }), /regular file/);
    writeFileSync(join(checkout, "real.xml"), "<real/>");
    symlinkSync(join(checkout, "real.xml"), join(checkout, "link.xml"));
    assert.ok(lstatSync(join(checkout, "link.xml")).isSymbolicLink());
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "link.xml" }), /symlink/);
    writeFileSync(join(checkout, "big.xml"), "x".repeat(100));
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "big.xml", maxBytes: 10 }), /size bound/);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ---- F6: E1 dependency closure for supported family selectors/helpers ----

const CSPROJ_WITH_IMPORTS = CSPROJ_TEST.replace("</Project>", `  <Import Project="selectors/custom.props" />
  <Import Project="selectors/items.txt" />
</Project>`);

test("V3 E1 pin trips when an imported MSBuild selector changes", async () => {
  const { root, revision } = await v3Repo({
    "Calc.Tests.csproj": CSPROJ_WITH_IMPORTS,
    "Calc.Tests.cs": "using Xunit;\n",
    "selectors/custom.props": "<Project></Project>\n",
    "selectors/items.txt": "cases=Calc\n",
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    writeFileSync(join(root, "selectors", "custom.props"), "<Project><!-- selector --></Project>\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "selector change"] });
    const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest);
    assert.ok(testIntegrityProfileFindings(pin, candidate).some((finding) => finding.code === "test_config_changed"));
    writeFileSync(join(root, "selectors", "items.txt"), "cases=Calc;Extra\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "helper change"] });
    const changedAgain = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidateAgain = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changedAgain, commands: [] });
    assert.notEqual(candidateAgain.configDigest, candidate.configDigest, "non-config extensions arrive only through the import edge");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin trips when an included CMake helper changes", async () => {
  const { root, revision } = await v3Repo({
    "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(fixture NONE)\ninclude(selectors/flags.txt)\n",
    "selectors/flags.txt": "set(FIXTURE_FLAGS 1)\n",
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    writeFileSync(join(root, "selectors", "flags.txt"), "set(FIXTURE_FLAGS 2)\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "helper change"] });
    const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest);
    assert.ok(testIntegrityProfileFindings(pin, candidate).some((finding) => finding.code === "test_config_changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin trips when an imported Python config helper changes", async () => {
  const { root, revision } = await v3Repo({
    "conftest.py": "from helpers import build_cases\n",
    "helpers.py": "def build_cases():\n    return []\n",
    "pytest.ini": "[pytest]\ntestpaths = tests\n",
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    writeFileSync(join(root, "helpers.py"), "def build_cases():\n    return [1]\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "helper change"] });
    const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest);
    assert.ok(testIntegrityProfileFindings(pin, candidate).some((finding) => finding.code === "test_config_changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin rejects an unresolvable relative import", async () => {
  const missing = CSPROJ_TEST.replace("</Project>", '  <Import Project="selectors/gone.props" />\n</Project>');
  const { root, revision } = await v3Repo({ "Calc.Tests.csproj": missing });
  try {
    await assert.rejects(
      inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] }),
      /unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 hasTestSignals matches the new families; the unknown floor stays clean", async () => {
  for (const [name, content] of [
    ["pom.xml", "<project></project>"],
    ["build.gradle", "plugins { id 'java' }"],
    ["CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\n"],
    ["Calc.csproj", CSPROJ_LIB],
    ["Cargo.toml", '[package]\nname = "c"\n'],
    ["go.mod", "module example.com/fixture\n"],
  ] as const) {
    const { root, revision } = await v3Repo({ [name]: content });
    try {
      const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
      assert.equal(pin.hasTestSignals, true, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const bare = await v3Repo({ "README.md": "# fixture\n", "notes.txt": "plans\n" });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: bare.root, revision: bare.revision, commands: [] });
    assert.equal(pin.hasTestSignals, false);
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }
});

test("V3 E1 filename guard rejects family markers in a no-suite claim", async () => {
  const { createHash } = await import("node:crypto");
  assert.equal(knownTestSuitePath("pom.xml"), true);
  assert.equal(knownTestSuitePath("Calc.Tests.csproj"), true);
  assert.equal(knownTestSuitePath("CMakeLists.txt"), true);
  assert.equal(knownTestSuitePath("README.md"), false);
  const pin = { revision: "rev", commands: [], configDigest: "digest", hasTestSignals: false as const };
  const row = (path: string): string => `100644 blob ${"a".repeat(40)}\t${path}`;
  const cleanInventory = row("README.md");
  assert.doesNotThrow(() =>
    assertNoConfiguredTestSuite(pin, cleanInventory, createHash("sha256").update(cleanInventory).digest("hex")),
  );
  const markedInventory = `${row("README.md")}\0${row("pom.xml")}`;
  assert.throws(
    () => assertNoConfiguredTestSuite(pin, markedInventory, createHash("sha256").update(markedInventory).digest("hex")),
    /test-suite signals/,
  );
  assert.equal(testIntegrityPinDigest(pin), testIntegrityPinDigest({ ...pin }), "pin digest is deterministic");
});

// ---- F3/F1/F5: concrete paths through the actual final-verification runtime ----

interface V3RuntimeFixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function v3RuntimeFixture(name: string): Promise<V3RuntimeFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-v3-runtime-${name}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_v3_runtime_${name}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return { root, project, state, runId, integration };
}

async function v3CloseRuntimeFixture(fixture: V3RuntimeFixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  await runGit({ cwd: fixture.project, args: ["worktree", "prune", "--expire", "now"], allowFailure: true }).catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

function v3TestsPlan(): FinalVerificationPlan {
  const skipped = (category: "build" | "runtime_smoke" | "browser", reason: string) => ({
    category,
    status: "not_applicable" as const,
    rationale: reason,
    repositoryInspection: { paths: ["fixture"], summary: reason },
  });
  return {
    checks: [
      skipped("build", "No build command is present."),
      { category: "tests", status: "required" },
      skipped("runtime_smoke", "No runtime command is present."),
      skipped("browser", "No browser surface is present."),
    ],
  };
}

type V3FamilyRunner = "pytest" | "dotnet test" | "ctest" | "maven test";

function v3FamilyProfile(
  revision: string,
  command: { label: string; executable: string; args: string[]; environment?: Record<string, string | undefined> },
  reports: ReadonlyArray<{ commandLabel: string; runner: V3FamilyRunner; format: "junit" | "trx" }>,
  inventoryIncomplete?: boolean,
) {
  return {
    version: 1 as const,
    targetRevision: revision,
    inspectedPaths: ["fixture-marker"],
    detectedSignals: [{ category: "tests" as const, source: "fixture-marker", detail: "fixture" }],
    commands: { tests: [{ ...command, args: [...command.args] }] },
    ...(reports.length > 0 ? { reports: reports.map((report) => ({ ...report })) } : {}),
    ...(inventoryIncomplete === true ? { inventoryIncomplete: true as const } : {}),
  };
}

function stubFlagDestination(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const junit = /^--junitxml=(.+)$/.exec(arg);
    if (junit?.[1]) return junit[1];
  }
  const junitIndex = args.indexOf("--output-junit");
  if (junitIndex >= 0) {
    const next = args[junitIndex + 1];
    if (next) return next;
  }
  const loggerIndex = args.findIndex((arg) => arg === "--logger" || arg === "-l");
  if (loggerIndex >= 0) {
    const match = /LogFileName=(.+?)\s*$/.exec(args[loggerIndex + 1] ?? "");
    if (match?.[1]) return match[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function writeStubFile(cwd: string, dest: string, content: string, overwrite: boolean): void {
  const absolute = resolve(cwd, dest);
  if (!overwrite && existsSync(absolute)) return;
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function familyStubExecutor(options: {
  exitCode: number;
  overwrite?: boolean;
  writeReport: (cwd: string, args: readonly string[]) => void;
}): OneShotCommandExecutor {
  return {
    execute: async (request): Promise<OneShotCommandResult> => {
      options.writeReport(request.workingDirectory, request.arguments);
      const finishedAt = new Date().toISOString();
      const stream = (name: "stdout" | "stderr") => ({
        stream: name, tail: "v3-stub", totalBytes: 7, truncated: false, spillBytes: 0, lossyBytes: 0,
      });
      return {
        process: {
          logicalProcessId: "v3-family-stub",
          outcome: "exited",
          exitCode: options.exitCode,
          finishedAt,
          output: [stream("stdout"), stream("stderr")],
          cleanup: { state: "verified_empty", verifiedAt: finishedAt },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
}

function v3CommandReport(check: { facts: readonly { kind: string }[] }): { executed: number; failed: number; artifactHash?: string } | undefined {
  const fact = check.facts.find((entry) => entry.kind === "command") as unknown as
    | { report?: { executed: number; failed: number; artifactHash?: string } }
    | undefined;
  return fact?.report;
}

async function v3RunFamilyTests(input: {
  fixture: V3RuntimeFixture;
  command: { label: string; executable: string; args: string[]; environment?: Record<string, string | undefined> };
  reports: ReadonlyArray<{ commandLabel: string; runner: V3FamilyRunner; format: "junit" | "trx" }>;
  execution: OneShotCommandExecutor;
  generationId: string;
  inventoryIncomplete?: boolean;
}) {
  const artifacts = new ArtifactStore(join(input.fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(input.fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: input.fixture.project,
    stateDirectory: input.fixture.state,
    runId: input.fixture.runId,
    targetRevision: input.fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: input.fixture.runId,
    integrationRevision: () => input.fixture.integration.revision,
    generationId: input.generationId,
    execution: input.execution,
  });
  try {
    const command = { ...input.command, args: [...input.command.args] };
    return await runtime.runCategory(
      {
        plan: v3TestsPlan(),
        executionProfile: v3FamilyProfile(input.fixture.integration.revision, command, input.reports, input.inventoryIncomplete),
        commands: { tests: [command] },
      },
      "tests",
    );
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
  }
}

const PYTEST_COMMAND = { label: "pytest", executable: "pytest", args: [] as string[] };

test("V3 runtime: exit 0 with a 1-pass-1-fail TRX report is red", async () => {
  const fixture = await v3RuntimeFixture("trx-fail");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "dotnet test", executable: "dotnet", args: ["test", "Calc.Tests.csproj", "--disable-build-servers"] },
      reports: [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd, args) => {
          const dest = stubFlagDestination(args);
          assert.ok(dest, "the TRX logger flag reaches the runner");
          writeStubFile(cwd, dest, TRX_FAILED, true);
        },
      }),
      generationId: "v3trxfail",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /1 failed tests; report failures prevent a green run/.test(issue)), run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: v3CommandReport(run.check)?.executed, failed: v3CommandReport(run.check)?.failed },
      { executed: 2, failed: 1 },
    );
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: exit 0 with a passing TRX report stays green with counts", async () => {
  const fixture = await v3RuntimeFixture("trx-pass");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "dotnet test", executable: "dotnet", args: ["test", "Calc.Tests.csproj", "--disable-build-servers"] },
      reports: [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd, args) => writeStubFile(cwd, stubFlagDestination(args)!, TRX_PASS, true),
      }),
      generationId: "v3trxpass",
    });
    assert.equal(run.check.green, true, run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: v3CommandReport(run.check)?.executed, failed: v3CommandReport(run.check)?.failed },
      { executed: 2, failed: 0 },
    );
    assert.match(v3CommandReport(run.check)?.artifactHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: exit 0 with no readable family report is red", async () => {
  const fixture = await v3RuntimeFixture("missing-report");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: PYTEST_COMMAND,
      reports: [{ commandLabel: "pytest", runner: "pytest", format: "junit" }],
      execution: familyStubExecutor({ exitCode: 0, writeReport: () => undefined }),
      generationId: "v3missing",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /no readable report/.test(issue)), run.check.issues.join("\n"));
    assert.equal(v3CommandReport(run.check), undefined);
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: unsupported gradle tests with no usable report are red", async () => {
  const fixture = await v3RuntimeFixture("gradle-unsupported");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "gradle test", executable: "gradle", args: ["test"] },
      reports: [],
      execution: familyStubExecutor({ exitCode: 0, writeReport: () => undefined }),
      generationId: "v3gradle",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /no usable machine-readable report/.test(issue)), run.check.issues.join("\n"));
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: descriptor mismatch fails closed", async () => {
  const fixture = await v3RuntimeFixture("descriptor-mismatch");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "ctest", executable: "ctest", args: ["--test-dir", "b"] },
      reports: [{ commandLabel: "ctest", runner: "pytest", format: "junit" }],
      execution: familyStubExecutor({ exitCode: 0, writeReport: () => undefined }),
      generationId: "v3mismatch",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /disagrees with the trusted execution profile/.test(issue)), run.check.issues.join("\n"));
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: pytest wiring survives caller NODE_OPTIONS", async () => {
  const fixture = await v3RuntimeFixture("node-options");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { ...PYTEST_COMMAND, environment: { NODE_OPTIONS: "--max-old-space-size=512" } },
      reports: [{ commandLabel: "pytest", runner: "pytest", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd, args) => writeStubFile(cwd, stubFlagDestination(args)!, PYTEST_JUNIT_XML, true),
      }),
      generationId: "v3nodeopts",
    });
    assert.equal(run.check.green, true, run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: v3CommandReport(run.check)?.executed, failed: v3CommandReport(run.check)?.failed },
      { executed: 2, failed: 0 },
      "the report proves the wiring ran instead of being suppressed",
    );
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: pytest without a trusted descriptor mints no counts", async () => {
  const fixture = await v3RuntimeFixture("no-descriptor");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: PYTEST_COMMAND,
      reports: [],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd, args) => writeStubFile(cwd, stubFlagDestination(args)!, PYTEST_JUNIT_XML, true),
      }),
      generationId: "v3nodesc",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /no report descriptor/.test(issue)), run.check.issues.join("\n"));
    assert.equal(v3CommandReport(run.check), undefined, "no descriptor, no counts");
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: a preexisting stale report is refused", async () => {
  const fixture = await v3RuntimeFixture("stale");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    generationId: "v3stale",
    execution: familyStubExecutor({
      exitCode: 0,
      overwrite: false,
      writeReport: (cwd, args) => {
        const dest = stubFlagDestination(args);
        if (dest) writeStubFile(cwd, dest, PYTEST_JUNIT_XML, false);
      },
    }),
  });
  try {
    const command = { ...PYTEST_COMMAND, args: [...PYTEST_COMMAND.args] };
    const profile = v3FamilyProfile(fixture.integration.revision, command, [{ commandLabel: "pytest", runner: "pytest", format: "junit" }]);
    const first = await runtime.runCategory({ plan: v3TestsPlan(), executionProfile: profile, commands: { tests: [command] } }, "tests");
    assert.equal(first.check.green, true, first.check.issues.join("\n"));
    const staleName = junitReportFileName("v3stale", "tests", 0, 2);
    writeFileSync(join(first.workspacePath, staleName), "stale-bytes");
    const second = await runtime.runCategory({ plan: v3TestsPlan(), executionProfile: profile, commands: { tests: [command] } }, "tests");
    assert.equal(second.check.green, false);
    assert.ok(second.check.issues.some((issue) => /already exists before this run/.test(issue)), second.check.issues.join("\n"));
    assert.equal(readFileSync(join(second.workspacePath, staleName), "utf8"), "stale-bytes", "the stale file is never adopted");
    assert.equal(v3CommandReport(second.check), undefined);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: a symlinked report is refused", async () => {
  const fixture = await v3RuntimeFixture("symlink");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    generationId: "v3link",
    execution: familyStubExecutor({
      exitCode: 0,
      overwrite: false,
      writeReport: (cwd, args) => {
        const dest = stubFlagDestination(args);
        if (dest) writeStubFile(cwd, dest, PYTEST_JUNIT_XML, false);
      },
    }),
  });
  try {
    const command = { ...PYTEST_COMMAND, args: [...PYTEST_COMMAND.args] };
    const profile = v3FamilyProfile(fixture.integration.revision, command, [{ commandLabel: "pytest", runner: "pytest", format: "junit" }]);
    const first = await runtime.runCategory({ plan: v3TestsPlan(), executionProfile: profile, commands: { tests: [command] } }, "tests");
    assert.equal(first.check.green, true, first.check.issues.join("\n"));
    symlinkSync(join(first.workspacePath, "no-such-target.xml"), join(first.workspacePath, junitReportFileName("v3link", "tests", 0, 2)));
    const second = await runtime.runCategory({ plan: v3TestsPlan(), executionProfile: profile, commands: { tests: [command] } }, "tests");
    assert.equal(second.check.green, false);
    assert.ok(second.check.issues.some((issue) => /no readable report/.test(issue)), second.check.issues.join("\n"));
    assert.equal(v3CommandReport(second.check), undefined);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: maven fresh set aggregates through the runtime", async () => {
  const fixture = await v3RuntimeFixture("maven-pass");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      reports: [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_PASS, true);
          writeStubFile(cwd, "module-b/target/surefire-reports/TEST-b.xml", SUREFIRE_PASS, true);
        },
      }),
      generationId: "v3mvnpass",
    });
    assert.equal(run.check.green, true, run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: v3CommandReport(run.check)?.executed, failed: v3CommandReport(run.check)?.failed },
      { executed: 4, failed: 0 },
    );
    assert.match(v3CommandReport(run.check)?.artifactHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: maven fresh set failures prevent green", async () => {
  const fixture = await v3RuntimeFixture("maven-fail");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      reports: [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_XML, true);
          writeStubFile(cwd, "module-b/target/surefire-reports/TEST-b.xml", SUREFIRE_PASS, true);
        },
      }),
      generationId: "v3mvnfail",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /report set shows 1 failed tests/.test(issue)), run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: v3CommandReport(run.check)?.executed, failed: v3CommandReport(run.check)?.failed },
      { executed: 4, failed: 1 },
    );
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: incomplete inventory cannot go green", async () => {
  const fixture = await v3RuntimeFixture("incomplete");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: PYTEST_COMMAND,
      reports: [{ commandLabel: "pytest", runner: "pytest", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd, args) => writeStubFile(cwd, stubFlagDestination(args)!, PYTEST_JUNIT_XML, true),
      }),
      generationId: "v3incomplete",
      inventoryIncomplete: true,
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /incomplete file inventory/.test(issue)), run.check.issues.join("\n"));
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: ambiguous multi-project dotnet mints no counts", async () => {
  const fixture = await v3RuntimeFixture("ambiguous");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] },
      reports: [],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => writeStubFile(cwd, ".aiboard-report-decoy.trx", TRX_PASS, true),
      }),
      generationId: "v3ambiguous",
    });
    assert.equal(run.check.green, false);
    assert.ok(run.check.issues.some((issue) => /no report descriptor/.test(issue)), run.check.issues.join("\n"));
    assert.equal(v3CommandReport(run.check), undefined, "a decoy single TRX never becomes the denominator");
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

// ---- delivery level: maven set aggregation and ambiguity through runDeliveryCategory ----

test("V3 delivery: maven fresh set aggregates with immutable bytes", async () => {
  const fixture = await v3RuntimeFixture("delivery-maven");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "delivery-evidence.sqlite"));
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  await manager.create();
  try {
    const profile = v3FamilyProfile(
      fixture.integration.revision,
      { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
    );
    const run = await runDeliveryCategory({
      category: "tests",
      profile,
      manager,
      runId: fixture.runId,
      evidenceTaskId: "delivery:T1",
      generationId: "v3deliverymvn",
      git: runGit,
      artifacts,
      evidenceStore: evidence,
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_XML, true);
          writeStubFile(cwd, "module-b/target/surefire-reports/TEST-b.xml", SUREFIRE_PASS, true);
        },
      }),
    });
    assert.equal(run.exitCode, 0);
    assert.equal(run.report?.status, "failed");
    assert.deepEqual(run.report?.counts, { selected: 5, passed: 3, failed: 1, skipped: 1 });
    assert.match(run.report?.artifactHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    evidence.close();
    await manager.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 delivery: ambiguous dotnet stays unknown without a descriptor", async () => {
  const fixture = await v3RuntimeFixture("delivery-ambiguous");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "delivery-evidence.sqlite"));
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  await manager.create();
  try {
    const profile = v3FamilyProfile(
      fixture.integration.revision,
      { label: "dotnet test", executable: "dotnet", args: ["test", "--disable-build-servers"] },
      [],
    );
    const run = await runDeliveryCategory({
      category: "tests",
      profile,
      manager,
      runId: fixture.runId,
      evidenceTaskId: "delivery:T1",
      generationId: "v3deliveryamb",
      git: runGit,
      artifacts,
      evidenceStore: evidence,
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => writeStubFile(cwd, ".aiboard-report-decoy.trx", TRX_PASS, true),
      }),
    });
    assert.equal(run.exitCode, 0);
    assert.equal(run.ran, true);
    assert.equal(run.report?.status, "unknown");
    assert.match(run.report?.reason ?? "", /no trusted report descriptor/);
  } finally {
    evidence.close();
    await manager.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

// ---- repair2 F1: unusable report-set members refuse all counts ----

test("V3 maven scan marks symlinked, non-regular, and directory members incomplete", async () => {
  const entries = (extra: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>) =>
    async (path: string) => {
      if (path === "C:/repo") return [{ name: "target", isDirectory: true, isSymbolicLink: false }];
      if (path === "C:/repo/target") return [{ name: "surefire-reports", isDirectory: true, isSymbolicLink: false }];
      if (path === "C:/repo/target/surefire-reports") return extra;
      return [];
    };
  const linked = await scanMavenSurefireReportFiles({
    checkoutPath: "C:/repo",
    before: new Map(),
    readdir: entries([
      { name: "TEST-a.xml", isDirectory: false, isSymbolicLink: false },
      { name: "TEST-b.xml", isDirectory: false, isSymbolicLink: true },
    ]),
    stat: async () => ({ size: 100, mtimeMs: 1, isRegularFile: true }),
  });
  assert.equal(linked.incomplete, true, "a symlinked expected member is incomplete, never silently dropped");
  assert.ok(!linked.fresh.includes("module-x/target/surefire-reports/TEST-b.xml") && !linked.fresh.some((path) => path.endsWith("TEST-b.xml")));
  const irregular = await scanMavenSurefireReportFiles({
    checkoutPath: "C:/repo",
    before: new Map(),
    readdir: entries([{ name: "TEST-b.xml", isDirectory: false, isSymbolicLink: false }]),
    stat: async () => ({ size: 100, mtimeMs: 1, isRegularFile: false }),
  });
  assert.equal(irregular.incomplete, true, "a non-regular expected member is incomplete");
  assert.deepEqual(irregular.fresh, []);
  const misnamed = await scanMavenSurefireReportFiles({
    checkoutPath: "C:/repo",
    before: new Map(),
    readdir: entries([{ name: "TEST-c.xml", isDirectory: true, isSymbolicLink: false }]),
    stat: async () => ({ size: 100, mtimeMs: 1, isRegularFile: true }),
  });
  assert.equal(misnamed.incomplete, true, "a directory carrying an expected report name is incomplete");
  assert.deepEqual(misnamed.fresh, []);
});

test("V3 runtime: maven valid report plus symlinked member refuses all counts", async () => {
  const fixture = await v3RuntimeFixture("maven-symlink");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      reports: [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_PASS, true);
          const dir = resolve(cwd, "module-b/target/surefire-reports");
          mkdirSync(dir, { recursive: true });
          symlinkSync(resolve(cwd, "module-a/target/surefire-reports/TEST-a.xml"), join(dir, "TEST-b.xml"));
        },
      }),
      generationId: "v3mvnsymlink",
    });
    assert.equal(run.check.green, false, run.check.issues.join("\n"));
    assert.ok(run.check.issues.some((issue) => /report.set|report set|fresh reports/.test(issue)), run.check.issues.join("\n"));
    assert.equal(v3CommandReport(run.check), undefined, "a partial set mints no counts");
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 runtime: maven valid report plus non-regular member refuses all counts", async () => {
  const fixture = await v3RuntimeFixture("maven-irregular");
  try {
    const run = await v3RunFamilyTests({
      fixture,
      command: { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      reports: [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_PASS, true);
          mkdirSync(resolve(cwd, "module-b/target/surefire-reports/TEST-b.xml"), { recursive: true });
        },
      }),
      generationId: "v3mvnirregular",
    });
    assert.equal(run.check.green, false, run.check.issues.join("\n"));
    assert.equal(v3CommandReport(run.check), undefined, "a partial set mints no counts");
  } finally {
    await v3CloseRuntimeFixture(fixture);
  }
});

test("V3 delivery: maven valid report plus symlinked member stays unknown", async () => {
  const fixture = await v3RuntimeFixture("delivery-symlink");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "delivery-evidence.sqlite"));
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  await manager.create();
  try {
    const profile = v3FamilyProfile(
      fixture.integration.revision,
      { label: "maven test", executable: "mvn", args: ["-B", "test"] },
      [{ commandLabel: "maven test", runner: "maven test", format: "junit" }],
    );
    const run = await runDeliveryCategory({
      category: "tests",
      profile,
      manager,
      runId: fixture.runId,
      evidenceTaskId: "delivery:T1",
      generationId: "v3deliverysymlink",
      git: runGit,
      artifacts,
      evidenceStore: evidence,
      execution: familyStubExecutor({
        exitCode: 0,
        writeReport: (cwd) => {
          writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_PASS, true);
          const dir = resolve(cwd, "module-b/target/surefire-reports");
          mkdirSync(dir, { recursive: true });
          symlinkSync(resolve(cwd, "module-a/target/surefire-reports/TEST-a.xml"), join(dir, "TEST-b.xml"));
        },
      }),
    });
    assert.equal(run.report?.status, "unknown");
    assert.match(run.report?.reason ?? "", /incomplete|unusable|bounds/);
    assert.equal(run.report?.counts, undefined, "a partial set mints no counts");
  } finally {
    evidence.close();
    await manager.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

// ---- repair2 F2: inspection uncertainty precedes absence-based applicability ----

test("V3 runtime: incomplete inventory forbids absence-based not_applicable", async () => {
  const fixture = await v3RuntimeFixture("absence");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    generationId: "v3absence",
    execution: familyStubExecutor({ exitCode: 0, writeReport: () => undefined }),
  });
  try {
    const skipped = (category: "build" | "runtime_smoke" | "browser") => ({
      category,
      status: "not_applicable" as const,
      rationale: "No command is present.",
      repositoryInspection: { paths: ["fixture-marker"], summary: "No command is present." },
    });
    const plan = {
      checks: [
        skipped("build"),
        {
          category: "tests" as const,
          status: "not_applicable" as const,
          rationale: "No test family applies.",
          repositoryInspection: { paths: ["fixture-marker"], summary: "No test family applies." },
        },
        skipped("runtime_smoke"),
        skipped("browser"),
      ],
    };
    const refused = await runtime.runCategory({
      plan,
      executionProfile: {
        version: 1 as const,
        targetRevision: fixture.integration.revision,
        inspectedPaths: ["fixture-marker"],
        detectedSignals: [],
        commands: {},
        inventoryIncomplete: true as const,
      },
      commands: {},
    }, "tests");
    assert.equal(refused.check.green, false, "an incomplete profile with no commands cannot accept absence");
    assert.ok(refused.check.issues.some((issue) => /incomplete file inventory/.test(issue)), refused.check.issues.join("\n"));
    const floor = await runtime.runCategory({
      plan,
      executionProfile: {
        version: 1 as const,
        targetRevision: fixture.integration.revision,
        inspectedPaths: ["fixture-marker"],
        detectedSignals: [],
        commands: {},
      },
      commands: {},
    }, "tests");
    assert.equal(floor.check.green, true, "a complete unknown-language floor stays green");
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await v3CloseRuntimeFixture(fixture);
  }
});

// ---- repair2 F4: parent-indirection confinement and the hard read cap ----

test("V3 bounded reader refuses parent-indirection escape", () => {
  const outside = mkdtempSync(join(tmpdir(), "aiboard-v3-reader-out-"));
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-v3-reader-esc-"));
  try {
    writeFileSync(join(outside, "evil.xml"), "<evil/>");
    symlinkSync(outside, join(checkout, "linked"), "junction");
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "linked/evil.xml" }), /outside/);
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "linked" }), /outside|regular file|symlink/);
  } finally {
    rmSync(join(checkout, "linked"), { force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("V3 bounded reader enforces its hard allocation cap at the boundary", () => {
  const checkout = mkdtempSync(join(tmpdir(), "aiboard-v3-reader-cap-"));
  try {
    writeFileSync(join(checkout, "exact.xml"), "0123456789");
    assert.equal(readBoundedReportBytes({ checkoutPath: checkout, reportPath: "exact.xml", maxBytes: 10 }).byteLength, 10);
    assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "exact.xml", maxBytes: 9 }), /size bound/);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ---- repair2 F5: .NET single-result qualification through the property closure ----

const CSPROJ_WITH_CUSTOM_PROPS = (extra: string): string => CSPROJ_TEST.replace("</Project>", `  <Import Project="${extra}" />\n</Project>`);
const PROPS_SINGLE = `<Project>\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;
const PROPS_MULTI = `<Project>\n  <PropertyGroup>\n    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>\n  </PropertyGroup>\n</Project>\n`;

test("V3 imported custom props qualify single-result; multi-target imports do not", () => {
  const [ok] = detectLanguageFamilies({
    files: ["App.Tests.csproj", "build/custom.props"],
    readFile: (path) => (path === "App.Tests.csproj" ? CSPROJ_WITH_CUSTOM_PROPS("build/custom.props") : PROPS_SINGLE),
  });
  assert.equal(ok?.testsAmbiguous, undefined);
  assert.deepEqual(languageReportDescriptors([ok!]), [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }]);
  const [multi] = detectLanguageFamilies({
    files: ["App.Tests.csproj", "build/custom.props"],
    readFile: (path) => (path === "App.Tests.csproj" ? CSPROJ_WITH_CUSTOM_PROPS("build/custom.props") : PROPS_MULTI),
  });
  assert.match(multi?.testsAmbiguous ?? "", /build\/custom\.props/);
  assert.deepEqual(languageReportDescriptors([multi!]), [], "an imported multi-target denominator never looks single-result");
});

test("V3 automatic Directory.Build.props and attributed frameworks qualify single-result", () => {
  const [auto] = detectLanguageFamilies({
    files: ["src/App.Tests.csproj", "Directory.Build.props"],
    readFile: (path) => (path.endsWith("Directory.Build.props") ? PROPS_MULTI : CSPROJ_TEST),
  });
  assert.match(auto?.testsAmbiguous ?? "", /Directory\.Build\.props/);
  assert.deepEqual(languageReportDescriptors([auto!]), []);
  const attributed = CSPROJ_TEST.replace(
    "<TargetFramework>net10.0</TargetFramework>",
    `<TargetFrameworks Condition="'$(Configuration)' == 'Debug'">net10.0</TargetFrameworks>`,
  );
  const [attr] = detectLanguageFamilies({ files: ["App.Tests.csproj"], readFile: () => attributed });
  assert.match(attr?.testsAmbiguous ?? "", /several frameworks/);
  assert.deepEqual(languageReportDescriptors([attr!]), []);
  const [control] = detectLanguageFamilies({
    files: ["src/App.Tests.csproj", "Directory.Build.props"],
    readFile: (path) => (path.endsWith("Directory.Build.props") ? PROPS_SINGLE : CSPROJ_TEST),
  });
  assert.equal(control?.testsAmbiguous, undefined, "a supported single-target closure keeps its descriptor");
  assert.deepEqual(languageReportDescriptors([control!]), [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }]);
});

test("V3 transitive and conditional property settings refuse single-result; SDK names stay external", () => {
  const transitive = CSPROJ_WITH_CUSTOM_PROPS("a.props");
  const [twoHop] = detectLanguageFamilies({
    files: ["App.Tests.csproj", "a.props", "b.props"],
    readFile: (path) => {
      if (path === "App.Tests.csproj") return transitive;
      if (path === "a.props") return `<Project>\n  <Import Project="b.props" />\n</Project>\n`;
      return PROPS_MULTI;
    },
  });
  assert.match(twoHop?.testsAmbiguous ?? "", /b\.props/);
  const [cond] = detectLanguageFamilies({
    files: ["App.Tests.csproj", "extra.props"],
    readFile: (path) => (
      path === "App.Tests.csproj"
        ? `<Project Sdk="Microsoft.NET.Sdk">\n  <Import Project="extra.props" Condition="'$(X)' == '1'" />\n</Project>`
        : PROPS_SINGLE
    ),
  });
  assert.match(cond?.testsAmbiguous ?? "", /conditional/);
  const [driven] = detectLanguageFamilies({
    files: ["App.Tests.csproj"],
    readFile: () => CSPROJ_TEST.replace("</Project>", '  <Import Project="./$(Config)/extra.props" />\n</Project>'),
  });
  assert.match(driven?.testsAmbiguous ?? "", /property-driven/);
  const [missing] = detectLanguageFamilies({
    files: ["App.Tests.csproj"],
    readFile: () => CSPROJ_WITH_CUSTOM_PROPS("build/gone.props"),
  });
  assert.match(missing?.testsAmbiguous ?? "", /unavailable/);
  const [sdk] = detectLanguageFamilies({
    files: ["App.Tests.csproj"],
    readFile: () => CSPROJ_TEST.replace(
      "</Project>",
      '  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />\n  <Import Project="$(MSBuildToolsPath)/Common.props" />\n</Project>',
    ),
  });
  assert.equal(sdk?.testsAmbiguous, undefined, "known external SDK references stay external");
  assert.deepEqual(languageReportDescriptors([sdk!]), [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }]);
});

test("V3 profile refuses single-result descriptor for imported multi-target props", async () => {
  const { root, revision } = await v3Repo({
    "Calc.Tests.csproj": CSPROJ_TEST.replace("</Project>", '  <Import Project="build/custom.props" />\n</Project>'),
    "build/custom.props": PROPS_MULTI,
  });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: root,
      targetRevision: revision,
      execute: runGit,
    });
    assert.ok(profile.commands.tests, "the run stays detected, never no-suite");
    assert.equal(profile.reports, undefined, "no single-result descriptor for a multi-target closure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- repair2 F6: transitive immutable closure across nonstandard extensions ----

test("V3 E1 pin follows a transitive custom helper through a nonstandard extension", async () => {
  const { root, revision } = await v3Repo({
    "Calc.Tests.csproj": CSPROJ_TEST.replace("</Project>", '  <Import Project="a.props" />\n</Project>'),
    "a.props": `<Project>\n  <Import Project="b.txt" />\n</Project>\n`,
    "b.txt": `<Project>\n  <Import Project="c.inc" />\n</Project>\n`,
    "c.inc": "setting=1\n",
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    // Only the two-hop transitive helper changes; the command and the
    // top-level project text are untouched.
    writeFileSync(join(root, "c.inc"), "setting=2\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "transitive helper change"] });
    const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest, "the .txt edge was parsed, not merely hashed");
    assert.ok(testIntegrityProfileFindings(pin, candidate).some((finding) => finding.code === "test_config_changed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin tracks literal local Maven parent POMs; external parents stay external", async () => {
  const child = (parent: string): string =>
    `<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version>${parent}</project>`;
  const local = await v3Repo({
    "pom.xml": child(`<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1</version><relativePath>parent/pom.xml</relativePath></parent>`),
    "parent/pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>parent</artifactId><version>1</version></project>`,
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: local.root, revision: local.revision, commands: [] });
    writeFileSync(join(local.root, "parent", "pom.xml"), `<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>parent</artifactId><version>2</version></project>`);
    await runGit({ cwd: local.root, args: ["add", "-A"] });
    await runGit({ cwd: local.root, args: ["commit", "-m", "parent change"] });
    const changed = (await runGit({ cwd: local.root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: local.root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest, "changing only the transitive parent POM trips the pin");
  } finally {
    rmSync(local.root, { recursive: true, force: true });
  }
  const external = await v3Repo({
    "pom.xml": child(`<parent><groupId>org.external</groupId><artifactId>parent</artifactId><version>9</version></parent>`),
  });
  try {
    await inspectTestIntegrityPin({ git: runGit, repositoryRoot: external.root, revision: external.revision, commands: [] });
  } finally {
    rmSync(external.root, { recursive: true, force: true });
  }
  const nowhere = await v3Repo({
    "pom.xml": child(`<parent><groupId>g</groupId><artifactId>parent</artifactId><version>1</version><relativePath>gone/pom.xml</relativePath></parent>`),
  });
  try {
    await assert.rejects(
      inspectTestIntegrityPin({ git: runGit, repositoryRoot: nowhere.root, revision: nowhere.revision, commands: [] }),
      /unavailable/,
      "a literal local parent with no tracked blob refuses the pin",
    );
  } finally {
    rmSync(nowhere.root, { recursive: true, force: true });
  }
});

test("V3 E1 pin tracks Python package init and the actual submodule", async () => {
  const { root, revision } = await v3Repo({
    "conftest.py": "from pkg.sub import build_cases\n",
    "pkg/__init__.py": "# pkg\n",
    "pkg/sub.py": "def build_cases():\n    return []\n",
    "pytest.ini": "[pytest]\n",
  });
  try {
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] });
    writeFileSync(join(root, "pkg", "sub.py"), "def build_cases():\n    return [1]\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "submodule change"] });
    const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] });
    assert.notEqual(candidate.configDigest, pin.configDigest, "changing only the actual submodule trips the pin");
    writeFileSync(join(root, "pkg", "__init__.py"), "# pkg changed\n");
    await runGit({ cwd: root, args: ["add", "-A"] });
    await runGit({ cwd: root, args: ["commit", "-m", "init change"] });
    const changedAgain = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const candidateAgain = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changedAgain, commands: [] });
    assert.notEqual(candidateAgain.configDigest, candidate.configDigest, "the package init participates too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("V3 E1 pin refuses unknown local selector identity; SDK references stay external", async () => {
  const variable = await v3Repo({
    "A.Tests.csproj": CSPROJ_TEST.replace("</Project>", '  <Import Project="./$(Config)/local.props" />\n</Project>'),
  });
  try {
    await assert.rejects(
      inspectTestIntegrityPin({ git: runGit, repositoryRoot: variable.root, revision: variable.revision, commands: [] }),
      /unavailable/,
      "a property-driven local MSBuild import refuses the pin",
    );
  } finally {
    rmSync(variable.root, { recursive: true, force: true });
  }
  const sdk = await v3Repo({
    "A.Tests.csproj": CSPROJ_TEST.replace(
      "</Project>",
      '  <Import Project="$(MSBuildToolsPath)/Common.props" />\n  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />\n</Project>',
    ),
  });
  try {
    await inspectTestIntegrityPin({ git: runGit, repositoryRoot: sdk.root, revision: sdk.revision, commands: [] });
  } finally {
    rmSync(sdk.root, { recursive: true, force: true });
  }
  const cmakeVariable = await v3Repo({
    "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(fixture NONE)\ninclude(${LOCAL_DIR}/flags.cmake)\n",
  });
  try {
    await assert.rejects(
      inspectTestIntegrityPin({ git: runGit, repositoryRoot: cmakeVariable.root, revision: cmakeVariable.revision, commands: [] }),
      /unavailable/,
      "a variable-based local CMake include refuses the pin",
    );
  } finally {
    rmSync(cmakeVariable.root, { recursive: true, force: true });
  }
  const cmakeModule = await v3Repo({
    "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(fixture NONE)\ninclude(ExternalModule)\n",
  });
  try {
    await inspectTestIntegrityPin({ git: runGit, repositoryRoot: cmakeModule.root, revision: cmakeModule.revision, commands: [] });
  } finally {
    rmSync(cmakeModule.root, { recursive: true, force: true });
  }
});

// Controller third-cycle regressions: prior source must fail for each open gap.
test("V3 root F1: linked report traversal refuses runtime and delivery partial sets", async () => {
  for (const route of ["runtime", "delivery"] as const) {
    const fixture = await v3RuntimeFixture(`root-maven-${route}`);
    const artifacts = new ArtifactStore(join(fixture.root, "root-artifacts"));
    const evidence = new SqliteEvidenceStore(join(fixture.root, "root-evidence.sqlite"));
    const manager = new VerificationWorkspaceManager({ repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId, targetRevision: fixture.integration.revision });
    const command = { label: "maven test", executable: "mvn", args: ["-B", "test"] };
    const reports = [{ commandLabel: "maven test", runner: "maven test" as const, format: "junit" as const }];
    const execution = familyStubExecutor({ exitCode: 0, writeReport: (cwd) => {
      writeStubFile(cwd, "module-a/target/surefire-reports/TEST-a.xml", SUREFIRE_PASS, true);
      mkdirSync(join(cwd, "module-b", "target"), { recursive: true });
      symlinkSync(join(cwd, "module-a", "target", "surefire-reports"), join(cwd, "module-b", "target", "surefire-reports"), "junction");
    }});
    try {
      if (route === "runtime") {
        const run = await v3RunFamilyTests({ fixture, command, reports, execution, generationId: "v3rootlinked" });
        assert.equal(run.check.green, false, "linked traversal cannot omit a required module");
        assert.equal(v3CommandReport(run.check), undefined);
      } else {
        await manager.create();
        const run = await runDeliveryCategory({ category: "tests", profile: v3FamilyProfile(fixture.integration.revision, command, reports), manager, runId: fixture.runId, evidenceTaskId: "delivery:T1", generationId: "v3rootlinked", git: runGit, artifacts, evidenceStore: evidence, execution });
        assert.equal(run.report?.status, "unknown", "linked traversal cannot produce passing partial counts");
        assert.equal(run.report?.counts, undefined);
      }
    } finally { evidence.close(); await manager.cleanup().catch(() => undefined); await v3CloseRuntimeFixture(fixture); }
  }
});

test("V3 root F4: parent replaced after canonicalization refuses before reading foreign bytes", () => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const checkout = mkdtempSync(join(tmpdir(), "v3-root-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "v3-root-foreign-"));
  const parent = join(checkout, "reports");
  mkdirSync(parent); writeFileSync(join(parent, "result.xml"), "owned"); writeFileSync(join(outside, "result.xml"), "foreign");
  const original = fs.realpathSync; let swapped = false; let reads = 0;
  const originalRead = fs.readSync;
  mock.method(fs, "realpathSync", (...args: Parameters<typeof fs.realpathSync>) => {
    const result = Reflect.apply(original, fs, args);
    if (!swapped && String(args[0]) === parent) { swapped = true; fs.renameSync(parent, `${parent}-retired`); symlinkSync(outside, parent, "junction"); }
    return result;
  });
  mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { reads++; return Reflect.apply(originalRead, fs, args); });
  syncBuiltinESMExports();
  try { assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "reports/result.xml" }), /outside|changed|indirect|symlink/); assert.equal(swapped, true); assert.equal(reads, 0, "foreign bytes must never be read or archived"); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); if (swapped) rmSync(parent, { force: true }); rmSync(checkout, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("V3 root F4: pre-open growth refuses rather than adopting a new report size", () => {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const checkout = mkdtempSync(join(tmpdir(), "v3-root-growth-")); const report = join(checkout, "result.xml"); writeFileSync(report, "owned");
  const original = fs.openSync; let grew = false; let reads = 0; const originalRead = fs.readSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (!grew && String(args[0]) === report) { grew = true; writeFileSync(report, "owned-grown"); } return Reflect.apply(original, fs, args); });
  mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => { reads++; return Reflect.apply(originalRead, fs, args); }); syncBuiltinESMExports();
  try { assert.throws(() => readBoundedReportBytes({ checkoutPath: checkout, reportPath: "result.xml", maxBytes: 32 }), /changed/); assert.equal(grew, true); assert.equal(reads, 0); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); rmSync(checkout, { recursive: true, force: true }); }
});

test("V3 root F5: nonstandard and property-rooted .NET import closures cannot mint single TRX", () => {
  for (const extension of ["txt", "inc"]) {
    const [detection] = detectLanguageFamilies({ files: ["App.Tests.csproj", `selectors/first.${extension}`, "selectors/second.txt"], readFile: (path) => path === "App.Tests.csproj" ? CSPROJ_WITH_CUSTOM_PROPS(`selectors/first.${extension}`) : path === `selectors/first.${extension}` ? '<Project><Import Project="second.txt" /></Project>' : PROPS_MULTI });
    assert.ok(detection?.testsAmbiguous, "a transitive nonstandard imported multi-target file is ambiguous"); assert.deepEqual(languageReportDescriptors([detection!]), []);
  }
  for (const raw of ["$(MSBuildThisFileDirectory)selectors/extra.props", "$(LocalProps)"]) {
    const [detection] = detectLanguageFamilies({ files: ["App.Tests.csproj"], readFile: () => CSPROJ_WITH_CUSTOM_PROPS(raw) });
    assert.ok(detection?.testsAmbiguous, "unknown local property identity cannot qualify one target"); assert.deepEqual(languageReportDescriptors([detection!]), []);
  }
});

test("V3 root F6: Python imported submodule names participate for absolute and relative packages", async () => {
  for (const [source, helper] of [["from pkg import submodule\n", "pkg/submodule.py"], ["from pkg import nested\n", "pkg/nested/__init__.py"], ["from .pkg import submodule\n", "pkg/submodule.py"]] as const) {
    const { root, revision } = await v3Repo({ "conftest.py": source, "pkg/__init__.py": "# pkg\n", [helper]: "setting = 1\n", "pytest.ini": "[pytest]\n" });
    try { const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] }); writeFileSync(join(root, helper), "setting = 2\n"); await runGit({ cwd: root, args: ["add", "-A"] }); await runGit({ cwd: root, args: ["commit", "-m", "only imported submodule"] }); const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim(); const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] }); assert.notEqual(candidate.configDigest, pin.configDigest, `${source.trim()} tracks the actual imported member`); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("V3 root F6: custom XML Maven parent changes participate transitively", async () => {
  const { root, revision } = await v3Repo({ "pom.xml": '<project><parent><relativePath>parent/custom.xml</relativePath></parent></project>', "parent/custom.xml": '<project><parent><relativePath>helper.xml</relativePath></parent></project>', "parent/helper.xml": '<project><version>1</version></project>' });
  try { const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] }); writeFileSync(join(root, "parent/helper.xml"), '<project><version>2</version></project>'); await runGit({ cwd: root, args: ["add", "-A"] }); await runGit({ cwd: root, args: ["commit", "-m", "only custom parent helper"] }); const changed = (await runGit({ cwd: root, args: ["rev-parse", "HEAD"] })).stdout.trim(); const candidate = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: changed, commands: [] }); assert.notEqual(candidate.configDigest, pin.configDigest); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("V3 root F6: property-rooted local MSBuild imports refuse unknown identity", async () => {
  for (const raw of ["$(MSBuildThisFileDirectory)selectors/extra.props", "$(LocalProps)"]) {
    const { root, revision } = await v3Repo({ "App.Tests.csproj": CSPROJ_WITH_CUSTOM_PROPS(raw) });
    try { await assert.rejects(inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: [] }), /unavailable/); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("V3 root F5: tracked Sdk.props is a local import in detector and actual profile", async () => {
  const files = { "App.Tests.csproj": CSPROJ_WITH_CUSTOM_PROPS("Sdk.props"), "Sdk.props": PROPS_MULTI };
  const [detection] = detectLanguageFamilies({ files: Object.keys(files), readFile: (path) => files[path as keyof typeof files] });
  assert.ok(detection?.testsAmbiguous, "a filename does not establish SDK provenance");
  assert.deepEqual(languageReportDescriptors([detection!]), []);
  const { root, revision } = await v3Repo(files);
  try { const profile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: root, targetRevision: revision, execute: runGit }); assert.ok(profile.commands.tests); assert.equal(profile.reports, undefined); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
