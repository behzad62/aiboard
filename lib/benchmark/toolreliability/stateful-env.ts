/**
 * Deterministic scripted-environment stepper for the `stateful` ToolReliability
 * category (Stateful ToolReliability charter, PR A). Mined from real Build-mode
 * failures (see docs/superpowers/specs/2026-07-21-stateful-toolreliability-design.md):
 * even frontier models fail STATE DISCIPLINE across turns (duplicate reads,
 * patching stale content, dead MCP refs, out-of-scope writes, oversized
 * single-response writes, and re-running a failing check with no fix).
 *
 * `createStatefulEnv(case)` returns a stepper that is a PURE function of
 * (case, outputs-so-far): no Date.now/Math.random anywhere in this file, so
 * certified scoring, trace replay, and the probe all reproduce the identical
 * verdict from a recorded `outputs[caseId]` string[] — see runner.ts's
 * stateful branch, which replays exactly this way.
 *
 * REUSE REAL MACHINERY, never a parallel reimplementation:
 *   - model turns are parsed with the real Build action parser,
 *     `parseArchitectAction` (lib/orchestrator/build.ts) — the same parser
 *     `scripts/test-parse-action.mts` exercises.
 *   - redundant reads are flagged by the real `createToolCallTracker` /
 *     `isRedundantToolCall` (build.ts ~4865/~4983) — interval-coverage based,
 *     so nudging startLine/lineCount cannot dodge the guard.
 *   - patches apply via the real `applyEditOps` (lib/artifacts/extract.ts).
 *   - final-content comparison reuses the real `normalizePatchContent`
 *     (./runner.ts) — the SAME comparator the `patch` category uses.
 *   - rejection/error texts mirror the real engine's own strings (see the
 *     per-function comments below for exactly which real message is mirrored
 *     and why: the patch "did NOT match the current file content" message,
 *     the file_writer "WRITE REJECTED" message, the "duplicate tool request
 *     (already delivered)" redundancy-skip reason, and the "Output was cut
 *     off mid-block" truncation message — all copied verbatim from their
 *     real call sites so a case never becomes a divergent second copy of the
 *     mechanism it is supposed to be testing).
 */
import { applyEditOps } from "@/lib/artifacts/extract";
import {
  createToolCallTracker,
  isRedundantToolCall,
  parseArchitectAction,
  recordToolCall,
  type ArchitectAction,
} from "@/lib/orchestrator/build";
import { normalizePatchContent } from "./runner";
import type { StatefulToolReliabilityCase } from "./types";

export interface StatefulEnvStepResult {
  /** The rendered tool result the model would see appended to its transcript. */
  renderedResult: string;
  /** True once the case is finished (final free-text answer or budget exhausted). */
  done: boolean;
}

export interface StatefulEnvVerdict {
  passed: boolean;
  reason: string;
  kindChecks: Record<string, boolean>;
}

export interface StatefulEnv {
  step(modelOutput: string): StatefulEnvStepResult;
  verdict(): StatefulEnvVerdict;
}

const REAL_PATCH_MISMATCH_MESSAGE = (
  path: string,
  applied: number,
  failed: number
): string =>
  // Mirrors lib/client/legacy-build-engine.benchmark.ts's applyPatchAction
  // rejection text verbatim (same phrase used at every one of its call
  // sites): "{failed} patch op(s) to {path} did NOT match the current file
  // content and were skipped ({applied} applied)."
  `${failed} patch op(s) to ${path} did NOT match the current file content and were skipped (${applied} applied).`;

const REAL_WRITE_REJECTED_MESSAGE = (
  caseId: string,
  path: string,
  scope: string[]
): string =>
  // Mirrors rejectWorkerWriteOutsideTaskScope's real "WRITE REJECTED" text
  // (lib/client/legacy-build-engine.benchmark.ts) verbatim in shape.
  `WRITE REJECTED: ${caseId} attempted to write ${path}, but this task may only write ${
    scope.length > 0 ? scope.join(", ") : "its declared output files"
  }. Evidence and browser-acceptance notes belong in the worker response, not in ad hoc result files.`;

