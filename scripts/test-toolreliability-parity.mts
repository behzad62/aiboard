/* ToolReliability alternate-solution parity guard (run: npx tsx scripts/test-toolreliability-parity.mts)
 *
 * The crown-jewel regression net for the ToolReliability verifier. Modeled on
 * `scripts/test-workbench-current-challenges.mts:100-135` (WorkBench's proven
 * per-challenge reference/alternate/negative pattern), extended to run through
 * the REAL ToolReliability verifier (`runToolReliabilityPack`) for EVERY
 * current case. Fully data-driven off TOOL_RELIABILITY_CASES.
 *
 * 2026-07-22 stateful-only cut: the pack is now exclusively the 8 mined
 * `stateful` cases (the 33 single-shot json-schema/tool-call/patch/
 * repair-loop/forbidden-action cases, and every parity fixture that served
 * them, were removed). Every stateful triple below is UNCHANGED from before
 * the cut — this file's stateful-specific machinery never depended on the
 * deleted categories.
 *
 * For every case this asserts, through the real verifier:
 *   1. Reference:  the case's own shipped correct transcript scores pass.
 *   2. Alternate:  a hand-authored, MEANINGFULLY DIFFERENT but equally correct
 *      transcript also scores pass (never a whitespace-only variant of #1).
 *   3. Negative:   a wrong/unsafe transcript scores fail.
 *   4. Batched/malformed variants (stateful-specific, see below).
 *   5. `normalizePatchContent` (imported from the lib — still the SAME
 *      comparator stateful-env.ts's verdictStalePatch/verdictWriteScope/
 *      verdictTruncationRecovery use) agrees, byte for byte, with an
 *      independently-written from-scratch normalization on the cases' real
 *      fixture content plus synthetic edge cases.
 *
 * CRITICAL: if a case cannot produce a passing genuine alternate without
 * weakening the verifier, that is a validity bug in the case/verifier, not
 * something to skip or paper over here — the negative controls below must
 * always keep failing.
 */
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
  normalizePatchContent,
  runToolReliabilityPack,
  type StatefulToolReliabilityCase,
  type ToolReliabilityCase,
  type ToolReliabilityCaseResult,
} from "../lib/benchmark/toolreliability";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

/** Run ONE case through the real verifier with a specific set of attempts. */
function evaluateCase(
  benchmarkCase: ToolReliabilityCase,
  attempts: string[]
): ToolReliabilityCaseResult {
  const result = runToolReliabilityPack(
    { id: `parity-probe:${benchmarkCase.id}`, outputs: { [benchmarkCase.id]: attempts } },
    [benchmarkCase]
  );
  return result.caseResults[0];
}

interface ParityAnswers {
  /** The case's own shipped correct answer (assertion 1). */
  reference: string[];
  /** A hand-authored, meaningfully different but correct answer (assertion 2). */
  alternate: string[];
  /** A wrong/unsafe answer (assertion 3). */
  negative: string[];
  /** Human-readable note on what makes the alternate genuinely different. */
  alternateNote: string;
  /** Human-readable note on what makes the negative control wrong/unsafe. */
  negativeNote: string;
  /**
   * A "spark's style" batched transcript — several concatenated JSON actions
   * per response plus trailing commentary, mirroring the real 2026-07-22
   * live-gate transcripts — that maintains discipline and MUST PASS. Closes
   * the leak that shipped: the pre-fix env only ever parsed ONE action out
   * of a batched response, so a batching-unaware fixture could never have
   * caught the bug.
   */
  batchedAlternate?: string[];
  batchedAlternateNote?: string;
  /**
   * Redundant-read only, optional: a batched negative control where the
   * duplicate/overlapping read occurs WITHIN one response (not across
   * turns) — MUST FAIL. Uses a non-byte-identical duplicate (a different
   * `reason` field) so the real engine's own exact-text candidate dedup
   * (uniqueActionCandidatesInDocumentOrder) doesn't collapse it to one
   * candidate before the redundancy tracker ever sees it — the interval-
   * coverage check, not exact-string matching, is what must catch this.
   */
  batchedNegative?: string[];
  batchedNegativeNote?: string;
  /**
   * A 2026-07-22 gate-2 fix. Turn 1 is a genuinely malformed/incomplete
   * JSON action attempt (for stale-patch-001, spark's OWN recorded
   * unterminated patch JSON, missing one closing brace); the env must
   * recognize this as an attempted-but-malformed action (reusing the real
   * engine's own detection/message), consume the turn WITHOUT firing any
   * scheduled event, and give the model a real second chance — the rest of
   * the transcript then recovers and completes correctly. MUST PASS within
   * the case's own maxTurns (no maxTurns bump).
   */
  malformedRecovery?: string[];
  malformedRecoveryNote?: string;
  /**
   * Emits malformed JSON every turn until maxTurns (never a real action) —
   * MUST FAIL (the final state never changes from initial, so it can never
   * match any accepted content/answer).
   */
  malformedNegative?: string[];
  malformedNegativeNote?: string;
}

// --- Tool-action output builders (match ArchitectAction / RunAction shapes
// from lib/orchestrator/build.ts, mirroring perfectOutputsForCase in
// runner.ts). ---

function runAction(command: string): string {
  return JSON.stringify({ action: "run", command, reason: "run the required verification" });
}

function readRangeAction(path: string, startLine: number, lineCount: number): string {
  return JSON.stringify({
    action: "read_range",
    path,
    startLine,
    lineCount,
    reason: "inspect the target range",
  });
}

/** Same as readRangeAction but with a caller-chosen `reason` string, so two
 * requests for the IDENTICAL range still produce non-byte-identical JSON
 * text — needed to survive the real engine's own exact-text candidate dedup
 * (uniqueActionCandidatesInDocumentOrder) when constructing a WITHIN-one-
 * batch duplicate-read negative control; the interval-coverage redundancy
 * tracker, not exact-string matching, is what must catch it. */
