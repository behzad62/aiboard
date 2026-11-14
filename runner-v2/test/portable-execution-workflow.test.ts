import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "runner-v2-portable-execution.yml");
const qualificationWorkflowPath = join(repoRoot, ".github", "workflows", "runner-v2-qualification.yml");
const nativeSmokeScript = "scripts/runner-v2-native-smoke.mts";

const deterministicPrTests = [
  "runner-v2/test/process-backend-contract.test.ts",
  "runner-v2/test/runner-capabilities-config.test.ts",
  "runner-v2/test/runner-capability-contract.test.ts",
  "runner-v2/test/plugin-loader.test.ts",
  "runner-v2/test/qualification-harness.test.ts",
  "runner-v2/test/oci-canonical-paths.test.ts",
  "runner-v2/test/a1-terminal-capture.test.ts",
  "runner-v2/test/owned-fixture-teardown.test.ts",
  "runner-v2/test/planning-ui-fixture.test.ts",
  "runner-v2/test/native-build-manager.test.ts",
  "runner-v2/test/native-build-manager-readers.test.ts",
  // VF3: the v1/v2 final-verification contract gate, in memory (about 1 s).
  "runner-v2/test/verification-plan-v2-contract.test.ts",
  // VF4: aiboard-validation.json checks, mandatory and the missing-tool pause, in memory (about 1 s).
  "runner-v2/test/project-validation-checks.test.ts",
  // VF8: known defects at the repair limit and the handoff's Not verified section, in memory (about 2 s).
  "runner-v2/test/verification-known-defects.test.ts",
  "runner-v2/test/handoff-not-verified.test.ts",
  // VF8: a failed start leaves its program not proven stopped unless the service cleaned it up (no process, about 1 s).
  "runner-v2/test/final-verification-managed-authority.test.ts",
  // VF9: this repository's aiboard-validation.json and the guide's example, read with the Runner's parser (no process, about 2 s).
  "runner-v2/test/repository-validation-config.test.ts",
  // The owned fence lock's Windows self-birth preparation through withOwnedFenceLock, on a fake clock, plus the
  // Windows Job host's wiring (about 1 s).
  "runner-v2/test/owned-fence-self-birth.test.ts",
  // A remote UNC path is refused before any filesystem call, in every remote file tool (an fs spy, no network, under 1 s).
  "runner-v2/test/remote-path-syntax-first.test.ts",
  "runner-v2/test/runner-resource-cleanup.test.ts",
  "runner-v2/test/static-adapter-policy.test.ts",
  "runner-v2/test/package-parity.test.ts",
  "runner-v2/test/runner-entrypoints.test.ts",
  "runner-v2/test/node-version.test.ts",
  "runner-v2/test/portable-execution-workflow.test.ts",
] as const;

const posixHostedTests = [
  "runner-v2/test/portable-process-protocol.test.ts",
  "runner-v2/test/portable-process-channel.test.ts",
  "runner-v2/test/posix-process-backend.test.ts",
] as const;

const targetedLegacyRepairTests = [
  "runner-v2/test/cli-capabilities-config.test.ts",
] as const;

/** Former giant mixed qualification invocations — must not remain as hosted qualification entrypoints. */
const retiredQualificationMonoliths = [
  "runner-v2/test/cli-capabilities-config.test.ts",
  "runner-v2/test/runner-capabilities-config.test.ts",
  "runner-v2/test/runner-capability-contract.test.ts",
  "runner-v2/test/plugin-loader.test.ts",
  "runner-v2/test/recovery-smoke.test.ts",
  "runner-v2/test/windows-process-backend.test.ts",
  "runner-v2/test/windows-job-process-channel.test.ts",
  "runner-v2/test/posix-process-backend.test.ts",
  "runner-v2/test/managed-shared-native.test.ts",
  "runner-v2/test/mcp-lazy-native.test.ts",
  "runner-v2/test/portable-process-protocol.test.ts",
  "runner-v2/test/portable-process-channel.test.ts",
  "runner-v2/test/oci-execution-isolation-provider.test.ts",
  "runner-v2/test/managed-strict-oci.test.ts",
  "runner-v2/test/mcp-tools.test.ts",
] as const;