const REAL_TRUNCATED_OUTPUT_MESSAGE = (path: string): string =>
  // Mirrors the real "truncated_output" build-problem text verbatim
  // (lib/client/legacy-build-engine.benchmark.ts).
  `Output was cut off mid-block for ${path} — nothing from the truncated block was written. This file is too large for a single response; use read_range/search plus patch for existing files, or append chunks for large/missing files.`;

const REAL_REDUNDANT_SKIP_REASON =
  // Mirrors the real skip reason recorded at every isRedundantToolCall call
  // site in lib/client/legacy-build-engine.benchmark.ts: "duplicate tool
  // request (already delivered)".
  "duplicate tool request (already delivered)";

const REAL_STALE_REF_MESSAGE =
  // Mirrors Playwright's own real error text for an interaction targeting a
  // ref that no longer resolves against the current page snapshot.
  "Ref not found in the current page snapshot. Take a new snapshot before interacting again.";

function renderReadRange(
  path: string,
  content: string,
  startLine: number,
  lineCount: number
): { rendered: string; deliveredStart: number; deliveredEnd: number } {
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.min(startLine, total));
  const end = Math.max(start, Math.min(start + Math.max(1, lineCount) - 1, total));
  const body = lines.slice(start - 1, end).join("\n");
  return {
    // Header format matches the real engine's own read_range render — the
    // "lines N-M of T" pattern that lib/orchestrator/build-tool-scheduler.ts's
    // read-loop guard parses back out of a rendered result.
    rendered: `--- ${path} lines ${start}-${end} of ${total} ---\n${body}`,
    deliveredStart: start,
    deliveredEnd: end,
  };
}

interface EnvState {
  files: Map<string, string>;
  turn: number;
  done: boolean;
  tracker: ReturnType<typeof createToolCallTracker>;
  firedEvents: Set<number>;
  finalAnswerText: string | null;
  // redundant-read
  anyRedundantRead: boolean;
  targetRangesCovered: Array<{ start: number; end: number }>;
  // stale-patch / write-scope / truncation-recovery
  hadRejectedPatch: boolean;
  // write-scope (strict)
  wroteOutsideScope: boolean;
  // truncation-recovery
  truncatedPathHits: Map<string, number>;
  // stale-ref
  refGeneration: number;
  requiredInteractionLanded: boolean;
  staleRefHits: number;
  // verify-persistence
  lastWasVerbatimRepeat: boolean;
  verbatimRepeatViolation: boolean;
  lastRunWasGreen: boolean;
  editedSinceLastRun: boolean;
  lastRunCommand: string | null;
}

function applyScheduledEvents(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  upcomingTurn: number
): string[] {
  const announcements: string[] = [];
  for (const event of c.scheduledEvents ?? []) {
    if (event.afterModelTurn === upcomingTurn && !state.firedEvents.has(upcomingTurn)) {
      state.firedEvents.add(upcomingTurn);
      state.files.set(event.path, event.newContent);
      announcements.push(`[ENV] ${event.announce}`);
    }
  }
  return announcements;
}

function stepRedundantRead(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  if (action.action !== "read_range") {
    return {
      renderedResult: "Action ignored: this task only reads and reports; use read_range.",
      done: false,
    };
  }
  const path = action.path;
  const content = state.files.get(path);
  if (content == null) {
    return { renderedResult: `read_range failed: unknown path ${path}`, done: false };
  }
  if (isRedundantToolCall(state.tracker, action)) {
    state.anyRedundantRead = true;
    return {
      renderedResult: `TOOL CALL SKIPPED: ${REAL_REDUNDANT_SKIP_REASON}. No new content was returned.`,
      done: false,
    };
  }
  const { rendered, deliveredStart, deliveredEnd } = renderReadRange(
    path,
    content,
    action.startLine,
    action.lineCount
  );
  recordToolCall(state.tracker, action, { startLine: deliveredStart, endLine: deliveredEnd });
  state.targetRangesCovered.push({ start: deliveredStart, end: deliveredEnd });
  return { renderedResult: rendered, done: false };
}

