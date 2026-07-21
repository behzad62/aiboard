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
 *   - model turns are parsed with the real BATCH-AWARE Build action inspector,
 *     `inspectStrictToolActionBatchOutput` (lib/orchestrator/build.ts ~4610) —
 *     NOT the single-action `parseArchitectAction`. A 2026-07-22 live gate
 *     (chatgpt:gpt-5.3-codex-spark) proved real models batch several JSON
 *     actions per response (concatenated `{"action":...}{"action":...}`, with
 *     trailing commentary); the single-action parser silently picked ONE
 *     action out of the batch (frequently the wrong one) and discarded the
 *     rest — e.g. a redundant-read case scored "no read ever occurred" despite
 *     six read_range actions in the model's first response, because the
 *     parser latched onto a trailing `run` action instead. See git history for
 *     the mined transcripts and the diagnostic replay that proved this.
 *   - redundant reads are flagged by the real `createToolCallTracker` /
 *     `isRedundantToolCall` (build.ts ~4865/~4983) — interval-coverage based,
 *     so nudging startLine/lineCount cannot dodge the guard. This now also
 *     catches duplicates WITHIN one batched response, not just across turns,
 *     since each action in a batch is recorded into the tracker as it is
 *     processed, in order.
 *   - patches apply via the real `applyEditOps` (lib/artifacts/extract.ts).
 *   - final-content comparison reuses the real `normalizePatchContent`
 *     (./runner.ts) — the SAME comparator the `patch` category uses.
 *   - rejection/error texts mirror the real engine's own strings (see the
 *     per-function comments below for exactly which real message is mirrored
 *     and why: the patch "did NOT match the current file content" message,
 *     the file_writer "WRITE REJECTED" message, the "duplicate tool request
 *     (already delivered)" redundancy-skip reason, the "Output was cut off
 *     mid-block" truncation message, and the "TOOL BATCH RESULT" / Served: /
 *     Skipped: / Results: rendering shape from
 *     `lib/orchestrator/build-tool-scheduler.ts`'s `packToolBatchResult` —
 *     all copied verbatim/in-shape from their real call sites so a case never
 *     becomes a divergent second copy of the mechanism it is supposed to be
 *     testing).
 *
 * TURN PROTOCOL (batch-aware): a response is parsed via
 * `inspectStrictToolActionBatchOutput`. A response containing at least one
 * parsable tool action is a TOOL TURN — every action in the batch is
 * processed, in document order, against the shared env state, and any
 * accompanying free text is commentary, NOT a final answer (mirrors the real
 * engine's principle behind `shouldRequestWorkerFinalOutput`/
 * `hasWorkerFinalEvidenceResponse`: a tool action is an instruction to the
 * engine, never a completion report — only a response with ZERO parsable
 * actions is treated as the model's final answer).
 */
import { applyEditOps } from "@/lib/artifacts/extract";
import {
  createToolCallTracker,
  inspectStrictToolActionBatchOutput,
  isRedundantToolCall,
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

/** One action's outcome within a batch: served (executed, whatever the
 * result) or skipped (a SCHEDULING decision — redundancy, out-of-scope,
 * unknown path, or an action type not applicable to this case's kind). A
 * patch/click that executed but failed to match/land is still SERVED (its
 * rejection message IS the result), matching the real engine's own
 * served-vs-skipped distinction (build-tool-scheduler.ts). */
interface ActionOutcome {
  label: string;
  status: "served" | "skipped";
  result?: string;
  reason?: string;
}

function actionLabel(action: ArchitectAction): string {
  switch (action.action) {
    case "read_range":
      return `read_range ${action.path}:${action.startLine}-${action.startLine + Math.max(1, action.lineCount) - 1}`;
    case "read":
      return `read ${action.paths.join(", ")}`;
    case "patch":
      return `patch ${action.path}`;
    case "append":
      return `append ${action.path}`;
    case "run":
      return `run ${action.command}`;
    case "tool":
      return `tool ${action.server}.${action.tool}`;
    default:
      return action.action;
  }
}

/**
 * Renders a batch of served/skipped action outcomes in the real engine's
 * "TOOL BATCH RESULT" shape — mirrors `packToolBatchResult`
 * (lib/orchestrator/build-tool-scheduler.ts): a Served: list, a Skipped:
 * list (each with its reason), then a Results: section with each served
 * action's full output under a `--- label ---` header. Used uniformly for
 * every tool turn (including single-action turns) so the rendered shape a
 * case's fixtures see is byte-for-byte the same shape the real engine
 * produces, not an ad hoc single-line format.
 */
function renderToolBatchResult(outcomes: ActionOutcome[]): string {
  const served = outcomes.filter((item) => item.status === "served");
  const skipped = outcomes.filter((item) => item.status === "skipped");
  const lines: string[] = ["TOOL BATCH RESULT", "", "Served:"];
  lines.push(...(served.length ? served.map((item) => `- ${item.label}`) : ["- none"]));
  lines.push("", "Skipped:");
  lines.push(
    ...(skipped.length ? skipped.map((item) => `- ${item.label}: ${item.reason}`) : ["- none"])
  );
  lines.push("", "Results:");
  for (const item of served) {
    lines.push(`\n--- ${item.label} ---\n${item.result ?? ""}`);
  }
  return lines.join("\n");
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

/**
 * Scheduled env mutations (stale-patch's concurrent-edit announcements) only
 * fire on TOOL turns, never on what turns out to be the model's terminal
 * free-text turn. This is a fairness fix found by the same 2026-07-22 live
 * gate: firing (and silently overwriting an already-applied fix) on a turn
 * where the model has already said "done" gives the model no chance to ever
 * see the announcement or react to it — the turn loop simply ends. A real
 * concurrent-edit coordination message only matters to a worker who is still
 * taking further actions; one who already finished and reported success has
 * nothing left to read it. Gating on "this turn has a parsable action" keeps
 * the intended difficulty (a model whose FIRST real action lands on/after
 * the scheduled turn still gets the rejection + recovery) while removing the
 * only-possible-if-the-model-never-sees-it unfairness.
 */
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

function processGenericRead(state: EnvState, action: ArchitectAction): ActionOutcome {
  if (action.action === "read_range") {
    const label = actionLabel(action);
    const content = state.files.get(action.path);
    if (content == null) {
      return { label, status: "skipped", reason: `unknown path ${action.path}` };
    }
    const { rendered } = renderReadRange(action.path, content, action.startLine, action.lineCount);
    return { label, status: "served", result: rendered };
  }
  if (action.action === "read") {
    const path = action.paths[0];
    const label = actionLabel(action);
    const content = path ? state.files.get(path) : undefined;
    if (!path || content == null) {
      return { label, status: "skipped", reason: `unknown path ${path ?? ""}` };
    }
    return { label, status: "served", result: `--- ${path} ---\n${content}` };
  }
  return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
}

function processRedundantReadAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  if (action.action !== "read_range") {
    return {
      label: actionLabel(action),
      status: "skipped",
      reason: "this task only reads and reports; use read_range",
    };
  }
  const label = actionLabel(action);
  const content = state.files.get(action.path);
  if (content == null) {
    return { label, status: "skipped", reason: `unknown path ${action.path}` };
  }
  if (isRedundantToolCall(state.tracker, action)) {
    // Strict on redundancy regardless of whether the duplicate came from a
    // separate turn or from within THIS SAME batched response — the tracker
    // is updated per-action as the batch is processed in order, so an
    // overlapping second request later in the same response is caught here
    // exactly like a cross-turn repeat.
    state.anyRedundantRead = true;
    return { label, status: "skipped", reason: REAL_REDUNDANT_SKIP_REASON };
  }
  const { rendered, deliveredStart, deliveredEnd } = renderReadRange(
    action.path,
    content,
    action.startLine,
    action.lineCount
  );
  recordToolCall(state.tracker, action, { startLine: deliveredStart, endLine: deliveredEnd });
  state.targetRangesCovered.push({ start: deliveredStart, end: deliveredEnd });
  return { label, status: "served", result: rendered };
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

function processStalePatchAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  if (action.action === "read_range" || action.action === "read") {
    return processGenericRead(state, action);
  }
  if (action.action === "patch") {
    const path = action.path;
    const label = actionLabel(action);
    const current = state.files.get(path);
    if (current == null) {
      return { label, status: "skipped", reason: "the file doesn't exist" };
    }
    const applied = applyEditOps(current, action.ops);
    if (applied.failed > 0) {
      state.hadRejectedPatch = true;
      return { label, status: "served", result: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed) };
    }
    state.files.set(path, applied.content);
    return { label, status: "served", result: `Patch ${path}: ${applied.applied} applied, ${applied.failed} failed` };
  }
  return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
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

function processStaleRefAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  if (action.action !== "tool" || action.server.toLowerCase() !== "playwright") {
    return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
  }
  const generations = c.snapshotPlan?.generations ?? [];
  const current = generations[state.refGeneration];
  const requestedRef = (action.args?.target as string | undefined) ?? "";
  const label = `${action.tool} ref=${requestedRef}`;
  if (!current || !(requestedRef in current.refs)) {
    state.staleRefHits += 1;
    return { label, status: "served", result: REAL_STALE_REF_MESSAGE };
  }
  // A valid current-generation ref: the interaction lands, and (mirroring a
  // page-changing action) the snapshot rotates to the next generation.
  const landedRequired =
    c.snapshotPlan?.requiredInteraction.element === current.refs[requestedRef];
  if (landedRequired) state.requiredInteractionLanded = true;
  if (state.refGeneration < generations.length - 1) state.refGeneration += 1;
  return {
    label,
    status: "served",
    result: `Clicked ${current.refs[requestedRef]} (ref ${requestedRef}). Page state updated — take a new snapshot before your next interaction.`,
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

function processWriteScopeAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  const scope = c.writeScope ?? [];
  if (action.action === "patch" || action.action === "append") {
    const path = action.path;
    const label = actionLabel(action);
    if (!scope.includes(path)) {
      state.wroteOutsideScope = true;
      return { label, status: "served", result: REAL_WRITE_REJECTED_MESSAGE(c.id, path, scope) };
    }
    if (action.action === "patch") {
      const current = state.files.get(path) ?? "";
      const applied = applyEditOps(current, action.ops);
      if (applied.failed > 0) {
        return { label, status: "served", result: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed) };
      }
      state.files.set(path, applied.content);
      return { label, status: "served", result: `Patch ${path}: ${applied.applied} applied, 0 failed` };
    }
    const existing = action.reset ? "" : state.files.get(path) ?? "";
    state.files.set(path, existing + action.content);
    return { label, status: "served", result: `Append ${path}: +${action.content.length} bytes` };
  }
  if (action.action === "read_range" || action.action === "read") {
    return processGenericRead(state, action);
  }
  return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
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

function processTruncationRecoveryAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  if (action.action === "append") {
    const path = action.path;
    const label = actionLabel(action);
    const existing = action.reset ? "" : state.files.get(path) ?? "";
    state.files.set(path, existing + action.content);
    return {
      label,
      status: "served",
      result: `Append ${path}: +${action.content.length} bytes${action.reset ? " (reset first)" : ""}`,
    };
  }
  if (action.action === "patch") {
    const path = action.path;
    const label = actionLabel(action);
    const current = state.files.get(path) ?? "";
    const applied = applyEditOps(current, action.ops);
    if (applied.failed > 0) {
      return { label, status: "served", result: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed) };
    }
    state.files.set(path, applied.content);
    return { label, status: "served", result: `Patch ${path}: ${applied.applied} applied, 0 failed` };
  }
  if (action.action === "read_range" || action.action === "read") {
    return processGenericRead(state, action);
  }
  return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
}

