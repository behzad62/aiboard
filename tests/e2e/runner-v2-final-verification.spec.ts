import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

import { ArtifactStore } from "../../runner-v2/src/artifact-store.js";
import { BuildRuntime, type FinalVerificationCheckDriver } from "../../runner-v2/src/build-runtime.js";
import type { BrowserConsoleEvent, BrowserNetworkEvent } from "../../runner-v2/src/browser-tools.js";
import { loadFinalVerificationDiagnostics } from "../../runner-v2/src/build-observability.js";
import {
  FinalVerificationDiagnosticsArchive,
  OwnedFinalVerificationCleanup,
} from "../../runner-v2/src/final-verification-cleanup.js";
import {
  planFinalVerification,
  validateFinalVerificationPlan,
  type FinalVerificationPlan,
} from "../../runner-v2/src/final-verification-contracts.js";
import {
  FinalVerificationRuntime,
  type FinalVerificationBrowserSession,
} from "../../runner-v2/src/final-verification-runtime.js";
import {
  FinalVerificationProfileAuthority,
  type FinalVerificationExecutionProfile,
} from "../../runner-v2/src/final-verification-profile.js";
import { captureGitBaseline } from "../../runner-v2/src/git-baseline.js";
import { runGit } from "../../runner-v2/src/git-command.js";
import { IntegrationManager } from "../../runner-v2/src/integration-manager.js";
import { ManagedProcessService } from "../../runner-v2/src/managed-process.js";
import { SqliteEvidenceStore } from "../../runner-v2/src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../../runner-v2/src/sqlite-scheduler-store.js";
import { VerificationWorkspaceManager } from "../../runner-v2/src/verification-workspace.js";