const qualificationEntrypoints = [
  "runner-v2/test/qualification/native-lifecycle.test.ts",
  "runner-v2/test/qualification/cli-readiness.test.ts",
  "runner-v2/test/qualification/recovery.test.ts",
  "runner-v2/test/qualification/windows-portable-channel.test.ts",
  "runner-v2/test/qualification/docker-oci.test.ts",
] as const;

const qualificationOnlyLeakGuards = [
  "runner-v2/test/recovery-smoke.test.ts",
  "runner-v2/test/windows-process-backend.test.ts",
  "runner-v2/test/windows-job-process-channel.test.ts",
  "runner-v2/test/managed-shared-native.test.ts",
  "runner-v2/test/mcp-lazy-native.test.ts",
  "runner-v2/test/oci-execution-isolation-provider.test.ts",
  "runner-v2/test/managed-strict-oci.test.ts",
  "runner-v2/test/mcp-tools.test.ts",
  ...qualificationEntrypoints,
] as const;

test("required PR CI stays deterministic on every supported Node 24 host", () => {
  assert.equal(existsSync(workflowPath), true, "Task 12 portable execution workflow is missing.");
  const source = readFileSync(workflowPath, "utf8");
  assert.match(source, /^\s*pull_request:/m);
  const portable = jobBlock(source, "portable-contract");
  const packages = jobBlock(source, "package-gate");

  for (const block of [portable, packages]) {
    for (const host of ["windows-latest", "ubuntu-latest", "macos-latest"]) assert.match(block, new RegExp(host));
    assert.match(block, /node-version:\s*\[24\.x\]/);
  }
  for (const testPath of deterministicPrTests) {
    assert.equal(source.includes(testPath), true, `Required PR CI omits deterministic test ${testPath}.`);
  }
  const ociStep = portable.indexOf("      - name: Run OCI canonical path contracts");
  assert.ok(ociStep > 0, "Public OCI path contracts require their own host-birth inspection step.");
  assert.equal(portable.slice(0, ociStep).includes("runner-v2/test/oci-canonical-paths.test.ts"), false,
    "Native fence self-birth inspection must not overlap the concurrent deterministic files.");
  assert.match(portable.slice(ociStep), /--test --test-concurrency=1\s+runner-v2\/test\/oci-canonical-paths\.test\.ts/);
  for (const testPath of posixHostedTests) {
    assert.equal(source.includes(testPath), true, `Required POSIX PR CI omits ${testPath}.`);
  }
  for (const testPath of targetedLegacyRepairTests) {
    assert.equal(source.includes(testPath), true, `Required CI omits targeted repaired regression ${testPath}.`);
  }
  assert.match(portable,
    /if:\s*runner\.os\s*!=\s*'Windows'[\s\S]*portable-process-protocol\.test\.ts[\s\S]*portable-process-channel\.test\.ts/,
    "Real owned-fence protocol/channel files must stay off required Windows PR CI and run there in qualification.");
  const acknowledgementStep = portable.indexOf("      - name: Run portable input acknowledgement deadline contracts on Windows");
  assert.ok(acknowledgementStep > 0, "Required Windows PR CI must prove durable input acknowledgement deadline outcomes.");
  const acknowledgementBlock = portable.slice(acknowledgementStep, portable.indexOf("\n      - name:", acknowledgementStep + 1));
  assert.match(acknowledgementBlock, /if:\s*runner\.os\s*==\s*'Windows'/);
  assert.match(acknowledgementBlock, /--test --test-concurrency=1\s+--test-name-pattern="\^portable command deadline reconciles durable acknowledgement "\s+runner-v2\/test\/portable-process-channel\.test\.ts/);
  const acknowledgementPattern = new RegExp(acknowledgementBlock.match(/--test-name-pattern="([^"]+)"/)![1]!);
  assert.equal(acknowledgementPattern.test("portable command deadline reconciles durable acknowledgement takeover"), true);
  assert.equal(acknowledgementPattern.test("portable reconcile and release reject corrupt acknowledgement evidence"), false);
  assert.match(portable,
    /--test-name-pattern=[^\n]*active legacy Build[^\n]*unsupported persisted execution-safety[\s\S]*?cli-capabilities-config\.test\.ts/,
    "Legacy CLI repairs must stay targeted instead of restoring the giant file as a full gate.");
  const backendStep = portable.indexOf("      - name: Run POSIX process backend contracts on POSIX hosts");
  assert.ok(backendStep > 0, "Required POSIX PR CI must run the POSIX process backend contracts.");
  const backendBlock = portable.slice(backendStep, portable.indexOf("\n      - name:", backendStep + 1));
  assert.match(backendBlock, /if:\s*runner\.os\s*!=\s*'Windows'/);
  assert.match(backendBlock, /--test --test-concurrency=1\s+runner-v2\/test\/posix-process-backend\.test\.ts/);
  assert.doesNotMatch(backendBlock, /--test-name-pattern/,
    "The whole POSIX backend file runs: under one name pattern the rest of it went stale unseen.");
  const inputWaitStep = portable.indexOf("      - name: Run T1 input-wait evidence and acceptance on POSIX hosts");
  assert.ok(inputWaitStep > 0, "T1 acceptance is the only proof of POSIX CPU evidence on Linux and macOS.");
  const inputWaitBlock = portable.slice(inputWaitStep);
  assert.match(inputWaitBlock, /if:\s*runner\.os\s*!=\s*'Windows'/);
  for (const testPath of ["posix-process-usage", "managed-process-wait-tracker", "managed-interaction-native"])
    assert.equal(inputWaitBlock.includes(`runner-v2/test/${testPath}.test.ts`), true, `POSIX T1 CI omits ${testPath}.`);
  for (const testPath of qualificationOnlyLeakGuards) {
    assert.equal(source.includes(testPath), false, `Host-sensitive qualification-only test leaked into required PR CI: ${testPath}.`);
  }
  assert.equal(source.includes("runner-v2/test/verification-plan-v2.test.ts"), false,
    "VF3's process tests (about 30 s of real checkouts and servers) stay out of required PR CI.");
  assert.equal(source.includes(nativeSmokeScript), true, "Required PR CI must retain one lightweight native-host smoke probe.");
  assert.doesNotMatch(source, /^  docker-oci-integration:/m,
    "Full Docker integration belongs to qualification, not the required hosted-runner PR gate.");
  assertWorkflowTestPathsExist(source);
});

