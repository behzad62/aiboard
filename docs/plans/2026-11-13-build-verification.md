# Build Verification: the Runner Records, the Architect Decides, the Owner Sets What Is Mandatory — Implementation Plan
Date: 2026-11-13
Status: Approved by the owner on 2026-11-13 ("revise the plan then start the implementation"), with the revision that moves browsing to the Playwright CLI (§4.5). It runs after the AIBoard home (done 2026-11-12) and before the CLI workers plan (VD-1).
Audience: the owner, and whoever implements the packets: a person or a Claude Code session.
Primary repository: D:\repos\ai-discussion-board, read at 8a3f4843 (main, 2026-11-12). Bare file names are under `runner-v2/src/`; `test/...` is `runner-v2/test/...`; other paths are repo-relative.

## 0. TL;DR

- **The problem.** Build's final check leans toward web apps, and the Runner decides what a project needs.
  - It detects checks from the project's files.
  - Every detected check is required: the Architect may not mark it "not applicable".
  - A check whose tool is missing fails, the Architect gets repair tasks it cannot fix, and the Build pauses when its repair cycles run out.
  - The "does it start" and browser checks exist only for Vite and Next apps. Desktop, mobile and CLI apps get build and tests at most, and ecosystems outside the seven the Runner knows get nothing.
  - This repository would fail its own final check: it has `"start": "next start"` and a static export, and Next.js refuses `next start` for a static export.
- **The principles** (owner, 2026-11-13; §3):
  - The Runner collects, records and checks. It never decides what a project needs.
  - The Architect decides what to verify and how, and can run the commands that need.
  - The owner decides what is mandatory. Only a mandatory check stops a Build.
  - A missing tool is a fact, not a failure. The Build goes on, and its summary lists what was not verified and why.
- **What changes** (§4):
  1. The Runner records which tools are installed before planning.
  2. A check whose tool is missing is recorded as "not run", never as a failure.
  3. The final check becomes a list the Architect writes: the Runner's detected checks are suggestions it may keep, change or skip with a reason, and it may add its own.
  4. Projects declare checks in `aiboard-validation.json`, and mark the mandatory ones.
  5. The Architect can run commands while planning, and start the app in its own copy.
  6. A command the Runner runs can return files (screenshots, reports) as evidence, for any kind of app.
  7. Every role browses through the Playwright CLI that each Runner already ships, as an ordinary command. The Runner's own `browser.*` tools are retired for new runs, and the final check has no built-in browser kind.
  8. The Build summary gets a "Not verified" section.
- **Estimate:** 17–22.5 days in ten packets (§6).

## 1. What the owner asked

From the planning conversation, 2026-11-12 and 2026-11-13:
- Build leaning toward web apps was a bad design.
- Evidence for workers' tasks is useful: it shows that everything was implemented and works as intended. But if Build requires it, we cannot expect the tools for it to be installed.
- Non-web apps need a real answer: how Build works with them and how it records their evidence.
- The Runner is a tool without intelligence. It can collect, record and check, but it should not decide. There are thousands of build scenarios, and a tool cannot support them all.
- The Architect is too limited. It should be able to run commands that help verification.
- The user decides which checks are mandatory.
- Do not stop the Build to report what was missing unless it is critical. The Build summary lists what was left to verify, and what the Build could not verify.
- Building Playwright into the Runner may have been a mistake; Playwright's own MCP server and CLI are cross-platform, and Microsoft recommends the CLI for coding agents (§4.5).

## 2. What Build does today

### 2.1 Evidence for each task: required, any kind
- A worker's claim with no evidence the Runner recorded starts as "unsatisfied". The Architect can override it only with a reason, after reading the cited evidence (delivery-acceptance.ts:1053-1062, architect-tools.ts:2554-2565).
- Evidence is a command the Runner ran, or one of three browser records (evidence-store.ts:8-74). A test, a script or a run of the program itself counts. A desktop or mobile app has no way to show what it looks like.
- A plan's requirement lists `requiredEvidenceKinds` (planning-contracts.ts:235), but nothing checks them: they appear only in the tool schema and the plan view (planning-tool-schemas.ts:60, planning-view-contracts.ts:13).

