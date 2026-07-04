import { listGameIqScenarioPacks } from "@/lib/benchmark/gameiq";
import { listWorkBenchCasePacks } from "@/lib/benchmark/workbench";
import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { CertifiedRunnableTrack } from "./ui-gates";
import type { CertifiedRunContext } from "./run-context";

export type { CertifiedRunnableTrack } from "./ui-gates";

export interface CertifiedSuiteOption {
  id: string;
  label: string;
}

// Synthetic suite id for the GameIQ "run everything" bundle. Selecting it runs
// one certified attempt per GameIQ scenario pack in a single run, so leaderboard
// attribution stays per-pack. It is not a real pack id — the run path expands it
// back to the full pack list (see gameIqBundlePackIds / CertifiedRunPanel).
export const GAMEIQ_ALL_PACKS_SUITE_ID = "gameiq-all-packs";

export function isGameIqBundleSuite(suiteId: string): boolean {
  return suiteId === GAMEIQ_ALL_PACKS_SUITE_ID;
}

// battleship: 11/11 saturated across all four 2026-07 reference models (see
// lib/benchmark/gameiq/saturation.ts) — zero discrimination; excluded from
// the default bundle. Standalone battleship runs remain available until the
// pack is re-authored (Phase D charter).
const GAMEIQ_BUNDLE_EXCLUDED_PACK_IDS = new Set(["gameiq-v0.1-battleship"]);

// The concrete GameIQ pack ids a suite selection expands to: the bundle
// expands to every pack except the excluded (saturated) ones above; any
// single-pack selection — including battleship — stays itself, so battleship
// is still selectable as a standalone pack.
export function gameIqBundlePackIds(suiteId: string): string[] {
  if (isGameIqBundleSuite(suiteId)) {
    return listGameIqScenarioPacks()
      .map((pack) => pack.id)
      .filter((packId) => !GAMEIQ_BUNDLE_EXCLUDED_PACK_IDS.has(packId));
  }
  return [suiteId];
}

// Per-pack context wrapper for the GameIQ bundle. The certified GameIQ runner
// reads the case id from context.caseIds[0] and builds its attempt/verifier ids
// off the (shared) run id, so we scope the case id to this pack and rewrite the
// verifier id/attemptId by pack before forwarding to the real context. The run
// id is left untouched so the recorded attempts still pass the run's ownership
// assertion. reidGameIqPackAttempt applies the mirror-image rewrite to the
// attempts returned by the runner (which the engine records separately).
export function gameIqPackRunContext(
  context: CertifiedRunContext,
  packId: string
): CertifiedRunContext {
  return {
    ...context,
    caseIds: [packId],
    recordVerifier: (result) =>
      context.recordVerifier({
        ...result,
        id: gameIqPackVerifierId(result.id, packId),
        attemptId: gameIqPackAttemptId(result.attemptId, packId),
        caseId: packId,
      }),
  };
}

export type GameIqModelRunOutcomeStatus = "passed" | "partial" | "failed";

export interface GameIqModelRunOutcome {
  status: GameIqModelRunOutcomeStatus;
  packsScored: number;
  packsPassed: number;
  /** Mean verified quality as a 0-100 percentage (matches the leaderboard). */
  avgQuality: number;
}

// Classify a GameIQ model's run from its actual pack attempts, NOT merely from
// whether the certified run completed. A pack "passes" only when its attempt
// status is "passed" — a "failed_model" attempt completes the run but scores 0,
// so it must never read as a green "Passed". "partial" = some (not all) packs
// passed; "failed" = the run errored, produced no attempts, or no pack passed.
// attempt.verifiedQuality is a 0-1 ratio; avgQuality is returned as a 0-100
// percentage so it reads the same as the leaderboard's quality column.
export function classifyGameIqModelRunOutcome(
  runCompleted: boolean,
  attempts: Array<Pick<BenchmarkAttemptV2, "status" | "verifiedQuality">>
): GameIqModelRunOutcome {
  const packsScored = attempts.length;
  const packsPassed = attempts.filter(
    (attempt) => attempt.status === "passed"
  ).length;
  const avgQuality =
    packsScored > 0
      ? (attempts.reduce(
          (sum, attempt) => sum + (attempt.verifiedQuality ?? 0),
          0
        ) /
          packsScored) *
        100
      : 0;
  const status: GameIqModelRunOutcomeStatus =
    !runCompleted || packsScored === 0 || packsPassed === 0
      ? "failed"
      : packsPassed === packsScored
        ? "passed"
        : "partial";
  return { status, packsScored, packsPassed, avgQuality };
}

export function reidGameIqPackAttempt(
  attempt: BenchmarkAttemptV2,
  packId: string
): BenchmarkAttemptV2 {
  return {
    ...attempt,
    id: gameIqPackAttemptId(attempt.id, packId),
    caseId: packId,
    verifierResultId:
      attempt.verifierResultId != null
        ? gameIqPackVerifierId(attempt.verifierResultId, packId)
        : attempt.verifierResultId,
  };
}

function gameIqPackAttemptId(attemptId: string, packId: string): string {
  return `${attemptId}:pack:${packId}`;
}

// Insert the pack scope before the trailing ":verifier" so the verifier id
// stays consistent whether derived from the recorded verifier or from the
// returned attempt's verifierResultId (both end in ":verifier").
function gameIqPackVerifierId(verifierId: string, packId: string): string {
  const suffix = ":verifier";
  const base = verifierId.endsWith(suffix)
    ? verifierId.slice(0, -suffix.length)
    : verifierId;
  return `${gameIqPackAttemptId(base, packId)}${suffix}`;
}

export function listCertifiedSuiteOptions(
  track: CertifiedRunnableTrack
): CertifiedSuiteOption[] {
  if (track === "toolreliability") {
    return [
      {
        id: "toolreliability-current-pack",
        label: "ToolReliability: Current challenge pack",
      },
    ];
  }
  if (track === "teamiq") {
    return [
      {
        id: "teamiq-toolreliability-current-quick",
        label: "TeamIQ: ToolReliability quick",
      },
      {
        id: "teamiq-toolreliability-current-all-modes",
        label: "TeamIQ: ToolReliability quick (all modes)",
      },
      {
        id: "fireworks-teamiq-tactics-v0.1",
        label: "Fireworks: Tactics (stratified sample)",
      },
      {
        id: "fireworks-teamiq-memory-v0.1",
        label: "Fireworks: Memory (stratified sample)",
      },
      {
        id: "fireworks-teamiq-full-v0.1",
        label: "Fireworks: Full games",
      },
      {
        id: "fireworks-teamiq-mixed-v0.1",
        label: "Fireworks: Mixed suite",
      },
    ];
  }
  if (track === "workbench") {
    return listWorkBenchCasePacks().map((pack) => ({
      id: pack.id,
      label: pack.label,
    }));
  }
  const packs = listGameIqScenarioPacks();
  const bundlePackCount = gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID).length;
  return [
    {
      id: GAMEIQ_ALL_PACKS_SUITE_ID,
      label: `All GameIQ packs (${bundlePackCount} packs - one run per pack)`,
    },
    ...packs.map((pack) => ({
      id: pack.id,
      label: pack.label,
    })),
  ];
}
