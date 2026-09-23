/**
 * A0 capture. Drives today's BuildRuntime + NativeVerifierRuntime once and
 * writes runner-v2/test/support/pre-capability-run.fixture.json.
 * Not part of the repo. Do not re-run after the fixture is accepted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/agent-contracts.ts";
import { ArtifactStore } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/artifact-store.ts";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
  type FinalVerificationCheckDriver,
  type IndependentVerifierDriver,
} from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/build-runtime.ts";
import { buildNativeVerifierInspectionRequest } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/native-build-factory.ts";
import { NativeVerifierRuntime } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/native-verifier-runtime.ts";
import { ProviderHealthRegistry } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/provider-health.ts";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
} from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/scheduler-store.ts";
import { SqliteAgentSessionStore } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/sqlite-agent-session-store.ts";
import { SqliteContextManifestStore } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/sqlite-context-manifest-store.ts";
import { SqliteEvidenceStore } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/sqlite-evidence-store.ts";
import { SqliteSchedulerStore } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/sqlite-scheduler-store.ts";
import {
  RuntimeRouter,
  type AgentRuntimeCandidate,
} from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/runtime-router.ts";
import type { BuildRiskAssessmentInput } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/risk-policy.ts";
import { SchedulerVerifierVerdictAuthority } from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/src/verifier-verdict-authority.ts";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "file:///D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5/runner-v2/test/support/final-verification-profile.ts";

const RUN_ID = "run-pre-capability";
const TASK_ID = "task_feature";
const CRITERION_ID = "behavior";
const CLOCK = "2026-09-23T00:00:00.000Z";
const ARCHITECT_RUNTIME_ID = "openai:architect";
const VERIFIER_RUNTIME_ID = "google:verifier";
const INTEGRATION_REVISION = "a".repeat(40);
const ARTIFACT_HASH = "e".repeat(64);
const OBJECTIVE = "Add a session check on the authentication path.";
const WORKSPACE = "D:/repos/ai-discussion-board/.worktrees/runner-v2-p6-5";
const FIXTURE_PATH = join(
  WORKSPACE,
  "runner-v2/test/support/pre-capability-run.fixture.json",
);
const SCRIPT_PATH = new URL(import.meta.url);

const CANDIDATES: AgentRuntimeCandidate[] = [
  {
    runtimeId: ARCHITECT_RUNTIME_ID,
    providerId: "openai",
    modelId: "architect-model",
    capabilities: ["code"],
    priority: 0,
  },
  {
    runtimeId: VERIFIER_RUNTIME_ID,
    providerId: "google",
    modelId: "verifier-model",
    capabilities: ["code"],
    priority: 1,
  },
];

function highRiskInput(): BuildRiskAssessmentInput {
  return {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/auth/session.ts"],
    },
  };
}

class ScriptedArchitect implements ArchitectRuntimeDriver {
  private callSequence = 0;

  async run(request: ArchitectActionRequest): Promise<void> {
    const reason = request.reason;
    if (reason.type === "plan_required") {
      await this.invoke(request, "plan_tasks", {
        revision: 1,
        tasks: [{
          id: TASK_ID,
          objective: "Implement the authentication session check.",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{
            id: CRITERION_ID,
            text: "The feature matches the requested behavior.",
          }],
        }],
      });
      return;
    }
    if (reason.type === "review_required") {
      const task = request.projection.tasks[reason.taskId];
      const links = task?.criterionEvidenceLinks ?? [];
      await this.invoke(request, "review_task", {
        taskId: reason.taskId,
        decision: "approved",
        summary: "Task intent is satisfied.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: (task?.acceptanceCriteria ?? []).map((criterion) => {
          const link = links.find((candidate) => candidate.criterionId === criterion.id);
          return {
            criterionId: criterion.id,
            verdict: "satisfied",
            rationale: "The worker evidence supports this criterion.",
            evidenceIds: link ? [link.evidenceId] : [],
            artifactHashes: link?.artifactHashes,
          };
        }),
      });
      return;
    }
    if (reason.type === "integration_approval_required") {
      await this.invoke(request, "request_integration", { taskId: reason.taskId });
      return;
    }
    if (reason.type === "final_verification_plan_required") {
      await this.invoke(request, "plan_final_verification", {
        plan: {
          checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
            category,
            status: "not_applicable",
            rationale: `No ${category} fixture is configured.`,
            repositoryInspection: {
              paths: ["package.json"],
              summary: `No ${category} fixture is configured.`,
            },
          })),
        },
      });
      return;
    }
    if (reason.type === "final_verification_review_required") {
      const current = request.projection.finalVerification?.current;
      const checks = current?.submissionResult?.checks ?? [];
      await this.invoke(request, "review_final_verification", {
        taskId: reason.taskId,
        generationId: reason.generationId,
        targetRevision: reason.targetRevision,
        submissionId: reason.submissionId,
        attempt: current?.submission?.attempt ?? 1,
        decision: "approved",
        summary: "Not-applicable checks match the repository and the integration is approved.",
        architectRisk: "high",
        architectRiskRationale: "The change touches an authentication path.",
        categoryReviews: checks.map((check) => ({
          category: check.category,
          verdict: "approved",
          rationale: `${check.category} is approved.`,
          evidenceIds: [...check.evidenceIds],
        })),
      });
      return;
    }
    throw new Error(`Unexpected Architect reason ${reason.type}`);
  }

  private async invoke(
    request: ArchitectActionRequest,
    name: string,
    argumentsValue: unknown,
  ): Promise<void> {
    this.callSequence += 1;
    const result = await request.tools.invoke({
      type: "tool_call",
      callId: `architect_${this.callSequence}`,
      name,
      arguments: argumentsValue,
    }, request.context);
    if (result.isError) {
      throw new Error(result.error?.message ?? `Architect tool ${name} failed`);
    }
  }
}

class ScriptedVerifierModel implements AgentModel {
  private index = 0;

  constructor(private readonly evidenceId: string) {}

  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    const turns: ModelTurn[] = [
      {
        blocks: [{
          type: "tool_call",
          callId: "exp-1",
          name: "record_verification_expectations",
          arguments: {
            expectations: [{
              taskId: TASK_ID,
              criterionId: CRITERION_ID,
              expectedBehaviors: ["The feature matches the requested behavior."],
              edgeCases: ["empty input"],
              regressionSurfaces: ["src/auth/session.ts"],
              requiredTests: ["feature behavior"],
            }],
          },
        }],
        stopReason: "tool_calls",
      },
      {
        blocks: [{
          type: "tool_call",
          callId: "verdict-1",
          name: "submit_verifier_verdict",
          arguments: {
            criterionVerdicts: [{
              taskId: TASK_ID,
              criterionId: CRITERION_ID,
              verdict: "satisfied",
              rationale: "The integrated feature matches the recorded expectations.",
              evidenceIds: [this.evidenceId],
            }],
          },
        }],
        stopReason: "tool_calls",
      },
    ];
    const turn = turns[this.index];
    this.index += 1;
    if (!turn) throw new Error("Unexpected verifier model call.");
    return structuredClone(turn);
  }
}

function sha256File(fileUrl: URL): string {
  return createHash("sha256").update(readFileSync(fileUrl)).digest("hex");
}

async function main(): Promise<void> {
  const root = join(tmpdir(), "aiboard-a0-pre-capability-capture");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const workspacePath = join(root, "verifier-workspace");
  const baselinePath = join(root, "verifier-baseline");
  mkdirSync(workspacePath);
  mkdirSync(baselinePath);
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const manifests = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const evidenceRecord = evidence.record({
    runId: RUN_ID,
    taskId: TASK_ID,
    actor: { role: "worker", id: `worker_${TASK_ID}_1` },
    fact: {
      kind: "browser_screenshot",
      label: "task_feature evidence",
      capturedAt: CLOCK,
      screenshotArtifactHash: ARTIFACT_HASH,
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: CLOCK,
    idempotencyKey: "evidence:task_feature",
    attempt: 1,
  });
  const model = new ScriptedVerifierModel(evidenceRecord.id);
  const router = new RuntimeRouter({
    candidates: CANDIDATES,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  const nativeVerifier = new NativeVerifierRuntime({
    router,
    candidates: CANDIDATES,
    models: new Map([[VERIFIER_RUNTIME_ID, model]]),
    verifierRuntimeIds: [VERIFIER_RUNTIME_ID],
    sessions,
    artifacts,
    evidenceStore: evidence,
    contextManifests: manifests,
    verdictAuthority: new SchedulerVerifierVerdictAuthority(scheduler),
    clock: () => CLOCK,
    workspaceManager: {
      workspaceKind: "independent-verifier",
      create: async (targetRevision: string) => ({
        runId: RUN_ID,
        workspaceId: "verifier-workspace",
        path: workspacePath,
        metadataPath: join(root, "workspace.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision,
        canonicalRevision: INTEGRATION_REVISION,
      }),
      createBaseline: async (revision: string) => ({
        runId: RUN_ID,
        workspaceId: "verifier-baseline",
        path: baselinePath,
        metadataPath: join(root, "baseline.metadata.json"),
        repositoryRoot: workspacePath,
        targetRevision: revision,
        canonicalRevision: revision,
      }),
      cleanupBaseline: async () => undefined,
    },
  });
  const independentVerifier: IndependentVerifierDriver = {
    candidateRuntimeIds: [VERIFIER_RUNTIME_ID],
    twoPass: true,
    assessRisk: async () => highRiskInput(),
    verify: async (request) => {
      const inspection = buildNativeVerifierInspectionRequest({
        runId: RUN_ID,
        objective: OBJECTIVE,
        architectRuntimeId: request.projection.runtime.architect.runtimeId ?? ARCHITECT_RUNTIME_ID,
        projection: request.projection,
        sessions: await sessions.listRun(RUN_ID),
        schedulerEvents: scheduler.readRun(RUN_ID),
        twoPass: true,
        risk: request.risk,
        ...(request.preferredRuntimeId ? { preferredRuntimeId: request.preferredRuntimeId } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const result = await nativeVerifier.inspect(inspection);
      if (result.status === "verdict_submitted") return { status: "verdict_submitted" };
      if (result.status === "unavailable") return { status: "unavailable", reason: result.reason };
      return {
        status: "suspended",
        reason: result.status === "suspended" ? result.reason : `unexpected:${result.status}`,
        ...(result.status === "suspended" ? { runtimeId: result.runtimeId, error: result.error } : {}),
      };
    },
  };
  const checks: FinalVerificationCheckDriver = {
    executeCheck: async (input) => {
      const planned = input.plan.checks.find((check) => check.category === input.category);
      if (!planned) throw new Error(`Missing planned check ${input.category}`);
      return {
        workspacePath: "C:/verification/pre-capability",
        startedAt: CLOCK,
        finishedAt: CLOCK,
        check: {
          ...planned,
          green: true,
          evidenceIds: [],
          facts: [],
          issues: [],
        },
      };
    },
  };
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      initialObjective: OBJECTIVE,
      store: scheduler,
      evidenceStore: evidence,
      architectId: ARCHITECT_RUNTIME_ID,
      architectDriver: new ScriptedArchitect(),
      workerDriver: {
        run: async (assignment) => ({
          type: "submitted",
          changeSetId: "changeset_feature",
          criterionEvidenceLinks: [{
            criterionId: CRITERION_ID,
            evidenceId: evidenceRecord.id,
            artifactHashes: [ARTIFACT_HASH],
            taskId: assignment.task.id,
            attempt: assignment.attempt,
          }],
        }),
      },
      integrationDriver: {
        integrate: async () => ({
          status: "integrated",
          integrationRevision: INTEGRATION_REVISION,
        }),
      },
      independentVerifier,
      finalVerificationDriver: checks,
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
      maxConcurrency: 1,
      workspaceFor: async () => "C:/work/task_feature",
      clock: () => CLOCK,
    });
    const actions: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const step = await runtime.step();
      actions.push(`${index}:${step.status}:${step.action ?? ""}`);
      const projection = runtime.projection();
      if (projection.verifier?.current?.status === "submitted" && projection.verifier.current.expectations) {
        break;
      }
      if (step.status !== "progressed") {
        throw new Error(`Build stopped at ${actions.at(-1)} before a two-pass verdict.`);
      }
    }
    const schedulerEvents = scheduler.readRun(RUN_ID);
    const schedulerProjection = rebuildSchedulerProjection(schedulerEvents);
    const task = schedulerProjection.tasks[TASK_ID];
    if (!schedulerEvents.some((event) => event.type === "plan.created")) {
      throw new Error("Capture is missing plan.created.");
    }
    if (task?.status !== "integrated") {
      throw new Error(`Task status is ${task?.status ?? "missing"}, expected integrated.`);
    }
    for (const type of [
      "verifier.review_requested",
      "verifier.expectations_recorded",
      "verifier.verdict_submitted",
    ] as const) {
      if (!schedulerEvents.some((event) => event.type === type)) {
        throw new Error(`Capture is missing ${type}.`);
      }
    }
    if (!schedulerProjection.verifier?.current?.expectations) {
      throw new Error("Capture is missing recorded verifier expectations.");
    }
    const contextManifests = manifests.listRun(RUN_ID);
    if (contextManifests.length === 0) {
      throw new Error("Capture recorded no context manifest.");
    }
    const manifestDatabase = new DatabaseSync(join(root, "context-manifests.sqlite"), { readOnly: true });
    let payloadRows: Array<{ manifest_id: string; payload_json: string }>;
    try {
      payloadRows = manifestDatabase.prepare(
        `SELECT manifest_id, payload_json FROM context_manifests
         WHERE run_id = ? ORDER BY recorded_at ASC, manifest_id ASC`,
      ).all(RUN_ID) as Array<{ manifest_id: string; payload_json: string }>;
    } finally {
      manifestDatabase.close();
    }
    if (payloadRows.length !== contextManifests.length) {
      throw new Error("Context manifest payload rows do not match listRun.");
    }
    const counts = new Map<string, number>();
    for (const event of schedulerEvents) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    }
    const fixture = {
      capturedAt: CLOCK,
      baseRevision: "6c166f97",
      generator: {
        path: SCRIPT_PATH.pathname.startsWith("/") && process.platform === "win32"
          ? decodeURIComponent(SCRIPT_PATH.pathname.slice(1))
          : decodeURIComponent(SCRIPT_PATH.pathname),
        sha256: sha256File(SCRIPT_PATH),
      },
      schedulerEvents,
      schedulerProjection,
      evidenceRecords: evidence.list({ runId: RUN_ID, limit: 100 }),
      contextManifests: payloadRows.map((row, index) => ({
        manifestId: row.manifest_id,
        payloadJson: row.payload_json,
        manifest: contextManifests[index],
      })),
    };
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(JSON.stringify({
      actions,
      eventCounts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      eventTotal: schedulerEvents.length,
      manifestCount: contextManifests.length,
      manifestPurposes: contextManifests.map((manifest) => manifest.purpose),
      taskStatus: task.status,
      verifierStatus: schedulerProjection.verifier?.current?.status,
      twoPass: schedulerProjection.verifier?.current?.twoPass === true,
      fixture: FIXTURE_PATH,
    }, null, 2));
  } finally {
    sessions.close();
    manifests.close();
    scheduler.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
