/** Build checkpoint shape checks (run: npx tsx scripts/test-build-checkpoint.mts) */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { BuildCheckpoint, Discussion } from "../lib/db/schema";
import type {
  getBuildCheckpoint,
  getDiscussionById,
  insertDiscussion,
  upsertBuildCheckpoint,
  __resetClientStoreForTests,
} from "../lib/client/store";
import {
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
  importBenchmarkReportBundleV2,
} from "../lib/benchmark/store";
import type { BenchmarkReportBundleV2 } from "../lib/benchmark/types";
import {
  normalizeBuildTasksForResume,
  restoreArchitectApprovedTasksAfterLegacyQualityGateVeto,
  reopenBuildTasksForQualityGate,
} from "../lib/orchestrator/build";

const require = createRequire(import.meta.url);
const storeApi = require("../lib/client/store") as {
  __resetClientStoreForTests: typeof __resetClientStoreForTests;
  getBuildCheckpoint: typeof getBuildCheckpoint;
  getDiscussionById: typeof getDiscussionById;
  insertDiscussion: typeof insertDiscussion;
  upsertBuildCheckpoint: typeof upsertBuildCheckpoint;
};
const clientApi = require("../lib/client/api") as typeof import("../lib/client/api");
const engineApi = require("../lib/client/engine") as typeof import("../lib/client/engine");
const buildEngineSource = readFileSync(
  new URL("../lib/client/build-engine.ts", import.meta.url),
  "utf8"
);

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const memoryAdapter = {
  kind: "indexeddb" as const,
  load: async () => null,
  save: async () => {},
  listBenchmarkRunIds: async () => [],
  loadBenchmarkRun: async () => null,
  saveBenchmarkRun: async () => {},
  deleteBenchmarkRun: async () => {},
  label: () => "test memory",
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
      avoidWorkerIndexes: [1, 2],
      unavailableWorkerIndexes: [3],
      guidance: [
        {
          id: "G-T1-1",
          taskId: "T1",
          mode: "async",
          question: "Should this become a convention?",
          status: "answered",
          answer: "Keep it task-scoped.",
          requestedBy: "Worker A",
          requestedAtWave: 2,
          answeredAtWave: 3,
        },
      ],
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
  planContractValidation: {
    valid: false,
    errors: [
      {
        code: "unknown_dependency",
        severity: "error",
        taskIds: ["T1"],
        message: 'Task T1 depends on unknown task "T0".',
      },
    ],
    warnings: [],
  },
  planContractRevisionCount: 2,
  taskVerificationFacts: [
    {
      taskId: "T1",
      wave: 3,
      at: "2026-06-21T00:00:00.000Z",
      action: "run",
      status: "passed",
      source: "project_verifier",
      summary: "npm run build exited successfully.",
      coveredPaths: ["lib/db/schema.ts"],
    },
  ],
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
check(
  "checkpoint stores plan contract validation",
  checkpoint.planContractValidation?.errors[0]?.code === "unknown_dependency",
  checkpoint.planContractValidation
);
check(
  "checkpoint stores plan contract revision count",
  checkpoint.planContractRevisionCount === 2,
  checkpoint.planContractRevisionCount
);
check(
  "checkpoint stores task verification facts with their wave",
  checkpoint.taskVerificationFacts?.[0]?.wave === 3,
  checkpoint.taskVerificationFacts
);
check(
  "Build engine v6 checkpoint contract snapshots plan validation state",
  buildEngineSource.includes('build-contracts-v1-live-checkpoint-v6') &&
    buildEngineSource.includes("BUILD_CHECKPOINT_CONTRACT_VERSION = 4") &&
    /planContractValidation:\s*input\.planContractValidation\s*\?\?\s*planContractValidation/.test(
      buildEngineSource
    ) &&
    /planContractRevisionCount:\s*input\.planContractRevisionCount\s*\?\?\s*planContractRevisionCount/.test(
      buildEngineSource
    ) &&
    /taskVerificationFacts:\s*taskVerificationFacts\.slice\(-96\)/.test(buildEngineSource) &&
    /existingCheckpoint\?\.taskVerificationFacts\s*\?\?\s*\[\]/.test(buildEngineSource),
  "checkpoint marker or plan contract snapshot fields are missing"
);
check(
  "resumed wave numbering advances beyond checkpointed verification facts",
  /const firstWave = wavesRun \+ 1/.test(buildEngineSource) &&
    /const finalWave = wavesRun \+ BUILD_MAX_WAVES/.test(buildEngineSource) &&
    /for \(let cycle = firstWave; cycle <= finalWave/.test(buildEngineSource) &&
    /cyclesLeft: Math\.max\(0, finalWave - cycle\)/.test(buildEngineSource),
  "resume would reuse old wave numbers"
);
check(
  "checkpoint stores avoided worker indexes for retry routing",
  checkpoint.tasks[0].avoidWorkerIndexes?.join(",") === "1,2",
  checkpoint.tasks[0]
);
check(
  "checkpoint stores provider-unavailable worker indexes separately",
  checkpoint.tasks[0].unavailableWorkerIndexes?.join(",") === "3",
  checkpoint.tasks[0]
);
check(
  "checkpoint stores task-local guidance",
  checkpoint.tasks[0].guidance?.[0]?.id === "G-T1-1" &&
    checkpoint.tasks[0].guidance?.[0]?.answer === "Keep it task-scoped.",
  checkpoint.tasks[0].guidance
);

const resumedTransient = normalizeBuildTasksForResume([
  {
    id: "T-transient",
    title: "Resume transient task",
    instructions: "Continue the interrupted work.",
    contextFiles: [],
    status: "in_progress",
    workerIndex: 1,
    retryAfterMs: 12345,
    avoidWorkerIndexes: [1],
    unavailableWorkerIndexes: [0],
  },
])[0];
check("resume requeues transient task as planned", resumedTransient.status === "planned", resumedTransient);
check(
  "resume clears stale transient worker pin",
  resumedTransient.workerIndex === undefined,
  resumedTransient
);
check(
  "resume clears stale transient retry delay",
  resumedTransient.retryAfterMs === undefined,
  resumedTransient
);
check(
  "resume preserves transient retry avoidance",
  resumedTransient.avoidWorkerIndexes?.join(",") === "1" &&
    resumedTransient.unavailableWorkerIndexes?.join(",") === "0",
  resumedTransient
);

const runningDiscussion: Discussion = {
  id: "disc-refresh-review",
  topic: "Build a browser app.",
  mode: "build",
  effort: "medium",
  status: "running",
  modelIds: JSON.stringify(["test:worker"]),
  judgeModelId: "test:architect",
  attachmentIds: null,
  currentRound: 4,
  maxRounds: 8,
  convergenceScore: null,
  buildRunPolicy: "budgeted",
  buildSkillMode: "strict",
  buildStopReason: null,
  buildStoppedAt: null,
  createdAt: "2026-07-09T07:00:00.000Z",
  updatedAt: "2026-07-09T07:10:00.000Z",
};
const runningReviewCheckpoint: BuildCheckpoint = {
  ...checkpoint,
  discussionId: runningDiscussion.id,
  status: "running",
  stopReason: null,
  updatedAt: "2026-07-09T07:10:00.000Z",
  tasks: [
    {
      id: "T-review",
      title: "Review landed implementation",
      instructions: "Architect is reviewing the worker output.",
      contextFiles: ["src/main.ts"],
      outputPaths: ["src/main.ts"],
      status: "review",
      workerIndex: 0,
    },
  ],
};
storeApi.__resetClientStoreForTests();
storeApi.insertDiscussion(runningDiscussion);
storeApi.upsertBuildCheckpoint(runningReviewCheckpoint);
const interrupted = clientApi.interruptOrphanedRunningBuild(runningDiscussion.id);
const interruptedDiscussion = storeApi.getDiscussionById(runningDiscussion.id);
const interruptedCheckpoint = storeApi.getBuildCheckpoint(runningDiscussion.id);
check(
  "checkpoint round-trips plan contract state",
  interruptedCheckpoint?.planContractValidation?.errors[0]?.code === "unknown_dependency" &&
    interruptedCheckpoint.planContractRevisionCount === 2,
  interruptedCheckpoint
);
check("refresh interruption is detected for orphaned running build", interrupted, {
  interruptedDiscussion,
  interruptedCheckpoint,
});
check(
  "refresh interruption stops the discussion instead of leaving it auto-runnable",
  interruptedDiscussion?.status === "stopped" &&
    interruptedDiscussion.buildStopReason === "user" &&
    typeof interruptedDiscussion.buildStoppedAt === "string",
  interruptedDiscussion
);
check(
  "refresh interruption preserves review task state for a controlled resume",
  interruptedCheckpoint?.status === "stopped" &&
    interruptedCheckpoint.stopReason === "user" &&
    interruptedCheckpoint.tasks[0]?.status === "review",
  interruptedCheckpoint
);

const thrownFailureDiscussion: Discussion = {
  ...runningDiscussion,
  id: "disc-thrown-build-failure",
  status: "running",
  updatedAt: "2026-07-09T09:58:00.000Z",
};
const thrownFailureCheckpoint: BuildCheckpoint = {
  ...runningReviewCheckpoint,
  discussionId: thrownFailureDiscussion.id,
  status: "running",
  stopReason: null,
  updatedAt: "2026-07-09T09:58:00.000Z",
  tasks: [
    {
      id: "T7",
      title: "Run final verification",
      instructions: "Run deterministic and browser checks.",
      contextFiles: ["src/game.js"],
      outputPaths: ["src/game.js"],
      status: "failed",
      failCount: 3,
    },
    {
      id: "T12",
      title: "Final browser acceptance",
      instructions: "Run browser acceptance.",
      contextFiles: ["index.html"],
      outputPaths: [],
      status: "planned",
    },
  ],
};
storeApi.__resetClientStoreForTests();
storeApi.insertDiscussion(thrownFailureDiscussion);
storeApi.upsertBuildCheckpoint(thrownFailureCheckpoint);
const finalizedAfterThrow = engineApi.finalizeRunningBuildCheckpointAfterFailure(
  thrownFailureDiscussion.id,
  "Failed to generate completions"
);
const failedCheckpoint = storeApi.getBuildCheckpoint(thrownFailureDiscussion.id);
check("thrown build failure finalizes a running checkpoint", finalizedAfterThrow, failedCheckpoint);
check(
  "thrown build failure checkpoint becomes blocked and resumable",
  failedCheckpoint?.status === "blocked" &&
    failedCheckpoint.stopReason === "blocked" &&
    failedCheckpoint.tasks[0]?.status === "failed" &&
    /unexpected failure/i.test(failedCheckpoint.recoveryLog.at(-1) ?? ""),
  failedCheckpoint
);

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
    guidance: [
      {
        id: "G-T2-1",
        taskId: "T2",
        mode: "blocking",
        question: "Which file owns the behavior?",
        status: "answered",
        answer: "Use src/game.ts.",
        requestedAtWave: 1,
        answeredAtWave: 1,
      },
    ],
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

const resumedReviewWithLandedOutput = normalizeBuildTasksForResume(
  [
    {
      id: "T-red",
      title: "Add RED renderer tests",
      instructions: "Persist the RED test before implementation.",
      contextFiles: ["src/renderer.js"],
      outputPaths: [
        "tests/voxel-renderer.test.mjs",
        "tests/not-yet-landed.test.mjs",
      ],
      testOutputPaths: [
        "tests/voxel-renderer.test.mjs",
        "tests/not-yet-landed.test.mjs",
      ],
      status: "review",
      writeGeneration: 1,
    },
  ],
  ["tests/voxel-renderer.test.mjs"]
)[0]!;
check(
  "resume carries only restored landed outputs into requeued review context",
  resumedReviewWithLandedOutput.status === "planned" &&
    resumedReviewWithLandedOutput.contextFiles.includes(
      "tests/voxel-renderer.test.mjs"
    ) &&
    !resumedReviewWithLandedOutput.contextFiles.includes(
      "tests/not-yet-landed.test.mjs"
    ),
  resumedReviewWithLandedOutput
);
const resumedFixingWithLandedOutput = normalizeBuildTasksForResume(
  [
    {
      id: "T-fix",
      title: "Repair RED renderer tests",
      instructions: "Make the smallest correction to the persisted test.",
      contextFiles: [],
      outputPaths: ["tests/voxel-renderer.test.mjs"],
      testOutputPaths: ["tests/voxel-renderer.test.mjs"],
      status: "fixing",
      writeGeneration: 2,
    },
  ],
  ["tests/voxel-renderer.test.mjs"]
)[0]!;
check(
  "resume carries restored landed outputs into an existing fix context",
  resumedFixingWithLandedOutput.status === "fixing" &&
    resumedFixingWithLandedOutput.contextFiles.includes(
      "tests/voxel-renderer.test.mjs"
    ) &&
    /restored landed output/i.test(
      resumedFixingWithLandedOutput.retryInstructions ?? ""
    ) &&
    /do not emit (?:an? )?full-file rewrite/i.test(
      resumedFixingWithLandedOutput.retryInstructions ?? ""
    ),
  resumedFixingWithLandedOutput
);

const resumedFailed = resumed.find((task) => task.id === "T2");
check("resume makes terminal failed tasks runnable", resumedFailed?.status === "fixing", resumed);
check("resume resets failed task retry budget", (resumedFailed?.failCount ?? 0) === 0, resumedFailed);
check("resume clears stale worker pin", resumedFailed?.workerIndex === undefined, resumedFailed);
check("resume clears stale worker preference", resumedFailed?.assignTo === undefined, resumedFailed);
check("resume clears stale retry delay", resumedFailed?.retryAfterMs === undefined, resumedFailed);
check(
  "resume preserves task-local guidance",
  resumedFailed?.guidance?.[0]?.answer === "Use src/game.ts.",
  resumedFailed
);
check("resume keeps dependent planned tasks intact", resumed.find((task) => task.id === "T3")?.status === "planned", resumed);

const qualityGateReopened = reopenBuildTasksForQualityGate(
  [
    {
      id: "T1",
      title: "Build web app",
      instructions: "Create the browser game.",
      contextFiles: [],
      outputPaths: ["index.html", "src/main.js"],
      status: "done",
      workerIndex: 0,
      assignTo: "claude-opus-4-5",
      retryAfterMs: 9999999999999,
    },
    {
      id: "T2",
      title: "Write docs",
      instructions: "Document usage.",
      contextFiles: ["README.md"],
      outputPaths: ["README.md"],
      status: "done",
    },
  ],
  {
    skillEvidence: [
      {
        taskId: "T1",
        skillId: "superpowers:strict-test-driven-development",
        actor: "worker-a",
        required: ["GREEN"],
        reportedEvidence: [],
        missingEvidence: ["GREEN test/check pass after implementation"],
        violations: [],
      },
    ],
    browserAcceptanceMissing: true,
    browserAcceptanceReason:
      "A web app or UI-affecting build cannot be marked done because no real-browser acceptance evidence was recorded.",
  }
);
const reopenedT1 = qualityGateReopened.find((task) => task.id === "T1");
const untouchedT2 = qualityGateReopened.find((task) => task.id === "T2");
check("quality gate resume reopens blocker task", reopenedT1?.status === "fixing", qualityGateReopened);
check("quality gate resume clears stale task routing", reopenedT1?.workerIndex === undefined && reopenedT1?.assignTo === undefined && reopenedT1?.retryAfterMs === undefined, reopenedT1);
check(
  "quality gate resume carries output paths as context",
  reopenedT1?.contextFiles.includes("index.html") && reopenedT1?.contextFiles.includes("src/main.js"),
  reopenedT1
);
check(
  "quality gate resume explains missing skill evidence",
  reopenedT1?.instructions === "Create the browser game." &&
    /Required skill evidence is missing/i.test(reopenedT1?.reviewInstructions ?? "") &&
    /GREEN test\/check pass/i.test(reopenedT1?.reviewInstructions ?? ""),
  reopenedT1
);
check(
  "quality gate resume requests browser acceptance",
  /real-browser acceptance/i.test(reopenedT1?.reviewInstructions ?? "") &&
    /no visible stuck loading/i.test(reopenedT1?.reviewInstructions ?? ""),
  reopenedT1?.reviewInstructions
);
check("quality gate resume leaves unrelated done tasks alone", untouchedT2?.status === "done", qualityGateReopened);

const architectPolicyQualityGateReopened = reopenBuildTasksForQualityGate(
  [
    {
      id: "T2",
      title: "Audit posture behavior",
      instructions: "Inspect current posture behavior and report evidence.",
      contextFiles: ["src/game.js"],
      outputPaths: ["src/game.js"],
      status: "done",
      kind: "audit",
      completionMode: "either",
      verificationPolicy: "architect",
    },
  ],
  {
    skillEvidence: [
      {
        taskId: "T2",
        skillId: "superpowers:strict-test-driven-development",
        actor: "worker-b",
        required: ["RED"],
        reportedEvidence: ["Architect review accepted the substantive audit evidence."],
        missingEvidence: ["RED test/check failure before implementation"],
        violations: [],
      },
    ],
  }
);
check(
  "quality gate resume does not reopen architect-policy tasks for advisory skill evidence",
  architectPolicyQualityGateReopened.find((task) => task.id === "T2")?.status === "done",
  architectPolicyQualityGateReopened
);

const requestGateReopened = reopenBuildTasksForQualityGate(
  [
    {
      id: "T1",
      title: "Build CSV CLI",
      instructions: "Build the parser and command-line interface.",
      contextFiles: ["src/index.ts"],
      outputPaths: ["src/index.ts", "src/cli.ts"],
      status: "done",
      workerIndex: 0,
    },
    {
      id: "T2",
      title: "Write docs",
      instructions: "Document usage.",
      contextFiles: ["README.md"],
      outputPaths: ["README.md"],
      status: "done",
    },
  ],
  {
    requestFulfillmentMissing: true,
    requestFulfillmentReason:
      "Review did not explicitly compare the landed output against the original user request.",
  }
);
const reopenedRequest = requestGateReopened.find((task) => task.id === "T1");
check("request-fulfillment gate reopens a likely implementation task", reopenedRequest?.status === "fixing", requestGateReopened);
check(
  "request-fulfillment gate asks for user-request comparison",
  reopenedRequest?.instructions === "Build the parser and command-line interface." &&
    /request fulfillment/i.test(reopenedRequest?.reviewInstructions ?? "") &&
    /original user request/i.test(reopenedRequest?.reviewInstructions ?? "") &&
    /requestFulfillment/i.test(reopenedRequest?.reviewInstructions ?? ""),
  reopenedRequest
);

const legacyCheckpointResume = restoreArchitectApprovedTasksAfterLegacyQualityGateVeto(
  normalizeBuildTasksForResume([
    {
      id: "T1",
      title: "Build web app",
      instructions: "Create the browser game.",
      contextFiles: [],
      outputPaths: ["index.html", "src/main.js"],
      status: "fixing",
      reviewInstructions:
        "Final Build quality gate:\nRequired skill evidence is missing and browser acceptance was not recorded.",
      retryInstructions:
        "NOTE: a previous evidence-only attempt ended with an incomplete final evidence response.",
    },
  ]),
  {
    status: "blocked",
    stopReason: "blocked",
    recoveryLog: ["Stopped as blocked by final quality gate after wave 1."],
    stopMessage:
      "Build blocked by final quality gate:\n- Required skill evidence is missing for T1.\n- A web app or UI-affecting build cannot be marked done because no real-browser acceptance evidence was recorded.",
    problems: [
      {
        code: "quality_gate_failed",
        message: "Required skill evidence is missing for T1.",
      },
      {
        code: "browser_acceptance_missing",
        message:
          "A web app or UI-affecting build cannot be marked done because no real-browser acceptance evidence was recorded.",
        details:
          "This appears to be a web app or UI-affecting build; Build mode must record a real-browser acceptance pass before completion.",
      },
    ],
    skillEvidence: [
      {
        taskId: "T1",
        skillId: "superpowers:strict-test-driven-development",
        actor: "worker-a",
        required: ["GREEN"],
        reportedEvidence: [],
        missingEvidence: ["GREEN test/check pass after implementation"],
        violations: [],
      },
    ],
  }
);
check(
  "legacy engine-veto checkpoint restores the Architect-approved task",
  legacyCheckpointResume[0]?.status === "done" &&
    legacyCheckpointResume[0]?.reviewInstructions === undefined &&
    legacyCheckpointResume[0]?.retryInstructions === undefined,
  legacyCheckpointResume
);

function benchmarkBundleWithGuidance(guidance: unknown): BenchmarkReportBundleV2 {
  return {
    version: 2,
    exportedAt: "2026-06-21T00:00:00.000Z",
    suites: [],
    runs: [],
    cases: [],
    attempts: [],
    metricValues: [],
    artifacts: [],
    failures: [],
    traces: [],
    caseV2: [],
    attemptsV2: [],
    verifierResults: [],
    runEvents: [],
    toolCallTraces: [],
    teamCompositions: [],
    harnessCertifications: [],
    sourceEvidence: {
      gameMatches: [],
      buildCheckpoints: [
        {
          ...checkpoint,
          tasks: [
            {
              ...checkpoint.tasks[0],
              guidance: [guidance],
            },
          ],
        } as never,
      ],
      buildStats: [],
    },
  };
}

async function expectGuidanceImportRejects(
  name: string,
  guidance: unknown
): Promise<void> {
  __resetBenchmarkStoreForTests();
  __setAdapterForTests(memoryAdapter);
  let rejected = false;
  let message = "";
  try {
    await importBenchmarkReportBundleV2(benchmarkBundleWithGuidance(guidance));
  } catch (err) {
    rejected = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check(
    name,
    rejected && /Invalid sourceEvidence\.buildCheckpoints/i.test(message),
    message || "bundle imported"
  );
}

await expectGuidanceImportRejects(
  "benchmark import rejects malformed task-local guidance",
  {
    ...checkpoint.tasks[0].guidance![0],
    requestedAtWave: "2",
  }
);
await expectGuidanceImportRejects(
  "benchmark import rejects answered task-local guidance without answer",
  {
    ...checkpoint.tasks[0].guidance![0],
    answer: undefined,
  }
);
await expectGuidanceImportRejects(
  "benchmark import rejects answered task-local guidance with blank answer",
  {
    ...checkpoint.tasks[0].guidance![0],
    answer: "   ",
  }
);
async function expectAvoidWorkerImportRejects(
  name: string,
  avoidWorkerIndexes: unknown
): Promise<void> {
  __resetBenchmarkStoreForTests();
  __setAdapterForTests(memoryAdapter);
  let rejected = false;
  let message = "";
  try {
    const bundle = benchmarkBundleWithGuidance(checkpoint.tasks[0].guidance![0]);
    bundle.sourceEvidence!.buildCheckpoints = [
      {
        ...checkpoint,
        tasks: [
          {
            ...checkpoint.tasks[0],
            avoidWorkerIndexes,
          },
        ],
      } as never,
    ];
    await importBenchmarkReportBundleV2(bundle);
  } catch (err) {
    rejected = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check(
    name,
    rejected && /Invalid sourceEvidence\.buildCheckpoints/i.test(message),
    message || "bundle imported"
  );
}

await expectAvoidWorkerImportRejects(
  "benchmark import rejects malformed avoided worker indexes",
  [1, "2"]
);
async function expectUnavailableWorkerImportRejects(
  name: string,
  unavailableWorkerIndexes: unknown
): Promise<void> {
  __resetBenchmarkStoreForTests();
  __setAdapterForTests(memoryAdapter);
  let rejected = false;
  let message = "";
  try {
    const bundle = benchmarkBundleWithGuidance(checkpoint.tasks[0].guidance![0]);
    bundle.sourceEvidence!.buildCheckpoints = [
      {
        ...checkpoint,
        tasks: [
          {
            ...checkpoint.tasks[0],
            unavailableWorkerIndexes,
          },
        ],
      } as never,
    ];
    await importBenchmarkReportBundleV2(bundle);
  } catch (err) {
    rejected = true;
    message = err instanceof Error ? err.message : String(err);
  }
  check(
    name,
    rejected && /Invalid sourceEvidence\.buildCheckpoints/i.test(message),
    message || "bundle imported"
  );
}

await expectUnavailableWorkerImportRejects(
  "benchmark import rejects malformed unavailable worker indexes",
  [0, "1"]
);
__setAdapterForTests(null);

process.exit(failed === 0 ? 0 : 1);
