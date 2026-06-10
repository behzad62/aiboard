# Build Mode Orchestrator + Mode Review — Design

Date: 2026-06-10
Status: Approved (user confirmed write-immediately + zip fallback)

## Mode review outcome

- **Panel** — kept as-is. Symmetric collaborate-and-refine; prompts and engine correct.
- **Debate** — kept; prompts reworked. Explicit FOR/AGAINST proposition framing,
  side rosters in the prompt, steelman opening → named rebuttals → closing with
  concessions and the crux. Judge gets debate-aware guidance (weigh sides on
  merit, verdict + flip conditions).
- **Specialist** — kept; bug fixed. The lead was rotating per round
  (`(round-1) % models.length`) so round 2's "lead" never wrote the draft it was
  told to revise. Lead is now pinned to the first selected model. Judge gets
  specialist-aware guidance (lead's final revision is the primary candidate).
- **Build** — kept; internals replaced with an orchestrated agent loop (below).

Each mode now has a distinct, non-overlapping purpose: symmetric collaboration /
adversarial stress-test / asymmetric draft+review / orchestrated production.

## Build mode: Architect-orchestrated project construction

**Intent:** the user defines a project; the judge model acts as the
Architect/Orchestrator (expensive model) and the other selected models are
workers (cheap models). The Architect plans tasks, workers implement them, the
Architect reviews, fixes or issues fix-instructions, adds tasks, and repeats
until the project is done.

### Loop

1. **Plan** — Architect receives the project request + project file tree +
   key manifest files. It may first answer `{"action":"read","paths":[...]}`
   (≤2 hops) to inspect existing files, then emits
   `{"action":"plan","tasks":[{id,title,instructions,contextFiles,expectedOutputs}],"notes"}`.
2. **Implement** — tasks run sequentially; task i goes to worker
   `workers[i % workers.length]` (fix-tasks return to the original worker; if
   the Architect is the only selected model it is also the worker). A worker
   sees ONLY: the tree, its task, and the contents of its contextFiles — not
   the whole transcript. It emits complete files as ```lang path= blocks; the
   engine writes them immediately (virtual FS always; the real folder too when
   granted).
3. **Review** — Architect sees what changed (paths + contents, truncated) and
   answers `{"action":"review","results":[{taskId,verdict:"approve"|"fix",fixInstructions}],"newTasks":[...],"done":bool}`.
   It may include corrected files itself (written to disk as its own fixes).
4. Repeat 2–3 until `done`, or the effort cycle cap (low 2 / medium 4 / high 6
   waves) or hard task cap (8/16/32 worker calls) hits.
5. **Summary** — Architect writes the final build summary (what was built, how
   to run, follow-ups) with the standard meta footer → final answer card.

No convergence vote or stagnation check in build — the Architect decides.

### Project folder (File System Access)

- Dashboard shows a **Project folder** picker when mode=build and FSA is
  supported. The directory handle is persisted in IndexedDB per discussion id;
  permission is re-granted per session (button gate before the run starts,
  since `requestPermission` needs a user gesture).
- `lib/client/project-fs.ts`: tree listing (ignores node_modules/.git/dist/
  .next/out/build/binaries; caps entries+depth), size-capped text reads,
  sanitized writes (no `..`/absolute paths) with recursive folder creation.
- **Write policy: immediate** — worker output lands on disk as each task
  finishes; the Architect reviews and overwrites with fixes (user decision).
- **No folder → zip fallback** — the same loop runs against the virtual FS
  only; files appear in the artifact panel with zip download (user decision).
  This keeps Build working on mobile/non-Chromium.

### Events / UI

New engine events: `build_plan` (task list), `task_status`
(planned/in_progress/review/fixing/done/failed + worker), `file_written`
(path, bytes, disk|virtual). The discussion page renders a task board and a
files-written list for build runs; the artifact panel/zip continues to work
from message content. Task board is live-run state (not persisted); the
transcript and final summary persist as before.

### Parsing and resilience

Architect turns must contain a fenced ```json action block (tolerant fallback:
first balanced `{...}`). On a parse failure the engine re-asks once with a
stricter instruction, then fails the discussion with a clear error. Worker
file extraction reuses lib/artifacts/extract.ts.

### Out of scope (v1)

- Mid-turn interactive tool calls for workers (context files are provided
  up-front by the Architect's task spec).
- Running shell commands / executing the project.
- Task-state persistence across reloads; resuming an interrupted build.
