import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ToolBenchSessions } from "../runner-v2/src/toolbench-session";
import { ArtifactStore } from "../runner-v2/src/artifact-store";
import { createExecutionHost } from "../runner-v2/src/execution-host";
import { snapshotNativeBuildAmbientEnvironment } from "../runner-v2/src/native-build-factory";
import { emptyRunnerCapabilitiesConfig } from "../runner-v2/src/runner-capabilities-config";
import {
  getNativeToolBenchPack, nativeToolBenchReferenceFiles,
  NATIVE_TOOLBENCH_SUITE, LEGACY_NATIVE_TOOLBENCH_SUITE, NATIVE_TOOLBENCH_VARIANT_SUITE, NATIVE_TOOLBENCH_BROWSER_SUITE, NATIVE_TOOLBENCH_SKILLS_SUITE,
  NATIVE_TOOLBENCH_EXTENDED_SUITE, NATIVE_TOOLBENCH_BROWSER_FORM_SUITE, NATIVE_TOOLBENCH_EXTENDED_VERSION,
} from "../lib/benchmark/toolreliability/native-cases";
import { qualifyNativeToolBench } from "../lib/benchmark/toolreliability/native-qualification";
import { NATIVE_TOOL_COVERAGE, nativeCoverageReport, capabilitiesForCase } from "../lib/benchmark/toolreliability/native-coverage";
import type { AgentModelRequest, ModelTurn, ToolResult } from "../runner-v2/src/agent-contracts";
import type { ToolBenchSessionSnapshot } from "../runner-v2/src/toolbench-contracts";
import type { WorkBenchCaseOption } from "../lib/benchmark/workbench/corpus";

type Step = [name: string, args: Record<string, unknown>];
type Planner = (results: ToolResult[]) => Step;
const finish: Step = ["finish_toolbench", {}];
const text = (result: ToolResult | undefined) => JSON.stringify(result?.content ?? []);
const last = (results: ToolResult[], tool: string) => [...results].reverse().find((result) => result.toolName === tool);
const jsonOf = (result: ToolResult | undefined) => {
  const block = result?.content.find((entry) => entry.type === "json");
  return block?.type === "json" ? block.value as Record<string, unknown> : undefined;
};