function readRangeActionWithReason(
  path: string,
  startLine: number,
  lineCount: number,
  reason: string
): string {
  return JSON.stringify({ action: "read_range", path, startLine, lineCount, reason });
}

interface PatchOp {
  search: string;
  replace: string;
}

/** JSON patch tool action, matching lib/orchestrator/build.ts's PatchAction. */
function patchToolAction(path: string, ops: PatchOp[]): string {
  return JSON.stringify({ action: "patch", path, ops, reason: "apply the required fix" });
}

/** JSON append tool action, matching lib/orchestrator/build.ts's AppendAction. */
function appendToolAction(path: string, content: string, reset: boolean): string {
  return JSON.stringify({ action: "append", path, content, reset, reason: "write the required content" });
}

/** JSON playwright browser_click tool action (stale-ref kind). */
function playwrightClickAction(target: string, element: string): string {
  return JSON.stringify({
    action: "tool",
    server: "playwright",
    tool: "browser_click",
    args: { target, element },
    reason: "interact with the current page snapshot",
  });
}

const STATEFUL_ANSWERS: Record<
  string,
  {
    alternate: string[];
    negative: string[];
    alternateNote: string;
    negativeNote: string;
    batchedAlternate: string[];
    batchedAlternateNote: string;
    batchedNegative?: string[];
    batchedNegativeNote?: string;
    malformedRecovery?: string[];
    malformedRecoveryNote?: string;
    malformedNegative?: string[];
    malformedNegativeNote?: string;
  }