This part already works for every kind of app. It stays.

### 2.2 The final check: the Runner decides
- Four fixed categories: build, tests, runtime_smoke, browser (final-verification-contracts.ts:2-7). Each is `required` or `not_applicable` (:26-29).
- **Detection.**
  - Build and test commands come from package.json scripts (final-verification-profile.ts:379-385) and seven language families: dotnet, cmake, pytest, maven, gradle, cargo, go (language-execution-profile.ts:27).
  - runtime_smoke and browser are detected only for a Vite `preview` script or a Next `start` script (final-verification-profile.ts:766-768, :449-458). The browser check fails on any console error, page error or failed request (:479-486).
- **A detected check cannot be skipped.** `not_applicable` is refused for a detected category (final-verification-contracts.ts:177-182, final-verification-semantics.ts:41-53).
- **A check that cannot run fails.** A required check with no command is recorded as a failed check (final-verification-semantics.ts:56-61). A command that cannot start is "Process launch was not proven" (final-verification-runtime.ts:2154). A browser that cannot open becomes an issue in the check (final-verification-runtime.ts:1297 onward).
- **Any failed check means repairs.** The Runner reports the failure, and the Architect must plan repair tasks (build-runtime.ts:2319-2372). When the repair cycles run out, the Build pauses (build-runtime.ts:5391-5407). A missing tool can never be repaired by a task, so it always ends in that pause, or in an external blocker the Architect records for the owner (agent-prompts.ts:151).
- **The per-task boundary check** runs the detected build and test commands, or the project's tier commands (delivery-execution.ts:1188-1189, :1441-1442). A failure offers the Architect only `recheck` or `repair_planned` (architect-tools.ts:1471).
- **No tool check before planning.** Nothing in runner-v2/src records which toolchains or browsers are installed.

### 2.3 The browser
- The Runner imports the `playwright` library (browser-tools.ts:1-2) and launches only the Chromium that Playwright downloads (browser-tools.ts:264-268). Nothing installs it, so on a fresh machine every browser call and every browser check fails.
- Workers and the Architect get ten `browser.*` tools (role-capabilities.ts:71-90, :301-310). Verifiers do not.
- **The Runner already ships the Playwright CLI.** The release bundle copies the whole `playwright` package and its dependencies (scripts/release/bundle-contents.mts:11, scripts/release/build-bundle.mts:124-150). Playwright 1.61.1 (package.json:83) includes `playwright cli`, Microsoft's CLI for coding agents, and its agent skill (node_modules/playwright-core/lib/tools/cli-client/skill/SKILL.md, about 12 KB). It runs on Windows, macOS and Linux, and can use an installed Chrome or Edge (`open --browser=...`, `attach --cdp=chrome`).
- Microsoft's playwright-mcp and playwright-cli READMEs recommend the CLI with skills over the MCP server for coding agents: CLI commands avoid loading large tool schemas and full accessibility trees into the model's context, and snapshots go to files the agent reads as needed. MCP is for long exploratory loops that keep reasoning over a live page.

### 2.4 The Architect's tools
- `run_evidence_command` exists for the Architect, in a disposable copy, but only once an integration revision exists or during a review (native-architect-runtime.ts:598-620). In the planning state it is refused (:365-380).
- The Architect has no process tools (role-capabilities.ts:108-136), so it cannot start the app it is reviewing. Its browser tools can only open a page something else serves.
- The verifiers can run commands and start the product in their own checkout (role-capabilities.ts:56-68, :163-175, :243-256). That is the pattern to copy.

### 2.5 The summary
- The handoff snapshot already has a verification table, open findings, external blockers and exhausted repair issues (handoff-snapshot.ts:126-154, :172-200). Known defects from finding dispositions reach the handoff (scheduler-store.ts:8043-8062), and a handoff with known defects pauses for the owner's choice (AGENTS.md:45).
- It has no place for "not verified, and why".