/** Each planner looks only at real tool results, like a model would. `variant` drives the negative controls. */
function plannerFor(id: string, variant: string | undefined): Planner {
  if (id.includes("code-navigation")) {
    const v6 = id.endsWith("-v6");
    const basic: Step[] = [["fs.search", { path: "src", pattern: "applyDiscount(" }], ["fs.read", { path: "src/pricing/discount.mjs" }],
      ["fs.patch", { path: "src/pricing/discount.mjs", search: "(1 - percent)", replace: "(1 - percent / 100)" }],
      ["fs.write", { path: "callers.json", content: '["src/cart.mjs","src/invoice/render.mjs"]\n' }], finish];
    if (!v6) return (results) => basic[results.length]!;
    const discount = { search: "(1 - percent)", replace: "(1 - percent / 100)" };
    const tax = { search: "(1 + percent)", replace: "(1 + percent / 100)" };
    const edits: Step[] = [
      ["fs.search", { path: "src", pattern: "applyDiscount(" }],
      ["fs.search", { path: "src", pattern: "applyTax(" }],
      ["fs.read", { path: "src/pricing/discount.mjs" }],
      ...(variant === "split-patches"
        ? [["fs.patch", { path: "src/pricing/discount.mjs", edits: [discount] }], ["fs.patch", { path: "src/pricing/discount.mjs", edits: [tax] }]] as Step[]
        : [["fs.patch", { path: "src/pricing/discount.mjs", edits: [discount, tax] }]] as Step[]),
      ["fs.write", { path: "callers.json", content: '{"applyDiscount":["src/cart.mjs","src/invoice/render.mjs"],"applyTax":["src/invoice/render.mjs"]}\n' }],
      finish,
    ];
    return (results) => edits[results.length]!;
  }
  if (id.includes("continued-search")) {
    return (results) => {
      const found = results.some((result) => result.toolName === "fs.search" && text(result).includes("amount=-1250"));
      if (found) return results.some((result) => result.toolName === "fs.write") ? finish : ["fs.write", { path: "answer.json", content: '{"id":"L27-04"}' }];
      // Negative control: one big page instead of continuing the cursor.
      if (variant === "no-continuation") return ["fs.search", { path: "ledger", pattern: "LEDGER_ENTRY", maxMatches: 500 }];
      const previous = jsonOf(last(results, "fs.search"));
      return previous?.cursor ? ["fs.search", { path: "ledger", pattern: "LEDGER_ENTRY", cursor: previous.cursor }] : ["fs.search", { path: "ledger", pattern: "LEDGER_ENTRY" }];
    };
  }
  if (id.includes("artifact-retrieval")) {
    const v6 = id.endsWith("-v6");
    return (results) => {
      const command = last(results, "run_evidence_command");
      if (!command) return ["run_evidence_command", { label: "Report", command: "node", args: v6 ? ["emit-report.mjs", "alpha beta", "gamma"] : ["emit-report.mjs"] }];
      const hash = text(command).match(/stdout \(last \d+ of \d+ bytes; artifact\.read hash=([a-f0-9]{64})/)?.[1];
      assert.ok(hash, `stdout must exceed the inline tail and name its artifact: ${text(command).slice(0, 400)}`);
      const reads = results.filter((result) => result.toolName === "artifact.read");
      const found = reads.some((result) => text(result).includes("INCIDENT_ID=inc-89fea6fda378"));
      if (found) {
        if (v6 && !last(results, "fs.read")) return ["fs.read", { path: "source.mjs", startLine: variant === "oversized-read" ? 1700 : 1750, endLine: 1780 }];
        return results.some((result) => result.toolName === "fs.write") ? finish : ["fs.write", { path: "answer.json", content: v6 ? '{"incidentId":"inc-89fea6fda378","checksum":"r7-cobalt-9217"}' : '{"incidentId":"inc-89fea6fda378"}' }];
      }
      // Advance by what the last page actually returned (pages are capped by the inline budget).
      // Negative control: re-read the first page once before advancing (wasteful, but still finds the value).
      const previous = jsonOf(reads.at(-1));
      const offset = !previous || (variant === "repeat-range" && reads.length === 1) ? 0 : (previous.offset as number) + (previous.returnedBytes as number);
      return ["artifact.read", { hash, offset, maxBytes: 65_536 }];
    };
  }
  if (id.includes("interactive-process")) {
    return (results) => {
      if (id.endsWith("-v6")) {
        const started = jsonOf(last(results, "process.start"));
        if (!started) return ["process.start", { command: "node", args: ["quiz.mjs"], interactive: true }];
        const processId = started.processId as string;
        const reads = results.filter(result => result.toolName === "process.read_output");
        const cursor = jsonOf(reads.at(-1))?.cursor as string | undefined;
        const output = reads.map(text).join("");
        const code = output.match(/access code (K[0-9A-F]{6})/)?.[1];
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (!code || !url) return ["process.read_output", { processId, waitMs: 2_000, ...(cursor ? { cursor } : {}) }];
        if (!last(results, "browser.open")) return ["browser.open", { url }];
        const snapshots = results.filter(result => result.toolName === "browser.snapshot");
        if (snapshots.length === 0) return ["browser.snapshot", {}];
        const fills = results.filter(result => result.toolName === "browser.fill").length;
        if (fills === 0) return ["browser.fill", { selector: "#name", value: "Ada Lovelace" }];
        if (fills === 1) return ["browser.fill", { selector: "#team", value: "Analytical Engines" }];
        if (!last(results, "browser.click")) return ["browser.click", { selector: "#submit" }];
        if (snapshots.length === 1 || !text(snapshots.at(-1)).includes("Saved: Ada Lovelace")) return ["browser.snapshot", {}];
        const writes = results.filter(result => result.toolName === "process.write_stdin");
        if (writes.length === 0) return ["process.write_stdin", { processId, writeId: "answer-1", data: code, appendNewline: true, closeInput: true }];
        if (writes.length === 1) return ["process.write_stdin", { processId, writeId: "answer-1", data: code, appendNewline: true, closeInput: true }];
        if (!reads.some(result => text(result).includes("BYE"))) return ["process.read_output", { processId, waitMs: 3_000, ...(cursor ? { cursor } : {}) }];
        if (!last(results, "process.signal")) return ["process.signal", { processId, signal: "SIGTERM" }];
        return finish;
      }
      // Negative control: try to forge the program-written output with a filesystem tool first.
      if (variant === "forge" && results.length === 0) return ["fs.write", { path: "session.json", content: '{"expected":"X","received":["X"],"eof":true}' }];
      const started = jsonOf(last(results, "process.start"));
      if (!started) return ["process.start", { command: "node", args: ["quiz.mjs"], interactive: true }];
      const processId = started.processId as string;
      const reads = results.filter((result) => result.toolName === "process.read_output");
      const code = reads.map(text).join("").match(/access code (K[0-9A-F]{6})/)?.[1];
      const writes = results.filter((result) => result.toolName === "process.write_stdin");
      const cursor = jsonOf(reads.at(-1))?.cursor as string | undefined;
      if (!code) return ["process.read_output", { processId, waitMs: 2_000, ...(cursor ? { cursor } : {}) }];
      // A retry with the same writeId must return the settled outcome without sending again.
      // The negative control keeps input open and then sends the code again under a NEW writeId
      // (a real second delivery), which the hidden verifier must catch.
      if (writes.length === 0) return ["process.write_stdin", { processId, writeId: "answer-1", data: code, appendNewline: true, ...(variant === "duplicate" ? {} : { closeInput: true }) }];
      if (writes.length === 1) return ["process.write_stdin", { processId, writeId: variant === "duplicate" ? "answer-2" : "answer-1", data: code, appendNewline: true, closeInput: true }];
      if (writes.length === 2 && variant !== "duplicate") assert.equal(jsonOf(writes[1])?.deduplicated, true, `same-writeId retry is deduplicated: ${text(writes[1])}`);
      if (!reads.slice(-1).some((result) => text(result).includes("BYE"))) return ["process.read_output", { processId, waitMs: 3_000, ...(cursor ? { cursor } : {}) }];
      return finish;
    };
  }
  if (id.includes("project-skill")) {
    return (results) => {
      if (!last(results, "list_skills")) return ["list_skills", {}];
      if (!last(results, "read_skill")) {
        const list = jsonOf(last(results, "list_skills")) as unknown as Array<{ id: string }>;
        return ["read_skill", { id: list[0]!.id }];
      }
      return results.some((result) => result.toolName === "fs.write") ? finish : ["fs.write", { path: "answer.json", content: '{"port":9217}' }];
    };
  }
  if (id.includes("browser-form")) {
    return (results) => {
      const started = jsonOf(last(results, "process.start"));
      if (!started) return ["process.start", { command: "node", args: ["form-server.mjs"] }];
      const processId = started.processId as string;
      const url = results.map(text).join("").match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (!url) return ["process.read_output", { processId, waitMs: 2_000 }];
      const names = results.map((result) => result.toolName);
      if (!names.includes("browser.open")) return ["browser.open", { url }];
      const snapshots = names.filter((name) => name === "browser.snapshot").length;
      if (snapshots === 0) return ["browser.snapshot", {}];
      const fills = names.filter((name) => name === "browser.fill").length;
      if (fills === 0) return ["browser.fill", { selector: "#name", value: "Ada Lovelace" }];
      if (fills === 1) return ["browser.fill", { selector: "#team", value: "Analytical Engines" }];
      if (!names.includes("browser.click")) return ["browser.click", { selector: "#submit" }];
      if (snapshots === 1 || !text(last(results, "browser.snapshot")).includes("Saved: Ada Lovelace")) return ["browser.snapshot", {}];
      if (!names.includes("process.signal")) return ["process.signal", { processId, signal: "SIGTERM" }];
      return finish;
    };
  }
  throw new Error(`Missing planner for ${id}`);
}

interface Outcome { snapshot: ToolBenchSessionSnapshot; qualification: ReturnType<typeof qualifyNativeToolBench>; verifierPassed: boolean; workspace: Record<string, string> }

async function runCase(option: WorkBenchCaseOption, variant?: string): Promise<Outcome> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "toolbench-v5-")));
  const project = join(root, "project"); const state = join(root, "state");
  mkdirSync(project); mkdirSync(state);
  for (const [path, content] of Object.entries(option.case.fixtureFiles!)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content); }
  const hiddenVerifier = readFileSync(join(project, "verifier.mjs"), "utf8");
  rmSync(join(project, "verifier.mjs"));
  for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Fixture"]]) execFileSync("git", args, { cwd: project, stdio: "pipe", windowsHide: true });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const planner = plannerFor(option.id, variant);
  const qualification = option.case.nativeQualification!;
  const config = { runtimeId: "test:model", providerId: "test", modelId: "model", transport: "openai-compatible" as const, secret: "test", capabilities: ["tools"], priority: 0, billingBasis: "api_priced" as const, inputCostMicrosPerMillion: 100_000, outputCostMicrosPerMillion: 200_000 };
  let turn = 0;
  const sessions = new ToolBenchSessions({ projectRoot: project, stateDirectory: state, providerConfigs: { load: () => [config], save() {}, close() {} }, executionHost: host, capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    modelFactory: () => ({ async complete(request: AgentModelRequest): Promise<ModelTurn> {
      assert.equal(existsSync(join(project, "verifier.mjs")), false, "Hidden scoring stays outside the model workspace during execution.");
      const results = request.messages.filter((message) => message.role === "tool").map((message) => message.content as ToolResult);
      const [name, args] = planner(results);
      turn++;
      return { stopReason: "tool_calls", blocks: [{ type: "tool_call", callId: `call-${turn}`, name, arguments: args }], usage: { inputTokens: 100, outputTokens: 10 } };
    } }),
  });
  try {
    await sessions.start({ sessionId: "solo", runtimeId: config.runtimeId, prompt: option.case.prompt.userRequest, allowedCommands: option.case.allowedCommands,
      hiddenPaths: ["verifier.mjs", "verifier-result.json", "case-meta.json"], protectedPaths: option.case.executionPolicy!.protectedPaths,
      // Same rule as the solo adapter: program-written outputs cannot be created with filesystem tools.
      editablePaths: qualification.requiresBrowser || qualification.processGeneratedOutputs ? [] : option.case.executionPolicy!.editablePaths,
      budget: { maxModelCalls: 40, maxInputTokens: 5_000_000, maxOutputTokens: 750_000, maxToolCalls: 90 }, maxWallClockMs: 120_000,
      skills: qualification.requiresSkills ?? qualification.profile.includes("skill"), browser: Boolean(qualification.requiresBrowser) });
    let snapshot: ToolBenchSessionSnapshot;
    do { await new Promise((r) => setTimeout(r, 20)); snapshot = await sessions.get("solo"); } while (snapshot.status === "running");
    snapshot = await sessions.stop("solo");
    assert.equal(snapshot.status, "completed", JSON.stringify({ reason: snapshot.reason, errors: snapshot.tools.filter((t) => t.isError) }));
    const verdict = qualifyNativeToolBench(option.case, { observability: { tools: snapshot.tools, evidence: snapshot.evidence } }, snapshot.toolEvidence);
    writeFileSync(join(project, "verifier.mjs"), hiddenVerifier);
    try { execFileSync(process.execPath, ["verifier.mjs"], { cwd: project, stdio: "pipe", timeout: 10_000, windowsHide: true }); } catch { /* the result file carries the verdict */ }
    const verifierPassed = JSON.parse(readFileSync(join(project, "verifier-result.json"), "utf8")).passed === true;
    const workspace = Object.fromEntries(["session.json", "submission.json", "answer.json"].filter((path) => existsSync(join(project, path))).map((path) => [path, readFileSync(join(project, path), "utf8")]));
    return { snapshot, qualification: verdict, verifierPassed, workspace };
  } finally {
    await sessions.close(); await host.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())), "Delete only owned test directory.");
    rmSync(root, { recursive: true, force: true });
  }
}

