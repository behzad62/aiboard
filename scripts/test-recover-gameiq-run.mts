/* Hermetic test for the GameIQ run-recovery core (run: npx tsx
 * scripts/test-recover-gameiq-run.mts).
 *
 * Builds a minimal in-memory FAILED BenchmarkReportBundleV2 with real
 * hand-made traces for two packs — one COMPLETE (every scenario has a
 * correct-answer trace) and one PARTIAL (only a few scenarios have traces) —
 * plus the synthesized provider_unavailable attempts the run engine would have
 * created, then asserts recoverBundle:
 *   - the complete pack's synthesized failed attempt is REPLACED by a scored
 *     attempt with a verifier (id via reidGameIqPackAttempt, harnessVersion
 *     +recovered);
 *   - the partial pack is LEFT as provider_unavailable (no verifier);
 *   - runs[0].status stays "failed" and the run_engine_failed failure is kept;
 *   - the recovered pack's provider_unavailable FAILURE is dropped;
 *   - bundle.recovery metadata is present.
 * Touches NO files — uses the real resolvePackTraceReplay + runGameIqScenarios
 * + createGameIqVerifierResult through recoverBundle.
 */
import { listGameIqScenarioPacks } from "../lib/benchmark/gameiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkReportBundleV2,
  BenchmarkRun,
} from "../lib/benchmark/types";
import { recoverBundle } from "./recover-gameiq-run.mts";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const RUN_ID = "ui-gameiq-test-recover-0";
const TEAM_ID = "teamiq-solo-test-recover";
const MODEL_ID = "fake:recover-model";

const packs = listGameIqScenarioPacks();
// Smallest first-class pack (10 scenarios) as the COMPLETE pack; a large pack
// (fireworks-hard, 40) as the PARTIAL pack with only a few traces.
const completePack = packs.find((pack) => pack.id === "gameiq-v0.1-codenames")!;
const partialPack = packs.find((pack) => pack.id === "gameiq-fireworks-hard-v1")!;
// A bogus/deleted pack id — mirrors a historical run file that still carries
// traces for the hard-deleted (2026-07-17) v0.1 chess pack.
const UNKNOWN_PACK_ID = "gameiq-v0.1-chess";

let traceSeq = 0;
function traceFor(
  caseId: string,
  action: unknown,
  startedAt: string
): BenchmarkModelCallTrace {
  return {
    id: `${RUN_ID}:trace:${traceSeq++}`,
    runId: RUN_ID,
    caseId,
    attemptId: `${RUN_ID}:${caseId}:${TEAM_ID}:failed`,
    modelId: MODEL_ID,
    providerId: "fake",
    participantId: TEAM_ID,
    startedAt,
    completedAt: startedAt,
    latencyMs: 5,
    inputTokens: 10,
    outputTokens: 5,
    parsedResponseJson: JSON.stringify({ action }),
    retryHistory: [],
  };
}

