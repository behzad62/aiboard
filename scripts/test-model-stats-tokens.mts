/**
 * Token-accounting checks for the Build model-stats pure core
 * (run: npx tsx scripts/test-model-stats-tokens.mts)
 *
 * Covers the pure, store-free math that backs accumulateModelStats:
 *  - mergeModelStatsRecord folds a build's per-worker delta and SUMS token
 *    totals across builds (tokens are attributed regardless of outcome).
 *  - normalizeModelStat fills token fields absent from legacy records with 0,
 *    so old on-disk records never NaN the running sums.
 *  - tokensPerApproval is the tokens-per-approved-task KPI (round, null-safe).
 *
 * Imports ONLY pure functions from model-stats (no React, no client store).
 */
import {
  mergeModelStatsRecord,
  normalizeModelStat,
  tokensPerApproval,
  type ModelStatDelta,
} from "../lib/client/model-stats";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const JUDGE = "anthropic:claude-x";
const MODEL = "openai:gpt-worker";

/** A per-worker build delta with sensible defaults, overridable per test. */
function delta(over: Partial<ModelStatDelta> = {}): ModelStatDelta {
  return {
    modelId: MODEL,
    displayName: "GPT Worker",
    attempts: 2,
    approvals: 2,
    fixes: 0,
    badOutput: 0,
    unavailable: 0,
    wApprovals: 2,
    wFixes: 0,
    wBadOutput: 0,
    responseMs: 1_000,
    responseChars: 500,
    inputTokens: 10_000,
    outputTokens: 5_000,
    ...over,
  };
}

// 1. Two builds accumulate: token totals sum across builds.
{
  const now = new Date("2026-07-05T00:00:00.000Z").toISOString();
  const first = mergeModelStatsRecord(undefined, delta(), JUDGE, now);
  const second = mergeModelStatsRecord(first, delta(), JUDGE, now);
  check("first build seeds token totals", first.inputTokens === 10_000 && first.outputTokens === 5_000, first);
  check(
    "second build sums input tokens across builds",
    second.inputTokens === 20_000,
    second.inputTokens
  );
  check(
    "second build sums output tokens across builds",
    second.outputTokens === 10_000,
    second.outputTokens
  );
  check("builds counter increments to 2", second.builds === 2, second.builds);
}

// 2. Legacy record (no token fields) normalizes to 0 and never NaNs the sums.
{
  const now = new Date("2026-07-05T00:00:00.000Z").toISOString();
  // Simulate a record persisted before token fields existed: cast a token-less
  // object through the normalizer's tolerant Partial input.
  const legacy = {
    modelId: MODEL,
    displayName: "GPT Worker",
    builds: 3,
    attempts: 6,
    approvals: 6,
    fixes: 0,
    badOutput: 0,
    unavailable: 0,
    wApprovals: 6,
    wFixes: 0,
    wBadOutput: 0,
    responseMs: 3_000,
    responseChars: 1_500,
    judges: { [JUDGE]: 6 },
    independentVerdicts: 6,
    updatedAt: now,
  } as Parameters<typeof normalizeModelStat>[0];
  const normalized = normalizeModelStat(legacy);
  check("legacy record normalizes inputTokens to 0", normalized.inputTokens === 0, normalized.inputTokens);
  check("legacy record normalizes outputTokens to 0", normalized.outputTokens === 0, normalized.outputTokens);

  // Folding a new delta onto the legacy record sums cleanly (no NaN).
  const merged = mergeModelStatsRecord(legacy, delta(), JUDGE, now);
  check("legacy + new build: input tokens are a finite sum", merged.inputTokens === 10_000, merged.inputTokens);
  check("legacy + new build: output tokens are a finite sum", merged.outputTokens === 5_000, merged.outputTokens);
  check("legacy + new build: no NaN in token totals", Number.isFinite(merged.inputTokens) && Number.isFinite(merged.outputTokens), merged);
}

// 3. Tokens are attributed even for failed/fixed attempts (failure waste shows up).
{
  const now = new Date("2026-07-05T00:00:00.000Z").toISOString();
  const failedDelta = delta({ approvals: 0, fixes: 1, badOutput: 1, attempts: 2, inputTokens: 8_000, outputTokens: 4_000 });
  const rec = mergeModelStatsRecord(undefined, failedDelta, JUDGE, now);
  check(
    "tokens from non-approved attempts are still counted",
    rec.inputTokens === 8_000 && rec.outputTokens === 4_000,
    rec
  );
}

// 4. tokensPerApproval math: (30000 + 30000) / 4 = 15000.
check(
  "tokensPerApproval divides total tokens by approvals (rounded)",
  tokensPerApproval({ inputTokens: 30_000, outputTokens: 30_000, approvals: 4 }) === 15_000,
  tokensPerApproval({ inputTokens: 30_000, outputTokens: 30_000, approvals: 4 })
);

// 5. tokensPerApproval rounds to a whole number.
check(
  "tokensPerApproval rounds a non-integer quotient",
  tokensPerApproval({ inputTokens: 10_000, outputTokens: 0, approvals: 3 }) === Math.round(10_000 / 3),
  tokensPerApproval({ inputTokens: 10_000, outputTokens: 0, approvals: 3 })
);

// 6. tokensPerApproval is null when there are no approvals.
check(
  "tokensPerApproval is null with zero approvals",
  tokensPerApproval({ inputTokens: 50_000, outputTokens: 10_000, approvals: 0 }) === null,
  tokensPerApproval({ inputTokens: 50_000, outputTokens: 10_000, approvals: 0 })
);

process.exit(failed === 0 ? 0 : 1);