const failed = (outcome: Outcome) => outcome.qualification.checks.filter((check) => !check.passed).map((check) => check.id);

// ---- Pack identity -------------------------------------------------------------------------------
const extended = getNativeToolBenchPack(NATIVE_TOOLBENCH_EXTENDED_SUITE)!;
const browserForm = getNativeToolBenchPack(NATIVE_TOOLBENCH_BROWSER_FORM_SUITE)!;
assert.deepEqual(extended.caseIds, ["toolbench-native-code-navigation-v5", "toolbench-native-continued-search-v5", "toolbench-native-artifact-retrieval-v5", "toolbench-native-interactive-process-v5", "toolbench-native-project-skill-v5"]);
const compact = getNativeToolBenchPack(NATIVE_TOOLBENCH_SUITE)!;
assert.equal(getNativeToolBenchPack(LEGACY_NATIVE_TOOLBENCH_SUITE)!.caseCount, 6, "old suite identity is readable");
assert.equal(compact.caseCount, 7);
const processBrowser = compact.cases.find(option => option.id.endsWith("interactive-process-v6"))!.case;
assert.equal(processBrowser.nativeQualification?.requiresBrowser, true);
assert.equal(processBrowser.nativeQualification?.processGeneratedOutputs, true);
assert.ok(processBrowser.nativeQualification?.coverage?.includes("browser_form"));
assert.equal(processBrowser.budget.maxModelCalls, 36);
const atomicCase = compact.cases.find(option => option.id.endsWith("code-navigation-v6"))!.case;
const boundedCase = compact.cases.find(option => option.id.endsWith("artifact-retrieval-v6"))!.case;
assert.equal(atomicCase.nativeQualification!.minimumAtomicEdits, 2);
assert.equal(boundedCase.nativeQualification!.requiredReadText!.maxLines, 64);
assert.deepEqual(boundedCase.nativeQualification!.requiredCommand!.args, ["emit-report.mjs", "alpha beta", "gamma"]);
assert.ok(atomicCase.nativeQualification!.coverage!.includes("atomic_multi_edit"));
assert.ok(boundedCase.nativeQualification!.coverage!.includes("bounded_file_read"));
assert.ok(boundedCase.nativeQualification!.coverage!.includes("command_arguments"));
for (const option of compact.cases) {
  assert.equal(option.case.caseVersion, "6.2.0");
  assert.ok(option.case.nativeQualification?.coverage?.length);
  assert.equal(option.case.nativeQualification!.profile, NATIVE_TOOLBENCH_SUITE);
  for (const capability of option.case.nativeQualification!.coverage!) assert.ok(NATIVE_TOOL_COVERAGE.find(row => row.id === capability)?.cases.includes(option.id), `v6 manifest missing ${option.id}: ${capability}`);
  assert.doesNotThrow(() => nativeToolBenchReferenceFiles(option.id));
}
for (const option of [...extended.cases, ...browserForm.cases]) {
  assert.equal(option.case.caseVersion, NATIVE_TOOLBENCH_EXTENDED_VERSION);
  assert.ok(option.case.nativeQualification?.coverage?.length, `${option.id} declares the capabilities it measures`);
  assert.deepEqual([...capabilitiesForCase(option.case)].sort(), [...option.case.nativeQualification!.coverage!].sort());
  for (const capability of option.case.nativeQualification!.coverage!) {
    assert.ok(NATIVE_TOOL_COVERAGE.find((entry) => entry.id === capability)?.cases.includes(option.id), `manifest lists ${option.id} under ${capability}`);
  }
  assert.ok(option.case.executionPolicy!.hiddenPaths!.includes("verifier.mjs"), "hidden scoring stays out of the model workspace");
  assert.doesNotThrow(() => nativeToolBenchReferenceFiles(option.id));
}
const allCaseIds = new Set([NATIVE_TOOLBENCH_SUITE, LEGACY_NATIVE_TOOLBENCH_SUITE, NATIVE_TOOLBENCH_VARIANT_SUITE, NATIVE_TOOLBENCH_BROWSER_SUITE, NATIVE_TOOLBENCH_SKILLS_SUITE, NATIVE_TOOLBENCH_EXTENDED_SUITE, NATIVE_TOOLBENCH_BROWSER_FORM_SUITE].flatMap((id) => getNativeToolBenchPack(id)!.caseIds));
for (const capability of NATIVE_TOOL_COVERAGE) for (const id of capability.cases) assert.ok(allCaseIds.has(id), `manifest case ${id} exists`);
console.log("PASS v5 historical and v6 compact identities and coverage manifest consistency");

