/* Recover the voided GameIQ pack scores of a FAILED run from its recorded
 * traces (run: npx tsx scripts/recover-gameiq-run.mts <run-file.json> [--write]).
 *
 * When a certified GameIQ run dies mid-way, run-engine's
 * createFailedAttemptsForRunError voids every pack's real attempt and replaces
 * it with a synthesized provider_unavailable attempt (id
 * `${runId}:${caseId}:${teamId}:failed`, gameIqScore 0), dropping the per-pack
 * verifierResults (they referenced the voided attempts). But the recorded model
 * -call traces still hold the model's actual answers for the packs that
 * completed before the failure. This tool replays those traces through the REAL
 * scorer (runGameIqScenarios) — via the SHARED resolvePackTraceReplay so its
 * pairing matches replay-gameiq-traces.mts exactly — and rebuilds a scored
 * attempt + verifier for each COMPLETE pack, leaving incomplete packs (the pack
 * the run died on) as provider_unavailable.
 *
 * Recovery does NOT rewrite history: the run DID fail, so runs[0].status stays
 * "failed" and the top-level run_engine_failed failure is kept. It only
 * restores the pack scores that were computed before the failure. The
 * recovered file remains a valid BenchmarkReportBundleV2 the app loads (the
 * dashboard recomputes from attemptsV2/verifierResults on load; summaryJson is
 * never read for scores, so it is left as-is).
 *
 * DEFAULT is dry-run: it computes and prints a per-pack before/after table plus
 * the index-prune plan and writes NOTHING. --write backs up <file>.bak (and
 * index.json.bak) then writes.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createGameIqVerifierResult,
  listGameIqScenarioPacks,
  resolvePackTraceReplay,
  runGameIqScenarios,
  type PackTraceRow,
} from "../lib/benchmark/gameiq";
import { reidGameIqPackAttempt } from "../lib/benchmark/certified/suite-options";
import type {
  BenchmarkAttemptV2,
  BenchmarkReportBundleV2,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

export interface RecoveredPackReport {
  packId: string;
  label: string;
  score: number;
  status: BenchmarkAttemptV2["status"];
  replayed: number;
  total: number;
  correct: number;
  attemptId: string;
  verifierId: string;
}

export interface SkippedPackReport {
  packId: string;
  label: string;
  replayed: number;
  total: number;
  reason: "incomplete" | "no-traces";
}

export interface RecoverBundleResult {
  bundle: BenchmarkReportBundleV2;
  recoveredPacks: RecoveredPackReport[];
  skipped: SkippedPackReport[];
}

export interface RecoverBundleOptions {
  /** ISO timestamp stamped into bundle.recovery.recoveredAt; omitted if unset. */
  recoveredAt?: string;
}

const SYNTHESIZED_STATUSES = new Set<BenchmarkAttemptV2["status"]>([
  "provider_unavailable",
  "invalid_harness",
  "failed_budget",
  "aborted_user",
]);

interface BundleRecoveryMeta {
  recoveredAt?: string;
  recoveredPacks: string[];
  skippedIncomplete: string[];
  tool: string;
  note: string;
}

/** Read the team + model this run scored, from the synthesized failed attempts. */
function resolveRunIdentity(bundle: BenchmarkReportBundleV2): {
  runId: string;
  modelId: string;
  teamCompositionId: string;
} {
  const run = bundle.runs[0];
  const gameiqAttempts = bundle.attemptsV2.filter(
    (attempt) => attempt.track === "gameiq"
  );
  const teamCompositionId =
    gameiqAttempts[0]?.teamCompositionId ??
    bundle.attemptsV2[0]?.teamCompositionId;
  if (!teamCompositionId) {
    throw new Error(
      "Cannot determine team composition id: no attemptsV2 in the run file."
    );
  }
  const modelId = run.modelIds[0];
  if (!modelId) {
    throw new Error("Cannot determine model id: runs[0].modelIds is empty.");
  }
  return { runId: run.id, modelId, teamCompositionId };
}

/**
 * Pure recovery: rebuild a FAILED GameIQ run bundle's complete-pack scores from
 * its traces. No file IO — testable directly.
 */