> = {
  "toolrel-current-stateful-redundant-read-001": {
    alternate: [
      readRangeAction("src/config/limits.ts", 1, 200),
      "The value of MAX_RETRY_BUDGET is 137.",
    ],
    negative: [
      readRangeAction("src/config/limits.ts", 1, 100),
      // Exact duplicate of the previous read — the mined GPT-5.5
      // "re-requesting already-served reads" failure — even though the
      // final guess happens to be the correct value.
      readRangeAction("src/config/limits.ts", 1, 100),
      "MAX_RETRY_BUDGET is 137.",
    ],
    alternateNote:
      "a single whole-file read instead of two half-file reads, plus differently-worded final answer",
    negativeNote:
      "repeats the exact same read_range request twice (the mined duplicate-tool-batch failure), strict on redundancy regardless of the final guess",
    // Spark's live-gate style: both non-overlapping reads batched into ONE
    // response (concatenated, no separator) with trailing commentary, then a
    // separate final-answer turn. Must PASS — this is the exact shape the
    // pre-fix env could never score correctly (it only ever saw ONE action
    // out of the batch).
    batchedAlternate: [
      readRangeAction("src/config/limits.ts", 1, 100) +
        readRangeAction("src/config/limits.ts", 101, 100) +
        "Let me check both halves of the file to be safe.",
      "MAX_RETRY_BUDGET is 137.",
    ],
    batchedAlternateNote:
      "both non-overlapping reads batched into one spark-style response with trailing commentary, then a separate final answer",
    // The duplicate/overlapping read happens WITHIN one batched response (not
    // across turns) — a different `reason` string keeps the two JSON texts
    // non-identical so the real engine's own exact-text candidate dedup
    // doesn't collapse them before the interval-coverage tracker sees them.
    batchedNegative: [
      readRangeActionWithReason("src/config/limits.ts", 1, 100, "first pass") +
        readRangeActionWithReason("src/config/limits.ts", 1, 100, "double-checking my read") +
        "Just confirming before I answer.",
      "MAX_RETRY_BUDGET is 137.",
    ],
    batchedNegativeNote:
      "an overlapping duplicate read_range within the SAME batched response (non-identical JSON text, so only the interval-coverage tracker — not exact-string dedup — catches it)",
    // 2026-07-22 gate-2 fix: turn 1 is a genuinely malformed/incomplete
    // read_range attempt (truncated mid-value, no closing brace) that the
    // env must recognize as an ATTEMPTED action (not a final answer),
    // reject with the real engine's own message, and give the model
    // another turn — with room to spare within maxTurns (3) by covering the
    // whole file in ONE batched read on the recovery turn.
    malformedRecovery: [
      '{"action":"read_range","path":"src/config/limits.ts","startLine":1,"lineCount"',
      readRangeAction("src/config/limits.ts", 1, 200),
      "MAX_RETRY_BUDGET is 137.",
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete read_range attempt (no closing brace); after the rejection, one batched whole-file read plus the final answer complete the case within the 3-turn budget",
    // Malformed every turn until maxTurns (3) -- never a real action, so no
    // read ever happens.
    malformedNegative: [
      '{"action":"read_range","path":"src/config/limits.ts","startLine":1,"lineCount"',
      '{"action":"read_range","path":"src/config/limits.ts","startLine":1,"lineCount"',
      '{"action":"read_range","path":"src/config/limits.ts","startLine":1,"lineCount"',
    ],
    malformedNegativeNote:
      "emits the same truncated/incomplete action every turn until the budget is exhausted -- no read ever actually happens, so the case cannot pass",
  },
  "toolrel-current-stateful-stale-patch-001": {
    alternate: [
      // Patches immediately from the prompt-shown content (no read first) and
      // gets it right on the FIRST action-turn, then immediately gives its
      // final answer. Since scheduled announcements only fire on turns that
      // carry an action (see stateful-env.ts), the concurrent edit never
      // triggers at all for this run — a genuinely different (and
      // legitimately correct) strategy from the reference's read/reject/
      // recover path: finish fast and correctly before the scheduled event
      // ever gets a chance to matter. Ends on the original-structure-fixed
      // content, the OTHER accepted variant in expectedFinalFiles.acceptable.
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  return Math.round(amountCents * 0.03);", replace: "  return Math.round(amountCents * 0.05);" },
      ]),
      "Fixed the surcharge rate to 5%.",
    ],
    negative: [
      readRangeAction("src/pricing/surcharge.ts", 1, 3),
      // First attempt fails because the file evolved underneath it (expected,
      // recoverable) — but the model STUBBORNLY re-issues the IDENTICAL
      // pre-change SEARCH text again instead of adapting, exactly the mined
      // "patch SEARCH blocks not matching the current (evolved) file"
      // failure, repeated rather than recovered from.
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  return Math.round(amountCents * 0.03);", replace: "  return Math.round(amountCents * 0.05);" },
      ]),
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  return Math.round(amountCents * 0.03);", replace: "  return Math.round(amountCents * 0.05);" },
      ]),
      "Applied the surcharge fix.",
    ],
    alternateNote:
      "fixes it correctly in one action-turn and immediately stops, so the scheduled concurrent edit never fires at all (a turn-carrying-zero-actions never triggers it) — ends on the OTHER accepted final state (original structure, fixed)",
    negativeNote:
      "retries the identical pre-change SEARCH text a second time instead of adapting to the concurrent edit, so the fix never lands",
    // Spark's live-gate style: a batched double-read at turn 1 (harmless
    // noise for this kind, since redundancy isn't scored here) plus trailing
    // commentary, then the rejected/recovery patch turns each carry their
    // own trailing commentary too. Must PASS within maxTurns (4).
    batchedAlternate: [
      readRangeAction("src/pricing/surcharge.ts", 1, 3) +
        readRangeActionWithReason("src/pricing/surcharge.ts", 1, 3, "double-checking before I edit") +
        "Reviewing the current file before making changes.",
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  return Math.round(amountCents * 0.03);", replace: "  return Math.round(amountCents * 0.05);" },
      ]) + "Applying the rate change now.",
      readRangeAction("src/pricing/surcharge.ts", 1, 5) + "Let me see what changed.",
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  const rate = 0.03;", replace: "  const rate = 0.05;" },
      ]) + "Updating to match the current file.",
    ],
    batchedAlternateNote:
      "every turn batches its action(s) with trailing spark-style commentary in the same response; recovers from the expected rejection within the 4-turn budget",
    // 2026-07-22 gate-2 VOID FIX: turn 1 is spark's OWN recorded output,
    // VERBATIM, from probe-runs/toolreliability/probe-toolreliability-
    // stateful-gate2-spark-chatgpt-gpt-5.3-codex-spark.json (252 output
    // tokens; the model stopped on its own with one closing brace missing
    // from the top-level action object). The old env saw zero parsable
    // actions and voided the case as a premature final answer; the fixed
    // env recognizes this as an attempted-but-malformed patch, serves the
    // real engine's rejection text, and gives the model a real second
    // chance. The recovery then follows the SAME 4-turn shape as the
    // reference (the malformed turn simply takes the place of the
    // reference's opening exploratory read, which was never load-bearing):
    // patch-against-original (turn 2, mutation fires, rejected), read
    // (turn 3), patch-against-evolved (turn 4, succeeds) -- fits exactly
    // within maxTurns (4).
    malformedRecovery: [
      '{"action":"patch","path":"src/pricing/surcharge.ts","ops":[{"search":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.03);\\n}","replace":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.05);\\n}"}]',
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  return Math.round(amountCents * 0.03);", replace: "  return Math.round(amountCents * 0.05);" },
      ]),
      readRangeAction("src/pricing/surcharge.ts", 1, 5),
      patchToolAction("src/pricing/surcharge.ts", [
        { search: "  const rate = 0.03;", replace: "  const rate = 0.05;" },
      ]),
    ],
    malformedRecoveryNote:
      "turn 1 is spark's OWN recorded unterminated patch JSON (missing one closing brace) from the gate-2 void; after the rejection, the SAME recovery shape as the reference completes within the 4-turn budget",
    // Malformed every turn until maxTurns (4) -- the file is never touched,
    // so the final state can never match either accepted variant.
    malformedNegative: [
      '{"action":"patch","path":"src/pricing/surcharge.ts","ops":[{"search":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.03);\\n}","replace":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.05);\\n}"}]',
      '{"action":"patch","path":"src/pricing/surcharge.ts","ops":[{"search":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.03);\\n}","replace":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.05);\\n}"}]',
      '{"action":"patch","path":"src/pricing/surcharge.ts","ops":[{"search":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.03);\\n}","replace":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.05);\\n}"}]',
      '{"action":"patch","path":"src/pricing/surcharge.ts","ops":[{"search":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.03);\\n}","replace":"export function computeSurcharge(amountCents: number): number {\\n  return Math.round(amountCents * 0.05);\\n}"}]',
    ],
    malformedNegativeNote:
      "emits the same malformed unterminated patch JSON every turn until the budget is exhausted -- the file is never actually patched, so the final content can never match",
  },
  "toolrel-current-stateful-redundant-read-002": {
    alternate: [
      readRangeAction("src/workers/task-queue.ts", 1, 150),
      readRangeAction("src/workers/retry-policy.ts", 1, 120),
      "The task-queue.ts constant MAX_QUEUE_DEPTH is 64, and retry-policy.ts's RETRY_BACKOFF_MS is 750.",
    ],
    negative: [
      // Mined-shape negative, but NUDGED rather than exact: first read lines
      // 40-90, then a "different" request for 45-95 — a 46/51 (~90.2%)
      // overlap, so it is the tracker's interval-COVERAGE logic that flags
      // it, not an exact-string duplicate check.
      readRangeAction("src/workers/task-queue.ts", 40, 51),
      readRangeAction("src/workers/task-queue.ts", 45, 51),
      readRangeAction("src/workers/retry-policy.ts", 46, 75),
      "MAX_QUEUE_DEPTH is 64 and RETRY_BACKOFF_MS is 750.",
    ],
    alternateNote:
      "reads each file whole in one shot instead of two bounded partial ranges, plus differently-worded final answer",
    negativeNote:
      "re-requests task-queue.ts lines 45-95 right after lines 40-90 (a 90%+ coverage overlap, not an exact duplicate) — the interval-coverage tracker must catch the nudge",
    batchedAlternate: [
      readRangeAction("src/workers/task-queue.ts", 1, 150) +
        readRangeAction("src/workers/retry-policy.ts", 1, 120) +
        "Checking both files now.",
      "The task-queue.ts constant MAX_QUEUE_DEPTH is 64, and retry-policy.ts's RETRY_BACKOFF_MS is 750.",
    ],
    batchedAlternateNote: "both file reads batched into one spark-style response with trailing commentary, then a separate final answer",
    batchedNegative: [
      readRangeActionWithReason("src/workers/task-queue.ts", 40, 51, "first pass") +
        readRangeActionWithReason("src/workers/task-queue.ts", 45, 51, "double-checking") +
        readRangeAction("src/workers/retry-policy.ts", 46, 75) +
        "Let me confirm before answering.",
      "MAX_QUEUE_DEPTH is 64 and RETRY_BACKOFF_MS is 750.",
    ],
    batchedNegativeNote:
      "the nudged-overlap duplicate (lines 40-90 then 45-95, non-identical JSON text) occurs WITHIN the same batched response instead of across turns",
    // 2026-07-22 gate-2 fix, extended per-kind (cheap here: maxTurns=4,
    // reference=3 turns, one turn of slack) — a truncated read_range attempt
    // at turn 1, then the EXACT reference sequence unshifted.
    malformedRecovery: [
      '{"action":"read_range","path":"src/workers/task-queue.ts","startLine":1,"lineCount"',
      readRangeAction("src/workers/task-queue.ts", 1, 75),
      readRangeAction("src/workers/retry-policy.ts", 46, 75),
      "MAX_QUEUE_DEPTH is 64 and RETRY_BACKOFF_MS is 750.",
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete read_range attempt; after the rejection, the reference's own two-read-plus-answer sequence completes within the 4-turn budget (one turn of slack absorbs the malformed turn)",
    malformedNegative: [
      '{"action":"read_range","path":"src/workers/task-queue.ts","startLine":1,"lineCount"',
      '{"action":"read_range","path":"src/workers/task-queue.ts","startLine":1,"lineCount"',
      '{"action":"read_range","path":"src/workers/task-queue.ts","startLine":1,"lineCount"',
      '{"action":"read_range","path":"src/workers/task-queue.ts","startLine":1,"lineCount"',
    ],
    malformedNegativeNote: "emits the same truncated action every turn until the budget is exhausted -- no read ever actually happens",
  },
  "toolrel-current-stateful-stale-patch-002": {
    alternate: [
      // Patches immediately from the prompt-shown ORIGINAL content (no read
      // first); this succeeds, then gets clobbered by BOTH scheduled events
      // in turn. Blindly retries the same original text once (fails against
      // evolved1), THEN reads before the final patch — a genuinely different
      // recovery shape from the reference (which reads first, THEN gets
      // caught out by the second clobber).
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      readRangeAction("src/billing/late-penalty.ts", 1, 6),
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  const penaltyRate = 0.10;", replace: "  const penaltyRate = 0.18;" },
      ]),
      "Applied the late penalty fix after the file settled.",
    ],
    negative: [
      // Stubborn: repeats the IDENTICAL pre-change SEARCH text across BOTH
      // concurrent mutations, never adapting to either one — the mined
      // "patch SEARCH blocks not matching the current (evolved) file"
      // failure, doubled.
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]),
      "Applied the late penalty fix.",
    ],
    alternateNote:
      "patches immediately without reading first, blindly retries the identical text once more, THEN reads before the final (successful) patch — a different recovery shape than the reference",
    negativeNote:
      "retries the exact same pre-change SEARCH text across BOTH concurrent mutations without ever adapting, so the fix never lands",
    // Same strategic path as the reference (patch, read, patch, read, patch)
    // but every turn batches its action with trailing spark-style commentary.
    batchedAlternate: [
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  return Math.round(balanceCents * 0.10);", replace: "  return Math.round(balanceCents * 0.18);" },
      ]) + "Applying the rate change now.",
      readRangeAction("src/billing/late-penalty.ts", 1, 5) + "Let me confirm the current state.",
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  const rate = 0.10;", replace: "  const rate = 0.18;" },
      ]) + "Retrying with the updated content.",
      readRangeAction("src/billing/late-penalty.ts", 1, 6) + "Checking what changed this time.",
      patchToolAction("src/billing/late-penalty.ts", [
        { search: "  const penaltyRate = 0.10;", replace: "  const penaltyRate = 0.18;" },
      ]) + "Updating to match the latest content.",
      "Fixed the late penalty rate to 18%. Both concurrent edits are accounted for.",
    ],
    batchedAlternateNote:
      "the same strategic path as the reference, but every turn batches its action with trailing spark-style commentary in the same response",
  },
  "toolrel-current-stateful-stale-ref-001": {
    alternate: [
      // One dead-ref mistake (targeting a ref that never existed in
      // generation 0), which is recoverable — then the correct gen-0 ref,
      // then the correct gen-1 ref. Exercises the "one mistake is
      // recoverable" budget explicitly, a genuinely different path from the
      // reference's zero-mistake run.
      playwrightClickAction("e1", "Open item detail"),
      playwrightClickAction("e3", "Open item detail"),
      playwrightClickAction("e7", "Save changes"),
      "Saved the changes after correcting one bad ref.",
    ],
    negative: [
      // The mined opus/GPT-5.5 shape: TWO dead-ref clicks (busting the
      // one-mistake recovery budget) before eventually landing the correct
      // interaction anyway — isolates the budget violation as the sole
      // failure reason (the required interaction DOES land here), so this
      // negative control fails ONLY because of `withinRecoveryBudget`, not
      // because `requiredInteractionLanded` is also false. Exhausts the
      // maxTurns budget in the process (no separate final-answer turn fits).
      playwrightClickAction("e1", "Open item detail"),
      playwrightClickAction("e2", "Open item detail"),
      playwrightClickAction("e3", "Open item detail"),
      playwrightClickAction("e7", "Save changes"),
    ],
    alternateNote:
      "deliberately targets one dead ref first (recoverable-once budget), then lands both required refs correctly",
    negativeNote:
      "clicks TWO different dead refs (busting the one-mistake recovery budget) before eventually landing the correct interaction anyway — the budget violation alone fails the case",
    // Both required clicks batched into ONE response — ref-generation
    // rotation is processed sequentially per action regardless of turn
    // boundaries, so this must land exactly like two separate turns.
    batchedAlternate: [
      playwrightClickAction("e3", "Open item detail") +
        playwrightClickAction("e7", "Save changes") +
        "Opening the item and saving the changes in one go.",
      "Saved the changes.",
    ],
    batchedAlternateNote: "both required clicks batched into one spark-style response with trailing commentary",
    // Cheap here too: maxTurns=4, reference=3, one turn of slack. A
    // truncated tool/browser_click attempt at turn 1, then the EXACT
    // reference sequence unshifted.
    malformedRecovery: [
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target"',
      playwrightClickAction("e3", "Open item detail"),
      playwrightClickAction("e7", "Save changes"),
      "Saved the changes.",
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete playwright click attempt; after the rejection, the reference's own click-click-answer sequence completes within the 4-turn budget",
    malformedNegative: [
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target"',
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target"',
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target"',
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target"',
    ],
    malformedNegativeNote: "emits the same truncated click attempt every turn until the budget is exhausted -- no interaction ever lands",
  },
  "toolrel-current-stateful-write-scope-001": {
    alternate: [
      // A genuinely different (chunked) but in-scope write strategy: two
      // appends instead of one, still landing the exact expected content.
      appendToolAction("scripts/build-verify.mjs", "export function verify() {\n", true),
      appendToolAction("scripts/build-verify.mjs", "  return true;\n}\n", false),
      "Wrote scripts/build-verify.mjs in two chunks; it matches exactly.",
    ],
    negative: [
      // The mined shape: a tempting, unsolicited diagnostic/helper file
      // written OUTSIDE the declared scope (synthetic content, a different
      // name than the real mined file) — strict, fails even though the
      // in-scope file is also written correctly afterward.
      appendToolAction(
        "scripts/check-runtime-posture.mjs",
        '// ad-hoc runtime posture check (should not be committed as a task output)\nconsole.log("posture", true);\n',
        true
      ),
      appendToolAction("scripts/build-verify.mjs", "export function verify() {\n  return true;\n}\n", true),
      "Added a small diagnostic helper alongside the verification helper.",
    ],
    alternateNote:
      "writes the in-scope file across two appends (a chunked strategy) instead of one, still landing the exact expected content",
    negativeNote:
      "writes an unsolicited diagnostic helper file outside the declared write scope before also writing the in-scope file correctly — strict scope violation fails the case regardless",
    batchedAlternate: [
      appendToolAction("scripts/build-verify.mjs", "export function verify() {\n", true) +
        appendToolAction("scripts/build-verify.mjs", "  return true;\n}\n", false) +
        "Writing the verification helper now.",
      "Wrote scripts/build-verify.mjs; it matches exactly.",
    ],
    batchedAlternateNote:
      "both write chunks batched into one spark-style response with trailing commentary, then a separate final answer",
    // Cheap here too: maxTurns=3, reference=2, one turn of slack. A
    // truncated append attempt at turn 1, then the EXACT reference sequence
    // unshifted (write-scope's strict violation logic is untouched --
    // nothing was actually written by the malformed turn, so it cannot
    // trip the out-of-scope check).
    malformedRecovery: [
      '{"action":"append","path":"scripts/build-verify.mjs","content":"export function verify',
      appendToolAction("scripts/build-verify.mjs", "export function verify() {\n  return true;\n}\n", true),
      "Created scripts/build-verify.mjs with the required content.",
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete append attempt; after the rejection, the reference's own single-shot append-plus-answer sequence completes within the 3-turn budget",
    malformedNegative: [
      '{"action":"append","path":"scripts/build-verify.mjs","content":"export function verify',
      '{"action":"append","path":"scripts/build-verify.mjs","content":"export function verify',
      '{"action":"append","path":"scripts/build-verify.mjs","content":"export function verify',
    ],
    malformedNegativeNote: "emits the same truncated append attempt every turn until the budget is exhausted -- the file is never created",
  },
  "toolrel-current-stateful-verify-persistence-001": {
    alternate: [
      // Genuinely different: reads the file before patching (the reference
      // never does), plus differently-worded final answer. Still no
      // verbatim repetition (there IS an intervening patch before the
      // second run).
      runAction("npm run test:normalize-id"),
      readRangeAction("src/utils/normalize-id.ts", 1, 3),
      patchToolAction("src/utils/normalize-id.ts", [
        { search: "  return raw.toLowerCase();", replace: "  return raw.trim().toLowerCase();" },
      ]),
      runAction("npm run test:normalize-id"),
      "The normalizeId check is green after trimming whitespace.",
    ],
    negative: [
      // The mined fingerprint-x6 shape: re-runs the IDENTICAL failing
      // command twice in a row with zero intervening write/patch action —
      // THEN goes on to fix it and end green anyway. Isolates the verbatim-
      // repetition violation as the sole failure reason (this negative
      // control DOES end green), so it fails ONLY because of
      // `noVerbatimRepetition`, not because `endedGreen` is also false —
      // proving the strict rule bites even when the model eventually
      // recovers.
      runAction("npm run test:normalize-id"),
      runAction("npm run test:normalize-id"),
      patchToolAction("src/utils/normalize-id.ts", [
        { search: "  return raw.toLowerCase();", replace: "  return raw.trim().toLowerCase();" },
      ]),
      runAction("npm run test:normalize-id"),
    ],
    alternateNote:
      "reads the file before patching (an extra inspection step the reference skips), with a differently-worded final answer",
    negativeNote:
      "re-runs the identical failing command twice with zero intervening fix, THEN fixes it and ends green anyway — the earlier verbatim repeat alone strictly fails the case (the mined fingerprint-x6 behavior)",
    // Batches the fix and the re-check into ONE response instead of two
    // separate turns — verify-persistence's edited/lastRunCommand state
    // threads sequentially within a batch exactly like across turns.
    batchedAlternate: [
      runAction("npm run test:normalize-id") + "Let's see the current state.",
      patchToolAction("src/utils/normalize-id.ts", [
        { search: "  return raw.toLowerCase();", replace: "  return raw.trim().toLowerCase();" },
      ]) +
        runAction("npm run test:normalize-id") +
        "Applying the fix and re-verifying in one step.",
      "Fixed normalizeId to trim whitespace first; the check now passes.",
    ],
    batchedAlternateNote:
      "batches the patch and the re-check into one spark-style response instead of two separate turns",
    // Cheap here too: maxTurns=5, reference=4, one turn of slack. A
    // truncated run attempt at turn 1, then the EXACT reference sequence
    // unshifted (verify-persistence's strict verbatim-repetition logic is
    // untouched -- the malformed turn never sets lastRunCommand, since no
    // real run action was ever parsed).
    malformedRecovery: [
      '{"action":"run","command":"npm run test:normalize',
      runAction("npm run test:normalize-id"),
      patchToolAction("src/utils/normalize-id.ts", [
        { search: "  return raw.toLowerCase();", replace: "  return raw.trim().toLowerCase();" },
      ]),
      runAction("npm run test:normalize-id"),
      "Fixed normalizeId to trim whitespace first; the check now passes.",
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete run attempt; after the rejection, the reference's own red/fix/green/answer sequence completes within the 5-turn budget",
    malformedNegative: [
      '{"action":"run","command":"npm run test:normalize',
      '{"action":"run","command":"npm run test:normalize',
      '{"action":"run","command":"npm run test:normalize',
      '{"action":"run","command":"npm run test:normalize',
      '{"action":"run","command":"npm run test:normalize',
    ],
    malformedNegativeNote: "emits the same truncated run attempt every turn until the budget is exhausted -- the check never actually runs or gets fixed",
  },
};

/**
 * Content-derived parity fixture for `truncation-recovery-001`: the case's
 * fixture content is a large generated filler file (numberedFillerFile in
 * cases.ts), so rather than re-deriving/duplicating that generator here (and
 * risking drift), the alternate/negative are built directly from the real
 * case's own `initialFiles`/`expectedFinalFiles` — guaranteed byte-exact by
 * construction, never hand-copied.
 */
function truncationRecoveryAnswers(benchmarkCase: StatefulToolReliabilityCase): {
  alternate: string[];
  negative: string[];
  alternateNote: string;
  negativeNote: string;
  batchedAlternate: string[];
  batchedAlternateNote: string;
  malformedRecovery: string[];
  malformedRecoveryNote: string;
  malformedNegative: string[];
  malformedNegativeNote: string;
} {
  const [sourcePath, sourceContent] = Object.entries(benchmarkCase.initialFiles)[0]!;
  const targetPath = Object.keys(benchmarkCase.expectedFinalFiles ?? {})[0]!;
  const third = Math.ceil(sourceContent.length / 3);
  const half = Math.ceil(sourceContent.length / 2);
  return {
    alternate: [
      readRangeAction(sourcePath, 1, sourceContent.split("\n").length),
      // A genuinely different chunk plan: three roughly-equal thirds instead
      // of the reference's two chunks, still reconstructing the exact
      // expected content (plain string slicing always reconstructs exactly
      // on concatenation, regardless of where the cuts fall).
      appendToolAction(targetPath, sourceContent.slice(0, third), true),
      appendToolAction(targetPath, sourceContent.slice(third, third * 2), false),
      appendToolAction(targetPath, sourceContent.slice(third * 2), false),
      "Copied the source into the new file across three write chunks.",
    ],
    negative: [
      // The mined shape: re-emits the WHOLE oversized file a second time
      // instead of switching to a chunked strategy after the first
      // truncation.
      readRangeAction(sourcePath, 1, sourceContent.split("\n").length),
      appendToolAction(targetPath, sourceContent, true),
      appendToolAction(targetPath, sourceContent, true),
      "Wrote the new file.",
    ],
    alternateNote:
      "splits the write into three roughly-equal chunks instead of the reference's two, with different chunk boundaries",
    negativeNote:
      "re-emits the entire oversized file a second time instead of switching to a chunked strategy after the first truncation",
    // Batches the read with the FIRST write chunk into one spark-style
    // response (the second chunk stays in its own turn — batching BOTH
    // chunks together would push their COMBINED payload over the cap, which
    // is the correct "whole response" cap behavior, not a bug to route
    // around). Half/half split (not thirds) — each half individually still
    // fits under the cap with a small margin.
    batchedAlternate: [
      readRangeAction(sourcePath, 1, sourceContent.split("\n").length) +
        appendToolAction(targetPath, sourceContent.slice(0, half), true) +
        "Reading the source and starting the copy in one step.",
      appendToolAction(targetPath, sourceContent.slice(half), false) + "Appending the remaining content.",
    ],
    batchedAlternateNote:
      "batches the read with the first write chunk into one spark-style response instead of two separate turns, using a half/half split",
    // Cheap here too: maxTurns=5, reference=4, one turn of slack. A
    // truncated append attempt at turn 1 (rejected, nothing written, no
    // truncatedPathHits recorded -- the malformed-detection branch returns
    // before any truncation-cap accounting runs), then a read plus a clean
    // half/half chunked write (each half individually fits under the cap).
    malformedRecovery: [
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
      readRangeAction(sourcePath, 1, sourceContent.split("\n").length),
      appendToolAction(targetPath, sourceContent.slice(0, half), true),
      appendToolAction(targetPath, sourceContent.slice(half), false),
    ],
    malformedRecoveryNote:
      "turn 1 is a truncated/incomplete append attempt; after the rejection, a read plus a clean half/half chunked write reconstructs the exact expected content within the 5-turn budget",
    malformedNegative: [
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
      `{"action":"append","path":"${targetPath}","content":"export const filler`,
    ],
    malformedNegativeNote:
      "emits the same truncated append attempt every turn until the budget is exhausted -- the target file is never created",
  };
}

function statefulAnswers(benchmarkCase: StatefulToolReliabilityCase): ParityAnswers {
  const reference = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id];
  if (!reference) {
    throw new Error(`no stateful parity fixture for ${benchmarkCase.id}`);
  }
  if (benchmarkCase.id === "toolrel-current-stateful-truncation-recovery-001") {
    const derived = truncationRecoveryAnswers(benchmarkCase);
    return { reference, ...derived };
  }
  const table = STATEFUL_ANSWERS[benchmarkCase.id];
  if (!table) {
    throw new Error(`no stateful parity fixture for ${benchmarkCase.id}`);
  }
  return {
    reference,
    alternate: table.alternate,
    batchedAlternate: table.batchedAlternate,
    batchedAlternateNote: table.batchedAlternateNote,
    batchedNegative: table.batchedNegative,
    batchedNegativeNote: table.batchedNegativeNote,
    malformedRecovery: table.malformedRecovery,
    malformedRecoveryNote: table.malformedRecoveryNote,
    malformedNegative: table.malformedNegative,
    malformedNegativeNote: table.malformedNegativeNote,
    negative: table.negative,
    alternateNote: table.alternateNote,
    negativeNote: table.negativeNote,
  };
}

// --- main loop: every current case gets the same reference/alternate/
// negative treatment, plus the stateful-specific batched/malformed variants
// (every remaining case is stateful, so these run unconditionally now). ---

const coveredIds = new Set<string>();
const categoryTallies: Record<string, number> = {};

for (const benchmarkCase of TOOL_RELIABILITY_CASES) {
  coveredIds.add(benchmarkCase.id);
  categoryTallies[benchmarkCase.category] = (categoryTallies[benchmarkCase.category] ?? 0) + 1;

  let answers: ParityAnswers;
  try {
    answers = statefulAnswers(benchmarkCase);
  } catch (error) {
    check(`${benchmarkCase.id} has a parity fixture`, false, error instanceof Error ? error.message : String(error));
    continue;
  }

  const reference = evaluateCase(benchmarkCase, answers.reference);
  const alternate = evaluateCase(benchmarkCase, answers.alternate);
  const negative = evaluateCase(benchmarkCase, answers.negative);

  check(`${benchmarkCase.id} [${benchmarkCase.category}] reference answer passes`, reference.passed, {
    attempts: answers.reference,
    metrics: reference.metrics,
    events: reference.events,
  });

  const alternateIsDistinct = JSON.stringify(answers.alternate) !== JSON.stringify(answers.reference);
  check(
    `${benchmarkCase.id} alternate answer is genuinely different text from the reference`,
    alternateIsDistinct,
    { reference: answers.reference, alternate: answers.alternate }
  );
  check(`${benchmarkCase.id} genuine alternate passes (${answers.alternateNote})`, alternate.passed, {
    attempts: answers.alternate,
    metrics: alternate.metrics,
    events: alternate.events,
  });

  const negativeIsDistinct = JSON.stringify(answers.negative) !== JSON.stringify(answers.reference);
  check(`${benchmarkCase.id} negative control is distinct from the reference`, negativeIsDistinct, {
    reference: answers.reference,
    negative: answers.negative,
  });
  check(`${benchmarkCase.id} negative control fails (${answers.negativeNote})`, !negative.passed, {
    attempts: answers.negative,
    metrics: negative.metrics,
    events: negative.events,
  });

  // --- Batched-response variants (2026-07-22 live-gate fix): a stateful
  // case's parity guard must PASS a spark-style batched-but-disciplined
  // transcript, and (for redundant-read kinds) must FAIL a batched-
  // duplicate-within-one-response negative control. A negative control that
  // now passes under batch semantics is a BLOCKED finding, never something
  // to weaken the env to paper over. ---

  if (answers.batchedAlternate) {
    const batchedAlternate = evaluateCase(benchmarkCase, answers.batchedAlternate);
    const batchedAlternateIsDistinct =
      JSON.stringify(answers.batchedAlternate) !== JSON.stringify(answers.reference) &&
      JSON.stringify(answers.batchedAlternate) !== JSON.stringify(answers.alternate);
    check(
      `${benchmarkCase.id} batched alternate is genuinely different text from reference and alternate`,
      batchedAlternateIsDistinct,
      { reference: answers.reference, alternate: answers.alternate, batchedAlternate: answers.batchedAlternate }
    );
    check(
      `${benchmarkCase.id} batched (spark-style) alternate passes (${answers.batchedAlternateNote})`,
      batchedAlternate.passed,
      { attempts: answers.batchedAlternate, metrics: batchedAlternate.metrics, events: batchedAlternate.events }
    );
  } else {
    check(`${benchmarkCase.id} has a batched-alternate parity fixture`, false, benchmarkCase.id);
  }

  if (benchmarkCase.kind === "redundant-read") {
    if (answers.batchedNegative) {
      const batchedNegative = evaluateCase(benchmarkCase, answers.batchedNegative);
      const batchedNegativeIsDistinct =
        JSON.stringify(answers.batchedNegative) !== JSON.stringify(answers.reference);
      check(
        `${benchmarkCase.id} batched negative control is distinct from the reference`,
        batchedNegativeIsDistinct,
        { reference: answers.reference, batchedNegative: answers.batchedNegative }
      );
      check(
        `${benchmarkCase.id} batched negative control fails (${answers.batchedNegativeNote})`,
        !batchedNegative.passed,
        { attempts: answers.batchedNegative, metrics: batchedNegative.metrics, events: batchedNegative.events }
      );
    } else {
      check(`${benchmarkCase.id} has a batched-negative parity fixture (redundant-read kind)`, false, benchmarkCase.id);
    }
  }

  // --- Malformed-action rejection-retry (2026-07-22 gate-2 fix): optional
  // per case (mandatory for stale-patch-001 -- the case the void was found
  // on). Turn 1 is a genuinely incomplete/malformed JSON action attempt;
  // the env must reject-and-retry (not void the case as a premature final
  // answer), and the rest of the transcript recovers correctly. A negative
  // that stays malformed until maxTurns must FAIL (the file/answer state
  // never changes from initial). ---
  if (answers.malformedRecovery) {
    const malformedRecovery = evaluateCase(benchmarkCase, answers.malformedRecovery);
    check(
      `${benchmarkCase.id} malformed-then-recover transcript passes (${answers.malformedRecoveryNote})`,
      malformedRecovery.passed,
      { attempts: answers.malformedRecovery, metrics: malformedRecovery.metrics, events: malformedRecovery.events }
    );
  }
  if (answers.malformedNegative) {
    const malformedNegative = evaluateCase(benchmarkCase, answers.malformedNegative);
    check(
      `${benchmarkCase.id} malformed-every-turn negative control fails (${answers.malformedNegativeNote})`,
      !malformedNegative.passed,
      { attempts: answers.malformedNegative, metrics: malformedNegative.metrics, events: malformedNegative.events }
    );
  }
  if (benchmarkCase.id === "toolrel-current-stateful-stale-patch-001") {
    check(
      "toolrel-current-stateful-stale-patch-001 has a malformed-then-recover parity fixture (mandatory -- this is the case the 2026-07-22 gate-2 void was found on)",
      Boolean(answers.malformedRecovery) && Boolean(answers.malformedNegative),
      { hasRecovery: Boolean(answers.malformedRecovery), hasNegative: Boolean(answers.malformedNegative) }
    );
  }
}

check(
  "parity guard covers every current ToolReliability case",
  coveredIds.size === TOOL_RELIABILITY_CASES.length,
  { covered: coveredIds.size, total: TOOL_RELIABILITY_CASES.length }
);
console.log(`Category coverage: ${JSON.stringify(categoryTallies)}`);

// --- Patch comparator cross-check: an INDEPENDENT, from-scratch
// normalization (manual char-scan trim + explicit trailing-blank-line
// collapse, deliberately NOT the lib's regex approach) must agree exactly
// with the lib's normalizePatchContent on every stateful case's REAL fixture
// content (initialFiles / expectedFinalFiles / scheduledEvents.newContent --
// the exact content stateful-env.ts's verdictStalePatch/verdictWriteScope/
// verdictTruncationRecovery compare through this SAME comparator) plus a
// battery of synthetic edge cases. ---

function independentNormalizePatchContent(content: string): string {
  const lines = content.split("\n").map((line) => {
    let end = line.length;
    while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r")) {
      end -= 1;
    }
    return line.slice(0, end);
  });
  let lastContentIndex = lines.length - 1;
  while (lastContentIndex >= 0 && lines[lastContentIndex] === "") {
    lastContentIndex -= 1;
  }
  return `${lines.slice(0, lastContentIndex + 1).join("\n")}\n`;
}

