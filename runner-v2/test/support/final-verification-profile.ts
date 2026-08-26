import type { FinalVerificationExecutionProfile } from "../../src/final-verification-profile.js";

export function emptyFinalVerificationProfile(
  targetRevision: string,
): FinalVerificationExecutionProfile {
  return {
    version: 1,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: [],
    commands: {},
  };
}

/** Explicit test-only authority for fixtures that do not exercise the durable archive. */
export function acceptFinalVerificationProfile(): void {}
