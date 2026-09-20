import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { BrowserConsoleEvent, BrowserNetworkEvent } from "../src/browser-tools.js";
import { captureGitBaseline } from "./support/git-fixture.js";
import { IntegrationManager } from "./support/git-fixture.js";
import { type FinalVerificationBrowserInput, type FinalVerificationBrowserSession, type FinalVerificationPlan } from "../src/final-verification-runtime.js";
import { FinalVerificationRuntime } from "./support/git-fixture.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { VerificationWorkspaceManager } from "./support/git-fixture.js";

test("browser verification records complete URL, DOM, screenshot, and event facts", async () => {
  const fixture = await createFixture("complete");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const browser = new FixtureBrowserSession();
  const runtime = createRuntime(fixture, artifacts, evidence, browser);
  try {
    const url = "http://127.0.0.1:4173/fixture?space=hello%20world";
    const browserInputValue = browserInput(url);
    const run = await runtime.run({
      plan: browserPlan(),
      executionProfile: browserProfile(fixture.integration.revision, browserInputValue),
      browser: browserInputValue,
    });
    const check = browserCheck(run);
    const snapshot = factByKind(check, "browser_snapshot");
    const screenshot = factByKind(check, "browser_screenshot");
    const events = factByKind(check, "browser_events");

    assert.equal(run.green, true);
    assert.equal(check.green, true);
    assert.equal(snapshot.url, url);
    assert.equal(snapshot.targetRevision, fixture.integration.revision);
    assert.ok((await artifacts.get(snapshot.htmlArtifactHash)).byteLength > 0);
    assert.ok((await artifacts.get(screenshot.screenshotArtifactHash)).byteLength > 0);
    assert.ok((await artifacts.get(events.eventsArtifactHash)).byteLength > 0);
    assert.equal(browser.openCalls, 1);
    assert.equal(browser.closeCalls, 1);
    assert.equal(evidence.list({ runId: fixture.runId, taskId: "final-verification" }).length, 3);
  } finally {
    evidence.close();
    await runtimeWorkspace(fixture).cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("browser verification rejects missing screenshot evidence", async () => {
  const fixture = await createFixture("missing-screenshot");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const browser = new FixtureBrowserSession({ missingScreenshot: true });
  const runtime = createRuntime(fixture, artifacts, evidence, browser);
  try {
    const browserInputValue = browserInput("http://127.0.0.1:4173/missing-screenshot");
    const run = await runtime.run({
      plan: browserPlan(),
      executionProfile: browserProfile(fixture.integration.revision, browserInputValue),
      browser: browserInputValue,
    });
    const check = browserCheck(run);
    assert.equal(run.green, false);
    assert.equal(check.green, false);
    assert.match(check.issues.join(" "), /missing.*screenshot/i);
    assert.equal(browser.closeCalls, 1);
  } finally {
    evidence.close();
    await runtimeWorkspace(fixture).cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("browser verification preserves the requested URL across a normal redirect", async () => {
  const fixture = await createFixture("redirect");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const observedUrl = "http://127.0.0.1:4173/signed-in";
  const requestedUrl = "http://127.0.0.1:4173/";
  const browser = new FixtureBrowserSession({ observedUrl });
  const runtime = createRuntime(fixture, artifacts, evidence, browser);
  try {
    const browserInputValue = browserInput(requestedUrl);
    const run = await runtime.run({
      plan: browserPlan(),
      executionProfile: browserProfile(fixture.integration.revision, browserInputValue),
      browser: browserInputValue,
    });
    const check = browserCheck(run);
    assert.equal(check.green, true);
    for (const fact of check.facts) {
      assert.equal((fact as { requestedUrl?: string }).requestedUrl, requestedUrl);
      assert.equal((fact as { url?: string }).url, observedUrl);
    }
  } finally {
    evidence.close();
    await runtimeWorkspace(fixture).cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("browser verification rejects unallowed console and failed-network events", async () => {
  const fixture = await createFixture("policy");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const browser = new FixtureBrowserSession({
    events: {
      console: [{
        source: "console",
        type: "error",
        text: "unexpected console failure",
        occurredAt: new Date().toISOString(),
      } as BrowserConsoleEvent & { source: "console" }],
      network: [{
        method: "GET",
        url: "http://127.0.0.1:4173/failed-response",
        status: 500,
        occurredAt: new Date().toISOString(),
      }],
    },
  });
  const runtime = createRuntime(fixture, artifacts, evidence, browser);
  try {
    const browserInputValue = browserInput("http://127.0.0.1:4173/policy");
    const run = await runtime.run({
      plan: browserPlan(),
      executionProfile: browserProfile(fixture.integration.revision, browserInputValue),
      browser: browserInputValue,
    });
    const check = browserCheck(run);
    assert.equal(run.green, false);
    assert.equal(check.green, false);
    assert.match(check.issues.join(" "), /console|network|response/i);
    const events = factByKind(check, "browser_events");
    assert.equal(events.consoleErrorCount, 1);
    assert.equal(events.networkFailureCount, 1);
    assert.equal(events.policyViolations.length > 0, true);
    assert.equal(browser.closeCalls, 1);
  } finally {
    evidence.close();
    await runtimeWorkspace(fixture).cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("browser verification closes once after thrown or cancelled navigation", async () => {
  for (const scenario of ["thrown", "cancelled"] as const) {
    const fixture = await createFixture(`navigation-${scenario}`);
    const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
    const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
    const browser = new FixtureBrowserSession({
      failOpen: scenario === "thrown",
      hangOpen: scenario === "cancelled",
    });
    const runtime = createRuntime(fixture, artifacts, evidence, browser);
    const controller = new AbortController();
    try {
      const browserInputValue = browserInput(
        `http://127.0.0.1:4173/${scenario}`,
        { timeoutMs: 100 },
      );
      const promise = runtime.run({
        plan: browserPlan(),
        executionProfile: browserProfile(fixture.integration.revision, browserInputValue),
        signal: scenario === "cancelled" ? controller.signal : undefined,
        browser: browserInputValue,
      });
      if (scenario === "cancelled") {
        await waitFor(() => browser.openCalls === 1, 5_000);
        controller.abort();
      }
      const run = await promise;
      const check = browserCheck(run);
      assert.equal(run.green, false);
      assert.equal(check.green, false);
      assert.match(check.issues.join(" "), /navigation|timed out|cancel/i);
      assert.equal(browser.closeCalls, 1);
    } finally {
      evidence.close();
      await runtimeWorkspace(fixture).cleanup().catch(() => undefined);
      await closeFixture(fixture);
    }
  }
});

function browserPlan(): FinalVerificationPlan {
  return {
    checks: [
      notApplicable("build", "No build command is configured for this fixture."),
      notApplicable("tests", "No test command is configured for this fixture."),
      notApplicable("runtime_smoke", "No runtime command is configured for this fixture."),
      { category: "browser", status: "required" },
    ],
  };
}

function notApplicable(category: "build" | "tests" | "runtime_smoke", rationale: string) {
  return {
    category,
    status: "not_applicable" as const,
    rationale,
    repositoryInspection: { paths: ["package.json"], summary: rationale },
  };
}

function browserInput(url: string, overrides: Partial<FinalVerificationBrowserInput> = {}) {
  return {
    label: "browser acceptance",
    url,
    width: 900,
    height: 700,
    timeoutMs: 2_000,
    policy: {
      consoleErrors: "fail" as const,
      pageErrors: "fail" as const,
      failedNetworkEvents: "fail" as const,
    },
    ...overrides,
  } satisfies FinalVerificationBrowserInput;
}

function browserProfile(targetRevision: string, browser: FinalVerificationBrowserInput) {
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["index.html"],
    detectedSignals: [{ category: "browser" as const, source: "fixture", detail: "browser" }],
    commands: {},
    browser,
  };
}

function createRuntime(
  fixture: Fixture,
  artifacts: ArtifactStore,
  evidence: SqliteEvidenceStore,
  browser: FinalVerificationBrowserSession,
) {
  return new FinalVerificationRuntime({
    workspaceManager: runtimeWorkspace(fixture),
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    taskId: "final-verification",
    integrationRevision: () => fixture.integration.revision,
    browserSession: browser,
  });
}

function runtimeWorkspace(fixture: Fixture): VerificationWorkspaceManager {
  return new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
}

function browserCheck(run: Awaited<ReturnType<FinalVerificationRuntime["run"]>>) {
  const check = run.checks.find((candidate) => candidate.category === "browser");
  assert.ok(check);
  return check;
}

function factByKind(
  check: ReturnType<typeof browserCheck>,
  kind: "browser_snapshot" | "browser_screenshot" | "browser_events",
) {
  const fact = check.facts.find((candidate) => candidate.kind === kind);
  assert.ok(fact);
  return fact as unknown as {
    kind: typeof kind;
    url: string;
    targetRevision: string;
    htmlArtifactHash: string;
    screenshotArtifactHash: string;
    eventsArtifactHash: string;
    consoleErrorCount: number;
    networkFailureCount: number;
    policyViolations: string[];
  };
}

interface Fixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

interface FixtureBrowserOptions {
  missingScreenshot?: boolean;
  failOpen?: boolean;
  hangOpen?: boolean;
  observedUrl?: string;
  events?: { console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] };
}

class FixtureBrowserSession implements FinalVerificationBrowserSession {
  openCalls = 0;
  closeCalls = 0;
  private readonly options: FixtureBrowserOptions;

  constructor(options: FixtureBrowserOptions = {}) {
    this.options = options;
  }

  async open(input: { url: string; width: number; height: number }) {
    this.openCalls += 1;
    if (this.options.failOpen) throw new Error("browser navigation failed");
    if (this.options.hangOpen) await new Promise<void>(() => undefined);
    return { url: this.options.observedUrl ?? input.url, title: "Fixture browser" };
  }

  async snapshot() {
    return {
      url: this.options.observedUrl ?? "http://127.0.0.1:4173/fixture?space=hello%20world",
      title: "Fixture browser",
      text: "Fixture browser",
      html: "<html><body>Fixture browser</body></html>",
    };
  }

  async screenshot(): Promise<Buffer> {
    return this.options.missingScreenshot ? Buffer.alloc(0) : Buffer.from("fixture screenshot");
  }

  async events() {
    return this.options.events ?? { console: [], network: [] };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

async function createFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-final-verification-browser-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state & data");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_browser_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
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

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
