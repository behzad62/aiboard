/**
 * Build mode: the Architect-orchestrated project loop.
 *
 * The judge model acts as the Architect (planner/reviewer); the other selected
 * models are workers. This module holds the shared vocabulary: task types, the
 * Architect's JSON action protocol (with tolerant parsing), and every prompt.
 * The loop itself runs in lib/client/build-engine.ts.
 */

import { FILE_OUTPUT_INSTRUCTION, META_FOOTER_INSTRUCTION } from "./prompts";

export type BuildTaskStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "fixing"
  | "done"
  | "failed";

export interface BuildTask {
  id: string;
  title: string;
  instructions: string;
  /** Existing files the worker needs to see to do the task. */
  contextFiles: string[];
  /** What the Architect expects back (free text, e.g. file paths). */
  expectedOutputs?: string;
  status: BuildTaskStatus;
  /** Pinned worker index — fix tasks return to the model that did the work. */
  workerIndex?: number;
}

// ── Architect action protocol ─────────────────────────────────────────────────

export interface ReadAction {
  action: "read";
  paths: string[];
}

export interface PlanAction {
  action: "plan";
  tasks: Array<{
    id?: string;
    title: string;
    instructions: string;
    contextFiles?: string[];
    expectedOutputs?: string;
  }>;
  notes?: string;
}

export interface ReviewAction {
  action: "review";
  results: Array<{
    taskId: string;
    verdict: "approve" | "fix";
    fixInstructions?: string;
  }>;
  newTasks?: PlanAction["tasks"];
  done: boolean;
  notes?: string;
}

export type ArchitectAction = ReadAction | PlanAction | ReviewAction;

/** Extract the first balanced top-level {...} starting at each "{". */
function firstBalancedObject(text: string): string | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = inString;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse the Architect's action from its (possibly chatty) output. Prefers a
 * fenced ```json block; falls back to the first balanced JSON object that has
 * a recognized "action". Returns null when nothing parseable is found.
 */
export function parseArchitectAction(text: string): ArchitectAction | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  for (let m = fenced.exec(text); m; m = fenced.exec(text)) {
    candidates.push(m[1]);
  }
  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ArchitectAction>;
      if (parsed && typeof parsed === "object" && "action" in parsed) {
        if (parsed.action === "read" && Array.isArray((parsed as ReadAction).paths)) {
          return parsed as ReadAction;
        }
        if (parsed.action === "plan" && Array.isArray((parsed as PlanAction).tasks)) {
          return parsed as PlanAction;
        }
        if (parsed.action === "review") {
          const review = parsed as ReviewAction;
          return {
            ...review,
            results: Array.isArray(review.results) ? review.results : [],
            done: !!review.done,
          };
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const ARCHITECT_ROLE =
  "You are the Architect — the senior engineer orchestrating a team of AI worker models building a project for the user. You plan tasks, review the workers' output, fix problems, and decide when the project is done. Be decisive and concrete; the workers only know what you put in their task instructions.";

function treeSection(treeText: string): string {
  return treeText.trim()
    ? `Current project files:\n${treeText}`
    : "The project folder is currently empty.";
}

export function buildArchitectPlanPrompt(input: {
  request: string;
  treeText: string;
  fileContext: string;
  maxTasks: number;
  workerNames: string[];
  readHopsLeft: number;
}): string {
  const readOption = input.readHopsLeft > 0
    ? `If you need to inspect existing files before planning, respond with ONLY:\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; you have ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left). Otherwise, plan now.`
    : "Plan now — no more file reads are available.";

  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    input.fileContext,
    "",
    `Your workers: ${input.workerNames.join(", ")}.`,
    "",
    readOption,
    "",
    `To plan, respond with a short rationale followed by ONE fenced json block:`,
    "```json",
    `{"action":"plan","tasks":[{"id":"T1","title":"...","instructions":"complete, self-contained instructions — the worker sees nothing else","contextFiles":["existing files the worker must see"],"expectedOutputs":"files or outcomes you expect"}],"notes":"conventions all workers must follow"}`,
    "```",
    `Rules: at most ${input.maxTasks} tasks this wave (you can add more after reviewing); order tasks so earlier outputs unblock later ones; make each task independently doable by one model in one response; put shared conventions (naming, stack, structure) in notes AND in each task's instructions.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWorkerTaskPrompt(input: {
  request: string;
  treeText: string;
  task: BuildTask;
  contextFileText: string;
  architectNotes: string;
  verbosityInstruction?: string;
}): string {
  return [
    `You are an AI engineer on a team building a project. The Architect assigned you ONE task. Complete it fully — other tasks are handled by teammates, so do not do their work or restructure files outside your task.`,
    "",
    "Overall project request (for context only):",
    input.request,
    "",
    treeSection(input.treeText),
    input.architectNotes ? `\nArchitect's conventions:\n${input.architectNotes}` : "",
    input.contextFileText,
    "",
    `YOUR TASK — ${input.task.id}: ${input.task.title}`,
    input.task.instructions,
    input.task.expectedOutputs ? `Expected outputs: ${input.task.expectedOutputs}` : "",
    input.task.status === "fixing"
      ? "This is a FIX round: the Architect reviewed your previous output and the instructions above tell you what to correct. Re-emit the complete corrected files."
      : "",
    "",
    FILE_OUTPUT_INSTRUCTION,
    input.verbosityInstruction ?? "",
    "Keep prose brief — a short note on decisions is enough; the files are the deliverable.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectReviewPrompt(input: {
  request: string;
  treeText: string;
  executedText: string;
  maxNewTasks: number;
  cyclesLeft: number;
}): string {
  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    "",
    "Work completed since your last review:",
    input.executedText,
    "",
    "Review each task's output. You can fix small problems YOURSELF by emitting corrected files as fenced blocks (```lang path=...) before your decision — your files overwrite the workers'. For bigger problems, send the task back with precise fix instructions.",
    "",
    "End with ONE fenced json block:",
    "```json",
    `{"action":"review","results":[{"taskId":"T1","verdict":"approve" /* or "fix" */,"fixInstructions":"required when verdict is fix"}],"newTasks":[{"id":"T9","title":"...","instructions":"...","contextFiles":[]}],"done":false,"notes":"updated conventions if any"}`,
    "```",
    `Rules: max ${input.maxNewTasks} new tasks; ${input.cyclesLeft} review cycle${input.cyclesLeft === 1 ? "" : "s"} remain after this one, so prioritize what makes the project complete and working. Set "done": true ONLY when the project fulfils the request with no outstanding fixes.`,
  ].join("\n");
}

export function buildArchitectSummaryPrompt(input: {
  request: string;
  treeText: string;
  historyText: string;
  verbosityInstruction?: string;
}): string {
  return [
    ARCHITECT_ROLE,
    "",
    "The build is finished. Write the final hand-off summary for the user in GitHub-flavored Markdown:",
    "- What was built and how it is structured (reference real file paths).",
    "- How to run / use it.",
    "- Key decisions and trade-offs.",
    "- Known gaps or follow-ups, if any.",
    "",
    "Project request:",
    input.request,
    "",
    treeSection(input.treeText),
    "",
    "Build history (plans, reviews, outcomes):",
    input.historyText,
    "",
    input.verbosityInstruction ?? "",
    "Do not re-emit file contents. Do NOT wrap the summary in JSON.",
    META_FOOTER_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n");
}

export const STRICT_RETRY_INSTRUCTION =
  'Your previous response did not contain a parseable JSON action. Respond again with ONLY the fenced json block (no other text), exactly matching the schema you were given, including the "action" field.';