function verdictRedundantRead(
  c: StatefulToolReliabilityCase,
  state: EnvState
): StatefulEnvVerdict {
  const mustInclude = c.groundTruthAnswer?.mustInclude ?? [];
  const answer = (state.finalAnswerText ?? "").toLowerCase();
  const answeredCorrectly =
    state.finalAnswerText != null &&
    mustInclude.every((needle) => answer.includes(needle.toLowerCase()));
  // "the target range was actually read" — reconstructed from the case's own
  // groundTruthAnswer via the recorded ranges is not directly knowable here
  // (the env does not see the case's private target line), so this checks
  // that AT LEAST ONE non-redundant read happened — combined with the
  // no-redundancy gate and the ground-truth substring check, a model cannot
  // pass by inaction or by guessing without ever reading.
  const readSomething = state.targetRangesCovered.length > 0;
  const kindChecks = {
    noRedundantReads: !state.anyRedundantRead,
    targetRead: readSomething,
    groundTruthReported: answeredCorrectly,
  };
  const passed = kindChecks.noRedundantReads && kindChecks.targetRead && kindChecks.groundTruthReported;
  const reason = passed
    ? "Passed: no redundant reads, and the final answer reported the ground-truth value."
    : !kindChecks.noRedundantReads
      ? "Failed: at least one redundant read was flagged by the tracker (strict on redundancy)."
      : !kindChecks.targetRead
        ? "Failed: no read ever occurred."
        : "Failed: the final answer did not state the ground-truth value.";
  return { passed, reason, kindChecks };
}

function stepStalePatch(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  if (action.action === "read_range" || action.action === "read") {
    const path = action.action === "read_range" ? action.path : action.paths[0];
    const content = path ? state.files.get(path) : undefined;
    if (!path || content == null) {
      return { renderedResult: `read failed: unknown path ${path ?? ""}`, done: false };
    }
    if (action.action === "read_range") {
      const { rendered } = renderReadRange(path, content, action.startLine, action.lineCount);
      return { renderedResult: rendered, done: false };
    }
    return { renderedResult: `--- ${path} ---\n${content}`, done: false };
  }
  if (action.action === "patch") {
    const path = action.path;
    const current = state.files.get(path);
    if (current == null) {
      return { renderedResult: `Patch to ${path} skipped — the file doesn't exist.`, done: false };
    }
    const applied = applyEditOps(current, action.ops);
    if (applied.failed > 0) {
      state.hadRejectedPatch = true;
      return {
        renderedResult: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed),
        done: false,
      };
    }
    state.files.set(path, applied.content);
    return {
      renderedResult: `Patch ${path}: ${applied.applied} applied, ${applied.failed} failed`,
      done: false,
    };
  }
  return { renderedResult: "Action ignored: this task expects read/patch actions.", done: false };
}

function verdictStalePatch(
  c: StatefulToolReliabilityCase,
  state: EnvState
): StatefulEnvVerdict {
  const results = Object.entries(c.expectedFinalFiles ?? {}).map(([path, expected]) => {
    const actual = state.files.get(path) ?? "";
    const accepted = expected.acceptable ?? [expected.content];
    const normalizedActual = normalizePatchContent(actual);
    return accepted.some((variant) => normalizePatchContent(variant) === normalizedActual);
  });
  const passed = results.length > 0 && results.every(Boolean);
  const kindChecks = { finalContentMatchesEvolvedExpectation: passed };
  const reason = passed
    ? "Passed: final file content semantically matches the expected evolved-file content."
    : "Failed: final file content does not match the expected evolved-file content (patch against pre-change content never recovered).";
  return { passed, reason, kindChecks };
}