// COMPLETE pack: one correct-answer trace per scenario (positional, no
// scenarioId — mirrors the legacy dead files this tool targets).
const traces: BenchmarkModelCallTrace[] = [];
completePack.scenarios.forEach((scenario, index) => {
  traces.push(
    traceFor(
      completePack.id,
      scenario.expectedActions[0].action,
      `2026-07-03T00:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
});
// PARTIAL pack: only 3 traces for a 40-scenario pack (interrupted, like memory).
partialPack.scenarios.slice(0, 3).forEach((scenario, index) => {
  traces.push(
    traceFor(
      partialPack.id,
      scenario.expectedActions[0].action,
      `2026-07-03T01:00:${String(index).padStart(2, "0")}.000Z`
    )
  );
});
// UNKNOWN pack: two traces for a caseId no longer in the registry (the
// hard-deleted v0.1 chess pack) — mirrors the user's real historical AIBoard
// run files. recoverBundle must SKIP these gracefully, never throw.
traces.push(
  traceFor(UNKNOWN_PACK_ID, { from: "a7", to: "a8", promotion: "queen" }, "2026-07-03T02:00:00.000Z"),
  traceFor(UNKNOWN_PACK_ID, { from: "e1", to: "e8" }, "2026-07-03T02:00:01.000Z")
);

function failedAttempt(caseId: string): BenchmarkAttemptV2 {
  return {
    id: `${RUN_ID}:${caseId}:${TEAM_ID}:failed`,
    runId: RUN_ID,
    caseId,
    teamCompositionId: TEAM_ID,
    mode: "certified",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    status: "provider_unavailable",
    startedAt: "2026-07-03T00:00:00.000Z",
    completedAt: "2026-07-03T02:00:00.000Z",
    verifiedQuality: 0,
    jobSuccessScore: 0,
    efficiencyScore: 0,
    gameIqScore: 0,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    durationMs: 0,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "certified-run-error-v0.1",
    promptSetVersion: "certified-run-error-v0.1",
    scoringVersion: "certified-run-error-v0.1",
  };
}

function providerFailure(caseId: string): BenchmarkFailure {
  const attemptId = `${RUN_ID}:${caseId}:${TEAM_ID}:failed`;
  return {
    id: `${attemptId}:failure:provider_unavailable`,
    runId: RUN_ID,
    caseId,
    attemptId,
    domain: "game",
    source: "benchmark",
    code: "provider_unavailable",
    severity: "error",
    message: "Synthesized provider_unavailable attempt.",
    createdAt: "2026-07-03T02:00:00.000Z",
  };
}

const run: BenchmarkRun = {
  id: RUN_ID,
  name: "Recover test run",
  domain: "game",
  status: "failed",
  startedAt: "2026-07-03T00:00:00.000Z",
  completedAt: "2026-07-03T02:00:00.000Z",
  source: "manual",
  modelIds: [MODEL_ID],
  caseIds: packs.map((pack) => pack.id),
  summaryJson: "{}",
  metricValueIds: [],
  artifactIds: [],
  failureIds: [],
};

const runEngineFailure: BenchmarkFailure = {
  id: `${RUN_ID}:failure:run_engine_failed`,
  runId: RUN_ID,
  domain: "game",
  source: "benchmark",
  code: "run_engine_failed",
  severity: "error",
  message: "Simulated mid-run failure.",
  createdAt: "2026-07-03T02:00:00.000Z",
};

// Mirror the real dead files: run-engine synthesizes ONE provider_unavailable
// attempt (+ failure) for EVERY pack, whether or not traces exist. So the
// fixture carries a synthesized attempt/failure for all 7 packs.
const synthesizedAttempts = packs.map((pack) => failedAttempt(pack.id));
const synthesizedFailures = packs.map((pack) => providerFailure(pack.id));

const bundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-07-03T02:00:00.000Z",
  suites: [],
  runs: [run],
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: [],
  failures: [runEngineFailure, ...synthesizedFailures],
  traces,
  caseV2: [],
  attemptsV2: synthesizedAttempts,
  verifierResults: [],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [
    {
      id: TEAM_ID,
      name: "Solo test",
      comboHash: "hash-recover",
      roles: [
        {
          role: "single",
          slot: "solo",
          modelId: MODEL_ID,
          providerId: "fake",
          displayName: "Recover Model",
          temperature: 0,
        },
      ],
      strategy: "solo",
    },
  ],
  harnessCertifications: [],
};

const RECOVERED_AT = "2026-07-03T03:00:00.000Z";
const { bundle: out, recoveredPacks, skipped, unknownPacks } = await recoverBundle(
  bundle,
  { recoveredAt: RECOVERED_AT }
);

// ── Recovered pack ────────────────────────────────────────────────────────────
check(
  "exactly one pack recovered (the complete codenames pack)",
  recoveredPacks.length === 1 && recoveredPacks[0].packId === completePack.id,
  recoveredPacks.map((p) => p.packId)
);
check(
  "recovered pack replayed all scenarios (complete)",
  recoveredPacks[0]?.replayed === completePack.scenarios.length &&
    recoveredPacks[0]?.total === completePack.scenarios.length,
  recoveredPacks[0]
);
check(
  "recovered pack score is finite and > 0 (perfect-answer traces)",
  Number.isFinite(recoveredPacks[0]?.score) && recoveredPacks[0].score > 0,
  recoveredPacks[0]?.score
);

const expectedAttemptId = `gameiq-attempt:${RUN_ID}:${TEAM_ID}:${MODEL_ID}:pack:${completePack.id}`;
const recoveredAttempt = out.attemptsV2.find(
  (attempt) => attempt.id === expectedAttemptId
);
check(
  "recovered attempt exists with reidGameIqPackAttempt id scheme",
  Boolean(recoveredAttempt),
  expectedAttemptId
);
check(
  "recovered attempt caseId scoped to the pack",
  recoveredAttempt?.caseId === completePack.id,
  recoveredAttempt?.caseId
);
check(
  "recovered attempt harnessVersion carries +recovered suffix",
  recoveredAttempt?.harnessVersion.endsWith("+recovered") === true,
  recoveredAttempt?.harnessVersion
);
check(
  "recovered attempt is no longer provider_unavailable",
  recoveredAttempt != null &&
    recoveredAttempt.status !== "provider_unavailable",
  recoveredAttempt?.status
);
check(
  "recovered attempt references its verifier",
  Boolean(recoveredAttempt?.verifierResultId) &&
    out.verifierResults.some(
      (verifier) => verifier.id === recoveredAttempt?.verifierResultId
    ),
  recoveredAttempt?.verifierResultId
);
check(
  "recovered verifier attemptId points back at the recovered attempt",
  out.verifierResults.some(
    (verifier) =>
      verifier.attemptId === expectedAttemptId &&
      verifier.caseId === completePack.id
  )
);

// ── Complete pack's synthesized failed attempt is gone ────────────────────────
check(
  "complete pack's synthesized provider_unavailable attempt removed",
  !out.attemptsV2.some(
    (attempt) =>
      attempt.id === `${RUN_ID}:${completePack.id}:${TEAM_ID}:failed`
  )
);
check(
  "complete pack's provider_unavailable FAILURE dropped",
  !out.failures.some(
    (failure) =>
      failure.attemptId === `${RUN_ID}:${completePack.id}:${TEAM_ID}:failed`
  )
);

// ── Partial pack left untouched ───────────────────────────────────────────────
check(
  "partial pack reported as incomplete skip (3/40)",
  skipped.some(
    (pack) =>
      pack.packId === partialPack.id &&
      pack.reason === "incomplete" &&
      pack.replayed === 3 &&
      pack.total === partialPack.scenarios.length
  ),
  skipped
);
check(
  "partial pack's synthesized provider_unavailable attempt PRESERVED",
  out.attemptsV2.some(
    (attempt) =>
      attempt.id === `${RUN_ID}:${partialPack.id}:${TEAM_ID}:failed` &&
      attempt.status === "provider_unavailable"
  )
);
check(
  "partial pack's provider_unavailable FAILURE preserved",
  out.failures.some(
    (failure) =>
      failure.attemptId === `${RUN_ID}:${partialPack.id}:${TEAM_ID}:failed`
  )
);
check(
  "no verifier produced for the partial pack",
  !out.verifierResults.some((verifier) => verifier.caseId === partialPack.id)
);

// ── Run history is NOT rewritten ──────────────────────────────────────────────
check("runs[0].status stays 'failed'", out.runs[0].status === "failed");
check(
  "top-level run_engine_failed failure kept",
  out.failures.some((failure) => failure.code === "run_engine_failed")
);

// ── Recovery metadata ─────────────────────────────────────────────────────────
const recovery = (out as unknown as { recovery?: Record<string, unknown> })
  .recovery;
check("bundle.recovery metadata present", Boolean(recovery), recovery);
check(
  "recovery.recoveredAt is the passed-in ISO",
  recovery?.recoveredAt === RECOVERED_AT,
  recovery?.recoveredAt
);
check(
  "recovery.recoveredPacks lists the complete pack",
  Array.isArray(recovery?.recoveredPacks) &&
    (recovery?.recoveredPacks as string[]).includes(completePack.id)
);
check(
  "recovery.skippedIncomplete lists the partial pack",
  Array.isArray(recovery?.skippedIncomplete) &&
    (recovery?.skippedIncomplete as string[]).includes(partialPack.id)
);
check(
  "recovery.tool identifies the recovery tool",
  recovery?.tool === "recover-gameiq-run"
);

// ── Zero-trace packs (early-skip branch) ──────────────────────────────────────
// Every pack other than codenames (complete) and fireworks-hard (partial) has
// NO traces in the fixture; the chess v2 pack exercises the no-traces early-skip.
const zeroTracePack = packs.find((pack) => pack.id === "gameiq-v0.2-chess")!;
check(
  "zero-trace pack skipped cleanly with reason no-traces (0/total)",
  skipped.some(
    (pack) =>
      pack.packId === zeroTracePack.id &&
      pack.reason === "no-traces" &&
      pack.replayed === 0 &&
      pack.total === zeroTracePack.scenarios.length
  ),
  skipped.filter((pack) => pack.reason === "no-traces").map((pack) => pack.packId)
);
check(
  "zero-trace pack not recovered (no recovered attempt for it)",
  !out.attemptsV2.some(
    (attempt) =>
      attempt.caseId === zeroTracePack.id && attempt.id.includes(":pack:")
  )
);
check(
  "zero-trace pack's synthesized failed attempt preserved untouched",
  out.attemptsV2.some(
    (attempt) =>
      attempt.id === `${RUN_ID}:${zeroTracePack.id}:${TEAM_ID}:failed` &&
      attempt.status === "provider_unavailable"
  )
);
check(
  "recovery.skippedNoTraces lists the zero-trace packs including chess",
  Array.isArray(recovery?.skippedNoTraces) &&
    (recovery?.skippedNoTraces as string[]).includes(zeroTracePack.id) &&
    !(recovery?.skippedNoTraces as string[]).includes(partialPack.id),
  recovery?.skippedNoTraces
);

// ── Unknown pack (deleted pack id) — graceful skip, never throw ───────────────
// A run file that still carries traces for the hard-deleted v0.1 chess pack
// must not crash recoverBundle; it must be reported and excluded from the
// pack loop entirely (it never becomes a "recovered" or "skipped" pack —
// there is no pack to recover it against).
check(
  "recoverBundle did not throw despite the unknown-pack traces (implicit: we got here)",
  true
);
check(
  "unknown pack is reported with its trace count",
  unknownPacks.some(
    (entry) => entry.caseId === UNKNOWN_PACK_ID && entry.traceCount === 2
  ),
  unknownPacks
);
check(
  "unknown pack never appears in recoveredPacks",
  !recoveredPacks.some((pack) => pack.packId === UNKNOWN_PACK_ID)
);
check(
  "unknown pack never appears in the known-pack skipped list",
  !skipped.some((pack) => pack.packId === UNKNOWN_PACK_ID)
);
check(
  "recovery.skippedUnknownPack lists the deleted pack id",
  Array.isArray(recovery?.skippedUnknownPack) &&
    (recovery?.skippedUnknownPack as string[]).includes(UNKNOWN_PACK_ID),
  recovery?.skippedUnknownPack
);
check(
  "unknown pack's traces produce no attemptsV2/verifier entries at all",
  !out.attemptsV2.some((attempt) => attempt.caseId === UNKNOWN_PACK_ID) &&
    !out.verifierResults.some((verifier) => verifier.caseId === UNKNOWN_PACK_ID)
);

// ── recoveredAt omitted when not passed ───────────────────────────────────────
const { bundle: outNoTs } = await recoverBundle(bundle);
const recoveryNoTs = (
  outNoTs as unknown as { recovery?: Record<string, unknown> }
).recovery;
check(
  "recovery.recoveredAt omitted when option not passed",
  recoveryNoTs != null && !("recoveredAt" in recoveryNoTs),
  recoveryNoTs
);

// ── Referential integrity: no dangling ids in the recovered bundle ────────────
const attemptIds = new Set(out.attemptsV2.map((attempt) => attempt.id));
const verifierIds = new Set(out.verifierResults.map((verifier) => verifier.id));
check(
  "every attempt.verifierResultId resolves to an existing verifier",
  out.attemptsV2.every(
    (attempt) =>
      attempt.verifierResultId == null ||
      verifierIds.has(attempt.verifierResultId)
  )
);
check(
  "every verifier.attemptId resolves to an existing attempt",
  out.verifierResults.every((verifier) => attemptIds.has(verifier.attemptId))
);
check(
  "every remaining failure.attemptId resolves to an existing attempt",
  out.failures.every(
    (failure) => failure.attemptId == null || attemptIds.has(failure.attemptId)
  )
);

// ── Idempotency: re-running on an already-recovered file is safe ──────────────
// Regression pin for the blocker: recovery leaves runs[0].status === "failed",
// so the CLI's only precondition still passes on a recovered file. A second run
// must REPLACE the prior recovered attempt (not duplicate it). Feed run-1 output
// into run-2 and assert counts stable + no duplicate ids + same recovered ids.
const {
  bundle: out2,
  recoveredPacks: recoveredPacks2,
  replacedAttempts: replaced2,
} = await recoverBundle(out, { recoveredAt: "2026-07-03T04:00:00.000Z" });

check(
  "second run still recovers the same one complete pack",
  recoveredPacks2.length === 1 && recoveredPacks2[0].packId === completePack.id,
  recoveredPacks2.map((p) => p.packId)
);
check(
  "second run reports it REPLACED the prior recovered attempt (replacedAttempts === 1)",
  replaced2 === 1,
  replaced2
);
check(
  "attemptsV2 count is STABLE across a re-run",
  out2.attemptsV2.length === out.attemptsV2.length,
  { run1: out.attemptsV2.length, run2: out2.attemptsV2.length }
);
check(
  "verifierResults count is STABLE across a re-run",
  out2.verifierResults.length === out.verifierResults.length,
  { run1: out.verifierResults.length, run2: out2.verifierResults.length }
);
const attemptIds2 = out2.attemptsV2.map((attempt) => attempt.id);
check(
  "NO duplicate attempt ids after re-run",
  new Set(attemptIds2).size === attemptIds2.length,
  attemptIds2.filter((id, i) => attemptIds2.indexOf(id) !== i)
);
const verifierIds2 = out2.verifierResults.map((verifier) => verifier.id);
check(
  "NO duplicate verifier ids after re-run",
  new Set(verifierIds2).size === verifierIds2.length,
  verifierIds2.filter((id, i) => verifierIds2.indexOf(id) !== i)
);
check(
  "recovered pack keeps the SAME attempt id as after run-1",
  out2.attemptsV2.some((attempt) => attempt.id === expectedAttemptId),
  expectedAttemptId
);
check(
  "recovered pack keeps the SAME verifier id as after run-1",
  out2.verifierResults.some(
    (verifier) => verifier.id === `${expectedAttemptId}:verifier`
  )
);
check(
  "re-run bundle still has exactly one attempt per pack caseId",
  packs.every(
    (pack) =>
      out2.attemptsV2.filter((attempt) => attempt.caseId === pack.id).length ===
      1
  ),
  packs
    .map((pack) => ({
      pack: pack.id,
      count: out2.attemptsV2.filter((a) => a.caseId === pack.id).length,
    }))
    .filter((entry) => entry.count !== 1)
);
// Byte-stability modulo the fields the SCORER stamps fresh each run: the
// recovered attempts carry runGameIqScenarios' wall-clock startedAt/completedAt
// /durationMs (inherent non-determinism, not a recovery concern) and
// recovery.recoveredAt. Normalize exactly those, then everything recovery
// itself controls — ids, order, caseIds, statuses, scores, verifiers, failures
// — must be byte-identical across a re-run.
function normalizeForStability(bundle: BenchmarkReportBundleV2): string {
  const clone = JSON.parse(JSON.stringify(bundle)) as BenchmarkReportBundleV2 & {
    recovery?: { recoveredAt?: string };
  };
  if (clone.recovery) delete clone.recovery.recoveredAt;
  for (const attempt of clone.attemptsV2) {
    const record = attempt as unknown as Record<string, unknown>;
    record.startedAt = "<normalized>";
    record.completedAt = "<normalized>";
    record.durationMs = 0;
  }
  for (const verifier of clone.verifierResults) {
    (verifier as unknown as Record<string, unknown>).durationMs = 0;
  }
  return JSON.stringify(clone);
}
check(
  "recoverBundle(recoverBundle(x)) is byte-stable (modulo scorer timestamps)",
  normalizeForStability(out) === normalizeForStability(out2),
  {
    run1Len: out.attemptsV2.length,
    run2Len: out2.attemptsV2.length,
  }
);

// ── Refuses a non-failed run ──────────────────────────────────────────────────
let refused = false;
try {
  await recoverBundle({ ...bundle, runs: [{ ...run, status: "completed" }] });
} catch {
  refused = true;
}
check("refuses to recover a non-failed run", refused);

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
