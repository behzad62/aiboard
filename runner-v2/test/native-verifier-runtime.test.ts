import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { NativeVerifierRuntime } from "../src/native-verifier-runtime.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  RuntimeRouter,
  type AgentRuntimeCandidate,
} from "../src/runtime-router.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";

const TARGET_REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const HASH = "c".repeat(64);

const candidates: AgentRuntimeCandidate[] = [
  {
    runtimeId: "openai:architect",
    providerId: "openai",
    modelId: "architect",
    capabilities: ["code"],
    priority: 0,
  },
  {
    runtimeId: "anthropic:author",
    providerId: "anthropic",
    modelId: "author",
    capabilities: ["code"],
    priority: 1,
  },
  {
    runtimeId: "google:verifier",
    providerId: "google",
    modelId: "verifier",
    capabilities: ["code"],
    priority: 2,
  },
];

test("verifier receives complete revision-bound context in a separate read-only session", async () => {
  const fixture = createFixture("context", [{
    blocks: [{ type: "text", text: "Inspection complete." }],
    stopReason: "end_turn",
  }]);
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_context"));

    assert.equal(result.status, "inspected");
    assert.equal(result.runtimeId, "google:verifier");
    assert.equal(result.targetRevision, TARGET_REVISION);
    assert.match(result.sessionId, /^verifier:run_context:/);
    assert.notEqual(result.sessionId, "architect:run_context");
    assert.equal(fixture.workspaceRequests.length, 1);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);

    const request = fixture.model.requests[0]!;
    assert.equal(request.sessionId, result.sessionId);
    assert.equal(request.tools.length > 0, true);
    assert.equal(
      request.tools.every(
        (definition) =>
          definition.readOnly &&
          definition.effect === "none" &&
          definition.lifecycle !== true
      ),
      true
    );
    const toolNames = request.tools.map((definition) => definition.name);
    for (const required of ["artifact.read", "fs.read", "git.show", "inspect_evidence"]) {
      assert.equal(toolNames.includes(required), true, required);
    }
    for (const forbidden of [
      "fs.write",
      "git.commit",
      "git.push",
      "plan_build",
      "review_task",
      "integrate_task",
      "complete_run",
    ]) {
      assert.equal(toolNames.includes(forbidden), false, forbidden);
    }

    const context = request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    for (const required of [
      "Build the audited application.",
      "criterion_ui",
      "The UI matches the request.",
      "review approved with evidence",
      "Keep the public API stable.",
      "change_set_1",
      "src/app.ts",
      "final build passed",
      "final build command fact",
      "security_auth_crypto_path",
      HASH,
      TARGET_REVISION,
    ]) {
      assert.match(context, new RegExp(escapeRegExp(required)), required);
    }

    const session = await fixture.sessions.load(result.sessionId);
    assert.equal(session.actor.role, "verifier");
    assert.equal(session.actor.id, "google:verifier");
    assert.equal(session.status, "completed");
  } finally {
    fixture.close();
  }
});

test("verifier cannot invoke write, commit, lifecycle, or completion tools", async () => {
  const fixture = createFixture("authority", [
    {
      blocks: [
        {
          type: "tool_call",
          callId: "write-1",
          name: "fs.write",
          arguments: { path: "app.txt", content: "tampered" },
        },
        {
          type: "tool_call",
          callId: "commit-1",
          name: "git.commit",
          arguments: { message: "bypass" },
        },
        {
          type: "tool_call",
          callId: "complete-1",
          name: "complete_run",
          arguments: {},
        },
      ],
      stopReason: "tool_calls",
    },
    {
      blocks: [{ type: "text", text: "No mutation authority is available." }],
      stopReason: "end_turn",
    },
  ]);
  const file = join(fixture.workspacePath, "app.txt");
  writeFileSync(file, "original", "utf8");
  try {
    const result = await fixture.runtime.inspect(verifierRequest("run_authority"));
    assert.equal(result.status, "inspected");
    assert.equal(readFileSync(file, "utf8"), "original");
    const replay = fixture.model.requests[1]!;
    const serialized = JSON.stringify(replay.messages);
    assert.match(serialized, /Tool fs\.write is not registered/);
    assert.match(serialized, /Tool git\.commit is not registered/);
    assert.match(serialized, /Tool complete_run is not registered/);
  } finally {
    fixture.close();
  }
});

