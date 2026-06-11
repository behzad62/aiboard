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
  /**
   * Task ids that must finish before this one starts. Tasks with no pending
   * dependencies run CONCURRENTLY, so the Architect should only add an edge
   * when one task genuinely consumes another's output.
   */
  dependsOn?: string[];
  /** Architect's preferred worker (display name) for this task, if any. */
  assignTo?: string;
  /** Failed attempts so far — the engine requeues a failed task once before
   * giving up on it. */
  failCount?: number;
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
    dependsOn?: string[];
    /** Optional: pin this task to a worker by display name (e.g. the best
     * performer for a hard task). The engine matches it case-insensitively. */
    assignTo?: string;
  }>;
  notes?: string;
  /**
   * Optional shell command that compiles/type-checks the project, run by the
   * engine automatically each wave (when a runner is connected) as a
   * mechanical backstop — its output goes into the review so broken code is
   * caught regardless of language. The Architect knows the stack, so it sets
   * this (e.g. "dotnet build", "go build ./...", "cargo check",
   * "npx tsc --noEmit"). Omit / "" when there's nothing meaningful to run.
   */
  verifyCommand?: string;
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

/**
 * Best-guess build/check command for a project from its manifest files —
 * a language-agnostic fallback used when the Architect doesn't declare a
 * verifyCommand. Returns "" when no confident command applies: languages
 * whose check is per-file (PHP `php -l`, Ruby `ruby -c`), build systems with
 * platform-specific wrappers (gradlew vs gradlew.bat), and bare package.json
 * projects are left to the Architect's explicit verifyCommand. Compiled
 * languages are checked first; `files` are project-relative paths.
 */
export function detectVerifyCommand(files: string[]): string {
  const has = (re: RegExp) => files.some((f) => re.test(f));
  if (has(/(^|\/)go\.mod$/)) return "go build ./...";
  if (has(/(^|\/)Cargo\.toml$/)) return "cargo check";
  if (has(/\.csproj$/) || has(/\.fsproj$/) || has(/\.sln$/)) return "dotnet build";
  if (has(/(^|\/)pom\.xml$/)) return "mvn -q -DskipTests compile";
  if (has(/(^|\/)mix\.exs$/)) return "mix compile";
  // C/C++: configure into a scratch dir, then build (&& works in cmd and sh).
  if (has(/(^|\/)CMakeLists\.txt$/))
    return "cmake -S . -B .verify-build && cmake --build .verify-build";
  if (has(/(^|\/)Makefile$/)) return "make";
  if (has(/(^|\/)tsconfig\.json$/)) return "npx --yes tsc --noEmit";
  // Python: stdlib byte-compile catches syntax errors; no deps assumed.
  if (has(/\.py$/)) return "python -m compileall -q .";
  return "";
}

/** A compact worker-performance line for the prompt scoreboard. */
export function scoreboardSection(scoreboard?: string): string {
  return scoreboard?.trim()
    ? `Worker performance so far (the engine tracks this automatically from your approve/fix verdicts, failures, and output speed relative to the other workers — higher score = more reliable). Assign harder or foundational tasks to higher-scoring workers via each task's "assignTo" (worker display name); benched workers won't be given tasks:\n${scoreboard}`
    : "";
}

/** Run a shell command in the project folder via the user's local runner. */
export interface RunAction {
  action: "run";
  command: string;
  reason?: string;
}

/** Case-insensitive substring search across all project files. */
export interface SearchAction {
  action: "search";
  query: string;
  reason?: string;
}

/** Call an MCP tool exposed by the user's local runner bridge. */
export interface ToolAction {
  action: "tool";
  server: string;
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
}

/** Fetch a public http(s) URL via the user's local runner (runner v3+). */
export interface FetchAction {
  action: "fetch";
  url: string;
  reason?: string;
}

export type ArchitectAction =
  | ReadAction
  | PlanAction
  | ReviewAction
  | RunAction
  | SearchAction
  | ToolAction
  | FetchAction;

/** The balanced top-level {...} starting exactly at `start`, or null. */
function balancedObjectAt(text: string, start: number): string | null {
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
  return null;
}

/** Every top-level balanced {...} in the text, in document order (capped). */
function balancedObjects(text: string, max = 20): string[] {
  const found: string[] = [];
  let start = text.indexOf("{");
  while (start >= 0 && found.length < max) {
    const obj = balancedObjectAt(text, start);
    if (obj) {
      found.push(obj);
      start = text.indexOf("{", start + obj.length);
    } else {
      start = text.indexOf("{", start + 1);
    }
  }
  return found;
}

