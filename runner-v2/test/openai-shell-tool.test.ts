import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage, ToolDefinition, ToolResult } from "../src/agent-contracts.js";
import { OpenAICompatibleModel } from "../src/openai-compatible-model.js";
import { parseShellAction, shellOutputEntry, supportsOpenAIShell, truncateMiddle } from "../src/openai-shell-tool.js";

const tool = (name: string, readOnly = false): ToolDefinition => ({
  name, description: name, inputSchema: { type: "object", properties: {} }, readOnly, effect: readOnly ? "none" : "workspace",
} as ToolDefinition);

const runResult = (callId: string, value: Record<string, unknown>, stdout = "", stderr = "", error?: string): ToolResult => ({
  callId, toolName: "process.run", isError: error !== undefined || value.timedOut === true,
  content: [{ type: "json", value }, ...(stdout ? [{ type: "text" as const, text: `STDOUT\n${stdout}` }] : []), ...(stderr ? [{ type: "text" as const, text: `STDERR\n${stderr}` }] : [])],
  ...(error ? { error: { code: "approval_denied", message: error } } : {}),
} as ToolResult);

test("the shell tool is for the GPT-6 family, whose model pages list it", () => {
  for (const id of ["gpt-6", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]) assert.equal(supportsOpenAIShell(id), true, id);
  for (const id of ["gpt-5.1", "gpt-5.2-codex", "gpt-60", "o4-mini", "deepseek-flash"]) assert.equal(supportsOpenAIShell(id), false, id);
});

test("a shell action needs commands; timeouts and output limits are kept only when positive", () => {
  assert.deepEqual(parseShellAction({ commands: ["ls"], timeout_ms: 5000, max_output_length: 100 }), { commands: ["ls"], timeout_ms: 5000, max_output_length: 100 });
  assert.deepEqual(parseShellAction({ commands: ["ls"], timeout_ms: null, max_output_length: 0 }), { commands: ["ls"] });
  for (const action of [undefined, {}, { commands: [] }, { commands: [""] }, { commands: [1] }, { commands: "ls" }]) {
    assert.ok("error" in parseShellAction(action), JSON.stringify(action));
  }
});

test("each command's result keeps its output and says how it ended, as the docs' outcomes", () => {
  assert.deepEqual(shellOutputEntry(runResult("c", { exitCode: 0 }, "hi\n")), { stdout: "hi\n", stderr: "", outcome: { type: "exit", exit_code: 0 } });
  assert.deepEqual(shellOutputEntry(runResult("c", { exitCode: 2 }, "", "nope\n")), { stdout: "", stderr: "nope\n", outcome: { type: "exit", exit_code: 2 } });
  assert.deepEqual(shellOutputEntry(runResult("c", { exitCode: null, timedOut: true }, "partial\n")), { stdout: "partial\n", stderr: "", outcome: { type: "timeout" } });
  const refused = shellOutputEntry(runResult("c", {}, "", "", "The owner declined this command."));
  assert.deepEqual(refused, { stdout: "", stderr: "AIBoard did not run this command: The owner declined this command.", outcome: { type: "exit", exit_code: 1 } });
  const long = shellOutputEntry(runResult("c", { exitCode: 0 }, "a".repeat(500) + "END"), 100);
  assert.equal(long.stdout.length, 100);
  assert.match(long.stdout, /^a+\n…403 characters omitted…\na+END$/u);
  assert.equal(truncateMiddle("short", 100), "short");
  assert.equal(truncateMiddle("0123456789", 3), "789");
});

function openai(modelId: string, output: unknown[], options: { bash?: boolean; providerId?: string } = {}) {
  const bodies: Array<{ tools?: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> }> = [];
  const model = new OpenAICompatibleModel({
    baseUrl: "https://api.openai.example", apiKey: "secret", modelId, providerId: options.providerId ?? "openai", protocol: "responses",
    bashAvailable: () => options.bash ?? true,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_1", status: "completed", output });
    },
  });
  return { model, bodies };
}

const user: AgentMessage = { id: "u", role: "user", content: "go" };
const working = [tool("fs.read", true), tool("fs.patch"), tool("fs.write"), tool("process.run"), tool("process.start")];