// ---- Coverage report semantics -------------------------------------------------------------------
{
  const report = nativeCoverageReport({
    selectedCaseIds: ["toolbench-native-continued-search-v5", "toolbench-native-artifact-retrieval-v5", "toolbench-native-browser-form-v5"],
    attempts: [
      { caseId: "toolbench-native-continued-search-v5", availableTools: ["fs.search", "fs.write"], succeededTools: ["fs.search", "fs.write"], passed: true },
      { caseId: "toolbench-native-artifact-retrieval-v5", availableTools: ["run_evidence_command", "fs.write"], succeededTools: ["run_evidence_command"], passed: false },
    ],
    environment: { browser: false, vision: false },
  });
  const status = Object.fromEntries(report.rows.map((row) => [row.capability, row.status]));
  assert.equal(status.search_continuation, "verified");
  assert.equal(status.artifact_retrieval, "unsupported", "artifact.read was not offered");
  assert.equal(status.evidence_command, "exercised", "ran, but its covering case failed");
  assert.equal(status.browser_form, "excluded_by_environment");
  assert.equal(status.patch_recovery, "not_tested");
  assert.equal(status.git_inspection, "not_tested");
  assert.equal(status.image_inspection, "not_tested");
  assert.equal(report.fullCoverage, false);
  const available = nativeCoverageReport({ selectedCaseIds: ["toolbench-native-continued-search-v5"], attempts: [{ caseId: "toolbench-native-continued-search-v5", succeededTools: [], passed: false }], environment: { browser: true, vision: true } });
  assert.equal(available.rows.find((row) => row.capability === "search_continuation")?.status, "available", "tool-name availability alone never verifies");
  console.log("PASS coverage statuses: verified / exercised / available / not tested / unsupported / excluded by environment");
}