test("verifier refuses a workspace whose revision differs from the requested integration snapshot", async () => {
  const fixture = createFixture("stale", [{
    blocks: [{ type: "text", text: "must not run" }],
    stopReason: "end_turn",
  }], OTHER_REVISION);
  try {
    await assert.rejects(
      fixture.runtime.inspect(verifierRequest("run_stale")),
      /workspace target revision.*requested integration revision/i
    );
    assert.equal(fixture.model.requests.length, 0);
    assert.deepEqual(fixture.workspaceRequests, [TARGET_REVISION]);
  } finally {
    fixture.close();
  }
});

function createFixture(
  name: string,
  turns: ModelTurn[],
  returnedRevision = TARGET_REVISION
) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-native-verifier-${name}-`));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(
    join(root, "sessions.sqlite"),
    artifacts
  );
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const model = new ScriptedModel(turns);
  const workspaceRequests: string[] = [];
  const workspaceManager = {
    workspaceKind: "independent-verifier" as const,
    create: async (targetRevision: string) => {
      workspaceRequests.push(targetRevision);
      return {
        runId: "fixture",
        workspaceId: "verifier-fixture",
        path: workspacePath,
        metadataPath: join(root, "workspace.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision: returnedRevision,
        canonicalRevision: TARGET_REVISION,
      };
    },
  };
  const router = new RuntimeRouter({
    candidates,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  return {
    root,
    workspacePath,
    sessions,
    model,
    workspaceRequests,
    runtime: new NativeVerifierRuntime({
      router,
      candidates,
      models: new Map([["google:verifier", model]]),
      verifierRuntimeIds: ["google:verifier"],
      sessions,
      artifacts,
      evidenceStore,
      workspaceManager,
      clock: () => "2026-08-27T00:00:00.000Z",
    }),
    close: () => {
      sessions.close();
      evidenceStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function verifierRequest(runId: string) {
  return {
    runId,
    objective: "Build the audited application.",
    targetRevision: TARGET_REVISION,
    architectRuntimeId: "openai:architect",
    criteria: [{
      taskId: "task_ui",
      taskTitle: "Implement the UI",
      criterion: {
        id: "criterion_ui",
        text: "The UI matches the request.",
      },
    }],
    reviews: [{
      taskId: "task_ui",
      attempt: 1,
      status: "approved" as const,
      summary: "review approved with evidence",
      evidenceArtifactHashes: [HASH],
      criterionVerdicts: [{
        criterionId: "criterion_ui",
        verdict: "satisfied" as const,
        rationale: "Evidence is current.",
        evidenceIds: ["evidence_ui"],
      }],
    }],
    guidance: [{
      id: "guidance_1",
      kind: "user_guidance" as const,
      version: 1,
      text: "Keep the public API stable.",
    }],
    changes: [{
      taskId: "task_ui",
      attempt: 1,
      changeSetId: "change_set_1",
      authorRuntimeId: "anthropic:author",
      baselineRevision: OTHER_REVISION,
      taskRevision: TARGET_REVISION,
      changedPaths: ["src/app.ts"],
      diffArtifactHash: HASH,
    }],
    finalVerification: {
      generationId: "final_generation_1",
      targetRevision: TARGET_REVISION,
      green: true,
      checks: [{
        category: "build" as const,
        status: "required" as const,
        green: true,
        rationale: "final build passed",
        evidenceIds: ["final_build_evidence"],
        facts: [{
          kind: "command" as const,
          label: "final build command fact",
          command: "npm",
          args: ["run", "build"],
          cwd: ".",
          startedAt: "2026-08-27T00:00:00.000Z",
          finishedAt: "2026-08-27T00:00:01.000Z",
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          stdoutArtifactHash: HASH,
          stderrArtifactHash: HASH,
          repositoryRevision: TARGET_REVISION,
          category: "build" as const,
          executable: "npm",
          targetRevision: TARGET_REVISION,
          startState: { revision: TARGET_REVISION, status: "" },
          endState: { revision: TARGET_REVISION, status: "" },
        }],
        issues: [],
      }],
    },
    riskReasons: [{
      code: "security_auth_crypto_path" as const,
      evidence: ["src/auth/session.ts"],
    }],
  };
}

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];

  constructor(private readonly turns: ModelTurn[]) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    });
    const turn = this.turns.shift();
    if (!turn) throw new Error("Unexpected verifier model call.");
    return structuredClone(turn);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
