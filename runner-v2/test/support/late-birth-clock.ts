import type { ProcessBirthInspection } from "../../src/native-process-backend.js";

/** A causal clock for the native late-result fixture, not a timing benchmark.
 * Keep startup before its boundary until the actual birth is observed, expose
 * that same result after the deadline, then restore real time for finalization.
 * No resource identity, production deadline, or cleanup result is fabricated.
 */
export function createLateBirthFixtureClock(startupAt: number, deadlineAt: number, realNow: () => number) {
  let phase: "before-observation" | "late-result" | "real-time" = "before-observation";
  return {
    now(): number {
      if (phase === "before-observation") return startupAt;
      return phase === "late-result" ? Math.max(realNow(), deadlineAt + 1) : realNow();
    },
    observeBeforeExpiry(observe: () => ProcessBirthInspection): ProcessBirthInspection {
      const result = observe();
      phase = "late-result";
      return result;
    },
    restore(): void { phase = "real-time"; },
  };
}