/**
 * All fenced code blocks, scanned line by line so a closing fence can never be
 * mistaken for an opening one — the failure a regex scan has when other code
 * blocks precede the action block (it then misses the action entirely).
 */
function fencedBlocks(text: string): Array<{ info: string; body: string }> {
  const lines = text.split("\n");
  const blocks: Array<{ info: string; body: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const closeRe = open[1][0] === "`" ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    blocks.push({ info: (open[2] ?? "").trim(), body: body.join("\n") });
    i = j + 1;
  }
  return blocks;
}

/**
 * Parse the Architect's action from its (possibly chatty) output. The prompts
 * say "END with ONE fenced json block", so candidates are tried LAST first:
 * json/unlabelled fenced blocks, then any balanced {...} in the text.
 * Returns null when nothing parseable is found.
 */
export function parseArchitectAction(text: string): ArchitectAction | null {
  const candidates: string[] = [];
  const blocks = fencedBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const lang = blocks[i].info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "" || lang === "json" || lang === "jsonc") {
      candidates.push(blocks[i].body);
    }
  }
  const balanced = balancedObjects(text);
  for (let i = balanced.length - 1; i >= 0; i--) {
    candidates.push(balanced[i]);
  }

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
        if (
          parsed.action === "run" &&
          typeof (parsed as RunAction).command === "string" &&
          (parsed as RunAction).command.trim()
        ) {
          return parsed as RunAction;
        }
        if (
          parsed.action === "search" &&
          typeof (parsed as SearchAction).query === "string" &&
          (parsed as SearchAction).query.trim()
        ) {
          return parsed as SearchAction;
        }
        if (
          parsed.action === "tool" &&
          typeof (parsed as ToolAction).server === "string" &&
          (parsed as ToolAction).server.trim() &&
          typeof (parsed as ToolAction).tool === "string" &&
          (parsed as ToolAction).tool.trim()
        ) {
          return parsed as ToolAction;
        }
        if (
          parsed.action === "fetch" &&
          typeof (parsed as FetchAction).url === "string" &&
          /^https?:\/\//i.test((parsed as FetchAction).url.trim())
        ) {
          return { ...(parsed as FetchAction), url: (parsed as FetchAction).url.trim() };
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

function userNotesSection(notes?: string): string {
  return notes?.trim()
    ? `NOTES FROM THE USER (added while the team was building — treat them as requirements and address every one):\n${notes}`
    : "";
}

function searchToolDoc(searchesLeft?: number): string {
  if (!searchesLeft || searchesLeft <= 0) return "";
  return [
    "TOOL — search the project: to find where something is defined or used (instead of guessing paths), respond with ONLY:",
    '{"action":"search","query":"text to find","reason":"why"}',
    `Case-insensitive substring match across all project files; results come back as path:line: text. ${searchesLeft} search${searchesLeft === 1 ? "" : "es"} left in this phase.`,
  ].join("\n");
}

/**
 * How models modify EXISTING files: targeted SEARCH/REPLACE edit blocks
 * instead of re-emitting whole files (cheaper, and immune to truncation
 * corrupting untouched parts of the file).
 */
export const EDIT_BLOCK_INSTRUCTION = [
  "To MODIFY an existing file, emit a targeted edit block instead of re-emitting the whole file:",
  "```edit path=src/example.js",
  "<<<<<<< SEARCH",
  "(copy the exact current lines being replaced — include enough surrounding lines to be unique)",
  "=======",
  "(the replacement lines)",
  ">>>>>>> REPLACE",
  "```",
  "The SEARCH text must match the current file content verbatim. Multiple SEARCH/REPLACE sections are allowed in one block. Use full ```lang path=... blocks only for NEW files or complete rewrites.",
].join("\n");

function mcpToolDoc(mcpToolsDoc?: string, mcpCallsLeft?: number): string {
  if (!mcpToolsDoc?.trim() || !mcpCallsLeft || mcpCallsLeft <= 0) return "";
  return [
    "TOOL — MCP tools (via the user's local runner; e.g. drive a real browser to verify your build). To call one, respond with ONLY:",
    '{"action":"tool","server":"<server>","tool":"<tool name>","args":{ /* per the tool\'s signature */ },"reason":"why"}',
    `The result comes back to you as text. Each tool below shows its exact argument names as name: type ("?" = optional) — use EXACTLY those names in "args". ${mcpCallsLeft} tool call${mcpCallsLeft === 1 ? "" : "s"} left in this phase. The user may deny a call — respect that and continue. Available tools:`,
    mcpToolsDoc,
  ].join("\n");
}

function fetchToolDoc(fetchesLeft?: number): string {
  if (!fetchesLeft || fetchesLeft <= 0) return "";
  return [
    "TOOL — fetch a web page: the user's local runner can retrieve a PUBLIC http(s) URL for you (docs, READMEs, API references). This fetches a KNOWN URL — it is not a search engine. To fetch, respond with ONLY:",
    '{"action":"fetch","url":"https://example.com/docs","reason":"why"}',
    `The page text comes back to you (truncated to a safe size). Local/private addresses are refused. ${fetchesLeft} fetch${fetchesLeft === 1 ? "" : "es"} left in this phase. The user may deny a fetch — respect that and continue.`,
  ].join("\n");
}

function runToolDoc(runsLeft?: number): string {
  if (!runsLeft || runsLeft <= 0) return "";
  return [
    "TOOL — run commands: the user granted you a local runner that executes shell commands in the project folder. Use it to install dependencies, run tests, build, or inspect the environment. To run a command, respond with ONLY:",
    '{"action":"run","command":"npm test","reason":"verify the suite passes"}',
    `One non-interactive command at a time (no editors/watch modes/prompts); stdout, stderr, and the exit code come back to you. ${runsLeft} run${runsLeft === 1 ? "" : "s"} left in this phase. The user may deny a command — respect that and continue without it.`,
  ].join("\n");
}

export function buildArchitectPlanPrompt(input: {
  request: string;
  treeText: string;
  fileContext: string;
  maxTasks: number;
  workerNames: string[];
  readHopsLeft: number;
  runsLeft?: number;
  searchesLeft?: number;
  fetchesLeft?: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  userNotes?: string;
  scoreboard?: string;
  /** Hand-off summary from a previous pass — this is a follow-up build. */
  previousSummary?: string;
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
    input.previousSummary?.trim()
      ? `\nThis is a FOLLOW-UP pass: a previous build already delivered the project summarized below. Everything delivered is still a requirement — preserve it. Plan ONLY the delta (changes the notes/request ask for), editing existing files where possible instead of rebuilding.\nPrevious hand-off summary:\n${input.previousSummary}`
      : "",
    input.fileContext,
    userNotesSection(input.userNotes),
    "",
    `Your workers: ${input.workerNames.join(", ")}.`,
    scoreboardSection(input.scoreboard),
    "",
    readOption,
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft),
    fetchToolDoc(input.fetchesLeft),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    `To plan, respond with a short rationale followed by ONE fenced json block:`,
    "```json",
    `{"action":"plan","tasks":[{"id":"T1","title":"...","instructions":"complete, self-contained instructions — the worker sees nothing else","contextFiles":["existing files the worker must see"],"expectedOutputs":"files or outcomes you expect","dependsOn":["ids of tasks whose output this one needs, [] when independent"],"assignTo":"optional worker display name for this task (omit to auto-assign by performance)"}],"notes":"conventions all workers must follow","verifyCommand":"ONE non-interactive shell command that compiles or syntax-checks this project; it runs automatically after every wave and its errors come back to you. Match the stack: dotnet build | go build ./... | cargo check | npx tsc --noEmit | cmake -S . -B .verify-build && cmake --build .verify-build | g++ -fsyntax-only src/*.cpp | php -l src/index.php | python -m compileall -q . | ./gradlew compileJava. Omit only when nothing meaningful can run."}`,
    "```",
    `Rules: at most ${input.maxTasks} tasks this wave (you can add more after reviewing); make each task independently doable by one model in one response; put shared conventions (naming, stack, structure) in notes AND in each task's instructions.`,
    `Tasks run CONCURRENTLY whenever their "dependsOn" tasks are finished — maximize parallelism: keep dependsOn empty unless a task truly consumes another task's files, and prefer many independent tasks over one long chain. Workers cannot see each other's in-progress output, so each task must own its files exclusively.`,
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
    EDIT_BLOCK_INSTRUCTION,
    input.verbosityInstruction ?? "",
    "Keep prose brief — a short note on decisions is enough; the files are the deliverable.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectReviewPrompt(input: {
  request: string;
  treeText: string;
  fileContext?: string;
  executedText: string;
  maxNewTasks: number;
  cyclesLeft: number;
  readHopsLeft?: number;
  runsLeft?: number;
  searchesLeft?: number;
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  fetchesLeft?: number;
  userNotes?: string;
  scoreboard?: string;
}): string {
  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    input.fileContext?.trim()
      ? `\nFile contents you have already read — ground every decision in these; NEVER invent replacement content for an existing file:${input.fileContext}`
      : "",
    userNotesSection(input.userNotes),
    "",
    "Work completed since your last review:",
    input.executedText,
    "",
    scoreboardSection(input.scoreboard),
    "Review each task's output. You can fix small problems YOURSELF before your decision — your changes overwrite the workers'. For bigger problems, send the task back with precise fix instructions.",
    EDIT_BLOCK_INSTRUCTION,
    input.readHopsLeft && input.readHopsLeft > 0
      ? `If you need to see an existing file's contents before deciding, respond with ONLY:\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left in this review). Never guess at a file's contents — read it.`
      : "",
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft),
    fetchToolDoc(input.fetchesLeft),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    "End with ONE fenced json block:",
    "```json",
    `{"action":"review","results":[{"taskId":"T1","verdict":"approve" /* or "fix" */,"fixInstructions":"required when verdict is fix"}],"newTasks":[{"id":"T9","title":"...","instructions":"...","contextFiles":["existing files the worker must see"],"dependsOn":[],"assignTo":"optional worker display name"}],"done":false,"notes":"updated conventions if any"}`,
    "```",
    `New tasks run CONCURRENTLY when their "dependsOn" tasks are finished — keep dependsOn empty unless a task consumes another task's output, and give each task exclusive ownership of its files. Always list the existing files a new task builds on in its contextFiles.`,
    `Rules: max ${input.maxNewTasks} new tasks; ${input.cyclesLeft} review cycle${input.cyclesLeft === 1 ? "" : "s"} remain after this one, so prioritize what makes the project complete and working. Set "done": true ONLY when the project fulfils the request with no outstanding fixes.`,
    input.userNotes?.trim()
      ? 'The user\'s notes above are requirements: turn any that aren\'t covered yet into fix instructions or new tasks, and do NOT set "done": true while one remains unaddressed.'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The optional mid-tier Reviewer: reads the workers' full output so the
 * expensive Architect can decide from a compact digest instead.
 */
