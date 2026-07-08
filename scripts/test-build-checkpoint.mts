/** Build checkpoint shape checks (run: npx tsx scripts/test-build-checkpoint.mts) */
import type { BuildCheckpoint } from "../lib/db/schema";
import {
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
  importBenchmarkReportBundleV2,
} from "../lib/benchmark/store";
import type { BenchmarkReportBundleV2 } from "../lib/benchmark/types";
import {
  normalizeBuildTasksForResume,
  reopenBuildTasksForBlockedQualityGateCheckpoint,
  reopenBuildTasksForQualityGate,
} from "../lib/orchestrator/build";

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
  "checkpoint stores avoided worker indexes for retry routing",
  checkpoint.tasks[0].avoidWorkerIndexes?.join(",") === "1,2",
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
  resumedTransient.avoidWorkerIndexes?.join(",") === "1",
  resumedTransient
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
  /Required skill evidence is missing/i.test(reopenedT1?.instructions ?? "") &&
    /GREEN test\/check pass/i.test(reopenedT1?.instructions ?? ""),
  reopenedT1?.instructions
);
check(
  "quality gate resume requests browser acceptance",
  /real-browser acceptance/i.test(reopenedT1?.instructions ?? "") &&
    /no visible stuck loading/i.test(reopenedT1?.instructions ?? ""),
  reopenedT1?.instructions
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
  /request fulfillment/i.test(reopenedRequest?.instructions ?? "") &&
    /original user request/i.test(reopenedRequest?.instructions ?? "") &&
    /requestFulfillment/i.test(reopenedRequest?.instructions ?? ""),
  reopenedRequest?.instructions
);

const legacyCheckpointResume = reopenBuildTasksForBlockedQualityGateCheckpoint(
  normalizeBuildTasksForResume([
    {
      id: "T1",
      title: "Build web app",
      instructions: "Create the browser game.",
      contextFiles: [],
      outputPaths: ["index.html", "src/main.js"],
      status: "done",
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
  "legacy quality-gate checkpoint resumes with runnable remediation",
  legacyCheckpointResume[0]?.status === "fixing" &&
    /final Build quality gate/i.test(legacyCheckpointResume[0]?.instructions ?? ""),
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
__setAdapterForTests(null);

process.exit(failed === 0 ? 0 : 1);