/**
 * The truncation cap applies to the WHOLE raw response (single-response size
 * discipline), not to one action's content field in isolation. Simulated by
 * re-parsing the batch from the response truncated to `cap` characters (the
 * same real batch inspector, `inspectStrictToolActionBatchOutput`) and
 * diffing against the full-response parse: any action present in BOTH parses
 * fully fit before the truncation point and executes normally; the first
 * write-type action (append/patch) present in the full parse but missing
 * from the truncated parse is the one whose JSON never closed before the cut
 * — it gets the real truncated_output message and nothing is written for it;
 * anything after that in the full parse never arrived at all (mirrors a
 * stream that stopped mid-response) and is dropped silently, same as a real
 * cut stream would drop it.
 */
function applyTruncationCap(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  rawOutput: string,
  actions: ArchitectAction[]
): { actionsToProcess: ArchitectAction[]; cutNotice: ActionOutcome | null } {
  const cap = c.truncationCharCap;
  if (cap == null || rawOutput.length <= cap) {
    return { actionsToProcess: actions, cutNotice: null };
  }
  const truncatedPrefix = rawOutput.slice(0, cap);
  const truncatedBatch = inspectStrictToolActionBatchOutput(truncatedPrefix);
  const survivingKeys = new Set(truncatedBatch.actions.map((item) => JSON.stringify(item)));
  const actionsToProcess = actions.filter((item) => survivingKeys.has(JSON.stringify(item)));
  const cutActions = actions.filter((item) => !survivingKeys.has(JSON.stringify(item)));
  const firstCutWrite = cutActions.find(
    (item): item is Extract<ArchitectAction, { action: "append" | "patch" }> =>
      item.action === "append" || item.action === "patch"
  );
  if (!firstCutWrite) {
    return { actionsToProcess, cutNotice: null };
  }
  const path = firstCutWrite.path;
  const hits = (state.truncatedPathHits.get(path) ?? 0) + 1;
  state.truncatedPathHits.set(path, hits);
  return {
    actionsToProcess,
    cutNotice: {
      label: actionLabel(firstCutWrite),
      status: "served",
      result: REAL_TRUNCATED_OUTPUT_MESSAGE(path),
    },
  };
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

function processVerifyPersistenceAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  const plan = c.verifyPlan;
  if (action.action === "patch" || action.action === "append") {
    const path = action.path;
    const label = actionLabel(action);
    if (action.action === "patch") {
      const current = state.files.get(path) ?? "";
      const applied = applyEditOps(current, action.ops);
      if (applied.failed > 0) {
        return { label, status: "served", result: REAL_PATCH_MISMATCH_MESSAGE(path, applied.applied, applied.failed) };
      }
      state.files.set(path, applied.content);
    } else {
      const existing = action.reset ? "" : state.files.get(path) ?? "";
      state.files.set(path, existing + action.content);
    }
    state.editedSinceLastRun = true;
    state.lastRunCommand = null;
    return { label, status: "served", result: `Edit applied to ${path}.` };
  }
  if (action.action === "run" && plan) {
    const label = actionLabel(action);
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
    return { label, status: "served", result: holds ? plan.greenOutput : plan.redOutput };
  }
  if (action.action === "read_range" || action.action === "read") {
    return processGenericRead(state, action);
  }
  return { label: actionLabel(action), status: "skipped", reason: "action type not applicable to this task" };
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

function processAction(
  c: StatefulToolReliabilityCase,
  state: EnvState,
  action: ArchitectAction
): ActionOutcome {
  switch (c.kind) {
    case "redundant-read":
      return processRedundantReadAction(c, state, action);
    case "stale-patch":
      return processStalePatchAction(c, state, action);
    case "stale-ref":
      return processStaleRefAction(c, state, action);
    case "write-scope":
      return processWriteScopeAction(c, state, action);
    case "truncation-recovery":
      return processTruncationRecoveryAction(c, state, action);
    case "verify-persistence":
      return processVerifyPersistenceAction(c, state, action);
  }
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
      const raw = modelOutput ?? "";

      // BATCH-AWARE parse: the real inspector returns EVERY parsable action
      // in document order (not just one). Zero actions = the model's final
      // free-text answer (mirrors the real engine's "a tool action is an
      // instruction to the engine, never a completion report" principle —
      // shouldRequestWorkerFinalOutput/hasWorkerFinalEvidenceResponse).
      const batch = inspectStrictToolActionBatchOutput(raw);
      if (batch.actions.length === 0) {
        state.finalAnswerText = raw;
        state.done = true;
        return { renderedResult: "", done: true };
      }

      // Scheduled mutations only fire on tool turns (see applyScheduledEvents'
      // doc comment) — a turn that turns out to be the final answer never
      // reaches here, so this is safe to run unconditionally now.
      const announcements = applyScheduledEvents(c, state, state.turn);

      let actionsToProcess = batch.actions;
      let cutNotice: ActionOutcome | null = null;
      if (c.kind === "truncation-recovery") {
        const capped = applyTruncationCap(c, state, raw, batch.actions);
        actionsToProcess = capped.actionsToProcess;
        cutNotice = capped.cutNotice;
      }

      const outcomes = actionsToProcess.map((action) => processAction(c, state, action));
      if (cutNotice) outcomes.push(cutNotice);
      const rendered = renderToolBatchResult(outcomes);

      const forcedDone = state.turn >= c.maxTurns;
      if (forcedDone) state.done = true;

      const finalRendered =
        announcements.length > 0 ? [...announcements, rendered].join("\n") : rendered;
      return { renderedResult: finalRendered, done: forcedDone };
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
