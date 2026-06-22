import type { BuildStopReason } from "../db/schema";
import type { OrchestratorEvent } from "./engine";

export type BuildStopDiagnosticPhase = Extract<
  OrchestratorEvent,
  { type: "diagnostic" }
>["phase"];

export function diagnosticPhaseForBuildStop(
  reason: BuildStopReason | "failed" | "incomplete"
): BuildStopDiagnosticPhase {
  switch (reason) {
    case "completed":
      return "finished";
    case "blocked":
    case "failed":
    case "incomplete":
      return "model_failed";
    case "budget":
    case "time":
    case "user":
      return "judging";
    default:
      return "judging";
  }
}
