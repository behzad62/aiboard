import type { SchedulerProjection } from "../../src/scheduler-store.js";

export function emptyProjectionForTest(runId: string): SchedulerProjection {
  return {
    runId,
    status: "running",
    planRevision: 1,
    tasks: {},
    guidance: {},
    userGuidance: {},
    architectQuestions: {},
    reviews: {},
    userGuidanceVersion: 0,
    architectQuestionVersion: 0,
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: 0,
  };
}