// ---- Real sessions: every v5 case passes with real tools; negative controls fail -------------------
const only = process.argv[2];
const browserAvailable = process.env.TOOLBENCH_SKIP_BROWSER !== "1";
for (const option of [...extended.cases, ...(browserAvailable ? browserForm.cases : [])].filter((entry) => !only || entry.id.includes(only))) {
  const outcome = await runCase(option);
  assert.equal(outcome.qualification.passed, true, `${option.id}: ${failed(outcome)}`);
  assert.equal(outcome.verifierPassed, true, `${option.id}: hidden verifier`);
  assert.ok(outcome.snapshot.availableTools?.includes("finish_toolbench"), "the session reports what it offered");
  console.log(`PASS ${option.id}: real tools, hidden verifier and qualification`);
}

// The consolidated pack must exercise the actual native tools, not just pass fixture assertions.
for (const option of compact.cases.filter(entry => /code-navigation-v6|artifact-retrieval-v6|interactive-process-v6/.test(entry.id) && (!only || entry.id.includes(only)))) {
  const outcome = await runCase(option);
  assert.equal(outcome.qualification.passed, true, `${option.id}: ${failed(outcome)}`);
  assert.equal(outcome.verifierPassed, true, `${option.id}: hidden verifier`);
  console.log(`PASS ${option.id}: real native tools, bounded evidence and hidden behavioral verifier`);
}
if (!only || "code-navigation".includes(only)) {
  const outcome = await runCase(compact.cases.find(entry => entry.id.endsWith("code-navigation-v6"))!, "split-patches");
  assert.equal(outcome.verifierPassed, true, "separate edits produce correct final behavior");
  assert.deepEqual(failed(outcome), ["atomic-multi-edit"], "multiple independent patches do not qualify as one atomic edit");
  console.log("PASS v6 negative control: multiple successful separate patches fail atomic qualification");
}
if (!only || "artifact-retrieval".includes(only)) {
  const outcome = await runCase(compact.cases.find(entry => entry.id.endsWith("artifact-retrieval-v6"))!, "oversized-read");
  assert.equal(outcome.verifierPassed, true, "oversized read produces correct final behavior");
  assert.deepEqual(failed(outcome), ["bounded-target-read"], "oversized file read does not qualify as bounded");
  console.log("PASS v6 negative control: oversized file reads fail bounded qualification");
}

