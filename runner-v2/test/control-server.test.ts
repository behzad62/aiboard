import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlServer } from "../src/control-server.js";
import { BuildRuntimeRegistry, type BuildControlPlane } from "../src/build-runtime-registry.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import type { GitPreflightResult } from "../src/git-preflight.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqlitePermissionStore } from "../src/permission-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const token = "test-control-token";
const gitReady: GitPreflightResult = {
  available: true,
  version: "2.45.1.windows.1",
  code: "git_ready",
  reason: null,
};
const bootstrapRun = async () => ({
  baselineRevision: "a".repeat(40),
  baselineRef: "refs/aiboard/runs/test/baseline",
});

function authorized(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createSteeringControlFixture(
  directory: string,
  decorateBuilds?: (builds: BuildControlPlane) => BuildControlPlane,
) {
  const scheduler = new SqliteSchedulerStore(join(directory, "scheduler.sqlite"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  const runtime = new BuildRuntime({
    runId: "run-steering",
    initialObjective: "Build exactly this application.\n",
    store: scheduler,
    workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
    architectDriver: { run: async () => undefined },
    integrationDriver: {
      integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }),
    },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
    clock: () => "2026-08-27T00:00:00.000Z",
  });
  const registry = new BuildRuntimeRegistry();
  registry.register(runtime);
  const server = new ControlServer({
    supervisor,
    token,
    bootstrapRun,
    builds: decorateBuilds?.(registry) ?? registry,
  });
  const address = await server.start(0);
  return {
    scheduler,
    server,
    url: `${address.url}/v2/runs/run-steering/build/user-guidance`,
    async close() {
      await server.close();
      scheduler.close();
      supervisor.close();
    },
  };
}

function durableGuidanceBody(
  guidanceId: string,
  text: string,
  idempotencyKey: string,
) {
  return { guidanceId, text, idempotencyKey };
}

test("control API authenticates every route and drives durable lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-api-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite")),
    { clock: () => "2026-07-11T00:00:00.000Z" }
  );
  let preflightCalls = 0;
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => {
      preflightCalls += 1;
      return gitReady;
    },
    bootstrapRun,
    heartbeatMs: 50,
  });

  try {
    const address = await server.start(0);
    const base = address.url;
    const preflight = await fetch(`${base}/v2/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "http://localhost:3000"
    );
    const hostilePreflight = await fetch(`${base}/v2/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://hostile.example" },
    });
    assert.equal(hostilePreflight.status, 403);
    assert.equal((await json(hostilePreflight)).code, "origin_not_allowed");
    assert.equal((await fetch(`${base}/v2/runs`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/v2/runs`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
      401
    );

    const create = await fetch(
      `${base}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_1",
          projectPath: join(directory, "project"),
          permissionProfile: "project",
          idempotencyKey: "create:run_1",
        }),
      })
    );
    assert.equal(create.status, 201);
    assert.equal(preflightCalls, 1);
    assert.equal((await json(create)).state, "created");

    const started = await fetch(
      `${base}/v2/runs/run_1/commands`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          command: "start",
          idempotencyKey: "start:run_1",
        }),
      })
    );
    assert.equal(started.status, 200);
    assert.equal((await json(started)).state, "running");

    const projection = await fetch(
      `${base}/v2/runs/run_1`,
      authorized()
    );
    assert.equal(projection.status, 200);
    assert.equal((await json(projection)).lastSequence, 3);

    const events = await fetch(
      `${base}/v2/runs/run_1/events?after=0`,
      authorized()
    );
    const history = (await events.json()) as Array<{ sequence: number }>;
    assert.deepEqual(
      history.map((event) => event.sequence),
      [1, 2, 3]
    );
    assert.equal(events.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("control API stores provider credentials without returning secrets and provisions native Builds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-native-build-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite")),
    { clock: () => "2026-07-11T00:00:00.000Z" }
  );
  let configs: RunnerProviderConfig[] = [];
  const created: NativeBuildSpec[] = [];
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => gitReady,
    bootstrapRun,
    providerConfigs: {
      load: () => configs.map((config) => ({ ...config })),
      save: (next) => {
        configs = next.map((config) => ({ ...config, capabilities: [...config.capabilities] }));
      },
      close: () => undefined,
    },
    buildProvisioner: {
      create: async (spec) => {
        created.push(spec);
        return {} as never;
      },
      listSpecs: () => created,
    },
  });
  try {
    const { url } = await server.start(0);
    const configured = await fetch(
      `${url}/v2/provider-configs`,
      authorized({
        method: "PUT",
        body: JSON.stringify({
          configs: [{
            runtimeId: "chatgpt:gpt-5.5",
            providerId: "chatgpt",
            modelId: "gpt-5.5",
            transport: "account-runner",
            baseUrl: "http://127.0.0.1:9911",
            secret: "provider-secret",
            runnerToken: "runner-secret",
            capabilities: ["code"],
            priority: 1,
          }],
        }),
      })
    );
    assert.equal(configured.status, 200);
    const listed = await json(await fetch(`${url}/v2/provider-configs`, authorized()));
    assert.equal(JSON.stringify(listed).includes("provider-secret"), false);
    assert.equal(JSON.stringify(listed).includes("runner-secret"), false);
    const secondTab = await fetch(
      `${url}/v2/provider-configs`,
      authorized({
        method: "PUT",
        body: JSON.stringify({
          configs: [{
            runtimeId: "anthropic:claude-code",
            providerId: "anthropic",
            modelId: "claude-code",
            transport: "anthropic",
            secret: "second-provider-secret",
            capabilities: ["code"],
            priority: 2,
          }],
        }),
      })
    );
    assert.equal(secondTab.status, 200);
    assert.deepEqual(
      configs.map((config) => config.runtimeId).sort(),
      ["anthropic:claude-code", "chatgpt:gpt-5.5"],
      "a second tab upserts its runtime without deleting the first run's recovery credentials"
    );
    assert.equal(configs.find((config) => config.runtimeId === "chatgpt:gpt-5.5")?.secret, "provider-secret");

    const create = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_native",
          projectPath: join(directory, "project"),
          permissionProfile: "full",
          idempotencyKey: "create:run_native",
          build: {
            projectId: "project_native",
            objective: "Build the requested feature.",
            architectRuntimeId: "chatgpt:gpt-5.5",
            workerRuntimeIds: ["chatgpt:gpt-5.5"],
            maxConcurrency: 2,
            runPolicy: "finish",
            budgetLimits: {},
          },
        }),
      })
    );
    assert.equal(create.status, 201);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      version: 1,
      runId: "run_native",
      projectId: "project_native",
      objective: "Build the requested feature.",
      architectRuntimeId: "chatgpt:gpt-5.5",
      workerRuntimeIds: ["chatgpt:gpt-5.5"],
      maxConcurrency: 2,
      permissionProfile: "full",
      runPolicy: "finish",
      budgetLimits: {},
      createdAt: "2026-07-11T00:00:00.000Z",
      idempotencyKey: "build:create:run_native",
    });

    const createBudgeted = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_budgeted",
          projectPath: join(directory, "project"),
          permissionProfile: "guarded",
          idempotencyKey: "create:run_budgeted",
          build: {
            projectId: "project_native",
            objective: "Build within the selected window.",
            architectRuntimeId: "chatgpt:gpt-5.5",
            workerRuntimeIds: ["chatgpt:gpt-5.5"],
            maxConcurrency: 1,
            runPolicy: "budgeted",
            budgetLimits: {
              maxEstimatedCostMicros: 2_750_000,
              maxActiveMs: 2_700_000,
            },
          },
        }),
      })
    );
    assert.equal(createBudgeted.status, 201);
    assert.deepEqual(created[1], {
      version: 1,
      runId: "run_budgeted",
      projectId: "project_native",
      objective: "Build within the selected window.",
      architectRuntimeId: "chatgpt:gpt-5.5",
      workerRuntimeIds: ["chatgpt:gpt-5.5"],
      maxConcurrency: 1,
      permissionProfile: "guarded",
      runPolicy: "budgeted",
      budgetLimits: {
        maxEstimatedCostMicros: 2_750_000,
        maxActiveMs: 2_700_000,
      },
      createdAt: "2026-07-11T00:00:00.000Z",
      idempotencyKey: "build:create:run_budgeted",
    });

    const createPlanOnly = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_plan_only",
          projectPath: join(directory, "project"),
          permissionProfile: "guarded",
          idempotencyKey: "create:run_plan_only",
          build: {
            projectId: "project_native",
            objective: "Plan without implementation.",
            architectRuntimeId: "chatgpt:gpt-5.5",
            workerRuntimeIds: ["chatgpt:gpt-5.5"],
            maxConcurrency: 1,
            runPolicy: "plan_only",
            budgetLimits: {},
          },
        }),
      })
    );
    assert.equal(createPlanOnly.status, 201);
    assert.deepEqual(created[2], {
      version: 1,
      runId: "run_plan_only",
      projectId: "project_native",
      objective: "Plan without implementation.",
      architectRuntimeId: "chatgpt:gpt-5.5",
      workerRuntimeIds: ["chatgpt:gpt-5.5"],
      maxConcurrency: 1,
      permissionProfile: "guarded",
      runPolicy: "plan_only",
      budgetLimits: {},
      createdAt: "2026-07-11T00:00:00.000Z",
      idempotencyKey: "build:create:run_plan_only",
    });

    const invalidBuilds = [
      {
        runId: "run_invalid_policy",
        runPolicy: "unbounded",
        budgetLimits: {},
      },
      {
        runId: "run_finish_with_ceiling",
        runPolicy: "finish",
        budgetLimits: { maxActiveMs: 60_000 },
      },
      {
        runId: "run_plan_with_ceiling",
        runPolicy: "plan_only",
        budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
      },
      {
        runId: "run_budgeted_empty",
        runPolicy: "budgeted",
        budgetLimits: {},
      },
      {
        runId: "run_budgeted_call_token_only",
        runPolicy: "budgeted",
        budgetLimits: { maxModelCalls: 10, maxInputTokens: 1_000 },
      },
    ];
    for (const invalid of invalidBuilds) {
      const response = await fetch(
        `${url}/v2/runs`,
        authorized({
          method: "POST",
          body: JSON.stringify({
            runId: invalid.runId,
            projectPath: join(directory, "project"),
            permissionProfile: "guarded",
            idempotencyKey: `create:${invalid.runId}`,
            build: {
              projectId: "project_native",
              objective: "Reject an invalid policy and limit combination.",
              architectRuntimeId: "chatgpt:gpt-5.5",
              workerRuntimeIds: ["chatgpt:gpt-5.5"],
              maxConcurrency: 1,
              runPolicy: invalid.runPolicy,
              budgetLimits: invalid.budgetLimits,
            },
          }),
        })
      );
      assert.equal(response.status, 400, invalid.runId);
      assert.throws(
        () => supervisor.getRun(invalid.runId),
        new RegExp(`Unknown run ${invalid.runId}`)
      );
    }
    assert.equal(created.length, 3);
    const references = await json(await fetch(
      `${url}/v2/builds?projectId=project_native`,
      authorized()
    ));
    assert.deepEqual(references, {
      builds: [
        {
          runId: "run_native",
          projectId: "project_native",
          state: "created",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
        {
          runId: "run_budgeted",
          projectId: "project_native",
          state: "created",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
        {
          runId: "run_plan_only",
          projectId: "project_native",
          state: "created",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
      ],
    });
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("control API lists and decides durable permission requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-permissions-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite"))
  );
  const permissions = new SqlitePermissionStore(join(directory, "permissions.sqlite"));
  const server = new ControlServer({
    supervisor,
    token,
    bootstrapRun,
    permissions,
  });
  try {
    const waiting = permissions.request({
      requestId: "perm_control",
      runId: "run_control",
      sessionId: "session_control",
      callId: "call_control",
      toolName: "deploy.release",
      actor: { role: "worker", id: "worker_1" },
      permissionProfile: "project",
      access: { capability: "deploy.release", external: true },
      outsideWorkspace: false,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const { url } = await server.start(0);
    const listed = await json(await fetch(
      `${url}/v2/permissions?runId=run_control`,
      authorized()
    ));
    assert.equal((listed.permissions as Array<{ status: string }>)[0].status, "pending");
    const decided = await json(await fetch(
      `${url}/v2/permissions/perm_control`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          decision: "approved",
          idempotencyKey: "approve:perm_control",
        }),
      })
    ));
    assert.equal(decided.status, "approved");
    assert.equal(await waiting, true);
  } finally {
    await server.close();
    permissions.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run creation stops before persistence when Git is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-git-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite"))
  );
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => ({
      available: false,
      version: null,
      code: "git_missing",
      reason: "Git is required for Build V2.",
    }),
    bootstrapRun,
  });

  try {
    const { url } = await server.start(0);
    const response = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_blocked",
          projectPath: directory,
          permissionProfile: "project",
          idempotencyKey: "create:run_blocked",
        }),
      })
    );
    assert.equal(response.status, 412);
    assert.equal((await json(response)).code, "git_missing");
    assert.deepEqual(supervisor.listRuns(), []);
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git bootstrap failure becomes a durable failed run before model work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-bootstrap-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite"))
  );
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => gitReady,
    bootstrapRun: async () => {
      throw new Error("baseline capture failed");
    },
  });
  try {
    const { url } = await server.start(0);
    const response = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          runId: "run_failed",
          projectPath: directory,
          permissionProfile: "project",
          idempotencyKey: "create:run_failed",
        }),
      })
    );
    assert.equal(response.status, 500);
    assert.equal(supervisor.getRun("run_failed").state, "failed");
    assert.match(supervisor.getRun("run_failed").stopReason ?? "", /baseline capture/);
    assert.deepEqual(
      supervisor.events("run_failed").map((event) => event.type),
      ["run.created", "run.failed"]
    );
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native Build projections and pump controls are runner-owned API routes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-build-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite"))
  );
  supervisor.createRun({
    runId: "run_1",
    projectPath: directory,
    permissionProfile: "project",
    idempotencyKey: "create:run_1",
  });
  supervisor.captureBaseline(
    "run_1",
    "baseline:run_1",
    "b".repeat(40),
    "refs/aiboard/runs/run_1/baseline"
  );
  supervisor.start("run_1", "start:run_1");
  let steps = 0;
  const projection = {
    runId: "run_1",
    status: "running" as const,
    planRevision: 1,
    tasks: {
      task_a: {
        id: "task_a",
        objective: "Implement A",
        dependencies: [],
        status: "planned" as const,
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "behavior", text: "The behavior works." }],
        acceptanceCriteriaVersion: 1,
        attempt: 0,
      },
    },
    guidance: {},
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: 1,
  };
  let projectHandoffChoice = "";
  let benchmarkContinuations = 0;
  let buildStatus: "running" | "paused" = "running";
  const builds = {
    projection: () => ({ ...projection, status: buildStatus }),
    events: () => [],
    transcript: (runId: string, afterSequence = 0) => {
      if (runId !== "run_1") throw new Error(`Unknown build runtime ${runId}.`);
      return {
        turns: afterSequence < 8
          ? [{
            id: "architect:run_1:message_1",
            sessionId: "architect:run_1",
            actor: { role: "architect", id: "architect_1" },
            sequence: 8,
            occurredAt: "2026-07-12T00:00:00.000Z",
            text: "The implementation is ready for review.",
            }]
          : [],
        cursor: 8,
      };
    },
    files: async (runId: string) => {
      if (runId !== "run_1") throw new Error(`Unknown build runtime ${runId}.`);
      return {
        source: "integration" as const,
        revision: "c".repeat(40),
        appliedToProject: false,
        omittedFileCount: 1,
        files: [{ path: "src/index.ts", content: "export {};\n" }],
      };
    },
    usage: () => ({
      scopeId: "run_1",
      reservations: {},
      activeSegments: {},
      models: [{
        runtimeId: "openai:gpt-code",
        providerId: "openai",
        modelId: "gpt-code",
        roles: ["architect", "worker"],
        status: "healthy",
        calls: 9,
        inputTokens: 12_000,
        cachedInputTokens: 2_000,
        cacheWriteInputTokens: 500,
        outputTokens: 3_000,
        totalTokens: 15_000,
        estimatedCostMicros: 125_000,
        costBasis: "api_estimate",
        usageQuality: "mixed",
        lastUsedAt: "2026-07-13T00:00:00.000Z",
      }],
      effective: {
        modelCalls: 9,
        toolCalls: 27,
        inputTokens: 12_000,
        outputTokens: 3_000,
        estimatedCostMicros: 125_000,
        activeMs: 45_000,
        artifactBytes: 1_024,
      },
      lastSequence: 42,
    }),
    observability: async () => ({
      runId: "run_1",
      toolCallCount: 1,
      budget: {
        scopeId: "run_1",
        reservations: {},
        activeSegments: {},
        effective: {
          modelCalls: 9,
          toolCalls: 27,
          inputTokens: 12_000,
          outputTokens: 3_000,
          estimatedCostMicros: 125_000,
          activeMs: 45_000,
          artifactBytes: 1_024,
        },
        lastSequence: 42,
      },
      agents: [{
        sessionId: "worker:run_1:task_a:1",
        actor: { role: "worker", id: "worker_task_a_1" },
        status: "submitted",
        turns: 4,
        changeSetId: "changeset_1",
        lastSequence: 8,
      }],
      tools: [{
        sequence: 1,
        sessionId: "worker:run_1:task_a:1",
        callId: "read_1",
        toolName: "fs.read",
        status: "completed",
        occurredAt: "2026-07-12T00:00:00.000Z",
        isError: false,
      }],
      evidence: [],
      memories: [],
      skills: [],
      processes: [],
      providers: [],
      events: [],
      git: { integrationBranch: "", integrationRevision: "", commits: [] },
      finalVerification: {
        canonicalRevision: "revision_final",
        history: [],
        current: {
          generationId: "generation-1", taskId: "verify-1", targetRevision: "revision_final", revisionStatus: "current",
          categories: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({ category, applicability: "required", status: "pending", evidenceIds: [], issues: [] })),
          submission: { status: "pending" }, cleanup: { status: "pending", diagnosticsAvailable: false }, review: { status: "pending" }, repairs: [],
        },
      },
    }),
    step: async () => {
      steps += 1;
      return { status: "progressed", action: "workers_advanced" };
    },
    runUntilBlocked: async (_runId: string, maxSteps?: number) => ({
      status: "idle",
      action: `max:${maxSteps ?? 100}`,
    }),
    activate: () => undefined,
    pause: () => {
      buildStatus = "paused";
      return { ...projection, status: buildStatus };
    },
    resume: () => {
      buildStatus = "running";
      return { ...projection, status: buildStatus };
    },
    continue: () => {
      benchmarkContinuations += 1;
      buildStatus = "running";
      return { ...projection, status: buildStatus };
    },
    selectArchitectHandoff: () => projection,
    selectProjectHandoff: async (_runId: string, choice: "keep_integration_branch" | "apply_to_project") => {
      projectHandoffChoice = choice;
      return {
        ...projection,
        status: "completed",
        projectHandoff: {
          status: "selected",
          summary: "Done",
          options: ["keep_integration_branch", "apply_to_project"],
          choice,
          integrationRevision: "revision_final",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: choice === "apply_to_project",
        },
      };
    },
  } as unknown as BuildControlPlane;
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => gitReady,
    bootstrapRun,
    builds,
  });
  try {
    const { url } = await server.start(0);
    const build = await fetch(`${url}/v2/runs/run_1/build`, authorized());
    assert.equal(build.status, 200);
    assert.equal((await json(build)).planRevision, 1);

    const usage = await fetch(
      `${url}/v2/runs/run_1/build/usage`,
      authorized()
    );
    assert.equal(usage.status, 200);
    const usageBody = await json(usage);
    assert.deepEqual(usageBody.effective, {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    });
    assert.deepEqual(usageBody.models, [{
      runtimeId: "openai:gpt-code",
      providerId: "openai",
      modelId: "gpt-code",
      roles: ["architect", "worker"],
      status: "healthy",
      calls: 9,
      inputTokens: 12_000,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 500,
      outputTokens: 3_000,
      totalTokens: 15_000,
      estimatedCostMicros: 125_000,
      costBasis: "api_estimate",
      usageQuality: "mixed",
      lastUsedAt: "2026-07-13T00:00:00.000Z",
    }]);

    const observability = await fetch(
      `${url}/v2/runs/run_1/build/observability`,
      authorized()
    );
    assert.equal(observability.status, 200);
    const observed = await json(observability);
    assert.equal((observed.agents as unknown[]).length, 1);
    assert.equal((observed.tools as unknown[]).length, 1);
    assert.equal((observed.finalVerification as { current: { generationId: string } }).current.generationId, "generation-1");

    const completeTranscript = await fetch(
      `${url}/v2/runs/run_1/build/transcript`,
      authorized()
    );
    assert.equal(completeTranscript.status, 200);
    assert.deepEqual(await completeTranscript.json(), {
      turns: [{
        id: "architect:run_1:message_1",
        sessionId: "architect:run_1",
        actor: { role: "architect", id: "architect_1" },
        sequence: 8,
        occurredAt: "2026-07-12T00:00:00.000Z",
        text: "The implementation is ready for review.",
      }],
      cursor: 8,
    });
    assert.deepEqual(
      await (await fetch(
        `${url}/v2/runs/run_1/build/transcript?after=8`,
        authorized()
      )).json(),
      { turns: [], cursor: 8 }
    );
    for (const after of ["-1", "1.5", "not-a-number", "1&after=2"]) {
      const invalid = await fetch(
        `${url}/v2/runs/run_1/build/transcript?after=${after}`,
        authorized()
      );
      assert.equal(invalid.status, 400, after);
      assert.equal((await json(invalid)).code, "invalid_after", after);
    }

    const files = await fetch(
      `${url}/v2/runs/run_1/build/files`,
      authorized()
    );
    assert.equal(files.status, 200);
    assert.deepEqual(await files.json(), {
      source: "integration",
      revision: "c".repeat(40),
      appliedToProject: false,
      omittedFileCount: 1,
      files: [{ path: "src/index.ts", content: "export {};\n" }],
    });
    for (const endpoint of ["transcript", "files"]) {
      const missing = await fetch(
        `${url}/v2/runs/missing/build/${endpoint}`,
        authorized()
      );
      assert.equal(missing.status, 404);
      assert.equal((await json(missing)).code, "build_runtime_not_found");
    }

    const auditResponse = await fetch(
      `${url}/v2/runs/run_1/build/audit`,
      authorized()
    );
    assert.equal(auditResponse.status, 200);
    const audit = await json(auditResponse);
    assert.equal(audit.protocolVersion, 2);
    assert.equal((audit.run as { runId: string }).runId, "run_1");
    assert.equal((audit.build as { planRevision: number }).planRevision, 1);
    assert.equal((audit.usage as { effective: { modelCalls: number } }).effective.modelCalls, 9);
    assert.equal((audit.usage as { models: unknown[] }).models.length, 1);
    assert.equal((audit.observability as { toolCallCount: number }).toolCallCount, 1);
    assert.equal((audit.observability as { finalVerification: { current: { targetRevision: string } } }).finalVerification.current.targetRevision, "revision_final");
    assert.deepEqual(audit.acceptanceContract, {
      status: "current",
      planRevision: 1,
      tasks: {
        task_a: {
          acceptanceCriteria: [{ id: "behavior", text: "The behavior works." }],
          acceptanceCriteriaVersion: 1,
          criterionEvidenceLinks: [],
          criterionVerdicts: [],
          submissionHistory: [],
          reviewHistory: [],
        },
      },
    });
    assert.deepEqual(
      (audit.build as { tasks: { task_a: { acceptanceCriteria: unknown } } }).tasks.task_a.acceptanceCriteria,
      (audit.acceptanceContract as { tasks: { task_a: { acceptanceCriteria: unknown } } }).tasks.task_a.acceptanceCriteria
    );
    assert.equal((audit.runEvents as unknown[]).length, 3);
    assert.deepEqual(audit.buildEvents, []);
    assert.equal(JSON.stringify(audit).includes("provider-secret"), false);

    const tasks = await fetch(
      `${url}/v2/runs/run_1/build/tasks`,
      authorized()
    );
    assert.equal(((await tasks.json()) as unknown[]).length, 1);

    const step = await fetch(
      `${url}/v2/runs/run_1/build/step`,
      authorized({ method: "POST", body: "{}" })
    );
    assert.equal(step.status, 200);
    assert.equal((await json(step)).action, "workers_advanced");
    assert.equal(steps, 1);

    const pump = await fetch(
      `${url}/v2/runs/run_1/build/run`,
      authorized({ method: "POST", body: JSON.stringify({ maxSteps: 12 }) })
    );
    assert.equal((await json(pump)).action, "max:12");

    const invalidContinue = await fetch(
      `${url}/v2/runs/run_1/commands`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          command: "continue",
          idempotencyKey: "continue:not-paused",
        }),
      })
    );
    assert.equal(invalidContinue.status, 409);
    assert.equal(supervisor.getRun("run_1").state, "running");
    assert.equal(buildStatus, "running");
    assert.equal(benchmarkContinuations, 0);

    const pause = await fetch(
      `${url}/v2/runs/run_1/commands`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          command: "pause",
          idempotencyKey: "pause:benchmark-repair",
          reason: "protocol_error:invalid_lifecycle_batch",
        }),
      })
    );
    assert.equal(pause.status, 200);
    const continued = await fetch(
      `${url}/v2/runs/run_1/commands`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          command: "continue",
          idempotencyKey: "continue:benchmark-repair",
        }),
      })
    );
    assert.equal(continued.status, 200);
    assert.equal(benchmarkContinuations, 1);

    const handoff = await fetch(
      `${url}/v2/runs/run_1/build/project-handoff`,
      authorized({
        method: "POST",
        body: JSON.stringify({
          choice: "keep_integration_branch",
          idempotencyKey: "handoff:keep",
        }),
      })
    );
    assert.equal(handoff.status, 200);
    assert.equal((await json(handoff)).status, "completed");
    assert.equal(projectHandoffChoice, "keep_integration_branch");
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated steering routes enforce validation, unique concurrency, idempotency conflicts, and exact question versions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-steering-"));
  const schedulerPath = join(directory, "scheduler.sqlite");
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  let scheduler: SqliteSchedulerStore | undefined;
  let server: ControlServer | undefined;
  const createServer = () => {
    scheduler = new SqliteSchedulerStore(schedulerPath);
    const runtime = new BuildRuntime({
      runId: "run-steering",
      initialObjective: "Build exactly this application.\n",
      store: scheduler,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      clock: () => "2026-08-27T00:00:00.000Z",
    });
    const builds = new BuildRuntimeRegistry();
    builds.register(runtime);
    server = new ControlServer({ supervisor, token, bootstrapRun, builds });
    return server;
  };
  const guidanceBody = (version: number, idempotencyKey = `guidance:${version}`) => ({
    guidanceId: `guidance-${version}`,
    text: `Durable guidance ${version}.`,
    idempotencyKey,
  });
  try {
    const control = createServer();
    const address = await control.start(0);
    const activeScheduler = scheduler!;
    const guidanceUrl = `${address.url}/v2/runs/run-steering/build/user-guidance`;
    assert.equal((await fetch(guidanceUrl, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(guidanceUrl, authorized())).status, 404);
    const invalid = await fetch(guidanceUrl, authorized({
      method: "POST",
      body: JSON.stringify({ ...guidanceBody(1), text: " " }),
    }));
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).code, "invalid_request");
    const oversized = await fetch(guidanceUrl, authorized({
      method: "POST",
      body: JSON.stringify({ ...guidanceBody(1), text: "x".repeat(1024 * 1024) }),
    }));
    assert.equal(oversized.status, 413);
    assert.equal((await json(oversized)).code, "body_too_large");

    const concurrent = await Promise.all([1, 2, 3].map((version) => fetch(
      guidanceUrl,
      authorized({ method: "POST", body: JSON.stringify(guidanceBody(version)) }),
    )));
    const concurrentBodies = await Promise.all(concurrent.map(async (response) => await response.clone().json()));
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200, 200], JSON.stringify(concurrentBodies));
    const eventsAfterConcurrent = activeScheduler.readRun("run-steering");
    assert.equal(eventsAfterConcurrent.filter((event) => event.type === "user.guidance_submitted").length, 3);
    assert.equal(eventsAfterConcurrent.find((event) => event.type === "run.initialized")?.payload.objective, "Build exactly this application.\n");

    const duplicate = await fetch(guidanceUrl, authorized({
      method: "POST",
      body: JSON.stringify(guidanceBody(1)),
    }));
    assert.equal(duplicate.status, 200);
    const duplicateProjection = await json(duplicate);
    assert.equal(duplicateProjection.userGuidanceVersion, 3);
    assert.equal(Object.keys(duplicateProjection.userGuidance as object).length, 3);
    assert.equal(activeScheduler.readRun("run-steering").filter((event) => event.type === "user.guidance_submitted").length, 3);
    const conflict = await fetch(guidanceUrl, authorized({
      method: "POST",
      body: JSON.stringify({ ...guidanceBody(1), text: "Conflicting retry." }),
    }));
    assert.equal(conflict.status, 409);
    assert.equal((await json(conflict)).code, "idempotency_conflict");

    activeScheduler.append({
      runId: "run-steering",
      type: "architect.question_requested",
      occurredAt: "2026-08-27T00:00:01.000Z",
      actor: { role: "architect", id: "architect-test" },
      idempotencyKey: "question:1",
      payload: {
        questionId: "question-1",
        version: 1,
        decisionKind: "authority_decision",
        question: "Which documented behavior is authoritative?",
      },
    });
    const answerUrl = `${address.url}/v2/runs/run-steering/build/architect-questions/question-1/answer`;
    const stale = await fetch(answerUrl, authorized({
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2, answer: "Use the public contract.", idempotencyKey: "answer:stale" }),
    }));
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).code, "invalid_transition");
    const forged = await fetch(answerUrl, authorized({
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        answer: "Use the public contract.",
        idempotencyKey: "answer:forged",
        actor: { role: "worker", id: "worker-1" },
      }),
    }));
    assert.equal(forged.status, 400);
    const answered = await fetch(answerUrl, authorized({
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, answer: "Use the public contract.", idempotencyKey: "answer:1" }),
    }));
    assert.equal(answered.status, 200);
    const answeredProjection = await json(answered);
    assert.equal(
      (answeredProjection.architectQuestions as Record<string, { status: string; version: number }>)["question-1"].status,
      "answered",
    );
    assert.equal(answeredProjection.blockingArchitectQuestionId, undefined);
    assert.equal(JSON.stringify(answeredProjection).includes(token), false);
    const retryAnswer = await fetch(answerUrl, authorized({
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, answer: "Use the public contract.", idempotencyKey: "answer:1" }),
    }));
    assert.equal(retryAnswer.status, 200);
    const duplicateAnswer = await fetch(answerUrl, authorized({
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, answer: "Use another contract.", idempotencyKey: "answer:2" }),
    }));
    assert.equal(duplicateAnswer.status, 409);
    assert.equal((await json(duplicateAnswer)).code, "invalid_transition");
    assert.equal(activeScheduler.readRun("run-steering").filter((event) => event.type === "architect.question_answered").length, 1);
  } finally {
    await server?.close();
    scheduler?.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent identical guidance retries both succeed with one durable event and version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-guidance-identical-"));
  let fixture: Awaited<ReturnType<typeof createSteeringControlFixture>> | undefined;
  try {
    fixture = await createSteeringControlFixture(directory);
    const body = durableGuidanceBody(
      "guidance-concurrent",
      "Apply the same durable direction.",
      "guidance:concurrent:same",
    );
    const responses = await Promise.all([
      fetch(fixture.url, authorized({ method: "POST", body: JSON.stringify(body) })),
      fetch(fixture.url, authorized({ method: "POST", body: JSON.stringify(body) })),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const projections = await Promise.all(responses.map(async (response) => await json(response)));
    assert.deepEqual(projections.map((projection) => projection.userGuidanceVersion), [1, 1]);

    const events = fixture.scheduler.readRun("run-steering");
    const guidanceEvents = events.filter((event) => event.type === "user.guidance_submitted");
    assert.equal(guidanceEvents.length, 1);
    assert.equal(guidanceEvents[0]?.payload.guidanceId, "guidance-concurrent");
    assert.equal(guidanceEvents[0]?.payload.version, 1);
  } finally {
    await fixture?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent conflicting guidance retries yield one success, one conflict, and one durable winner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-guidance-conflict-"));
  let fixture: Awaited<ReturnType<typeof createSteeringControlFixture>> | undefined;
  try {
    fixture = await createSteeringControlFixture(directory);
    const first = durableGuidanceBody(
      "guidance-conflict",
      "Choose the first direction.",
      "guidance:concurrent:conflict",
    );
    const second = durableGuidanceBody(
      "guidance-conflict",
      "Choose the second direction.",
      "guidance:concurrent:conflict",
    );
    const responses = await Promise.all([
      fetch(fixture.url, authorized({ method: "POST", body: JSON.stringify(first) })),
      fetch(fixture.url, authorized({ method: "POST", body: JSON.stringify(second) })),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    assert.ok(conflict);
    assert.equal((await json(conflict)).code, "idempotency_conflict");

    const guidanceEvents = fixture.scheduler
      .readRun("run-steering")
      .filter((event) => event.type === "user.guidance_submitted");
    assert.equal(guidanceEvents.length, 1);
    assert.equal(guidanceEvents[0]?.payload.version, 1);
    assert.ok(
      guidanceEvents[0]?.payload.text === first.text
      || guidanceEvents[0]?.payload.text === second.text,
    );
  } finally {
    await fixture?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guidance retry after a lost post-append response replays one WAL event without changing the objective", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-guidance-lost-response-"));
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let signalAppended!: () => void;
  const appended = new Promise<void>((resolve) => {
    signalAppended = resolve;
  });
  let signalReturned!: () => void;
  const returned = new Promise<void>((resolve) => {
    signalReturned = resolve;
  });
  let fixture: Awaited<ReturnType<typeof createSteeringControlFixture>> | undefined;
  let recovered: Awaited<ReturnType<typeof createSteeringControlFixture>> | undefined;
  try {
    fixture = await createSteeringControlFixture(directory, (builds) => new Proxy(builds, {
      get(target, property, receiver) {
        if (property === "submitUserGuidance") {
          return async (
            runId: Parameters<BuildControlPlane["submitUserGuidance"]>[0],
            input: Parameters<BuildControlPlane["submitUserGuidance"]>[1],
          ) => {
            const projection = await target.submitUserGuidance(runId, input);
            signalAppended();
            await responseReleased;
            signalReturned();
            return projection;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    const body = durableGuidanceBody(
      "guidance-lost-response",
      "Persist this before acknowledging HTTP success.",
      "guidance:lost-response",
    );
    const abortController = new AbortController();
    const request = fetch(fixture.url, authorized({
      method: "POST",
      body: JSON.stringify(body),
      signal: abortController.signal,
    })).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    await appended;
    assert.equal(
      fixture.scheduler.readRun("run-steering").filter((event) => event.type === "user.guidance_submitted").length,
      1,
    );
    abortController.abort();
    releaseResponse();
    const lostResponse = await request;
    assert.ok("error" in lostResponse);
    assert.equal((lostResponse.error as Error).name, "AbortError");
    await returned;

    await fixture.close();
    fixture = undefined;
    recovered = await createSteeringControlFixture(directory);
    const retry = await fetch(recovered.url, authorized({
      method: "POST",
      body: JSON.stringify(body),
    }));
    assert.equal(retry.status, 200);
    const retryProjection = await json(retry);
    assert.equal(retryProjection.userGuidanceVersion, 1);

    const recoveredEvents = recovered.scheduler.readRun("run-steering");
    assert.equal(recoveredEvents.filter((event) => event.type === "user.guidance_submitted").length, 1);
    assert.equal(
      recoveredEvents.find((event) => event.type === "run.initialized")?.payload.objective,
      "Build exactly this application.\n",
    );
  } finally {
    releaseResponse();
    await fixture?.close();
    await recovered?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SSE reconnect replays only events after the acknowledged sequence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-sse-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite")),
    { clock: () => "2026-07-11T00:00:00.000Z" }
  );
  supervisor.createRun({
    runId: "run_1",
    projectPath: directory,
    permissionProfile: "project",
    idempotencyKey: "create:run_1",
  });
  supervisor.captureBaseline(
    "run_1",
    "baseline:run_1",
    "b".repeat(40),
    "refs/aiboard/runs/test/baseline"
  );
  supervisor.start("run_1", "start:run_1");
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => gitReady,
    bootstrapRun,
    heartbeatMs: 50,
  });

  try {
    const { url } = await server.start(0);
    const firstResponse = await fetch(
      `${url}/v2/runs/run_1/stream?after=0`,
      authorized({ headers: { Accept: "text/event-stream" } })
    );
    assert.equal(firstResponse.status, 200);
    const firstReader = firstResponse.body?.getReader();
    assert.ok(firstReader);
    const firstText = await readThroughEvent(firstReader, 3);
    await firstReader.cancel();
    assert.deepEqual(eventIds(firstText), [1, 2, 3]);

    supervisor.pause("run_1", "pause:run_1", "test");
    supervisor.resume("run_1", "resume:run_1");

    const response = await fetch(
      `${url}/v2/runs/run_1/stream?after=3`,
      authorized({ headers: { Accept: "text/event-stream" } })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    assert.ok(reader);
    const text = await readThroughEvent(reader, 5);
    await reader.cancel();
    assert.deepEqual(eventIds(text), [4, 5]);
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function readThroughEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sequence: number
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(`id: ${sequence}`)) {
    const result = await reader.read();
    assert.equal(result.done, false);
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

function eventIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

test("control API rejects request bodies larger than one MiB", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-limit-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite"))
  );
  const server = new ControlServer({
    supervisor,
    token,
    checkGit: async () => gitReady,
    bootstrapRun,
  });
  try {
    const { url } = await server.start(0);
    const response = await fetch(
      `${url}/v2/runs`,
      authorized({
        method: "POST",
        body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
      })
    );
    assert.equal(response.status, 413);
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