function stepStaleRef(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  if (action.action !== "tool" || action.server.toLowerCase() !== "playwright") {
    return { renderedResult: "Action ignored: this task expects a playwright tool action.", done: false };
  }
  const generations = c.snapshotPlan?.generations ?? [];
  const current = generations[state.refGeneration];
  const requestedRef = (action.args?.target as string | undefined) ?? "";
  if (!current || !(requestedRef in current.refs)) {
    state.staleRefHits += 1;
    return { renderedResult: REAL_STALE_REF_MESSAGE, done: false };
  }
  // A valid current-generation ref: the interaction lands, and (mirroring a
  // page-changing action) the snapshot rotates to the next generation.
  const landedRequired =
    c.snapshotPlan?.requiredInteraction.element === current.refs[requestedRef];
  if (landedRequired) state.requiredInteractionLanded = true;
  if (state.refGeneration < generations.length - 1) state.refGeneration += 1;
  return {
    renderedResult: `Clicked ${current.refs[requestedRef]} (ref ${requestedRef}). Page state updated — take a new snapshot before your next interaction.`,
    done: false,
  };
}

function verdictStaleRef(state: EnvState): StatefulEnvVerdict {
  const kindChecks = {
    requiredInteractionLanded: state.requiredInteractionLanded,
    withinRecoveryBudget: state.staleRefHits <= 1,
  };
  const passed = kindChecks.requiredInteractionLanded && kindChecks.withinRecoveryBudget;
  const reason = passed
    ? "Passed: the required interaction landed on a current-generation ref within budget."
    : !kindChecks.withinRecoveryBudget
      ? "Failed: more than one interaction targeted a stale (dead) ref."
      : "Failed: the required interaction never landed.";
  return { passed, reason, kindChecks };
}

function stepWriteScope(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  const scope = c.writeScope ?? [];
  if (action.action === "patch" || action.action === "append") {
    const path = action.path;
    if (!scope.includes(path)) {
      state.wroteOutsideScope = true;
      return { renderedResult: REAL_WRITE_REJECTED_MESSAGE(c.id, path, scope), done: false };
    }
    if (action.action === "patch") {
      const current = state.files.get(path) ?? "";
      const applied = applyEditOps(current, action.ops);
      if (applied.failed > 0) {
        return {
          renderedResult: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed),
          done: false,
        };
      }
      state.files.set(path, applied.content);
      return { renderedResult: `Patch ${path}: ${applied.applied} applied, 0 failed`, done: false };
    }
    const existing = action.reset ? "" : state.files.get(path) ?? "";
    state.files.set(path, existing + action.content);
    return { renderedResult: `Append ${path}: +${action.content.length} bytes`, done: false };
  }
  if (action.action === "read_range" || action.action === "read") {
    const path = action.action === "read_range" ? action.path : action.paths[0];
    const content = path ? state.files.get(path) : undefined;
    if (!path || content == null) return { renderedResult: `read failed: unknown path ${path ?? ""}`, done: false };
    if (action.action === "read_range") {
      return { renderedResult: renderReadRange(path, content, action.startLine, action.lineCount).rendered, done: false };
    }
    return { renderedResult: `--- ${path} ---\n${content}`, done: false };
  }
  return { renderedResult: "Action ignored: this task expects read/patch/append actions.", done: false };
}

function verdictWriteScope(
  c: StatefulToolReliabilityCase,
  state: EnvState
): StatefulEnvVerdict {
  const contentOk = Object.entries(c.expectedFinalFiles ?? {}).every(([path, expected]) => {
    const actual = state.files.get(path) ?? "";
    const accepted = expected.acceptable ?? [expected.content];
    const normalizedActual = normalizePatchContent(actual);
    return accepted.some((variant) => normalizePatchContent(variant) === normalizedActual);
  });
  const kindChecks = {
    stayedInScope: !state.wroteOutsideScope,
    inScopeFileCorrect: contentOk,
  };
  // ✗ strict — any out-of-scope write fails the case outright, regardless of
  // whether the in-scope file also landed correctly.
  const passed = kindChecks.stayedInScope && kindChecks.inScopeFileCorrect;
  const reason = !kindChecks.stayedInScope
    ? "Failed: a write landed outside the declared output scope (strict violation)."
    : kindChecks.inScopeFileCorrect
      ? "Passed: stayed in scope and the in-scope file matches the expected content."
      : "Failed: stayed in scope, but the in-scope file does not match the expected content.";
  return { passed, reason, kindChecks };
}

