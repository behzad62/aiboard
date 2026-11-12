# Build Verification: the Runner Records, the Architect Decides, the Owner Sets What Is Mandatory — Implementation Plan
Date: 2026-11-13
Status: Draft for the owner's approval. When approved, it runs after the AIBoard home (done 2026-11-12) and before the CLI workers plan (VD-1).
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
  7. The browser check uses an installed Chrome or Edge first; browser tools are offered only when a browser exists.
  8. The Build summary gets a "Not verified" section.
- **Estimate:** 15.5–20.5 days in nine packets (§6). A smaller first step (VF1, VF2, VF4, VF7, VF8) is 8–10.5 days; it stops the blocking and lists the gaps, but keeps the Runner's four fixed categories and gives the Architect no new tools.

## 1. What the owner asked

From the planning conversation, 2026-11-12 and 2026-11-13:
- Build leaning toward web apps was a bad design.
- Evidence for workers' tasks is useful: it shows that everything was implemented and works as intended. But if Build requires it, we cannot expect the tools for it to be installed.
- Non-web apps need a real answer: how Build works with them and how it records their evidence.
- The Runner is a tool without intelligence. It can collect, record and check, but it should not decide. There are thousands of build scenarios, and a tool cannot support them all.
- The Architect is too limited. It should be able to run commands that help verification.
- The user decides which checks are mandatory.
- Do not stop the Build to report what was missing unless it is critical. The Build summary lists what was left to verify, and what the Build could not verify.

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
- The Runner launches only the Chromium that Playwright downloads (browser-tools.ts:264-268). Nothing installs it, so on a fresh machine every browser call and every browser check fails.
- Workers and the Architect get `browser.*` tools (role-capabilities.ts:71-90, :301-310). Verifiers do not.

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
6. **No kind of app is special.** Web apps keep their browser check as one optional kind of check, not as the model for all checks.
7. **The summary says what was and was not verified.** Nothing is left out because it went well or badly.

These do not change the Runner V2 standing rules: fail-closed process ownership and fencing stay as they are, no timeout is raised to make a test pass, and every change is checked with its targeted tests plus `npm run typecheck:runner-v2`.

## 4. Design

### 4.1 The tool inventory (VF1)