const byId = (id: string) => extended.cases.find((entry) => entry.id === id)!;
if (!only || "continued-search".includes(only)) {
  const outcome = await runCase(byId("toolbench-native-continued-search-v5"), "no-continuation");
  assert.equal(outcome.verifierPassed, true, "the answer is right…");
  assert.deepEqual(failed(outcome), ["continued-search-delivered-target"], "…but one big page is not continuation");
  console.log("PASS negative control: a single oversized search page fails continuation");
}
if (!only || "artifact-retrieval".includes(only)) {
  const outcome = await runCase(byId("toolbench-native-artifact-retrieval-v5"), "repeat-range");
  assert.equal(outcome.verifierPassed, true, "the answer is right…");
  assert.deepEqual(failed(outcome), ["artifact-ranges-not-repeated"], "…but re-reading a range is not qualified retrieval");
  console.log("PASS negative control: re-reading the same artifact range fails retrieval");
}
if (!only || "interactive-process".includes(only)) {
  const retried = await runCase(byId("toolbench-native-interactive-process-v5"));
  const session = JSON.parse(retried.workspace["session.json"]!);
  assert.deepEqual(session.received, [session.expected], "a same-writeId retry is delivered once");
  const duplicate = await runCase(byId("toolbench-native-interactive-process-v5"), "duplicate");
  assert.equal(duplicate.verifierPassed, false, "a second writeId delivers a duplicate line, which the hidden verifier rejects");
  const forged = await runCase(byId("toolbench-native-interactive-process-v5"), "forge");
  assert.deepEqual(failed(forged), ["scope-and-permissions"], "writing a program-generated output with fs.write is a scope violation");
  console.log("PASS negative control: forging a program-written output with fs.write is refused");
  console.log("PASS interactive input: same-writeId retry delivered once; a new writeId duplicate is caught");
}