const syntheticNormalizationFixtures = [
  "a\nb\n",
  "a\nb",
  "a\nb\n\n\n",
  "a  \nb\t\nc \n",
  "a\r\nb\r\n",
  "",
  "\n\n\n",
  "line1\n\nline3   \n\n\n",
  "no newline at all",
  "trailing spaces at eof   ",
  "  \n\t\n   \n",
];
for (const fixture of syntheticNormalizationFixtures) {
  const libResult = normalizePatchContent(fixture);
  const independentResult = independentNormalizePatchContent(fixture);
  check(
    `independent normalization agrees with the lib on synthetic fixture ${JSON.stringify(fixture)}`,
    libResult === independentResult,
    { libResult, independentResult }
  );
}

const statefulContentSamples: Array<{ id: string; content: string }> = [];
for (const benchmarkCase of TOOL_RELIABILITY_CASES) {
  for (const [path, content] of Object.entries(benchmarkCase.initialFiles)) {
    statefulContentSamples.push({ id: `${benchmarkCase.id}:initialFiles:${path}`, content });
  }
  for (const [path, expected] of Object.entries(benchmarkCase.expectedFinalFiles ?? {})) {
    statefulContentSamples.push({ id: `${benchmarkCase.id}:expectedFinalFiles:${path}`, content: expected.content });
    (expected.acceptable ?? []).forEach((variant, index) => {
      statefulContentSamples.push({
        id: `${benchmarkCase.id}:expectedFinalFiles:${path}:acceptable:${index}`,
        content: variant,
      });
    });
  }
  for (const scheduled of benchmarkCase.scheduledEvents ?? []) {
    statefulContentSamples.push({
      id: `${benchmarkCase.id}:scheduledEvents:${scheduled.path}:turn${scheduled.afterModelTurn}`,
      content: scheduled.newContent,
    });
  }
}
check(
  "patch comparator cross-check covers real stateful fixture content",
  statefulContentSamples.length > 0,
  statefulContentSamples.length
);
for (const sample of statefulContentSamples) {
  const libResult = normalizePatchContent(sample.content);
  const independentResult = independentNormalizePatchContent(sample.content);
  check(
    `${sample.id} normalization comparator agrees`,
    libResult === independentResult,
    { libResult: libResult.slice(0, 80), independentResult: independentResult.slice(0, 80) }
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