test("host-sensitive lifecycle and Docker coverage uses focused qualification entrypoints", () => {
  assert.equal(existsSync(qualificationWorkflowPath), true, "Runner V2 qualification workflow is missing.");
  const source = readFileSync(qualificationWorkflowPath, "utf8");
  assert.match(source, /^\s*workflow_dispatch:/m);
  assert.match(source, /^\s*schedule:/m);
  assert.match(source, /^\s*pull_request:\s*\n\s*types:\s*\[labeled\]/m,
    "Qualification needs a label-only PR trigger so a pre-merge tip can be qualified explicitly.");
  const labelGuards = source.match(/github\.event\.label\.name\s*==\s*'runner-v2-qualification'/g) ?? [];
  assert.equal(labelGuards.length, 5,
    "Every qualification job must stay gated behind the explicit runner-v2-qualification PR label.");
  assert.match(source, /node-version:\s*\[24\.x\]/);
  assert.doesNotMatch(source, /node-version:\s*\[[^\]]*22/);

  for (const testPath of qualificationEntrypoints) {
    assert.equal(source.includes(testPath), true, `Qualification coverage omits focused entrypoint ${testPath}.`);
    const entryPath = join(repoRoot, testPath);
    assert.equal(existsSync(entryPath), true, `Focused qualification entrypoint missing on disk: ${testPath}.`);
    const entrySource = readFileSync(entryPath, "utf8");
    assert.match(entrySource, /hostPoisoned/,
      `Focused qualification entrypoint must fail-stop after a scenario failure: ${testPath}.`);
    assert.match(entrySource, /no later scenario may start/,
      `Focused qualification entrypoint must not launch later scenarios on a poisoned host: ${testPath}.`);
  }
  for (const testPath of retiredQualificationMonoliths) {
    assert.equal(source.includes(testPath), false,
      `Qualification still invokes retired monolith ${testPath}; use focused qualification/** entrypoints.`);
  }

  const native = jobBlock(source, "native-lifecycle");
  const cli = jobBlock(source, "cli-readiness");
  const recovery = jobBlock(source, "recovery");
  const portable = jobBlock(source, "windows-portable-channel");
  const docker = jobBlock(source, "docker-oci-integration");

  assert.match(source, /qualification-scope:[\s\S]*?default: full[\s\S]*?options:\s*\n\s*- full\s*\n\s*- docker-oci-only/);
  for (const block of [native, cli, recovery, portable]) {
    const guard = block.split(/\r?\n/).find((line) => line.trimStart().startsWith("if:"))!;
    assert.match(guard, /github\.event_name != 'workflow_dispatch' \|\| inputs\['qualification-scope'\] != 'docker-oci-only'/);
    assert.doesNotMatch(guard, /matrix\./, "Job selection must use only event/input context before matrix expansion.");
  }
  assert.match(docker, /if: github\.event_name != 'pull_request' \|\| github\.event\.label\.name == 'runner-v2-qualification'/);
  assert.doesNotMatch(docker.split(/\r?\n/).find((line) => line.trimStart().startsWith("if:"))!, /qualification-scope/);
  assert.match(docker, /timeout-minutes: 45/);

  assert.match(native, /qualification\/native-lifecycle\.test\.ts/);
  assert.match(cli, /qualification\/cli-readiness\.test\.ts/);
  assert.match(recovery, /qualification\/recovery\.test\.ts/);
  assert.match(portable, /qualification\/windows-portable-channel\.test\.ts/);
  assert.match(docker, /qualification\/docker-oci\.test\.ts/);

  assert.match(source, /RUNNER_V2_REQUIRE_DOCKER:\s*["']?1["']?/);
  assert.match(source, /docker\s+info/i);
  assert.match(source, /actions\/upload-artifact@v7/,
    "Qualification must upload failure diagnostics artifacts.");
  assert.match(source, /if:\s*always\(\)/,
    "Artifact upload must use always() so killed/hung jobs still surface pre-created evidence roots.");
  assertWorkflowTestPathsExist(source);
});

test("Docker-only manual scope preserves full, schedule and labelled qualification selection", () => {
  const source = readFileSync(qualificationWorkflowPath, "utf8");
  const jobs = ["native-lifecycle", "cli-readiness", "recovery", "windows-portable-channel", "docker-oci-integration"];
  for (const scenario of [
    { event: "workflow_dispatch", scope: "full", label: undefined, ordinary: true },
    { event: "workflow_dispatch", scope: undefined, label: undefined, ordinary: true },
    { event: "workflow_dispatch", scope: "docker-oci-only", label: undefined, ordinary: false },
    { event: "schedule", scope: undefined, label: undefined, ordinary: true },
    { event: "pull_request", scope: undefined, label: "runner-v2-qualification", ordinary: true },
    { event: "pull_request", scope: undefined, label: "unrelated", ordinary: false },
  ]) {
    for (const job of jobs) {
      const guard = jobBlock(source, job).split(/\r?\n/).find((line) => line.trimStart().startsWith("if:"))!.trim().slice(3);
      // These owned workflow guards use only the common boolean event/input expression subset.
      const selected = new Function("github", "inputs", `return (${guard});`)(
        { event_name: scenario.event, event: { label: { name: scenario.label } } },
        { "qualification-scope": scenario.scope },
      );
      const expected = job === "docker-oci-integration" && scenario.event === "workflow_dispatch"
        ? true : scenario.ordinary;
      assert.equal(selected, expected, `${job}: ${scenario.event}/${scenario.scope}/${scenario.label}`);
    }
  }
});

test("required native smoke is an adapter probe rather than a lifecycle timing test", () => {
  const source = readFileSync(workflowPath, "utf8");
  // One lightweight native probe on every host: a step of portable-contract (Windows, Ubuntu and macOS) that runs on
  // each of them, right after dependencies are installed and before any contract test.
  const portable = jobBlock(source, "portable-contract");
  for (const host of ["windows-latest", "ubuntu-latest", "macos-latest"]) assert.match(portable, new RegExp(`os:\\s*\\[[^\\]]*${host}`));
  assert.doesNotMatch(portable, /^\s+exclude:/m, "Every portable-contract host runs the native probe.");
  const steps = portable.split(/\n(?=      - name: )/).slice(1);
  const probes = steps.filter((step) => step.includes(nativeSmokeScript));
  assert.equal(probes.length, 1, "portable-contract runs the native adapter probe exactly once.");
  const probe = probes[0]!;
  assert.doesNotMatch(probe, /^\s+if:/m, "The native adapter probe runs on every host, never behind a condition.");
  assert.match(probe, new RegExp(`run: node node_modules/tsx/dist/cli\\.mjs ${nativeSmokeScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`));
  assert.doesNotMatch(probe, /--test\b/);
  for (const testPath of [...qualificationEntrypoints, ...retiredQualificationMonoliths]) {
    assert.equal(probe.includes(testPath), false);
  }
  const index = steps.indexOf(probe);
  const lastInstall = steps.findLastIndex((step) => /npm ci|actions\/cache\/(?:restore|save)/.test(step));
  const firstTest = steps.findIndex((step) => /--test\b/.test(step));
  assert.ok(lastInstall >= 0 && index > lastInstall, "The probe runs after dependencies are installed.");
  assert.ok(firstTest > index, "The probe runs before any contract test.");
  assert.equal(source.split(nativeSmokeScript).length, 2, "The probe has no second copy in another job.");
});

test("package parity remains cross-host and reproducible on Node 24", () => {
  const source = readFileSync(workflowPath, "utf8");
  const packages = jobBlock(source, "package-gate");
  const crossHost = jobBlock(source, "package-cross-host");
  assert.match(packages, /actions\/upload-artifact@v7/);
  assert.match(packages, /runner-v2-package-hashes\.mjs\s+write/);
  assert.match(crossHost, /needs:\s*package-gate/);
  assert.match(crossHost, /node-version:\s*\[24\.x\]/);
  assert.match(crossHost, /actions\/download-artifact@v8/);
  assert.match(crossHost, /runner-v2-package-hashes\.mjs\s+compare/);
});

test("the pull_request path filter skips docs-only and web-only changes but never a file a portable test reads", () => {
  const source = readFileSync(workflowPath, "utf8");
  const patterns = pullRequestPaths(source);
  assert.ok(patterns.length > 0, "The pull_request trigger lists its paths.");
  const runs = (file: string) => patterns.reduce((included, pattern) =>
    pattern.startsWith("!") ? (globMatches(pattern.slice(1), file) ? false : included) : (globMatches(pattern, file) ? true : included), false);

  for (const file of ["runner-v2/src/build-runtime.ts", "runner-v2/test/package-parity.test.ts", "runner-v2/skills/tdd/SKILL.md",
    "runner-v2/MCP.md", "package.json", "package-lock.json", "scripts/publish-downloads.mjs", "public/aiboard-runner-v2.zip",
    "release/channel.json", ".github/workflows/runner-v2-portable-execution.yml", ".github/workflows/runner-v2-qualification.yml"]) {
    assert.equal(runs(file), true, `A pull request that changes ${file} must run the portable workflow.`);
  }
  for (const file of ["docs/plans/plan.md", "README.md", "AGENTS.md", "app/page.tsx", "components/DashboardPage.tsx",
    "lib/client/engine.ts", "tests/e2e/catalog-model-metadata.spec.ts", ".github/workflows/benchmark-tests.yml"]) {
    assert.equal(runs(file), false, `A pull request that only changes ${file} should skip the portable workflow.`);
  }

  // Every repository file outside runner-v2 that a workflow test or script names by a relative path (../../x), by
  // join(repoRoot | runnerRoot, ...), or as a published legal file, must be one this filter runs for.
  const readers = [...new Set(source.match(/(?:runner-v2\/test|scripts)\/[A-Za-z0-9_./-]+\.(?:test\.ts|mts|mjs)/g) ?? [])];
  const inputs = new Set<string>();
  for (const reader of readers) {
    const text = readFileSync(join(repoRoot, reader), "utf8");
    const base = dirname(join(repoRoot, reader));
    for (const match of text.matchAll(/["'`]((?:\.\.\/)+[A-Za-z0-9_][^"'`$]*)["'`]/g)) inputs.add(relativeToRepo(join(base, match[1]!)));
    const rootNames = reader.startsWith("scripts/") ? "repoRoot|root" : "repoRoot|runnerRoot";
    for (const match of text.matchAll(new RegExp(`join\\((${rootNames})((?:,\\s*"[^"]+")+)\\)`, "g"))) {
      const parts = [...match[2]!.matchAll(/"([^"]+)"/g)].map((part) => part[1]!);
      inputs.add(relativeToRepo(join(match[1] === "runnerRoot" ? join(repoRoot, "runner-v2") : repoRoot, ...parts)));
    }
    for (const match of text.matchAll(/legalFile of \[([^\]]+)\]/g)) {
      for (const name of match[1]!.matchAll(/"([^"]+)"/g)) inputs.add(name[1]!);
    }
  }
  const checked = [...inputs].filter((file) => !file.startsWith("..") && existsSync(join(repoRoot, file)));
  assert.ok(checked.includes("lib/db/schema.ts") && checked.includes("TRADEMARKS.md"), `The input scan found ${JSON.stringify(checked)}.`);
  for (const file of checked) {
    assert.equal(runs(file), true, `A portable test or the publisher reads ${file}; add it after the exclusions in the pull_request paths.`);
  }
});

function pullRequestPaths(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const trigger = lines.findIndex((line) => line === "  pull_request:");
  assert.notEqual(trigger, -1, "Missing the pull_request trigger.");
  const paths = lines.findIndex((line, index) => index > trigger && line === "    paths:");
  const patterns: string[] = [];
  for (let index = paths + 1; paths !== -1 && index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const entry = line.match(/^      - "([^"]+)"$/);
    if (!entry) break;
    patterns.push(entry[1]!);
  }
  return patterns;
}

/** GitHub's path filter globs: `*` stays inside one folder, `**` crosses folders, `**\/` may match no folder. */
function globMatches(glob: string, file: string): boolean {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") { pattern += "(?:.*/)?"; index += 2; } else { pattern += ".*"; index += 1; }
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(file);
}

function relativeToRepo(path: string): string {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function jobBlock(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `Missing workflow job ${name}.`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index]!)) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

function assertWorkflowTestPathsExist(source: string): void {
  for (const match of source.matchAll(/runner-v2\/test\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
    assert.equal(existsSync(join(repoRoot, match[0])), true, `Workflow references missing test file ${match[0]}.`);
  }
}