test.describe("Runner V2 canonical final verification", () => {
  test("verifies the exact integrated revision with real commands, process, browser, evidence, and owned cleanup", async ({ browser }) => {
    test.setTimeout(90_000);
    const fixture = await createFixture("full application");
    const port = await unusedPort();
    let ui: ChildProcessWithoutNullStreams | undefined;
    const evidence = new SqliteEvidenceStore(join(fixture.state, "evidence.sqlite"));
    const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
    const workspace = verificationWorkspace(fixture);
    const managed = new ManagedProcessService({
      stateDirectory: join(fixture.state, "managed processes"),
      platform: "win32",
    });
    const browserSession = new PlaywrightFixtureSession(browser);
    try {
      expect(isWithin(fixture.project, fixture.state)).toBe(false);
      expect(existsSync(join(fixture.project, "verification-workspaces"))).toBe(false);
      const canonicalBefore = await repositoryState(fixture.integration.path);
      ui = await startFixtureServer(fixture.integration.path, port);
      const runtime = new FinalVerificationRuntime({
        workspaceManager: workspace,
        artifacts,
        evidenceStore: evidence,
        managedProcessService: managed,
        browserSession,
        runId: fixture.runId,
        taskId: "final-verification-task",
        generationId: "generation-full",
        attempt: 1,
        currentIntegrationRevision: () => fixture.integration.revision,
      });
      const runtimeSmoke = {
        label: "fixture runtime health",
        executable: process.execPath,
        args: ["server.mjs", "0"],
        endpoint: "http://127.0.0.1:0/health",
        readiness: {
          timeoutMs: 10_000,
          healthCheck: ({ observation }: { observation: { stdout: string } }) => observation.stdout.includes("READY"),
        },
      };
      const browserInput = {
        label: "fixture browser UI",
        url: `http://127.0.0.1:${port}/`,
        policy: {
          consoleErrors: "fail" as const,
          pageErrors: "fail" as const,
          failedNetworkEvents: "fail" as const,
        },
      };
      const run = await runtime.run({
        plan: requiredPlan(),
        executionProfile: executionProfile(fixture.integration.revision, {
          commands: {
            build: [{ label: "fixture build", executable: process.execPath, args: ["build.mjs"] }],
            tests: [{ label: "fixture tests", executable: process.execPath, args: ["test.mjs"] }],
          },
          runtimeSmoke: { ...runtimeSmoke, readiness: { timeoutMs: 10_000 } },
          browser: browserInput,
        }),
        commands: {
          build: [{
            label: "fixture build",
            executable: process.execPath,
            args: ["build.mjs"],
          }],
          tests: [{
            label: "fixture tests",
            executable: process.execPath,
            args: ["test.mjs"],
          }],
        },
        runtimeSmoke,
        browser: browserInput,
      });

      expect(run.green).toBe(true);
      expect(run.targetRevision).toBe(fixture.integration.revision);
      expect(run.checks.map((check) => [check.category, check.green])).toEqual([
        ["build", true], ["tests", true], ["runtime_smoke", true], ["browser", true],
      ]);
      expect(existsSync(join(run.workspacePath, "generated", "bundle.txt"))).toBe(true);
      expect(existsSync(join(fixture.integration.path, "generated", "bundle.txt"))).toBe(false);
      expect(await repositoryState(fixture.integration.path)).toEqual(canonicalBefore);
      expect(existsSync(join(fixture.project, "verification-workspaces"))).toBe(false);
      expect("changeSet" in run).toBe(false);
      expect(browserSession.closed).toBe(true);

      const commandFacts = run.checks.slice(0, 3).flatMap((check) => check.facts)
        .filter((fact) => fact.kind === "command") as unknown as Array<Record<string, unknown>>;
      expect(commandFacts.every((fact) => fact.targetRevision === fixture.integration.revision)).toBe(true);
      expect(commandFacts.every((fact) => fact.cwd === run.workspacePath)).toBe(true);
      expect(commandFacts[0]?.args).toEqual(["build.mjs"]);
      const browserCheck = run.checks[3]!;
      expect(browserCheck.facts.map((fact) => fact.kind)).toEqual([
        "browser_snapshot", "browser_screenshot", "browser_events",
      ]);
      expect(browserCheck.evidenceIds).toHaveLength(3);
      expect(evidence.list({ runId: fixture.runId }).length).toBeGreaterThanOrEqual(6);

      const archive = new FinalVerificationDiagnosticsArchive({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        workspaceManager: workspace,
      });
      const cleanup = new OwnedFinalVerificationCleanup({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        stopRun: async (runId) => await managed.stopRun(runId),
        closeBrowserRun: async () => await browserSession.close(),
        workspaceManager: workspace,
        diagnostics: archive,
      });
      const diagnostic = await cleanup.cleanup({
        generationId: "generation-full",
        taskId: "final-verification-task",
        targetRevision: fixture.integration.revision,
        failed: {
          generationId: "generation-full",
          taskId: "final-verification-task",
          targetRevision: fixture.integration.revision,
          checks: run.checks,
          evidenceReferences: browserCheck.evidenceIds,
          logs: ["authorization=real-secret must never escape"],
        },
      });
      expect(existsSync(run.workspacePath)).toBe(false);
      expect(await repositoryState(fixture.integration.path)).toEqual(canonicalBefore);
      expect(diagnostic.diagnosticsPath).toBeTruthy();
      const runSegment = dirname(dirname(dirname(diagnostic.diagnosticsPath!))).split(/[\\/]/).at(-1)!;
      const loaded = await loadFinalVerificationDiagnostics({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        expectedRunSegment: runSegment,
        diagnosticsPath: diagnostic.diagnosticsPath!,
        generationId: "generation-full",
        taskId: "final-verification-task",
        targetRevision: fixture.integration.revision,
      });
      expect(JSON.stringify(loaded)).not.toContain("real-secret");
      expect(await loadFinalVerificationDiagnostics({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        expectedRunSegment: runSegment,
        diagnosticsPath: join(fixture.root, "foreign.json"),
        generationId: "generation-full",
        taskId: "final-verification-task",
        targetRevision: fixture.integration.revision,
      })).toBeUndefined();
      const crossRunPath = join(fixture.state, "builds", "cross-run", "audit", "final-verification-diagnostics", "generation.json");
      await mkdir(dirname(crossRunPath), { recursive: true });
      await writeFile(crossRunPath, JSON.stringify({
        version: 1, kind: "final-verification-diagnostics", runId: "another-run",
        generationId: "generation-full", taskId: "final-verification-task",
        targetRevision: fixture.integration.revision, changedPaths: [], checks: [],
        evidenceReferences: [], logs: ["secret=cross-run-secret"],
      }));
      expect(await loadFinalVerificationDiagnostics({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        expectedRunSegment: "cross-run",
        diagnosticsPath: crossRunPath,
        generationId: "generation-full",
        taskId: "final-verification-task",
        targetRevision: fixture.integration.revision,
      })).toBeUndefined();
    } finally {
      evidence.close();
      await browserSession.close().catch(() => undefined);
      if (ui) await stopChild(ui);
      await workspace.cleanup().catch(() => undefined);
      await closeFixture(fixture);
    }
  });

  test("keeps inapplicability explicit and rejects detected scripts, integrated breakage, and stale revisions", async () => {
    test.setTimeout(45_000);
    const fixture = await createFixture("mechanical boundaries");
    const evidence = new SqliteEvidenceStore(join(fixture.state, "boundary-evidence.sqlite"));
    const workspace = verificationWorkspace(fixture);
    try {
      const noBuild = planFinalVerification({ checks: [
        na("build", "package.json has no build script"),
        { category: "tests", status: "required" },
        na("runtime_smoke", "no server entry point"),
        na("browser", "no browser surface"),
      ] });
      expect(noBuild.checks[0]).toMatchObject({ category: "build", status: "not_applicable" });
      const detected = validateFinalVerificationPlan(noBuild, { detectedSignals: ["build"] });
      expect(detected.valid).toBe(false);
      expect(detected.detectedNotApplicableCategories).toEqual(["build"]);

      await writeFile(join(fixture.integration.path, "test.mjs"), "process.exit(7);\n");
      await commitAll(fixture.integration.path, "Break integrated tests");
      const currentRevision = (await runGit({ cwd: fixture.integration.path, args: ["rev-parse", "HEAD"] })).stdout.trim();
      const brokenWorkspace = new VerificationWorkspaceManager({
        repositoryRoot: fixture.project,
        stateDirectory: fixture.state,
        runId: fixture.runId,
        targetRevision: currentRevision,
      });
      const runtime = new FinalVerificationRuntime({
        workspaceManager: brokenWorkspace,
        artifacts: new ArtifactStore(join(fixture.state, "boundary-artifacts")),
        evidenceStore: evidence,
        runId: fixture.runId,
        taskId: "boundary-verification",
        currentIntegrationRevision: () => currentRevision,
      });
      const testCommand = { label: "integrated tests", executable: process.execPath, args: ["test.mjs"] };
      const result = await runtime.run({
        plan: noBuild,
        executionProfile: executionProfile(currentRevision, { commands: { tests: [testCommand] } }),
        commands: { tests: [testCommand] },
      });
      expect(result.green).toBe(false);
      expect(result.checks.find((check) => check.category === "tests")?.green).toBe(false);
      expect(result.checks.find((check) => check.category === "tests")?.issues.join(" ")).toMatch(/non-zero/i);

      const staleRevision = fixture.baselineRevision;
      const stale = new VerificationWorkspaceManager({
        repositoryRoot: fixture.project,
        stateDirectory: join(fixture.root, "stale runner state"),
        runId: `${fixture.runId}-stale`,
        targetRevision: staleRevision,
      });
      const staleRuntime = new FinalVerificationRuntime({
        workspaceManager: stale,
        artifacts: new ArtifactStore(join(fixture.state, "stale-artifacts")),
        runId: `${fixture.runId}-stale`,
        currentIntegrationRevision: () => currentRevision,
      });
      await expect(staleRuntime.run({
        plan: noBuild,
        executionProfile: executionProfile(staleRevision, { commands: { tests: [testCommand] } }),
        commands: { tests: [testCommand] },
      }))
        .rejects.toThrow(/stale|current integration revision/i);
      await stale.cleanup().catch(() => undefined);
    } finally {
      evidence.close();
      await workspace.cleanup().catch(() => undefined);
      await closeFixture(fixture);
    }
  });

  test("Runner CLI port zero starts, releases its control port, and reopens durable state with spaced paths", async () => {
    test.setTimeout(60_000);
    const fixture = await createFixture("cli recovery");
    let first: RunnerProcess | undefined;
    let second: RunnerProcess | undefined;
    try {
      first = await startRunner(fixture.project, fixture.state);
      expect((await fetch(`${first.url}/v2/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      const firstPort = Number(new URL(first.url).port);
      await stopRunner(first);
      first = undefined;
      await expectPortReusable(firstPort);

      second = await startRunner(fixture.project, fixture.state);
      expect((await fetch(`${second.url}/v2/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      expect(existsSync(fixture.state)).toBe(true);
      expect(isWithin(fixture.project, fixture.state)).toBe(false);
    } finally {
      if (first) await stopRunner(first);
      if (second) await stopRunner(second);
      await closeFixture(fixture);
    }
  });

  test("restart between categories reuses completed evidence and submits exactly once", async () => {
    test.setTimeout(60_000);
    const fixture = await createFixture("durable category resume");
    const schedulerPath = join(fixture.state, "scheduler.sqlite");
    const evidence = new SqliteEvidenceStore(join(fixture.state, "resume-evidence.sqlite"));
    const workspace = verificationWorkspace(fixture);
    const plan: FinalVerificationPlan = { checks: [
      { category: "build", status: "required" },
      { category: "tests", status: "required" },
      na("runtime_smoke", "no long-running service required for resume fixture"),
      na("browser", "browser already covered by the real fixture test"),
    ] };
    const artifacts = new ArtifactStore(join(fixture.state, "resume-artifacts"));
    const authority = new FinalVerificationProfileAuthority({ stateDirectory: fixture.state, runId: fixture.runId });
    const profile = await authority.inspectAndPersist({
      repositoryRoot: fixture.integration.path,
      targetRevision: fixture.integration.revision,
    });
    const storeOptions = {
      evidenceStore: evidence,
      artifacts,
      validateExecutionProfile: (input: { profile: FinalVerificationExecutionProfile; targetRevision: string }) =>
        authority.validate(input.profile, input.targetRevision),
    };
    let store = new SqliteSchedulerStore(schedulerPath, storeOptions);
    const calls: string[] = [];
    const driver: FinalVerificationCheckDriver = {
      executeCheck: async (input) => {
        calls.push(input.category);
        const runtime = new FinalVerificationRuntime({
          workspaceManager: workspace,
          artifacts,
          evidenceStore: evidence,
          runId: fixture.runId,
          taskId: input.taskId,
          generationId: input.generationId,
          attempt: input.attempt,
          currentIntegrationRevision: () => fixture.integration.revision,
        });
        return await runtime.runCategory({
          plan,
          executionProfile: input.executionProfile,
        }, input.category);
      },
    };
    try {
      seedVerification(store, fixture, plan, profile);
      let runtime = schedulerRuntime(store, evidence, artifacts, driver, fixture.runId);
      expect((await runtime.step()).action).toBe("final_verification_check_completed");
      expect(calls).toEqual(["build"]);
      const evidenceAfterBuild = evidence.list({ runId: fixture.runId });
      expect(evidenceAfterBuild).toHaveLength(1);

      store.close();
      store = new SqliteSchedulerStore(schedulerPath, storeOptions);
      runtime = schedulerRuntime(store, evidence, artifacts, driver, fixture.runId);
      expect((await runtime.step()).action).toBe("final_verification_check_completed");
      expect(calls).toEqual(["build", "tests"]);
      expect((await runtime.step()).action).toBe("final_verification_check_completed");
      expect((await runtime.step()).action).toBe("final_verification_check_completed");
      expect((await runtime.step()).action).toBe("final_verification_submitted");
      expect(calls).toEqual(["build", "tests", "runtime_smoke", "browser"]);
      const events = store.readRun(fixture.runId);
      expect(events.filter((event) => event.type === "final_verification.submitted")).toHaveLength(1);
      expect(events.filter((event) => event.type === "final_verification.check_completed")).toHaveLength(4);
      const records = evidence.list({ runId: fixture.runId });
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.id)).size).toBe(2);
      expect(records[0]?.id).toBe(evidenceAfterBuild[0]?.id);
    } finally {
      store.close();
      evidence.close();
      await workspace.cleanup().catch(() => undefined);
      await closeFixture(fixture);
    }
  });

  test("cancellation stops the owned process tree, closes browser context, and releases the port", async ({ browser }) => {
    test.setTimeout(60_000);
    const fixture = await createFixture("cancel lifecycle");
    const workspace = verificationWorkspace(fixture);
    const port = await unusedPort();
    const managed = new ManagedProcessService({ stateDirectory: join(fixture.state, "cancel processes"), platform: "win32" });
    try {
      const abort = new AbortController();
      const runtime = new FinalVerificationRuntime({
        workspaceManager: workspace,
        artifacts: new ArtifactStore(join(fixture.state, "cancel artifacts")),
        managedProcessService: managed,
        runId: fixture.runId,
        taskId: "cancel-runtime",
        currentIntegrationRevision: () => fixture.integration.revision,
      });
      const runtimeSmoke = {
        label: "cancelled owned tree",
        executable: process.execPath,
        args: ["tree-server.mjs", String(port)],
        endpoint: `http://127.0.0.1:${port}/health`,
        readiness: { timeoutMs: 10_000, healthCheck: ({ observation }: { observation: { stdout: string } }) => {
          if (observation.stdout.includes("READY")) abort.abort();
          return false;
        } },
        releasePort: async () => await expectPortReusable(port),
      };
      const result = await runtime.run({
        plan: runtimeOnlyPlan(),
        executionProfile: executionProfile(fixture.integration.revision, {
          runtimeSmoke: { ...runtimeSmoke, readiness: { timeoutMs: 10_000 }, releasePort: undefined },
        }),
        signal: abort.signal,
        runtimeSmoke,
      });
      expect(result.green).toBe(false);
      expect((result.checks.find((check) => check.category === "runtime_smoke")?.facts[0] as unknown as Record<string, unknown>).cancelled).toBe(true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_800));
      expect(existsSync(join(workspace.path, "late-descendant.txt"))).toBe(false);
      await expectPortReusable(port);

      const uiPort = await unusedPort();
      const ui = await startFixtureServer(fixture.integration.path, uiPort);
      const browserAbort = new AbortController();
      const session = new PlaywrightFixtureSession(browser, browserAbort);
      try {
        const browserRuntime = new FinalVerificationRuntime({
          workspaceManager: workspace,
          artifacts: new ArtifactStore(join(fixture.state, "cancel browser artifacts")),
          browserSession: session,
          runId: fixture.runId,
          taskId: "cancel-browser",
          currentIntegrationRevision: () => fixture.integration.revision,
        });
        const browserInput = { label: "cancel browser", url: `http://127.0.0.1:${uiPort}/`, policy: {} };
        const browserResult = await browserRuntime.run({
          plan: browserOnlyPlan(),
          executionProfile: executionProfile(fixture.integration.revision, { browser: browserInput }),
          signal: browserAbort.signal,
          browser: browserInput,
        });
        expect(browserResult.green).toBe(false);
        expect(session.closed).toBe(true);
      } finally { await stopChild(ui); }
    } finally {
      await workspace.cleanup().catch(() => undefined);
      await closeFixture(fixture);
    }
  });
});