export function buildReviewerPrompt(input: {
  request: string;
  treeText: string;
  executedText: string;
  architectNotes?: string;
  userNotes?: string;
}): string {
  return [
    "You are the REVIEWER — a senior engineer pre-screening the worker models' output so the Architect (an expensive model) doesn't have to read every file. The Architect decides approve/fix per task based primarily on YOUR digest, so be precise, concrete, and complete — but compact.",
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    input.architectNotes?.trim()
      ? `\nArchitect's conventions:\n${input.architectNotes}`
      : "",
    userNotesSection(input.userNotes),
    "",
    "Work to review (full files):",
    input.executedText,
    "",
    "Write a review digest in Markdown:",
    "- Per task: a heading `### <taskId> — RECOMMEND APPROVE` or `### <taskId> — RECOMMEND FIX`, followed by concrete findings (bugs, spec violations, missing requirements), each naming the file path and quoting the offending lines verbatim (short quotes only).",
    "- Explicitly check cross-file contracts: imports match exports, referenced ids/classes/selectors exist, referenced paths exist in the tree.",
    "- Flag anything that violates the user's request, the user's notes, or the Architect's conventions.",
    "- End with `## Must-see` — file paths the Architect should read in full before deciding, or `nothing`.",
    "Do NOT re-emit whole files. Do NOT output JSON action blocks. Keep the digest compact.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectSummaryPrompt(input: {
  request: string;
  treeText: string;
  /** Paths actually written this run — the summary may only claim these. */
  filesChanged?: string;
  historyText: string;
  verbosityInstruction?: string;
  userNotes?: string;
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
    input.filesChanged?.trim()
      ? `\nFiles actually created or modified in THIS run (the complete list — do NOT claim changes to any file not listed here; if something planned is missing from this list, it did NOT happen and belongs under known gaps):\n${input.filesChanged}`
      : "\nNo files were created or modified in this run — say so plainly and describe what went wrong instead of describing planned work as done.",
    userNotesSection(input.userNotes),
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
