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
import { getNativeToolBenchPack, LEGACY_NATIVE_TOOLBENCH_SUITE, NATIVE_TOOLBENCH_SKILLS_SUITE, NATIVE_TOOLBENCH_BROWSER_SUITE } from "../lib/benchmark/toolreliability/native-cases";
import { qualifyNativeToolBench } from "../lib/benchmark/toolreliability/native-qualification";
import type { AgentModelRequest, ModelTurn, ToolResult } from "../runner-v2/src/agent-contracts";
import type { ToolBenchSessionSnapshot } from "../runner-v2/src/toolbench-contracts";

type Step = [name: string, args: Record<string, unknown>];
const finish: Step = ["finish_toolbench", {}];
const read = (path: string): Step => ["fs.read", { path }];
const patch = (search: string, replace: string): Step => ["fs.patch", { path: "normalize.mjs", search, replace }];
const check: Step = ["run_evidence_command", { label: "Behavior", command: "node", args: ["check.mjs"] }];
const stepsFor = (id: string): Step[] => {
  if (id.includes("investigate")) return [["fs.search", { path: "src", pattern: "MAX_RETRY_BUDGET" }], read("src/config/limits.mjs"), ["fs.write", { path: "answer.json", content: '{"value":263}\n' }], finish];
  if (id.includes("revision-recovery")) return [read("normalize.mjs"), patch("raw.toLocaleLowerCase()", "raw.trim().toLowerCase()"), read("normalize.mjs"), patch("raw.toLowerCase()", "raw.trim().toLowerCase()"), finish];
  if (id.includes("verify")) return [check, read("normalize.mjs"), patch("raw.toLowerCase()", "raw.trim().toLowerCase()"), check, finish];
  if (id.includes("atomic-edits")) return [read("prices.mjs"), ["fs.patch", { path: "prices.mjs", edits: [{ search: "cents * 0.9", replace: "cents * 0.8" }, { search: "cents * 1.03", replace: "cents * 1.05" }] }], finish];
  if (id.includes("bounded-output")) return [["fs.read", { path: "source.mjs", startLine: 1750, endLine: 1780 }], ["fs.write", { path: "answer.json", content: '{"checksum":"r7-cobalt-9217"}' }], finish];
  if (id.includes("command-args")) return [read("argv-check.mjs"), ["run_evidence_command", { label: "Arguments", command: "node", args: ["argv-check.mjs", "alpha beta", "gamma"] }], ["fs.write", { path: "answer.json", content: '{"arguments":["alpha beta","gamma"]}' }], finish];
  if (id.includes("skills")) return [["list_skills", {}], ["read_skill", { id: "port-policy" }], ["fs.write", { path: "answer.json", content: '{"port":9217}' }], finish];
  if (id.includes("browser")) return [["process.start", { command: "node", args: ["browser-server.mjs"] }], ["process.poll", {}], ["browser.open", {}], ["browser.snapshot", {}], ["browser.click", { selector: "#save" }], ["browser.snapshot", {}], ["process.signal", { signal: "SIGTERM" }], finish];
  throw new Error(`Missing steps for ${id}`);
};
const packs = [getNativeToolBenchPack(LEGACY_NATIVE_TOOLBENCH_SUITE)!, getNativeToolBenchPack(NATIVE_TOOLBENCH_SKILLS_SUITE)!, getNativeToolBenchPack(NATIVE_TOOLBENCH_BROWSER_SUITE)!];
for (const option of packs.flatMap(p => p.cases).filter(option => !process.argv[2] || option.id.includes(process.argv[2]))) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "solo-toolbench-")));
  const project = join(root, "project"); const state = join(root, "state");
  mkdirSync(project); mkdirSync(state);
  for (const [path, content] of Object.entries(option.case.fixtureFiles!)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content); }
  const hiddenVerifier = readFileSync(join(project, "verifier.mjs"), "utf8");
  rmSync(join(project, "verifier.mjs"));
  execFileSync("git", ["init", "-b", "main"], { cwd: project, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["add", "."], { cwd: project, stdio: "pipe", windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Fixture"], { cwd: project, stdio: "pipe", windowsHide: true });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const steps = stepsFor(option.id); let turn = 0; let stepIndex = 0;
  const config = { runtimeId: "test:model", providerId: "test", modelId: "model", transport: "openai-compatible" as const, secret: "test", capabilities: ["tools"], priority: 0, billingBasis: "api_priced" as const, inputCostMicrosPerMillion: 100_000, outputCostMicrosPerMillion: 200_000 };
  const sessions = new ToolBenchSessions({ projectRoot: project, stateDirectory: state, providerConfigs: { load: () => [config], save() {}, close() {} }, executionHost: host, capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    modelFactory: () => ({ async complete(request: AgentModelRequest): Promise<ModelTurn> {
      assert.equal(request.sessionId, "solo");
      assert.equal(existsSync(join(project, "verifier.mjs")), false, "Hidden scoring stays outside the model workspace during execution.");
      assert.ok(request.tools.some(t => t.name === "finish_toolbench"));
      assert.ok(!request.tools.some(t => ["create_plan", "review_task", "commit_project_doc", "complete_run", "ask_architect"].includes(t.name)));
      for (const message of request.messages.filter(m => m.role === "tool")) {
        const result = message.content as ToolResult;
        if (result.isError) assert.ok(["ambiguous_patch", "process_exit"].includes(result.error?.code ?? ""), JSON.stringify(result));
      }
      turn++; let step = steps[stepIndex++]; assert.ok(step, "Session must finish without orchestration retries.");
      if (option.id.includes("investigate") && step[0] === "fs.read") step[1].path = join(project, String(step[1].path));
      if (option.id.includes("browser")) {
        const results = request.messages.filter(message => message.role === "tool").map(message => message.content as ToolResult);
        const started = results.find(result => result.toolName === "process.start")?.content.find(block => block.type === "json");
        const processId = started?.type === "json" ? (started.value as { processId: string }).processId : undefined;
        if (["process.poll", "process.signal"].includes(step[0])) step[1].processId = processId;
        if (step[0] === "browser.open") {
          const url = JSON.stringify(results).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (!url) { stepIndex--; step = ["process.poll", { processId }]; }
          else step[1].url = url;
        }
        if (step[0] === "finish_toolbench") assert.ok(results.some(result => result.toolName === "browser.snapshot" && JSON.stringify(result.content).includes("Saved")), "Browser must observe the post-click state.");
      }
      if (step[0] === "read_skill") {
        const list = request.messages.filter(message => message.role === "tool").map(message => message.content as ToolResult).find(result => result.toolName === "list_skills");
        const json = list?.content.find(block => block.type === "json");
        assert.ok(json?.type === "json"); step[1].id = (json.value as Array<{ id: string }>)[0].id;
      }
      return { stopReason: "tool_calls", blocks: [{ type: "tool_call", callId: `call-${turn}`, name: step[0], arguments: step[1] }], usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, providerReportedCostUsd: 0.0001 } };
    } }),
  });
  try {
    await sessions.start({ sessionId: "solo", runtimeId: config.runtimeId, prompt: option.case.prompt.userRequest, allowedCommands: option.case.allowedCommands,
      hiddenPaths: ["verifier.mjs", "verifier-result.json", "case-meta.json"], protectedPaths: option.case.executionPolicy!.protectedPaths, editablePaths: option.id.includes("browser") ? [] : option.case.executionPolicy!.editablePaths,
      budget: { maxModelCalls: 30, maxInputTokens: 5_000_000, maxOutputTokens: 750_000, maxToolCalls: 90 }, maxWallClockMs: 120_000, skills: option.id.includes("skills"), browser: option.id.includes("browser") });
    let snapshot: ToolBenchSessionSnapshot;
    do { await new Promise(r => setTimeout(r, 20)); snapshot = await sessions.get("solo"); } while (snapshot.status === "running");
    snapshot = await sessions.stop("solo");
    assert.equal(snapshot.status, "completed", JSON.stringify({ reason: snapshot.reason, errors: snapshot.tools.filter(t => t.isError) }));
    const qualification = qualifyNativeToolBench(option.case, { observability: { tools: snapshot.tools, evidence: snapshot.evidence } }, snapshot.toolEvidence);
    assert.equal(qualification.passed, true, JSON.stringify(qualification.checks));
    assert.equal(snapshot.usage!.lifetime!.inputTokens, turn * 100);
    assert.equal(snapshot.usage!.lifetime!.outputTokens, turn * 10);
    assert.equal(snapshot.usage!.models[0].roles.join(","), "worker");
    assert.ok(Object.values(snapshot.usage!.reservations).filter(r => r.kind === "model").every(r => r.tokenSources?.inputTokens === "reported" && r.providerReportedCostUsd === 0.0001));
    writeFileSync(join(project, "verifier.mjs"), hiddenVerifier);
    execFileSync(process.execPath, ["verifier.mjs"], { cwd: project, stdio: "pipe", timeout: 10_000, windowsHide: true });
    assert.equal(JSON.parse(readFileSync(join(project, "verifier-result.json"), "utf8")).passed, true);
    await assert.rejects(sessions.start({ sessionId: "solo" } as never), /requires|already|Invalid/);
    console.log(`PASS solo session, native tools, deterministic verifier and usage: ${option.id} (${turn} calls)`);
  } finally {
    await sessions.close(); await host.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())), "Delete only owned test directory.");
    rmSync(root, { recursive: true, force: true });
  }
}
