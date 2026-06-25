/** Build checkpoint shape checks (run: npx tsx scripts/test-build-checkpoint.mts) */
import type { BuildCheckpoint } from "../lib/db/schema";
import { normalizeBuildTasksForResume } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const checkpoint: BuildCheckpoint = {
  discussionId: "d1",
  status: "stopped",
  updatedAt: "2026-06-21T00:00:00.000Z",
  runPolicy: "budgeted",
  stopReason: "budget",
  wave: 3,
  tasks: [
    {
      id: "T1",
      title: "Implement settings",
      instructions: "Add Build settings fields.",
      contextFiles: [],
      outputPaths: ["lib/db/schema.ts"],
      status: "done",
    },
  ],
  architectNotes: "Continue with UI.",
  verifyCommand: "npm run build",
  branch: "codex/build-mode-run-policy",
  prUrl: null,
  milestone: "Build mode redesign",
  issueNumbers: [12, 13],
  failureFingerprints: { "npm run build|TS123": 2 },
  recoveryLog: ["Split UI task after first failure."],
  usageWindow: {
    startedAt: "2026-06-21T00:00:00.000Z",
    elapsedMs: 1000,
    estimatedUsd: 0.42,
    unknownPricedModelIds: [],
    models: [],
  },
  skillMode: "strict",
  skillEvidence: [
    {
      taskId: "T1",
      skillId: "agent:test-driven-development",
      actor: "worker-a",
      required: ["RED", "GREEN"],
      reportedEvidence: ["RED failed", "GREEN passed"],
      missingEvidence: [],
      violations: [],
    },
  ],
  skillEvents: [
    {
      scope: "T1",
      phase: "worker",
      actor: "worker",
      activeSkills: ["aiboard:build-os", "agent:test-driven-development"],
      evidence: [],
      warnings: [],
    },
  ],
};

check("checkpoint stores discussion id", checkpoint.discussionId === "d1", checkpoint);
check("checkpoint stores task graph", checkpoint.tasks.length === 1, checkpoint);
check("checkpoint stores budget stop reason", checkpoint.stopReason === "budget", checkpoint);
check("checkpoint stores skill mode", checkpoint.skillMode === "strict", checkpoint);
check("checkpoint stores skill evidence", checkpoint.skillEvidence?.length === 1, checkpoint);
check("checkpoint stores skill events", checkpoint.skillEvents?.length === 1, checkpoint);

const resumed = normalizeBuildTasksForResume([
  {
    id: "T1",
    title: "Approved foundation",
    instructions: "Already done.",
    contextFiles: [],
    status: "done",
  },
  {
    id: "T2",
    title: "Failed implementation",
    instructions: "Try the game implementation.",
    contextFiles: [],
    status: "failed",
    failCount: 3,
    workerIndex: 1,
    assignTo: "claude-opus-4-5",
    retryAfterMs: 9999999999999,
  },
  {
    id: "T3",
    title: "Dependent page wiring",
    instructions: "Wire the page after T2 lands.",
    contextFiles: [],
    status: "planned",
    dependsOn: ["T2"],
  },
]);

const resumedFailed = resumed.find((task) => task.id === "T2");
check("resume makes terminal failed tasks runnable", resumedFailed?.status === "fixing", resumed);
check("resume preserves failed task history", resumedFailed?.failCount === 3, resumedFailed);
check("resume clears stale worker pin", resumedFailed?.workerIndex === undefined, resumedFailed);
check("resume clears stale worker preference", resumedFailed?.assignTo === undefined, resumedFailed);
check("resume clears stale retry delay", resumedFailed?.retryAfterMs === undefined, resumedFailed);
check("resume keeps dependent planned tasks intact", resumed.find((task) => task.id === "T3")?.status === "planned", resumed);

process.exit(failed === 0 ? 0 : 1);