### 2.6 This repository
package.json:21 has `"start": "next start"` and :67 has `next`, so the Runner detects runtime_smoke and browser and runs `next start`. next.config.ts:25 sets `output: "export"`, and Next.js refuses `next start` for a static export. The AIBoard Build of SB1–SB9 planned for this repository (2026-11-03 plan, §18.1) would fail its final check on the first try, and pause after its repairs.

## 3. Principles

Decided by the owner on 2026-11-13. Every packet follows them.

1. **The Runner records and checks; it never decides.** Detection only suggests checks. The Runner runs what the plan says, records exactly what happened, and reports facts. AGENTS.md:45 already says it for the verifiers: they "record mechanical facts and never decide completeness. The Architect is semantic authority."
2. **The Architect decides what to verify and how.** It keeps, changes or skips suggested checks, giving a reason for each skip, and adds its own. It can run commands and start the app to work out what to check.
3. **The owner decides what is mandatory.** Only a check marked mandatory in the project's `aiboard-validation.json` is mandatory (VD-2). The Architect can never skip one.
4. **A missing tool is a fact.** Only the Runner can record that a tool is missing, from its own lookup. The Architect cannot claim it. A missing tool never spends a repair cycle.
5. **Stop only when it matters** (§4.6):
   - a mandatory check cannot run, or still fails after its repairs;
   - the safety stops that exist today: secrets, process ownership, budgets, provider outages.
6. **No kind of app is special.** The Runner has no built-in web check. A browser is one tool on the machine, used through ordinary commands like any other.
7. **The summary says what was and was not verified.** Nothing is left out because it went well or badly.

These do not change the Runner V2 standing rules: fail-closed process ownership and fencing stay as they are, no timeout is raised to make a test pass, a change to process ownership gets an independent review, and every change is checked with its targeted tests plus `npm run typecheck:runner-v2`.

## 4. Design

### 4.1 The tool inventory (VF1)