export async function recoverBundle(
  bundle: BenchmarkReportBundleV2,
  options: RecoverBundleOptions = {}
): Promise<RecoverBundleResult> {
  const run = bundle.runs[0];
  if (!run) throw new Error("Run file has no runs[]; nothing to recover.");
  if (run.status !== "failed") {
    throw new Error(
      `Run status is "${run.status}", not "failed"; nothing to recover.`
    );
  }

  const { runId, modelId, teamCompositionId } = resolveRunIdentity(bundle);
  const packs = listGameIqScenarioPacks();
  const traces = bundle.traces as PackTraceRow[];

  const recoveredPacks: RecoveredPackReport[] = [];
  const skipped: SkippedPackReport[] = [];
  const recoveredAttempts: BenchmarkAttemptV2[] = [];
  const recoveredVerifiers: BenchmarkVerifierResult[] = [];
  // caseIds whose synthesized provider_unavailable attempt must be removed.
  const recoveredCaseIds = new Set<string>();

  for (const pack of packs) {
    const packTraces = traces.filter((t) => t.caseId === pack.id);
    if (packTraces.length === 0) {
      skipped.push({
        packId: pack.id,
        label: pack.label,
        replayed: 0,
        total: pack.scenarios.length,
        reason: "no-traces",
      });
      continue;
    }
    const { replayScenarios, actions, replayed, total, partial } =
      resolvePackTraceReplay(pack, packTraces);
    if (partial || replayed !== total) {
      skipped.push({
        packId: pack.id,
        label: pack.label,
        replayed,
        total,
        reason: "incomplete",
      });
      continue;
    }

    let cursor = 0;
    const result = await runGameIqScenarios({
      runId,
      modelId,
      teamCompositionId,
      caseId: pack.id,
      scenarios: replayScenarios,
      moveProvider: () => ({ action: actions[cursor++] }),
    });

    const reidedAttempt = reidGameIqPackAttempt(result.attempt, pack.id);
    const verifier = createGameIqVerifierResult(reidedAttempt.id, result);
    const recoveredAttempt: BenchmarkAttemptV2 = {
      ...reidedAttempt,
      // Wire the attempt to its verifier exactly as the production certified
      // runner does (runGameIqScenarios leaves verifierResultId unset). Without
      // this the recovered attempt dangles with no verifier reference.
      verifierResultId: verifier.id,
      harnessVersion: `${result.attempt.harnessVersion}+recovered`,
    };

    recoveredAttempts.push(recoveredAttempt);
    recoveredVerifiers.push(verifier);
    recoveredCaseIds.add(pack.id);
    recoveredPacks.push({
      packId: pack.id,
      label: pack.label,
      score: result.score,
      status: recoveredAttempt.status,
      replayed,
      total,
      correct: result.metrics.correctActions,
      attemptId: recoveredAttempt.id,
      verifierId: verifier.id,
    });
  }

  const recovery: BundleRecoveryMeta = {
    ...(options.recoveredAt ? { recoveredAt: options.recoveredAt } : {}),
    recoveredPacks: recoveredPacks.map((pack) => pack.packId),
    skippedIncomplete: skipped
      .filter((pack) => pack.reason === "incomplete")
      .map((pack) => pack.packId),
    tool: "recover-gameiq-run",
    note: "pack scores rebuilt from recorded traces; run status left 'failed'",
  };

  // Rewrite the bundle:
  //  - drop each recovered pack's synthesized failed attempt (match by caseId),
  //    add the recovered scored attempt;
  //  - add the recovered verifiers;
  //  - drop the recovered packs' provider_unavailable FAILURE entries (no
  //    longer failures) but KEEP the top-level run_engine_failed failure;
  //  - leave incomplete packs' synthesized attempts + failures untouched;
  //  - runs[0].status stays "failed".
  const removedAttemptIds = new Set(
    bundle.attemptsV2
      .filter(
        (attempt) =>
          recoveredCaseIds.has(attempt.caseId) &&
          SYNTHESIZED_STATUSES.has(attempt.status) &&
          attempt.id.endsWith(":failed")
      )
      .map((attempt) => attempt.id)
  );

  const nextAttemptsV2: BenchmarkAttemptV2[] = [
    ...bundle.attemptsV2.filter((attempt) => !removedAttemptIds.has(attempt.id)),
    ...recoveredAttempts,
  ];
  const nextVerifierResults: BenchmarkVerifierResult[] = [
    ...bundle.verifierResults,
    ...recoveredVerifiers,
  ];
  const nextFailures = bundle.failures.filter(
    (failure) =>
      failure.attemptId == null || !removedAttemptIds.has(failure.attemptId)
  );

  const nextBundle: BenchmarkReportBundleV2 & { recovery: BundleRecoveryMeta } = {
    ...bundle,
    attemptsV2: nextAttemptsV2,
    verifierResults: nextVerifierResults,
    failures: nextFailures,
    recovery,
  };

  return { bundle: nextBundle, recoveredPacks, skipped };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface IndexEntry {
  id: string;
  file: string;
}
interface IndexFile {
  version: number;
  updatedAt: string;
  runs: IndexEntry[];
}

interface IndexPrunePlan {
  indexPath: string;
  removed: IndexEntry[];
  kept: number;
}

/** Plan pruning of index.json entries whose runs/<file> is missing on disk. */
function planIndexPrune(runFilePath: string): IndexPrunePlan | null {
  const runsDir = dirname(runFilePath);
  const benchmarksDir = dirname(runsDir);
  const indexPath = join(benchmarksDir, "index.json");
  if (!existsSync(indexPath)) return null;
  let index: IndexFile;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8")) as IndexFile;
  } catch {
    return null;
  }
  if (!Array.isArray(index.runs)) return null;
  const removed = index.runs.filter(
    (entry) => !existsSync(join(benchmarksDir, entry.file))
  );
  return { indexPath, removed, kept: index.runs.length - removed.length };
}