test("GPT-6 on OpenAI gets the local shell in place of process.run; one shell_call runs each command and answers once", async () => {
  const action = { commands: ["npm test", "git status --short"], timeout_ms: 60000, max_output_length: 4096 };
  const { model, bodies } = openai("gpt-6.1-sol", [{ type: "shell_call", id: "sh_1", call_id: "call_s", action, status: "in_progress" }]);
  const turn = await model.complete({ sessionId: "s", tools: working, messages: [user] } as never);
  const declared = bodies[0]!.tools!;
  assert.deepEqual(declared.filter((entry) => entry.type === "shell"), [{ type: "shell", environment: { type: "local" } }]);
  const functions = declared.filter((entry) => entry.type === "function").map((entry) => String(entry.name));
  assert.equal(functions.some((name) => /process.run|process_run/u.test(name)), false, "the model never sees two command tools");
  assert.ok(functions.some((name) => /process.start|process_start/u.test(name)), "long jobs keep process.start");
  assert.deepEqual(turn.stopReason, "tool_calls");
  assert.deepEqual(turn.blocks.map((block) => block.type === "tool_call" ? [block.callId, block.name, block.arguments] : [block.type]), [
    ["call_s::shell::1", "process.run", { shell: "bash", script: "npm test", timeoutMs: 60000 }],
    ["call_s::shell::2", "process.run", { shell: "bash", script: "git status --short", timeoutMs: 60000 }],
  ]);
  const result = (callId: string, value: Record<string, unknown>, stdout: string): AgentMessage => ({ id: callId, role: "tool", content: runResult(callId, value, stdout) });
  await model.complete({ sessionId: "s", tools: working, messages: [
    user, { id: "a", role: "assistant", content: turn.blocks },
    result("call_s::shell::1", { exitCode: 1 }, "1 failing\n"), result("call_s::shell::2", { exitCode: 0 }, " M a.ts\n"),
  ] } as never);
  const input = bodies[1]!.input;
  assert.deepEqual(input.filter((item) => item.type === "shell_call"), [{ type: "shell_call", call_id: "call_s", action, status: "completed" }]);
  assert.deepEqual(input.filter((item) => item.type === "shell_call_output"), [{
    type: "shell_call_output", call_id: "call_s", max_output_length: 4096, output: [
      { stdout: "1 failing\n", stderr: "", outcome: { type: "exit", exit_code: 1 } },
      { stdout: " M a.ts\n", stderr: "", outcome: { type: "exit", exit_code: 0 } },
    ],
  }]);
  assert.equal(input.some((item) => item.type === "function_call" || item.type === "function_call_output"), false, "the shell's parts are runner bookkeeping");
});

test("a shell_call the runner cannot run reaches the model as its reason, and nothing runs", async () => {
  const { model, bodies } = openai("gpt-6-astra", [{ type: "shell_call", call_id: "call_x", action: { commands: [] } }]);
  const turn = await model.complete({ sessionId: "s", tools: working, messages: [user] } as never);
  assert.deepEqual(turn.blocks.map((block) => block.type === "tool_call" ? block.name : block.type), ["shell"], "no tool is named shell, so the broker runs nothing");
  const call = turn.blocks[0] as { callId: string };
  await model.complete({ sessionId: "s", tools: working, messages: [
    user, { id: "a", role: "assistant", content: turn.blocks },
    { id: "r", role: "tool", content: { callId: call.callId, toolName: "shell", isError: true, content: [{ type: "text", text: "Unknown tool" }], error: { code: "unknown_tool", message: "Unknown tool" } } as ToolResult },
  ] } as never);
  const output = bodies[1]!.input.find((item) => item.type === "shell_call_output") as { output: Array<{ stderr: string; outcome: unknown }> };
  assert.match(output.output[0]!.stderr, /^Error: action\.commands must be a non-empty array.*Nothing was run\.$/u);
  assert.deepEqual(output.output[0]!.outcome, { type: "exit", exit_code: 1 });
});

test("the shell is offered only to a listed model, on OpenAI, with process.run and a bash to run it", async () => {
  const offered = async (modelId: string, tools: ToolDefinition[], options: { bash?: boolean; providerId?: string } = {}) => {
    const { model, bodies } = openai(modelId, [], options);
    await model.complete({ sessionId: "s", tools, messages: [user] } as never);
    return (bodies[0]!.tools ?? []).some((entry) => entry.type === "shell");
  };
  assert.equal(await offered("gpt-6.1-sol", working), true);
  assert.equal(await offered("gpt-5.1", working), false, "gpt-5.1 lists no shell");
  assert.equal(await offered("gpt-6.1-sol", working, { bash: false }), false, "no bash, so process.run stays");
  assert.equal(await offered("gpt-6.1-sol", working.filter((entry) => entry.name !== "process.run")), false, "a session without process.run gets no shell");
  assert.equal(await offered("gpt-6.1-sol", working, { providerId: "openrouter" }), false, "openrouter:shell is hosted, not this");
  assert.equal(await offered("gpt-6.1-sol", working, { providerId: "deepseek" }), false);
});