Before planning, and again on resume, the Runner records what this machine has:
- Git and Node, which it already requires.
- For each detected or declared check, its executable, looked up on PATH the way language servers are (docs/runner-v2/extensions.md: the Runner resolves a bare command once and records the path). Then `--version` (or the family's version flag), with a short timeout and no network.
- A browser the Playwright CLI can use: installed Chrome, installed Edge, or a Chromium downloaded by `aiboard browser install` (§4.5).

It records one `environment.inventory_recorded` event: for each tool, found or not, the resolved path, and the first line of its version. The Architect sees it in its planning context, and the web shows it in Run details. It decides nothing.

### 4.2 Missing tool: "not run" (VF2)

- When a check's executable is not found on PATH, the Runner records the check as `not_run` with reason `tool_missing`, naming the executable. It does this at the per-task boundary and in the final check.
- It never reports a failure for it, never asks for repairs, and never spends a repair cycle.
- A launch that fails for any other reason stays a failure, as today.
- On the v1 contract, the built-in browser check with no browser it can launch is `not_run: tool_missing` (browser).
- VF2 lands on today's contract first, as a third result next to green and failed, so the blocking stops before VF3.

### 4.3 The final check becomes the Architect's list (VF3, VF4)

`VerificationPlanV2` replaces the four fixed entries:

```ts
interface VerificationCheckV2 {
  id: string;                       // stable within the run
  label: string;
  kind: "build" | "tests" | "start" | "other";
  origin: "detected" | "project" | "architect";
  mandatory: boolean;               // only from aiboard-validation.json; the Architect cannot set it
  run?: { executable: string; args: string[]; cwd?: string; timeoutMs?: number };            // build, tests, other
  start?: {                          // start: run a program and see that it works
    executable: string; args: string[]; timeoutMs?: number;
    ready: { http?: { path: string; status: number } } | { outputLine: string } | { exitCode: number };
    steps?: { label: string; executable: string; args: string[]; outputs?: string[] }[];
  };
  outputs?: string[];                // workspace-relative paths or globs kept as evidence (VF6)
}
interface VerificationPlanV2 {
  version: 2;
  checks: VerificationCheckV2[];
  skipped: { checkId: string; reason: string }[];   // suggested checks the Architect drops
}
```

- **Prefill.** The Runner offers its detected checks and the project's declared ones. The Architect keeps them, changes their commands, skips them with a reason, or adds its own. A mandatory check cannot be skipped or changed.
- **Results** per check: `passed`, `failed` (exit code, timeout or readiness), or `not_run` (`tool_missing`, set by the Runner, or `skipped`, set by the Architect's plan).
- **`start` covers every kind of program.**
  - A server is ready on an HTTP status, on a port the Runner leases, as runtime_smoke does today.
  - A CLI is ready on its exit code.
  - A desktop app's own headless or test mode is ready on a line of its output.
  - Steps run against the started program, as runtime_smoke's steps do today. A web app's browser check is a step that runs Playwright CLI commands against the leased port (open the page, list console errors, take a screenshot) and keeps the files as outputs. There is no `browser` kind: the Runner records what the commands did, and the Architect judges it (principle 6).
- **Repairs** are keyed by check id instead of category. The Architect still plans them as today.
- **Old runs.** A run started before VF3 keeps the v1 contract to the end; its events replay unchanged, and the v1 tests stay. A new run records `verificationContractVersion: 2` when it starts.
- **Project checks (VF4).** `aiboard-validation.json` version 2 adds `checks` in the same shape, each with `mandatory`, next to the existing tiers. A version-1 file still works. An older Runner refuses a version-2 file with a clear error (project-validation-config.ts already fails closed on a malformed file).
- **Detection fixes (VF4).** A Next app with `output: "export"` gets no `next start` suggestion. Detection stays a fallback for projects that declare nothing.
- **A mandatory check whose tool is missing** stops once, before planning, naming the tool and the config line (§4.6). It is the one pause this plan adds, and it comes before any work is spent.

### 4.4 The Architect's tools (VF5)

- `run_evidence_command` also works in the planning state, in a disposable copy of the baseline revision, created when first used (as the review copy is today). The Architect can check a tool's version, run the existing tests, or run the program to learn how it behaves before it plans.
- The process tools the verifiers have (`process.start`, `poll`, `read_output`, `signal`, `interact`, `write_stdin`, `list`; role-capabilities.ts:56-68) join `architect:inspection`, bound to the Architect's disposable copy. The Architect can start the app and look at it, through the program's output or, after VF7, the Playwright CLI.
- They run under the Build's access level, with the same approvals as the verifiers' commands. Processes the Architect starts are stopped when its copy is removed, the way verifier processes are; no ownership or fencing rule changes.

### 4.5 Evidence from any app (VF6) and browsing through the Playwright CLI (VF7)

- **Output files (VF6).** A check, or a `run_evidence_command` call, may list `outputs`: paths or globs in its workspace, with a cap on count and size. After the command exits, the Runner stores those files as artifacts linked to the evidence record. Images go to reviewers whose model accepts images, as `image.inspect` and the visual artifact output already do (image-tools.ts:70). A desktop UI test, a mobile emulator test, a game's screenshot script or a Playwright CLI screenshot all get the same visual review.
- **Browsing (VF7).** Every role browses with the Playwright CLI the Runner already ships (§2.3), through ordinary commands:
  - API workers run it with their process tools; CLI workers (Claude Code, Codex, agy) use it with their own skills; the Architect runs it with VF5's commands; the verifiers run it with `run_evidence_command`, which gives them a browser for the first time.
  - The Runner puts a `playwright-cli` command on PATH for the processes it starts, pointing at its bundled Playwright, so the version matches the skill it offers. The CLI's skill text is offered to API workers, the Architect and the verifiers as an AIBoard skill.
  - Snapshots and screenshots are files. Each CLI call is a command the Runner records, and the files a check names in `outputs` become evidence (VF6). New runs need no browser evidence kinds.
  - **The CLI's session is a Runner-owned process** (VF7a findings, spike report §9). Playwright 1.61.1 has no idle timer: a session lives until it is closed or its daemon is stopped. So the session is never started with the CLI's `open`: each agent session starts its own once, with `process.start playwright-cli-session` (until "Daemon listening on"), a managed process that runs the bundled daemon in the foreground with the browser the inventory (VF1) chose. Each owning agent session gets one named session (`t-<8 hex>` from the run and session ids), set as `PLAYWRIGHT_CLI_SESSION` in every process the Runner starts for that owner, and a task-owned state folder in the Runner's state (the daemon's registry, temp folder and browser profile), so two sessions never share or see each other's browser. The `playwright-cli` shim refuses `open`, `attach`, the `--cdp`/`--endpoint`/`--extension` connections, `show`, the installs, `close-all`, `kill-all`, `delete-data`, profiles and another session's `-s`, each with what to do instead; it is a guardrail, not a boundary. Screenshots and snapshots go to `.aiboard-browser/` in the workspace, which ignores itself in git and so never lands in a task commit. The session stops with its owner like any managed process. On POSIX the browser leaves the process group, so when the Runner stops the session process (the one it launched as `playwright-cli-session`), it reads the browser's PID from the session's own profile (Chrome's `SingletonLock` in the state folder) and confirms it by that PID's command line naming the profile, with the same birth and group around the read. The browser is never found by enumerating the host's processes: every read is by PID, and the only listing is on the last pass of a short wait, one zombie-aware `ps -e -o pid=,pgid=,stat=` per browser group that still answers `kill(-group, 0)`, read as that group's emptiness evidence only. Nothing outside the managed group is signalled (DECISION 2026-09-19 §8). Chrome quits when the daemon stops (DevTools-pipe EOF). A browser still there after the wait is a known escape (§8.3): it is recorded, the owner's folder stays, and the owner's later stops check it again. The session process's own stop is proven, so that stop still succeeds and an agent's close never pauses the run; the run's folder removal checks every owner again and fails closed while a browser runs, so the run's resources are not released. An unreadable browser is handled the same way. Killing it would need an amendment to §8. A session that ended by itself is checked the same way when the run's folders are removed. Each owner can run one session at a time (a pidfile on POSIX, a held lock file on Windows), and the session command keeps the user's own Playwright CLI config and every `PLAYWRIGHT_MCP_*` variable but the output folder away from the daemon. Chrome's crashpad handlers leave the browser's group too, are not in any file, and exit with Chrome; the check does not claim them. The change got an independent review, as the standing rules require for process ownership.
  - The browser: the inventory (VF1) records which one the CLI can use, installed Chrome or Edge first. A download happens only as the owner's own action, `aiboard browser install` or a button in Settings > Tools, which runs Playwright's Chromium install (VD-4). A Build never downloads a browser on its own. On Linux, missing system libraries are recorded with the first error line; installing them needs root, so the Runner never does it.
  - The `browser.*` tools are no longer registered for new runs, which removes ten tools from the tool surface. A run records `run.browsing_configured` before its first plan; a run without it (every run started before VF7b) keeps `browser.*` on resume and replay. Their code stays until no stored run needs it; removing it is a later cleanup.
- **MCP.** The Runner already supports MCP servers, so a user who wants Playwright MCP can add it as an extension. It is not a default (VD-6).

### 4.6 When a Build stops

| Situation | Today | After this plan |
|---|---|---|
| A suggested check's tool is missing | Failed check, repair tasks, pause when the cycles run out | `not_run: tool_missing`, listed in the summary, no repairs |
| A mandatory check's tool is missing | Same as above | One pause before planning, naming the tool and the config line |
| A suggested check does not apply | Refused if detected | The Architect skips it with a reason; listed in the summary |
| A non-mandatory check fails | Repairs, then a pause at the cycle limit | Repairs; at the limit it becomes a known defect, and the Build goes on to its handoff (VD-3) |
| A mandatory check fails | Repairs, then a pause at the cycle limit | Unchanged |
| Secrets, process ownership, budgets, provider outages | Their own stops | Unchanged |

A handoff with known defects already pauses for the owner's choice (AGENTS.md:45). That happens once, at the end, with the full list.

### 4.7 The summary (VF8)

- The handoff snapshot gets a **Not verified** section:
  - every check `not_run`, with the missing tool or the Architect's skip reason;
  - every non-mandatory check that still failed at the repair limit (also a known defect);
  - every criterion accepted on an Architect override without Runner evidence;
  - the Architect's own `leftToVerify` items, a new optional list on `complete_run` for things only the owner can check (for example, "the installer on macOS").
- The verification table also lists the inventory line for each tool a check used.
- The web shows the same in Run details, and the Build's final card says how many checks passed and what was not verified.
- None of this pauses the Build.

### 4.8 CLI workers

The CLI workers plan comes after this one and builds on it:
- A CLI reports the checks it ran; the Runner re-runs them through `run_evidence_command`, with their output files (VF6).
- A missing tool is `not_run`, as for any worker.
- A CLI browses with the same Playwright CLI as every other role, and the Runner trusts only what it re-runs and its own final check.
- The Architect can start the app during review (VF5), so it can look at a CLI worker's UI work even though the CLI's own server stopped when the CLI exited.

## 5. What does not change

- Evidence for each task works as in §2.1: a claim needs Runner evidence, and the Architect's override needs a reason.
- The verifiers and the independent reviews.
- Process ownership, fencing, containment, cleanup and the port authority. VF7b adds a managed process; it does not change the rules.
- Access levels and approvals.
- The legacy browser Build engine and the benchmark tracks.

## 6. Packets

Verification rules for every packet:
- The targeted tests named below, plus `npm run typecheck:runner-v2`. Packets that add imports in runner-v2/src also run `npx tsx scripts/release/test-bundle-closure.mts`. Web packets also run root `npx tsc --noEmit` and `npm run lint`.
- The full `test:runner-v2` runs only at the gate (VF9), by CI or the owner.
- A module that newly imports a mutation-capable `node:fs` API updates test/filesystem-mutation-routing.test.ts and adds a filesystem-owner review record (AGENTS.md).
- Stale tests that pin the old "detected means required" rule are rewritten to the new rule, never bent around it.
- Each packet is a pull request against main, reviewed and merged before the packets that depend on it start.

| Id | Title | Depends on | Days | Targeted tests | Acceptance |
|---|---|---|---|---|---|
| VF1 | Tool inventory: PATH lookup and version line for each check's executable and for a browser the Playwright CLI can use; `environment.inventory_recorded` before planning and on resume; shown to the Architect and in Run details | VF2, VF5 (shared files) | 1.5–2 | new test/verification-inventory.test.ts, test/native-architect-runtime.test.ts, test/build-runtime.test.ts, scripts/test-runner-v2-client.mts | • no network, a short timeout per probe, no project file written<br>• a missing tool is recorded as missing with its name<br>• the event replays; a resumed run records a new inventory<br>• the Architect's planning context lists it |
| VF2 | `not_run: tool_missing` at the per-task boundary and in the final check, on the v1 contract; no repairs and no repair cycle for it; a v1 browser check that cannot open a browser is `tool_missing` | — | 2–2.5 | test/final-verification-runtime.test.ts, test/final-verification-browser.test.ts, test/final-verification-repair.test.ts, test/final-verification-orchestration.test.ts, test/t6b-repair-boundary.test.ts, test/iv2-selected-kernel.test.ts, test/repair-cycles.test.ts | • a check whose executable is not on PATH never produces a failure, a repair task or a cycle charge<br>• a launch failure with the tool present stays a failure<br>• the Architect cannot set `tool_missing`<br>• a Build with every tool missing reaches its handoff |
| VF3 | `VerificationPlanV2`: the Architect's list with suggestions, skips with reasons and its own checks; kinds build, tests, start and other, with no browser kind; results per check; repairs keyed by check id; `verificationContractVersion` per run; v1 runs unchanged | VF2 | 3–4 | test/final-verification-contracts.test.ts, test/final-verification-submission.test.ts, test/final-verification-review.test.ts, test/final-verification-completion.test.ts, test/final-verification-scheduler.test.ts, test/w3-final-verification-prefill.test.ts, test/native-final-verification-factory.test.ts, test/architect-tools.test.ts, new test/verification-plan-v2.test.ts | • a detected check can be skipped with a reason, and a mandatory one cannot<br>• an Architect-added check runs in the fresh checkout and its facts are recorded<br>• a v1 run started before VF3 replays and finishes unchanged<br>• the prompts describe the list, not four categories |
| VF4 | `aiboard-validation.json` version 2: `checks` with `mandatory`; `start` checks with HTTP, output-line or exit-code readiness and steps; the one pause before planning for a mandatory check with a missing tool; no `next start` suggestion for a static export | VF1, VF3 | 1.5–2 | test/iv3-validation-budget-tiers.test.ts, test/final-verification-profile.test.ts, test/v3-language-profiles.test.ts, new test/project-validation-checks.test.ts, test/build-runtime.test.ts | • version 1 files behave as today; unknown keys still fail closed<br>• a CLI `start` check passes on its exit code, a server's on HTTP, a desktop test mode's on an output line<br>• a mandatory check with a missing tool pauses once, before any model call, naming the tool<br>• a Next app with `output: "export"` gets no `next start` check |
| VF5 | Architect commands in planning, in a disposable copy of the baseline; the verifiers' process tools on `architect:inspection`, bound to that copy; cleanup with the copy | — | 1.5–2.5 | test/native-architect-runtime.test.ts, test/role-capabilities.test.ts, test/process-tools.test.ts, test/evidence-tools.test.ts | • a planning-state command runs in the copy and never in the project<br>• the Architect starts a server in its copy and reads it; the process is gone after the copy is removed<br>• approvals match the verifiers' at every access level<br>• no ownership or fencing test changes |
| VF6 | Output files: `outputs` on checks and on `run_evidence_command`, kept as artifacts linked to the evidence; images offered to reviewers whose model accepts images | — | 1.5–2 | test/evidence-tools.test.ts, test/sqlite-evidence-store.test.ts, test/validation-evidence-store.test.ts, test/image-inspection.test.ts | • paths stay inside the workspace (no `..`, symlink or junction out)<br>• count and size caps; a missing file is recorded as missing, not an error<br>• a screenshot reaches a vision reviewer and is skipped for others |
| VF7a | Spike, no product code: the bundled `playwright cli` under the Runner's process containment on Windows, macOS and Linux (Docker); a written report with the session's lifetime under `process.run` and as a managed process, what is left behind after a task's tree kill, and the bundle's CLI files | — | 0.5–1 | a throwaway harness outside runner-v2/src; `npx tsx scripts/release/test-bundle-closure.mts` | • the report names the process design for VF7b, with evidence from each OS<br>• no browser process left behind in the chosen design<br>• confirms the release bundle contains the CLI client and its skill |
| VF7b | Browsing through the Playwright CLI: `playwright-cli` on PATH for Runner-started processes; the task's CLI session as a managed process, named per task and stopped with the task; the skill offered to API workers, the Architect and the verifiers; `browser.*` not registered for new runs; `aiboard browser install` and the Settings > Tools button | VF1, VF6, VF7a | 2.5–3 | test/browser-tools.test.ts, test/role-capabilities.test.ts, test/process-tools.test.ts, test/local-launcher.test.ts, test/runner-resource-cleanup.test.ts, new test/playwright-cli-session.test.ts, `npx tsc --noEmit`, `npm run lint` | • a worker opens a page and takes a screenshot that becomes an evidence file<br>• no browser process remains after the task ends, on every kill kind the Runner uses<br>• two tasks never share a session<br>• new runs list no `browser.*`; a run started before VF7b replays<br>• the install runs only on the owner's action, never inside a Build<br>• an independent review of the process change |
| VF8 | Summary: the handoff's Not verified section; `leftToVerify` on `complete_run`; a non-mandatory check failing at the repair limit becomes a known defect; Run details and the final card in the web | VF2, VF3 | 2–2.5 | test/handoff-snapshot.test.ts, test/build-runtime.test.ts, test/repair-cycles.test.ts, scripts/test-build-live-state.mts, scripts/test-build-ui-overhaul.mts, `npx tsc --noEmit`, `npm run lint` | • every `not_run` check, skip, override and `leftToVerify` item appears once<br>• a non-mandatory failure at the limit reaches the handoff as a known defect and no extra pause<br>• a mandatory failure at the limit still pauses<br>• the snapshot digest still verifies |
| VF9 | Gate and docs: the Runner guide (checks, mandatory, browsing, browser install), AGENTS.md and CLAUDE.md lines on verification and browsing, this repository's own `aiboard-validation.json` (VD-5) | VF1–VF8 | 1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, the targeted tests above; the full `test:runner-v2` by CI or the owner | green, or fixed forward; no doc still says a detected check must run or that the Runner has browser tools |

**Order.**
- First wave, in parallel, each in its own worktree: VF2, VF5, VF6, VF7a. They touch different files.
- Then VF1 (it shares build-runtime.ts with VF2 and native-architect-runtime.ts with VF5) and VF3 (after VF2).
- Then VF4, VF7b and VF8, then VF9.
- agent-prompts.ts is shared by several packets; each keeps its prompt edits small and rebases on main before its pull request.

## 7. Owner decisions

| Id | Question | Decision | Source |
|---|---|---|---|
| VD-1 | Order | After the home, before the CLI workers plan; then the AIBoard Build. Built in Claude Code sessions. | owner (2026-11-13) |
| VD-2 | Where "mandatory" is set | Only in the project's `aiboard-validation.json`, which is committed with the project. A per-Build switch in the web can come later. | owner (2026-11-13) |
| VD-3 | A non-mandatory check that still fails at the repair limit | It becomes a known defect and the Build goes on to its handoff, which pauses for the owner's choice as today. | owner (2026-11-13) |
| VD-4 | Browser download | Never automatic. `aiboard browser install` and a Settings > Tools button; an installed Chrome or Edge is used first. | owner (2026-11-13) |
| VD-5 | This repository's mandatory checks | `npm run typecheck:runner-v2`, root `npx tsc --noEmit` and `npm run lint` mandatory; targeted test groups as suggested checks; never the full `test:runner-v2`, which takes hours. | owner (2026-11-13) |
| VD-6 | How models browse | Through the Playwright CLI the Runner ships, as ordinary commands, for every role. The Runner's `browser.*` tools are retired for new runs; Playwright MCP stays available as a user-added MCP server, not a default. | owner (2026-11-13) |
| VD-7 | `requiredEvidenceKinds` in plans | Left as a label. Checking it would make the Runner decide again. | owner (2026-11-13) |

## 8. Risks

- **The v2 contract touches the most-tested part of the Runner.** About twenty test files cover final verification. VF2 lands first on v1, so the blocking stops early even if VF3 takes longer.
- **The CLI's session process.** It must never outlive its task or escape the Runner's containment. VF7a settles the design before any product code, and VF7b gets an independent review.
- **Losing the automatic console-error rule.** The built-in browser check failed on any console error. Now the Architect judges the recorded console output, unless the check it writes fails on errors itself. The summary shows what was checked.
- **Skipping becomes easy.** The Architect could skip checks it should run. Every skip needs a reason and appears in the summary, and the owner can make a check mandatory.
- **Architect commands in planning cost time.** They count against the Build's budgets like any tool call.
- **Older Runners refuse a version-2 `aiboard-validation.json`.** The error names the fix: update the Runner.