function stepTruncationRecovery(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  const cap = c.truncationCharCap ?? Number.POSITIVE_INFINITY;
  if (action.action === "append") {
    const path = action.path;
    if (action.content.length > cap) {
      const hits = (state.truncatedPathHits.get(path) ?? 0) + 1;
      state.truncatedPathHits.set(path, hits);
      return { renderedResult: REAL_TRUNCATED_OUTPUT_MESSAGE(path), done: false };
    }
    const existing = action.reset ? "" : state.files.get(path) ?? "";
    state.files.set(path, existing + action.content);
    return { renderedResult: `Append ${path}: +${action.content.length} bytes${action.reset ? " (reset first)" : ""}`, done: false };
  }
  if (action.action === "patch") {
    const path = action.path;
    const current = state.files.get(path) ?? "";
    const applied = applyEditOps(current, action.ops);
    if (applied.failed > 0) {
      return { renderedResult: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed), done: false };
    }
    state.files.set(path, applied.content);
    return { renderedResult: `Patch ${path}: ${applied.applied} applied, 0 failed`, done: false };
  }
  if (action.action === "read_range" || action.action === "read") {
    const path = action.action === "read_range" ? action.path : action.paths[0];
    const content = path ? state.files.get(path) : undefined;
    if (!path || content == null) return { renderedResult: `read failed: unknown path ${path ?? ""}`, done: false };
    if (action.action === "read_range") {
      return { renderedResult: renderReadRange(path, content, action.startLine, action.lineCount).rendered, done: false };
    }
    return { renderedResult: `--- ${path} ---\n${content}`, done: false };
  }
  return { renderedResult: "Action ignored: this task expects read/patch/append actions.", done: false };
}

function verdictTruncationRecovery(
  c: StatefulToolReliabilityCase,
  state: EnvState
): StatefulEnvVerdict {
  const repeatedOverCap = [...state.truncatedPathHits.values()].some((hits) => hits >= 2);
  const contentOk = Object.entries(c.expectedFinalFiles ?? {}).every(([path, expected]) => {
    const actual = state.files.get(path) ?? "";
    const accepted = expected.acceptable ?? [expected.content];
    const normalizedActual = normalizePatchContent(actual);
    return accepted.some((variant) => normalizePatchContent(variant) === normalizedActual);
  });
  const kindChecks = {
    noRepeatedOverCapResponse: !repeatedOverCap,
    finalContentComplete: contentOk,
  };
  const passed = kindChecks.noRepeatedOverCapResponse && kindChecks.finalContentComplete;
  const reason = !kindChecks.noRepeatedOverCapResponse
    ? "Failed: a second over-cap response was emitted after the first was truncated (strict on repetition)."
    : kindChecks.finalContentComplete
      ? "Passed: switched to a chunked strategy and the final content is complete."
      : "Failed: the final content is incomplete or incorrect.";
  return { passed, reason, kindChecks };
}

function stepVerifyPersistence(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction | null,
  rawOutput: string
): StatefulEnvStepResult {
  if (!action) {
    state.finalAnswerText = rawOutput;
    return { renderedResult: "", done: true };
  }
  const plan = c.verifyPlan;
  if (action.action === "patch" || action.action === "append") {
    const path = action.path;
    if (action.action === "patch") {
      const current = state.files.get(path) ?? "";
      const applied = applyEditOps(current, action.ops);
      if (applied.failed > 0) {
        return { renderedResult: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed), done: false };
      }
      state.files.set(path, applied.content);
    } else {
      const existing = action.reset ? "" : state.files.get(path) ?? "";
      state.files.set(path, existing + action.content);
    }
    state.editedSinceLastRun = true;
    state.lastRunCommand = null;
    return { renderedResult: `Edit applied to ${path}.`, done: false };
  }
  if (action.action === "run" && plan) {
    const isVerbatimRepeat =
      state.lastRunCommand === action.command.trim() && !state.editedSinceLastRun;
    if (isVerbatimRepeat) state.verbatimRepeatViolation = true;
    const holds =
      state.files.get(plan.fixPredicate.path) != null &&
      plan.fixPredicate.mustInclude.every((needle) =>
        (state.files.get(plan.fixPredicate.path) ?? "").includes(needle)
      );
    state.lastRunWasGreen = holds;
    state.lastRunCommand = action.command.trim();
    state.editedSinceLastRun = false;
    return { renderedResult: holds ? plan.greenOutput : plan.redOutput, done: false };
  }
  if (action.action === "read_range" || action.action === "read") {
    const path = action.action === "read_range" ? action.path : action.paths[0];
    const content = path ? state.files.get(path) : undefined;
    if (!path || content == null) return { renderedResult: `read failed: unknown path ${path ?? ""}`, done: false };
    if (action.action === "read_range") {
      return { renderedResult: renderReadRange(path, content, action.startLine, action.lineCount).rendered, done: false };
    }
    return { renderedResult: `--- ${path} ---\n${content}`, done: false };
  }
  return { renderedResult: "Action ignored: this task expects read/patch/append/run actions.", done: false };
}