function applyIndexPrune(plan: IndexPrunePlan, backupSuffix: string): void {
  const index = JSON.parse(readFileSync(plan.indexPath, "utf8")) as IndexFile;
  const removedFiles = new Set(plan.removed.map((entry) => entry.file));
  const nextRuns = index.runs.filter((entry) => !removedFiles.has(entry.file));
  copyFileSync(plan.indexPath, `${plan.indexPath}.${backupSuffix}.bak`);
  writeFileSync(
    plan.indexPath,
    JSON.stringify(
      { ...index, updatedAt: new Date().toISOString(), runs: nextRuns },
      null,
      2
    )
  );
}

function fmtScore(score: number): string {
  return String(Math.round(score * 100) / 100).padStart(6);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const fileArg = args.find((arg) => !arg.startsWith("--"));
  if (!fileArg) {
    console.log(
      "Usage: npx tsx scripts/recover-gameiq-run.mts <run-file.json> [--write]"
    );
    process.exit(2);
  }
  const filePath = resolve(fileArg);
  if (!existsSync(filePath)) {
    console.error(`Run file not found: ${filePath}`);
    process.exit(2);
  }

  const bundle = JSON.parse(readFileSync(filePath, "utf8")) as BenchmarkReportBundleV2;
  const recoveredAt = new Date().toISOString();
  const { bundle: nextBundle, recoveredPacks, skipped } = await recoverBundle(
    bundle,
    { recoveredAt }
  );

  const mode = write ? "WRITE" : "DRY-RUN";
  console.log(`\n=== recover-gameiq-run [${mode}] ===`);
  console.log(`file: ${filePath}`);
  console.log(
    `run:  ${bundle.runs[0]?.id}  status=${bundle.runs[0]?.status}  model=${bundle.runs[0]?.modelIds?.[0]}`
  );

  console.log(`\nRecovered packs (${recoveredPacks.length}):`);
  for (const pack of recoveredPacks) {
    console.log(
      `  ${pack.label.replace("Certified GameIQ v1: ", "").padEnd(30)} score=${fmtScore(
        pack.score
      )} status=${pack.status.padEnd(14)} correct=${pack.correct}/${pack.replayed}`
    );
  }

  console.log(`\nSkipped packs (${skipped.length}):`);
  for (const pack of skipped) {
    const label = pack.label.replace("Certified GameIQ v1: ", "").padEnd(30);
    console.log(
      `  ${label} ${pack.reason === "incomplete" ? `incomplete ${pack.replayed}/${pack.total}` : "no traces"} — not recovered`
    );
  }

  const prunePlan = planIndexPrune(filePath);
  console.log("\nindex.json prune plan:");
  if (!prunePlan) {
    console.log("  (no sibling index.json found)");
  } else if (prunePlan.removed.length === 0) {
    console.log(
      `  no stale entries (${prunePlan.kept} entries, all files present)`
    );
  } else {
    for (const entry of prunePlan.removed) {
      console.log(`  DROP ${entry.id} (missing ${entry.file})`);
    }
    console.log(`  keep ${prunePlan.kept} entries`);
  }

  if (!write) {
    console.log("\nDRY-RUN: no files written. Re-run with --write to apply.");
    return;
  }

  const backupSuffix = `recover-${Date.now()}`;
  copyFileSync(filePath, `${filePath}.${backupSuffix}.bak`);
  writeFileSync(filePath, JSON.stringify(nextBundle, null, 2));
  console.log(`\nWROTE ${filePath} (backup: ${filePath}.${backupSuffix}.bak)`);
  if (prunePlan && prunePlan.removed.length > 0) {
    applyIndexPrune(prunePlan, backupSuffix);
    console.log(
      `WROTE ${prunePlan.indexPath} (backup: ${prunePlan.indexPath}.${backupSuffix}.bak)`
    );
  }
}

// Only run the CLI when invoked directly (not when imported by tests). Under
// tsx the entry module's URL matches process.argv[1] (pathToFileURL yields the
// exact file:// form import.meta.url uses, cross-platform).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
