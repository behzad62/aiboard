import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectFinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import { captureGitBaseline, IntegrationManager, runGit } from "./support/git-fixture.js";

test("installed npm CLI resolves with empty ambient and pins npm argv/provisioning", async () => {
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const posixInstalled = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const discovered = existsSync(bundled) ? bundled : existsSync(posixInstalled) ? posixInstalled : undefined;
  assert.ok(discovered, "real installed npm CLI must exist at a known Node-install location");
  const version = execFileSync(process.execPath, [discovered, "--version"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe",
    windowsHide: true,
  }) as unknown as string;
  assert.match(version.trim(), /^\d+\.\d+\.\d+/);
  const fixture = await createNpmFixture("empty-ambient", discovered);
  let primaryError: unknown;
  let hasPrimary = false;
  try {
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: fixture.integration.path,
      targetRevision: fixture.integration.revision,
      execute: runGit,
      ambientEnvironment: {},
    });
    assert.equal(profile.targetRevision, fixture.integration.revision);
    assert.equal(profile.commands.tests?.[0]?.executable, process.execPath);
    assert.equal(profile.commands.tests?.[0]?.args[0], discovered);
    assert.deepEqual(profile.commands.tests?.[0]?.args.slice(1), ["run", "test"]);
    assert.equal(profile.commands.build?.[0]?.executable, process.execPath);
    assert.equal(profile.commands.build?.[0]?.args[0], discovered);
    assert.deepEqual(profile.commands.build?.[0]?.args.slice(-2), ["run", "build"]);
    assert.equal(profile.provisioning?.manager, "npm");
    assert.equal(profile.provisioning?.lockfile, "package-lock.json");
    assert.equal(profile.provisioning?.command.executable, process.execPath);
    assert.equal(profile.provisioning?.command.args[0], discovered);
    assert.deepEqual(profile.provisioning?.command.args.slice(-3), ["ci", "--no-audit", "--no-fund"]);
    assert.ok(profile.detectedSignals.some((signal) => signal.category === "tests" && signal.source === "package.json#scripts.test"));
    assert.ok(profile.detectedSignals.some((signal) => signal.category === "build" && signal.source === "package.json#scripts.build"));
    assert.ok(profile.inspectedPaths.includes("package.json"));
    assert.ok(profile.inspectedPaths.includes("package-lock.json"));
  } catch (error) {
    primaryError = error;
    hasPrimary = true;
  }
  await teardownNpmFixture(fixture, primaryError, hasPrimary);
});

test("explicit missing npm_execpath fails closed without fallback to installed npm", async () => {
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const posixInstalled = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  assert.ok(existsSync(bundled) || existsSync(posixInstalled), "real installed npm bundle must exist for the fail-closed proof");
  const installedCli = existsSync(bundled) ? bundled : posixInstalled;
  const fixture = await createNpmFixture("missing-explicit", installedCli);
  let primaryError: unknown;
  let hasPrimary = false;
  try {
    const missingCli = join(fixture.root, "missing-npm-cli.js");
    assert.equal(existsSync(missingCli), false);
    await assert.rejects(
      () => inspectFinalVerificationExecutionProfile({
        repositoryRoot: fixture.integration.path,
        targetRevision: fixture.integration.revision,
        execute: runGit,
        ambientEnvironment: { npm_execpath: missingCli },
      }),
      /Declared npm package manager is unavailable/,
    );
  } catch (error) {
    primaryError = error;
    hasPrimary = true;
  }
  await teardownNpmFixture(fixture, primaryError, hasPrimary);
});

async function teardownNpmFixture(
  fixture: { root: string; close: () => Promise<void> },
  primaryError: unknown,
  hasPrimary: boolean,
): Promise<void> {
  try {
    await fixture.close();
  } catch (teardownError) {
    if (hasPrimary) {
      throw new AggregateError([primaryError, teardownError], `npm fixture primary and teardown failures; owned root: ${fixture.root}`);
    }
    throw teardownError;
  }
  if (hasPrimary) {
    throw primaryError;
  }
}

async function createNpmFixture(tag: string, npmCli: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-npm-installed-")));
  const project = join(root, "project");
  const state = join(root, "state");
  const runId = `npm-installed-${tag}`;
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "npm-fixture",
    packageManager: "npm@11.0.0",
    scripts: { build: "node build.mjs", test: "node --test" },
    dependencies: { "local-package": "file:./local-package" },
  }, null, 2));
  writeFileSync(join(project, "build.mjs"), "console.log('build')\n");
  mkdirSync(join(project, "local-package"), { recursive: true });
  writeFileSync(join(project, "local-package", "package.json"), JSON.stringify({ name: "local-package", version: "1.0.0" }));
  // NOTE: The writer did not run the actual npm command below; future test executions perform it.
  // Generate a genuine package-lock.json with the already-discovered installed npm CLI only.
  // Local file dependency only (local-package); no remote dependencies and no network claim.
  execFileSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: project,
    timeout: 30_000,
    stdio: "pipe",
    windowsHide: true,
  });
  const lockPath = join(project, "package-lock.json");
  assert.ok(existsSync(lockPath), "genuine package-lock.json must exist after npm install --package-lock-only");
  const lockText = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(lockText) as { name?: unknown };
  assert.equal(lock.name, "npm-fixture");
  assert.ok(lockText.includes("local-package"), "genuine lock must reference the fixture local-package");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return {
    root,
    state,
    runId,
    integration,
    close: async () => {
      try {
        await integration.cleanup();
      } catch (error) {
        throw new Error(`npm fixture integration cleanup failed; owned root retained for diagnosis: ${root}`, { cause: error });
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        throw new Error(`npm fixture owned root removal failed and may be partially removed: ${root}`, { cause: error });
      }
    },
  };
}