Before planning, and again on resume, the Runner records what this machine has:
- Git and Node, which it already requires.
- For each detected or declared check, its executable, looked up on PATH the way language servers are (extensions.md: the Runner resolves a bare command once and records the path). Then `--version` (or the family's version flag), with a short timeout and no network.
- A browser: installed Chrome, installed Edge, or Playwright's Chromium (§4.5).

It records one `environment.inventory_recorded` event: for each tool, found or not, the resolved path, and the first line of its version. The Architect sees it in its planning context, and the web shows it in Run details. It decides nothing.

### 4.2 Missing tool: "not run" (VF2)

- When a check's executable is not found on PATH, the Runner records the check as `not_run` with reason `tool_missing`, naming the executable. It does this at the per-task boundary and in the final check.
- It never reports a failure for it, never asks for repairs, and never spends a repair cycle.
- A launch that fails for any other reason stays a failure, as today.
- A browser check with no browser is `not_run: tool_missing` (browser).
- VF2 lands on today's contract first, as a third result next to green and failed, so the blocking stops before VF3.

### 4.3 The final check becomes the Architect's list (VF3, VF4)

`VerificationPlanV2` replaces the four fixed entries:

```ts
interface VerificationCheckV2 {
  id: string;                       // stable within the run
  label: string;
  kind: "build" | "tests" | "start" | "browser" | "other";
  origin: "detected" | "project" | "architect";
  mandatory: boolean;               // only from aiboard-validation.json; the Architect cannot set it
  run?: { executable: string; args: string[]; cwd?: string; timeoutMs?: number };            // build, tests, other
  start?: {                          // start: run a program and see that it works
    executable: string; args: string[]; timeoutMs?: number;
    ready: { http?: { path: string; status: number } } | { outputLine: string } | { exitCode: number };
    steps?: { label: string; executable: string; args: string[] }[];
  };
  browser?: { startCheckId: string; path: string; policy: BrowserPolicy };                  // opens a started app
  outputs?: string[];                // workspace-relative paths or globs kept as evidence (VF6)
}
interface VerificationPlanV2 {
  version: 2;
  checks: VerificationCheckV2[];
  skipped: { checkId: string; reason: string }[];   // suggested checks the Architect drops
}
```

- **Prefill.** The Runner offers its detected checks and the project's declared ones. The Architect keeps them, changes their commands, skips them with a reason, or adds its own. A mandatory check cannot be skipped or changed.
- **Results** per check: `passed`, `failed` (exit code, timeout or policy), or `not_run` (`tool_missing`, set by the Runner, or `skipped`, set by the Architect's plan).
- **`start` covers every kind of program.**
  - A server is ready on an HTTP status, on a port the Runner leases, as runtime_smoke does today.
  - A CLI is ready on its exit code.
  - A desktop app's own headless or test mode is ready on a line of its output.
  - Optional steps run against it, as runtime_smoke's steps do today.
- **Repairs** are keyed by check id instead of category. The Architect still plans them as today.
- **Old runs.** A run started before VF3 keeps the v1 contract to the end; its events replay unchanged, and the v1 tests stay. A new run records `verificationContractVersion: 2` when it starts.
- **Project checks (VF4).** `aiboard-validation.json` version 2 adds `checks` in the same shape, each with `mandatory`, next to the existing tiers. A version-1 file still works. An older Runner refuses a version-2 file with a clear error (project-validation-config.ts already fails closed on a malformed file).
- **Detection fixes (VF4).** A Next app with `output: "export"` gets no `next start` suggestion. Detection stays a fallback for projects that declare nothing.
- **A mandatory check whose tool is missing** stops once, before planning, naming the tool and the config line (§4.6). It is the one pause this plan adds, and it comes before any work is spent.

### 4.4 The Architect's tools (VF5)

- `run_evidence_command` also works in the planning state, in a disposable copy of the baseline revision, created when first used (as the review copy is today). The Architect can check a tool's version, run the existing tests, or run the program to learn how it behaves before it plans.
- The process tools the verifiers have (`process.start`, `poll`, `read_output`, `signal`, `interact`, `write_stdin`, `list`; role-capabilities.ts:56-68) join `architect:inspection`, bound to the Architect's disposable copy. The Architect can start the app and look at it: with `browser.*` when a browser exists, or through the program's output.
- They run under the Build's access level, with the same approvals as the verifiers' commands. Processes the Architect starts are stopped when its copy is removed, the way verifier processes are; no ownership or fencing rule changes.

### 4.5 Evidence from any app (VF6) and the browser (VF7)

- **Output files (VF6).** A check, or a `run_evidence_command` call, may list `outputs`: paths or globs in its workspace, with a cap on count and size. After the command exits, the Runner stores those files as artifacts linked to the evidence record. Images go to reviewers whose model accepts images, as `image.inspect` and the visual artifact output already do (image-tools.ts). A desktop UI test, a mobile emulator test or a game's screenshot script then gets the same visual review that web apps get from the browser.
- **The browser (VF7).**
  - The Runner tries an installed Chrome, then an installed Edge (Playwright's `channel` option), then Playwright's own Chromium. The inventory records which one it found. Edge ships with Windows, so most Windows machines need no download.
  - `browser.*` tools are registered only when a browser was found (role-capabilities.ts already has optional tools that depend on configuration).
  - A browser download happens only as the owner's own action: `aiboard browser install`, or a button in Settings > Tools, which runs Playwright's Chromium install (VD-4). A Build never downloads a browser on its own.
  - On Linux, a launch that fails for missing system libraries is recorded as `tool_missing` with the first error line. The Runner guide says how to install them; that needs root, so the Runner never does it.
- Moving `browser.*` to an MCP connector is not part of this plan (VD-6).

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
- Each CLI browses with its own tools; the Runner trusts only what it re-runs and its own final check.
- The Architect can start the app during review (VF5), so it can look at a CLI worker's UI work even though the CLI's own server stopped when the CLI exited.

## 5. What does not change

- Evidence for each task works as in §2.1: a claim needs Runner evidence, and the Architect's override needs a reason.
- The verifiers and the independent reviews.
- Process ownership, fencing, containment, cleanup and the port authority.
- Access levels and approvals.
- The legacy browser Build engine and the benchmark tracks.

## 6. Packets

Verification rules for every packet:
- The targeted tests named below, plus `npm run typecheck:runner-v2`. Packets that add imports in runner-v2/src also run `npx tsx scripts/release/test-bundle-closure.mts`. Web packets also run root `npx tsc --noEmit` and `npm run lint`.
- The full `test:runner-v2` runs only at the gate (VF9), by CI or the owner.
- A module that newly imports a mutation-capable `node:fs` API updates test/filesystem-mutation-routing.test.ts and adds a filesystem-owner review record (AGENTS.md).
- Stale tests that pin the old "detected means required" rule are rewritten to the new rule, never bent around it.

| Id | Title | Depends on | Days | Targeted tests | Acceptance |
|---|---|---|---|---|---|
| VF1 | Tool inventory: PATH lookup and version line for each check's executable and for a browser; `environment.inventory_recorded` before planning and on resume; shown to the Architect and in Run details | — | 1.5–2 | new test/verification-inventory.test.ts, test/native-architect-runtime.test.ts, test/build-runtime.test.ts, scripts/test-runner-v2-client.mts | • no network, a short timeout per probe, no project file written<br>• a missing tool is recorded as missing with its name<br>• the event replays; a resumed run records a new inventory<br>• the Architect's planning context lists it |
| VF2 | `not_run: tool_missing` at the per-task boundary and in the final check, on the v1 contract; no repairs and no repair cycle for it; a browser that cannot open is `tool_missing` | — | 2–2.5 | test/final-verification-runtime.test.ts, test/final-verification-browser.test.ts, test/final-verification-repair.test.ts, test/final-verification-orchestration.test.ts, test/t6b-repair-boundary.test.ts, test/iv2-selected-kernel.test.ts, test/repair-cycles.test.ts | • a check whose executable is not on PATH never produces a failure, a repair task or a cycle charge<br>• a launch failure with the tool present stays a failure<br>• the Architect cannot set `tool_missing`<br>• a Build with every tool missing reaches its handoff |
| VF3 | `VerificationPlanV2`: the Architect's list with suggestions, skips with reasons and its own checks; results per check; repairs keyed by check id; `verificationContractVersion` per run; v1 runs unchanged | VF2 | 3.5–4.5 | test/final-verification-contracts.test.ts, test/final-verification-submission.test.ts, test/final-verification-review.test.ts, test/final-verification-completion.test.ts, test/final-verification-scheduler.test.ts, test/w3-final-verification-prefill.test.ts, test/native-final-verification-factory.test.ts, test/architect-tools.test.ts, new test/verification-plan-v2.test.ts | • a detected check can be skipped with a reason, and a mandatory one cannot<br>• an Architect-added check runs in the fresh checkout and its facts are recorded<br>• a v1 run started before VF3 replays and finishes unchanged<br>• the prompts describe the list, not four categories |
| VF4 | `aiboard-validation.json` version 2: `checks` with `mandatory`; `start` checks with HTTP, output-line or exit-code readiness; the one pause before planning for a mandatory check with a missing tool; no `next start` suggestion for a static export | VF1, VF3 | 1.5–2 | test/iv3-validation-budget-tiers.test.ts, test/final-verification-profile.test.ts, test/v3-language-profiles.test.ts, new test/project-validation-checks.test.ts, test/build-runtime.test.ts | • version 1 files behave as today; unknown keys still fail closed<br>• a CLI `start` check passes on its exit code, a server's on HTTP, a desktop test mode's on an output line<br>• a mandatory check with a missing tool pauses once, before any model call, naming the tool<br>• a Next app with `output: "export"` gets no `next start` check |
| VF5 | Architect commands in planning, in a disposable copy of the baseline; the verifiers' process tools on `architect:inspection`, bound to that copy; cleanup with the copy | — | 1.5–2.5 | test/native-architect-runtime.test.ts, test/role-capabilities.test.ts, test/process-tools.test.ts, test/evidence-tools.test.ts | • a planning-state command runs in the copy and never in the project<br>• the Architect starts a server in its copy and reads it with `browser.*`; the process is gone after the copy is removed<br>• approvals match the verifiers' at every access level<br>• no ownership or fencing test changes |
| VF6 | Output files: `outputs` on checks and on `run_evidence_command`, kept as artifacts linked to the evidence; images offered to reviewers whose model accepts images | — | 1.5–2 | test/evidence-tools.test.ts, test/sqlite-evidence-store.test.ts, test/validation-evidence-store.test.ts, test/image-inspection.test.ts | • paths stay inside the workspace (no `..`, symlink or junction out)<br>• count and size caps; a missing file is recorded as missing, not an error<br>• a screenshot reaches a vision reviewer and is skipped for others |
| VF7 | Browser: installed Chrome, then Edge, then Playwright's Chromium; `browser.*` only when one exists; `aiboard browser install` and the Settings > Tools button; Linux library errors recorded | VF1 | 1–1.5 | test/browser-tools.test.ts, test/role-capabilities.test.ts, test/local-launcher.test.ts, `npx tsc --noEmit`, `npm run lint` | • with no browser, no role lists `browser.*` and browser checks are `not_run`<br>• the install runs only on the owner's action, never inside a Build<br>• the inventory names the browser used |
| VF8 | Summary: the handoff's Not verified section; `leftToVerify` on `complete_run`; a non-mandatory check failing at the repair limit becomes a known defect; Run details and the final card in the web | VF2, VF3 | 2–2.5 | test/handoff-snapshot.test.ts, test/build-runtime.test.ts, test/repair-cycles.test.ts, scripts/test-build-live-state.mts, scripts/test-build-ui-overhaul.mts, `npx tsc --noEmit`, `npm run lint` | • every `not_run` check, skip, override and `leftToVerify` item appears once<br>• a non-mandatory failure at the limit reaches the handoff as a known defect and no extra pause<br>• a mandatory failure at the limit still pauses<br>• the snapshot digest still verifies |
| VF9 | Gate and docs: the Runner guide (checks, mandatory, browser install), AGENTS.md and CLAUDE.md lines on verification, this repository's own `aiboard-validation.json` (VD-5) | VF1–VF8 | 1 | `npm run typecheck:runner-v2`, root `npx tsc --noEmit`, `npm run lint`, the targeted tests above; the full `test:runner-v2` by CI or the owner | green, or fixed forward; no doc still says a detected check must run |

**Parallel work.** VF1, VF2, VF5 and VF6 do not depend on each other and can run in separate Claude Code sessions, each in its own worktree. VF2 and VF3 both touch final-verification-*.ts, so VF3 waits for VF2. agent-prompts.ts is shared by VF1, VF3 and VF5; the later packet rebases.

**Smaller first step.** VF1, VF2, VF4 (without the `checks` that need VF3: only `mandatory` on the tiers and the static-export fix), VF7 and VF8 take 8–10.5 days. They stop the blocking and list the gaps. They keep the four fixed categories and give the Architect no new tools.

## 7. Owner decisions

| Id | Question | Recommendation | Source |
|---|---|---|---|
| VD-1 | Order | After the home, before the CLI workers plan; then the AIBoard Build. Built in Claude Code sessions. | owner (2026-11-13) |
| VD-2 | Where "mandatory" is set | Only in the project's `aiboard-validation.json`, which is committed with the project. A per-Build switch in the web can come later. | proposed |
| VD-3 | A non-mandatory check that still fails at the repair limit | It becomes a known defect and the Build goes on to its handoff, which pauses for the owner's choice as today. | proposed |
| VD-4 | Browser download | Never automatic. `aiboard browser install` and a Settings > Tools button; an installed Chrome or Edge is used first. | proposed |
| VD-5 | This repository's mandatory checks | `npm run typecheck:runner-v2`, root `npx tsc --noEmit` and `npm run lint` mandatory; targeted test groups as suggested checks; never the full `test:runner-v2`, which takes hours. | proposed |
| VD-6 | Moving `browser.*` to an MCP connector | Not in this plan. It can be decided after CLI workers. | proposed |
| VD-7 | `requiredEvidenceKinds` in plans | Left as a label. Checking it would make the Runner decide again. | proposed |

## 8. Risks

- **The v2 contract touches the most-tested part of the Runner.** About twenty test files cover final verification. VF2 lands first on v1, so the blocking stops early even if VF3 takes longer.
- **Skipping becomes easy.** The Architect could skip checks it should run. Every skip needs a reason and appears in the summary, and the owner can make a check mandatory.
- **Architect commands in planning cost time.** They count against the Build's budgets like any tool call.
- **Older Runners refuse a version-2 `aiboard-validation.json`.** The error names the fix: update the Runner.