const TOKEN = "runner-v2-e2e-token";
const cliPath = resolve("runner-v2/src/cli.ts");
const tsxPath = resolve("node_modules/tsx/dist/cli.mjs");

interface Fixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  baselineRevision: string;
  integration: IntegrationManager;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `Runner V2 P2.6D ${name} `));
  const project = join(root, "canonical project with spaces");
  const state = join(root, "runner state sibling with spaces");
  await mkdir(project, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({
    scripts: { build: "node build.mjs", test: "node test.mjs", start: "node server.mjs" },
  }, null, 2));
  await writeFile(join(project, "build.mjs"), "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('generated',{recursive:true}); writeFileSync('generated/bundle.txt','built\\n'); console.log('BUILD_OK');\n");
  await writeFile(join(project, "test.mjs"), "console.log('TEST_OK');\n");
  await writeFile(join(project, "server.mjs"), "import http from 'node:http'; const port=Number(process.argv[2]); const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(req.url==='/health'?'healthy':'<!doctype html><title>Fixture UI</title><main id=app>Runner V2 fixture UI</main>')});server.listen(port,'127.0.0.1',()=>console.log('READY '+server.address().port));\n");
  await writeFile(join(project, "tree-server.mjs"), "import http from 'node:http'; import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('late-descendant.txt','late'),1500)\"],{stdio:'ignore'}); const server=http.createServer((req,res)=>res.end('healthy')); server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('READY '+child.pid));\n");
  const runId = `run-p26d-${name.replaceAll(" ", "-")}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return { root, project, state, runId, baselineRevision: baseline.revision, integration };
}

function verificationWorkspace(fixture: Fixture): VerificationWorkspaceManager {
  return new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    integrationManager: fixture.integration,
  });
}

function requiredPlan(): FinalVerificationPlan {
  return { checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
    category: category as "build" | "tests" | "runtime_smoke" | "browser",
    status: "required" as const,
  })) };
}

function runtimeOnlyPlan(): FinalVerificationPlan {
  return { checks: [
    na("build", "build is not part of the cancellation fixture"),
    { category: "tests", status: "not_applicable", rationale: "tests are not part of the cancellation fixture", repositoryInspection: { paths: ["package.json"], summary: "tests are not part of the cancellation fixture" } },
    { category: "runtime_smoke", status: "required" },
    na("browser", "browser cancellation is checked separately"),
  ] };
}

function browserOnlyPlan(): FinalVerificationPlan {
  return { checks: [
    na("build", "build is not part of the browser cancellation fixture"),
    { category: "tests", status: "not_applicable", rationale: "tests are not part of the browser cancellation fixture", repositoryInspection: { paths: ["package.json"], summary: "tests are not part of the browser cancellation fixture" } },
    { category: "runtime_smoke", status: "not_applicable", rationale: "fixture server is already running", repositoryInspection: { paths: ["server.mjs"], summary: "fixture server is already running" } },
    { category: "browser", status: "required" },
  ] };
}

function na(category: "build" | "runtime_smoke" | "browser", reason: string) {
  return {
    category,
    status: "not_applicable" as const,
    rationale: reason,
    repositoryInspection: { paths: ["package.json"], summary: reason },
  };
}

function executionProfile(
  targetRevision: string,
  specs: Partial<Pick<FinalVerificationExecutionProfile, "commands" | "runtimeSmoke" | "browser">>,
): FinalVerificationExecutionProfile {
  const commands = specs.commands ?? {};
  return {
    version: 1,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: [
      ...(commands.build ? [{ category: "build" as const, source: "E2E fixture build binding" }] : []),
      ...(commands.tests ? [{ category: "tests" as const, source: "E2E fixture test binding" }] : []),
      ...(specs.runtimeSmoke ? [{ category: "runtime_smoke" as const, source: "E2E fixture runtime binding" }] : []),
      ...(specs.browser ? [{ category: "browser" as const, source: "E2E fixture browser binding" }] : []),
    ],
    commands,
    ...(specs.runtimeSmoke ? { runtimeSmoke: specs.runtimeSmoke } : {}),
    ...(specs.browser ? { browser: specs.browser } : {}),
  };
}

class PlaywrightFixtureSession implements FinalVerificationBrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private console: BrowserConsoleEvent[] = [];
  private network: BrowserNetworkEvent[] = [];
  closed = false;
  constructor(private readonly browser: Browser, private readonly abortOnSnapshot?: AbortController) {}
  async open(input: { url: string; width: number; height: number }) {
    this.closed = false;
    this.context = await this.browser.newContext({ viewport: { width: input.width, height: input.height } });
    this.page = await this.context.newPage();
    this.page.on("console", (message) => this.console.push({ type: message.type(), text: message.text(), occurredAt: new Date().toISOString(), source: "console" }));
    this.page.on("pageerror", (error) => this.console.push({ type: "error", text: error.message, occurredAt: new Date().toISOString(), source: "pageerror" }));
    this.page.on("response", (response) => this.network.push({ method: response.request().method(), url: response.url(), status: response.status(), occurredAt: new Date().toISOString() }));
    this.page.on("requestfailed", (request) => this.network.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? "failed", occurredAt: new Date().toISOString() }));
    await this.page.goto(input.url, { waitUntil: "domcontentloaded" });
    await expect(this.page.locator("#app")).toContainText("Runner V2 fixture UI");
    return { url: this.page.url(), title: await this.page.title() };
  }
  async snapshot() {
    if (!this.page) throw new Error("browser not open");
    this.abortOnSnapshot?.abort();
    return { url: this.page.url(), title: await this.page.title(), text: await this.page.locator("body").innerText(), html: await this.page.content() };
  }
  async screenshot() { if (!this.page) throw new Error("browser not open"); return Buffer.from(await this.page.screenshot()); }
  async events() { return { console: [...this.console], network: [...this.network] }; }
  async close() { if (this.context) await this.context.close(); this.context = undefined; this.page = undefined; this.closed = true; }
}

async function startFixtureServer(cwd: string, port: number): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["server.mjs", String(port)], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  try {
    await Promise.race([
      once(lines, "line").then(([line]) => expect(String(line)).toContain("READY")),
      once(child, "exit").then(([code]) => { throw new Error(`fixture server exited ${String(code)}`); }),
      timeout(10_000, "fixture server readiness timed out"),
    ]);
    return child;
  } finally { lines.close(); }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), timeout(10_000, "fixture server did not stop")]);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => server.listen(0, "127.0.0.1", resolveReady).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function expectPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => server.listen(port, "127.0.0.1", resolveReady).once("error", reject));
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

async function repositoryState(path: string) {
  return {
    revision: (await runGit({ cwd: path, args: ["rev-parse", "HEAD"] })).stdout.trim(),
    status: (await runGit({ cwd: path, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"] })).stdout,
  };
}

async function commitAll(path: string, message: string): Promise<void> {
  await runGit({ cwd: path, args: ["add", "-A"] });
  await runGit({ cwd: path, args: ["commit", "-m", message], env: {
    GIT_AUTHOR_NAME: "Runner Test", GIT_AUTHOR_EMAIL: "runner@example.test",
    GIT_COMMITTER_NAME: "Runner Test", GIT_COMMITTER_EMAIL: "runner@example.test",
  } });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  await runGit({ cwd: fixture.project, args: ["worktree", "prune", "--expire", "now"], allowFailure: true }).catch(() => undefined);
  await rm(fixture.root, { recursive: true, force: true });
}

interface RunnerProcess { child: ChildProcessWithoutNullStreams; url: string }
async function startRunner(project: string, state: string): Promise<RunnerProcess> {
  const child = spawn(process.execPath, [tsxPath, cliPath, "--project", project, "--state-dir", state, "--port", "0", "--token", TOKEN], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const errors: string[] = [];
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => errors.push(chunk));
  try {
    const readiness = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(String(line)) as { url: string }),
      once(child, "exit").then(([code]) => { throw new Error(`runner exited ${String(code)}: ${errors.join("")}`); }),
      timeout(15_000, "runner readiness timed out"),
    ]);
    return { child, url: readiness.url };
  } finally { lines.close(); }
}

async function stopRunner(runner: RunnerProcess): Promise<void> {
  if (runner.child.exitCode !== null) return;
  runner.child.kill();
  await Promise.race([once(runner.child, "exit"), timeout(15_000, "runner did not stop")]);
}

function timeout(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(message)), milliseconds); timer.unref(); });
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = resolve(candidate).slice(resolve(parent).length);
  return relative.startsWith("\\") || relative.startsWith("/") || relative === "";
}

function seedVerification(
  store: SqliteSchedulerStore,
  fixture: Fixture,
  plan: FinalVerificationPlan,
  executionProfile: FinalVerificationExecutionProfile,
): void {
  const append = (type: string, idempotencyKey: string, payload: Record<string, unknown>, actorRole = "runner") => store.append({
    runId: fixture.runId,
    type,
    occurredAt: new Date().toISOString(),
    actor: { role: actorRole as "runner" | "architect", id: "p26d-e2e" },
    idempotencyKey,
    payload,
  } as Parameters<SqliteSchedulerStore["append"]>[0]);
  append("run.initialized", "resume-run", {});
  append("plan.created", "resume-plan", { revision: 1, tasks: [{
    id: "implementation-one", objective: "Fixture implemented", dependencies: [], status: "integrated",
    requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "done", text: "Fixture is implemented" }],
    acceptanceCriteriaVersion: 1, attempt: 1,
  }] }, "architect");
  append("integration.revision_advanced", "resume-revision", { integrationRevision: fixture.integration.revision });
  append("final_verification.generation_created", "resume-generation", {
    taskId: "final-verification-resume", generationId: "generation-resume",
    targetRevision: fixture.integration.revision, planVersion: 1, plan, executionProfile,
  });
}

function schedulerRuntime(
  store: SqliteSchedulerStore,
  evidence: SqliteEvidenceStore,
  artifacts: ArtifactStore,
  driver: FinalVerificationCheckDriver,
  runId: string,
): BuildRuntime {
  return new BuildRuntime({
    runId,
    store,
    evidenceStore: evidence,
    artifacts,
    finalVerificationDriver: driver,
    workerDriver: { run: async () => ({ type: "failed" as const, reason: "worker must not run verification" }) },
    architectDriver: { run: async () => undefined },
    integrationDriver: { integrate: async () => ({ status: "conflict" as const, integrationRevision: "unused", conflictPaths: ["integration must not rerun"] }) },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
  });
}
