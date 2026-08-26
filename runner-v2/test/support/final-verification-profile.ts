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

export function profileForRequiredCategories(
  targetRevision: string,
  categories: readonly ("build" | "tests" | "runtime_smoke" | "browser")[],
) {
  const commands = {
    ...(categories.includes("build") ? { build: [{ label: "build", executable: "fixture", args: [] }] } : {}),
    ...(categories.includes("tests") ? { tests: [{ label: "tests", executable: "fixture", args: [] }] } : {}),
  };
  const runtimeSmoke = categories.includes("runtime_smoke") ? {
    label: "runtime_smoke",
    executable: "fixture",
    args: [],
    endpoint: "http://127.0.0.1:4173/",
    readiness: { expectedStatus: 200 },
  } : undefined;
  const browser = categories.includes("browser") ? {
    label: "browser",
    url: "http://127.0.0.1:4173/",
    policy: {},
  } : undefined;
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: categories.map((category) => ({ category, source: "fixture", detail: category })),
    commands,
    ...(runtimeSmoke ? { runtimeSmoke } : {}),
    ...(browser ? { browser } : {}),
  };
}
