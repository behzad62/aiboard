import type { BuildStepResult } from "./build-runtime.js";
import type { RunState } from "./contracts.js";
import type { HistoricalTerminalState } from "./native-build-manager.js";
import { RunSupervisor } from "./run-supervisor.js";
import type { SchedulerProjection } from "./scheduler-store.js";

export function isTerminalRunState(state: RunState): state is HistoricalTerminalState {
  return state === "stopped" || state === "completed" || state === "failed";
}

export function failBuildIfActive(
  supervisor: RunSupervisor,
  runId: string,
  reason: string,
): void {
  const run = supervisor.getRun(runId);
  if (isTerminalRunState(run.state)) return;
  supervisor.fail(runId, `build-failed:${run.lastSequence}`, reason);
}

export function syncAutonomousBuildLifecycle(
  supervisor: RunSupervisor,
  runId: string,
  result: BuildStepResult,
  build: SchedulerProjection,
): void {
  if (result.status === "failed") {
    failBuildIfActive(supervisor, runId, result.action ?? "context_recording_aborted");
    return;
  }
  const run = supervisor.getRun(runId);
  if (
    result.status === "completed" &&
    run.state === "running"
  ) {
    supervisor.completeBuild(
      runId,
      `autonomous-build-completed:${run.lastSequence}`,
      build,
    );
  } else if (result.status === "paused" && run.state === "running") {
    supervisor.pause(
      runId,
      `autonomous-build-paused:${run.lastSequence}`,
      result.action ?? "native-build"
    );
  }
}
