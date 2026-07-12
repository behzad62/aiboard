import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlServer } from "../src/control-server.js";
import type { BuildControlPlane } from "../src/build-runtime-registry.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import type { GitPreflightResult } from "../src/git-preflight.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

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
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
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
            budgetLimits: { maxModelCalls: 50, maxToolCalls: 200 },
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
      budgetLimits: { maxModelCalls: 50, maxToolCalls: 200 },
      createdAt: "2026-07-11T00:00:00.000Z",
      idempotencyKey: "build:create:run_native",
    });
  } finally {
    await server.close();
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
        attempt: 0,
      },
    },
    guidance: {},
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: 1,
  };
  let projectHandoffChoice = "";
  const builds: BuildControlPlane = {
    projection: () => projection,
    events: () => [],
    step: async () => {
      steps += 1;
      return { status: "progressed", action: "workers_advanced" };
    },
    runUntilBlocked: async (_runId, maxSteps) => ({
      status: "idle",
      action: `max:${maxSteps ?? 100}`,
    }),
    activate: () => undefined,
    pause: () => ({ ...projection, status: "paused" }),
    resume: () => projection,
    selectArchitectHandoff: () => projection,
    selectProjectHandoff: async (_runId, choice) => {
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
  };
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
