import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "runner-v2-portable-execution.yml");
const task12CiTests = [
  "runner-v2/test/cli-capabilities-config.test.ts",
  "runner-v2/test/managed-shared-native.test.ts",
  "runner-v2/test/managed-strict-oci.test.ts",
  "runner-v2/test/mcp-lazy-native.test.ts",
  "runner-v2/test/mcp-tools.test.ts",
  "runner-v2/test/native-build-manager.test.ts",
  "runner-v2/test/oci-execution-isolation-provider.test.ts",
  "runner-v2/test/package-parity.test.ts",
  "runner-v2/test/portable-execution-workflow.test.ts",
  "runner-v2/test/recovery-smoke.test.ts",
  "runner-v2/test/runner-entrypoints.test.ts",
  "runner-v2/test/runner-resource-cleanup.test.ts",
  "runner-v2/test/static-adapter-policy.test.ts",
] as const;

test("portable execution CI covers every host on both maintained Node lines and cannot silently skip Docker integration", () => {
  assert.equal(existsSync(workflowPath), true, "Task 12 portable execution workflow is missing.");
  const source = readFileSync(workflowPath, "utf8");
  const portable = jobBlock(source, "portable-contract");  const native = jobBlock(source, "native-adapter");
  const packages = jobBlock(source, "package-gate");
  const docker = jobBlock(source, "docker-oci-integration");
  const crossHost = jobBlock(source, "package-cross-host");

  for (const block of [portable, native, packages]) {
    for (const host of ["windows-latest", "ubuntu-latest", "macos-latest"]) assert.match(block, new RegExp(host));
    assert.match(block, /node-version:\s*\[22\.x,\s*24\.x\]/);
    assert.match(block, /node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/);
  }
  assert.match(portable, /process-backend-contract\.test\.ts/);
  assert.match(portable, /static-adapter-policy\.test\.ts/);
  assert.match(packages, /package-parity\.test\.ts/);
  assert.match(packages, /runner-entrypoints\.test\.ts/);
  assert.match(packages, /portable-execution-workflow\.test\.ts/);
  for (const testPath of task12CiTests) {
    assert.equal(source.includes(testPath), true, `Task 12 CI omits ${testPath}.`);
  }
  for (const match of source.matchAll(/runner-v2\/test\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
    assert.equal(existsSync(join(repoRoot, match[0])), true, `Workflow references missing test file ${match[0]}.`);
  }

  assert.match(docker, /docker\s+info/i);
  assert.match(docker, /docker\s+pull\s+alpine:latest/i);
  assert.match(docker, /docker\s+pull\s+node:24-slim/i);
  assert.match(docker, /RUNNER_V2_REQUIRE_DOCKER:\s*["']?1["']?/);
  assert.match(docker, /oci-execution-isolation-provider\.test\.ts/);
  assert.match(docker, /managed-strict-oci\.test\.ts/);  assert.match(docker, /mcp-tools\.test\.ts/);
  assert.doesNotMatch(docker, /--test-name-pattern/, "Docker CI must not turn green merely because a selected test name changed.");

  assert.match(packages, /actions\/upload-artifact@v4/);
  assert.match(packages, /runner-v2-package-hashes\.mjs\s+write/);
  assert.match(crossHost, /needs:\s*package-gate/);
  assert.match(crossHost, /node-version:\s*\[22\.x,\s*24\.x\]/);
  assert.match(crossHost, /actions\/download-artifact@v4/);
  assert.match(crossHost, /runner-v2-package-hashes\.mjs\s+compare/);
});

test("native adapter CI runs each host-specific backend suite only on the hosts that can execute it", () => {
  const native = jobBlock(readFileSync(workflowPath, "utf8"), "native-adapter");
  const steps = stepBlocks(native);
  const owning = (testPath: string) => {
    const matches = steps.filter((step) => step.includes(testPath));
    assert.equal(matches.length, 1, `Exactly one native-adapter step must run ${testPath}.`);
    return matches[0]!;
  };

  // The Windows Job-object backend throws "unavailable on linux" before any
  // assertion, so scheduling it off-Windows fails the matrix by construction.
  for (const windowsOnly of ["windows-process-backend.test.ts", "windows-job-process-channel.test.ts"])
    assert.match(owning(windowsOnly), /if:\s*runner\.os\s*==\s*'Windows'/,
      `${windowsOnly} must be gated to Windows hosts.`);
  assert.match(owning("windows-process-backend.test.ts"), /--test-concurrency=1/,
    "Windows native adapter tests must run serially; Job/startup probes starve under default node:test parallelism.");
  assert.match(owning("posix-process-backend.test.ts"), /if:\s*runner\.os\s*!=\s*'Windows'/,
    "The POSIX backend suite must be gated to POSIX hosts.");
  for (const portable of ["managed-shared-native.test.ts", "mcp-lazy-native.test.ts"])
    assert.doesNotMatch(owning(portable), /^\s+if:/m, `${portable} is host-portable and must run on every host.`);
});

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

function stepBlocks(job: string): string[] {
  const lines = job.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => (/^      - name:/.test(line) ? [index] : []));
  assert.notEqual(starts.length, 0, "Workflow job declares no steps.");
  return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length).join("\n"));
}