function verdictVerifyPersistence(state: EnvState): StatefulEnvVerdict {
  const kindChecks = {
    noVerbatimRepetition: !state.verbatimRepeatViolation,
    endedGreen: state.lastRunWasGreen,
  };
  const passed = kindChecks.noVerbatimRepetition && kindChecks.endedGreen;
  const reason = !kindChecks.noVerbatimRepetition
    ? "Failed: the identical verification command was re-run with zero intervening fix (strict on verbatim repetition)."
    : kindChecks.endedGreen
      ? "Passed: the flagged file was edited before re-running, and the check ended green."
      : "Failed: the check never ended green.";
  return { passed, reason, kindChecks };
}

export function createStatefulEnv(c: StatefulToolReliabilityCase): StatefulEnv {
  const state: EnvState = {
    files: new Map(Object.entries(c.initialFiles)),
    turn: 0,
    done: false,
    tracker: createToolCallTracker(),
    firedEvents: new Set(),
    finalAnswerText: null,
    anyRedundantRead: false,
    targetRangesCovered: [],
    hadRejectedPatch: false,
    wroteOutsideScope: false,
    truncatedPathHits: new Map(),
    refGeneration: 0,
    requiredInteractionLanded: false,
    staleRefHits: 0,
    lastWasVerbatimRepeat: false,
    verbatimRepeatViolation: false,
    lastRunWasGreen: false,
    editedSinceLastRun: false,
    lastRunCommand: null,
  };

  return {
    step(modelOutput: string): StatefulEnvStepResult {
      if (state.done) return { renderedResult: "", done: true };
      state.turn += 1;
      const announcements = applyScheduledEvents(c, state, state.turn);
      const action = parseArchitectAction(modelOutput ?? "");

      let result: StatefulEnvStepResult;
      switch (c.kind) {
        case "redundant-read":
          result = stepRedundantRead(c, state, action, modelOutput);
          break;
        case "stale-patch":
          result = stepStalePatch(c, state, action, modelOutput);
          break;
        case "stale-ref":
          result = stepStaleRef(c, state, action, modelOutput);
          break;
        case "write-scope":
          result = stepWriteScope(c, state, action, modelOutput);
          break;
        case "truncation-recovery":
          result = stepTruncationRecovery(c, state, action, modelOutput);
          break;
        case "verify-persistence":
          result = stepVerifyPersistence(c, state, action, modelOutput);
          break;
      }

      const forcedDone = !result.done && state.turn >= c.maxTurns;
      const finalDone = result.done || forcedDone;
      if (finalDone) state.done = true;

      const rendered =
        announcements.length > 0
          ? [...announcements, result.renderedResult].filter(Boolean).join("\n")
          : result.renderedResult;
      return { renderedResult: rendered, done: finalDone };
    },
    verdict(): StatefulEnvVerdict {
      switch (c.kind) {
        case "redundant-read":
          return verdictRedundantRead(c, state);
        case "stale-patch":
          return verdictStalePatch(c, state);
        case "stale-ref":
          return verdictStaleRef(state);
        case "write-scope":
          return verdictWriteScope(c, state);
        case "truncation-recovery":
          return verdictTruncationRecovery(c, state);
        case "verify-persistence":
          return verdictVerifyPersistence(state);
      }
    },
  };
}
