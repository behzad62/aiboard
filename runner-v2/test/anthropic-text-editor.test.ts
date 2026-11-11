import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage, ToolCallBlock, ToolDefinition, ToolResult } from "../src/agent-contracts.js";
import { AnthropicModel } from "../src/anthropic-model.js";
import { BASH_SESSION, bashCall, bashResult, supportsBash } from "../src/anthropic-bash-tool.js";
import { mapEditorInput, supportsTextEditor, textEditorCall, textEditorResult, TEXT_EDITOR_NAME } from "../src/anthropic-text-editor.js";
import { createFilesystemTools, insertAfterLine } from "../src/filesystem-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

test("editor commands map onto the shared fs tools; input the editor does not take maps to nothing", () => {
  assert.deepEqual(mapEditorInput({ command: "view", path: "a.ts" }), { name: "fs.read", arguments: { path: "a.ts", startLine: 1, endLine: Number.MAX_SAFE_INTEGER } });
  assert.deepEqual(mapEditorInput({ command: "view", path: "a.ts", view_range: [3, -1] }), { name: "fs.read", arguments: { path: "a.ts", startLine: 3, endLine: Number.MAX_SAFE_INTEGER } });
  assert.deepEqual(mapEditorInput({ command: "view", path: "a.ts", view_range: [3, 9] }), { name: "fs.read", arguments: { path: "a.ts", startLine: 3, endLine: 9 } });
  assert.deepEqual(mapEditorInput({ command: "create", path: "n.ts", file_text: "x" }), { name: "fs.write", arguments: { path: "n.ts", content: "x" } });
  assert.deepEqual(mapEditorInput({ command: "str_replace", path: "a.ts", old_str: "a", new_str: "b" }), { name: "fs.patch", arguments: { path: "a.ts", search: "a", replace: "b" } });
  assert.deepEqual(mapEditorInput({ command: "str_replace", path: "a.ts", old_str: "a" }), { name: "fs.patch", arguments: { path: "a.ts", search: "a", replace: "" } });
  assert.deepEqual(mapEditorInput({ command: "insert", path: "a.ts", insert_line: 0, insert_text: "top" }), { name: "fs.patch", arguments: { path: "a.ts", _insert: { afterLine: 0, text: "top" } } });
  for (const bad of [undefined, { command: "view" }, { command: "view", path: "a", view_range: [0, 3] }, { command: "view", path: "a", view_range: [5, 2] },
    { command: "create", path: "a" }, { command: "str_replace", path: "a", old_str: "" }, { command: "insert", path: "a", insert_line: -1, insert_text: "x" },
    { command: "undo_edit", path: "a" }, { command: "rm", path: "a" }]) {
    assert.ok("error" in mapEditorInput(bad), JSON.stringify(bad));
  }
  const call = textEditorCall("toolu_1", { command: "undo_edit", path: "a" });
  assert.equal(call.name, TEXT_EDITOR_NAME, "no registered tool has the editor's name, so nothing runs");
  assert.deepEqual(call.nativeCall, { callId: "toolu_1", name: TEXT_EDITOR_NAME, input: JSON.stringify({ command: "undo_edit", path: "a" }), part: 1, parts: 1 });
});

test("the editor is offered for the models its docs list", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-opus-4-8", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]) assert.ok(supportsTextEditor(id), id);
  for (const id of ["claude-opus-4-1", "claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-code", "gpt-5"]) assert.ok(!supportsTextEditor(id), id);
});

test("insert puts whole lines after a line, in the file's newline style", () => {
  assert.equal(insertAfterLine("a\nb\n", 0, "x"), "x\na\nb\n");
  assert.equal(insertAfterLine("a\nb\n", 1, "x\n"), "a\nx\nb\n");
  assert.equal(insertAfterLine("a\nb\n", 2, "x"), "a\nb\nx\n");
  assert.equal(insertAfterLine("a\nb", 2, "x"), "a\nb\nx");
  assert.equal(insertAfterLine("a\r\nb\r\n", 1, "x\ny"), "a\r\nx\r\ny\r\nb\r\n");
  assert.equal(insertAfterLine("", 0, "x"), "x\n");
  assert.throws(() => insertAfterLine("a\nb\n", 3, "x"), /the file has 2 lines, so use 0 to 2/u);
});

test("an editor session runs on the real fs tools: view, str_replace, insert, create, and their errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-text-editor-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src", "lib"), { recursive: true });
  mkdirSync(join(workspace, ".git"));
  writeFileSync(join(workspace, "src", "app.ts"), "const a = 1;\nconst b = 2;\nconst b2 = 2;\n");
  writeFileSync(join(workspace, "src", "lib", "util.ts"), "export {};\n");
  writeFileSync(join(workspace, "src", ".secret"), "x");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
  for (const tool of createFilesystemTools()) broker.register(tool);
  let n = 0;
  const edit = async (input: Record<string, unknown>) => {
    const call = textEditorCall(`toolu_${++n}`, input);
    const result = await broker.invoke(call, { runId: "editor", sessionId: "s1", actor: { role: "worker", id: "w1" } });
    return textEditorResult(call.nativeCall!.input, result);
  };
  try {
    const listing = await edit({ command: "view", path: "src" });
    assert.equal(listing.isError, false);
    assert.match(listing.text, /^Here are the files and directories up to 2 levels deep in src/u);
    assert.match(listing.text, /src\/app\.ts\nsrc\/lib\/\nsrc\/lib\/util\.ts/u);
    assert.doesNotMatch(listing.text, /\.secret/u);

    assert.deepEqual(await edit({ command: "view", path: "src/app.ts" }), { text: "1: const a = 1;\n2: const b = 2;\n3: const b2 = 2;", isError: false });
    assert.deepEqual(await edit({ command: "view", path: "src/app.ts", view_range: [2, -1] }), { text: "2: const b = 2;\n3: const b2 = 2;", isError: false });

    const ambiguous = await edit({ command: "str_replace", path: "src/app.ts", old_str: " = 2;", new_str: " = 3;" });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /^Error: Edit 1: expected one match, found 2/u);
    const missing = await edit({ command: "str_replace", path: "src/app.ts", old_str: "const z", new_str: "const y" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /^Error: .*found 0/u);

    assert.deepEqual(await edit({ command: "str_replace", path: "src/app.ts", old_str: "const b = 2;", new_str: "const b = 3;" }),
      { text: "Successfully replaced text at exactly one location.", isError: false });
    assert.deepEqual(await edit({ command: "insert", path: "src/app.ts", insert_line: 1, insert_text: "// after a\n" }),
      { text: "Inserted the text after line 1 of src/app.ts.", isError: false });
    assert.equal(readFileSync(join(workspace, "src", "app.ts"), "utf8"), "const a = 1;\n// after a\nconst b = 3;\nconst b2 = 2;\n");
    const outOfRange = await edit({ command: "insert", path: "src/app.ts", insert_line: 9, insert_text: "x" });
    assert.equal(outOfRange.isError, true);
    assert.match(outOfRange.text, /the file has 4 lines/u);

    assert.deepEqual(await edit({ command: "create", path: "src/new.ts", file_text: "export const c = 1;\n" }), { text: "File written: src/new.ts", isError: false });
    assert.equal(readFileSync(join(workspace, "src", "new.ts"), "utf8"), "export const c = 1;\n");
    const unread = await edit({ command: "create", path: "src/lib/util.ts", file_text: "replaced\n" });
    assert.equal(unread.isError, true, "create over a file it has not viewed is refused, as fs.write refuses it");
    assert.equal(readFileSync(join(workspace, "src", "lib", "util.ts"), "utf8"), "export {};\n");

    assert.deepEqual(await edit({ command: "undo_edit", path: "src/app.ts" }),
      { text: "Error: undo_edit is not available in this version of the tool; make the change back with str_replace.", isError: true });
    const absent = await edit({ command: "view", path: "src/none.ts" });
    assert.equal(absent.isError, true);
    assert.match(absent.text, /^Error: /u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const tool = (name: string, readOnly = false): ToolDefinition => ({ name, description: name, inputSchema: { type: "object" }, readOnly, effect: readOnly ? "none" : "workspace" } as ToolDefinition);
const EDIT_TOOLS = [tool("fs.read", true), tool("fs.write"), tool("fs.patch"), tool("fs.list", true), tool("process.run")];

function capturingModel(modelId: string, reply: unknown, options: { nativeTools?: boolean; bashAvailable?: () => boolean } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const model = new AnthropicModel({
    apiKey: "k", modelId, bashAvailable: () => false, ...options,
    fetch: async (_input, init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return Response.json(reply); },
  });
  return { model, bodies };
}

test("a Claude model that can edit gets the editor in place of fs.read, fs.write and fs.patch; others keep the generic tools", async () => {
  const reply = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
  const messages: AgentMessage[] = [{ id: "u1", role: "user", content: "fix it" }];
  const names = (body: Record<string, unknown>) => (body.tools as Array<{ name: string; type?: string }>).map((entry) => entry.type ?? entry.name);

  const editing = capturingModel("claude-opus-5-5", reply);
  await editing.model.complete({ sessionId: "s", messages, tools: EDIT_TOOLS });
  assert.deepEqual(names(editing.bodies[0]!), ["text_editor_20250728", "fs_list", "process_run"]);
  assert.deepEqual((editing.bodies[0]!.tools as unknown[])[0], { type: "text_editor_20250728", name: TEXT_EDITOR_NAME });

  for (const [modelId, tools, options] of [
    ["claude-3-7-sonnet-latest", EDIT_TOOLS, {}],
    ["claude-opus-5-5", [tool("fs.read", true), tool("fs.list", true)], {}],
    ["claude-opus-5-5", EDIT_TOOLS, { nativeTools: false }],
  ] as const) {
    const plain = capturingModel(modelId, reply, options);
    await plain.model.complete({ sessionId: "s", messages, tools });
    assert.ok(!names(plain.bodies[0]!).includes("text_editor_20250728"), `${modelId} ${tools.length}`);
  }
});

test("where bash can run, a Claude 4+ model gets bash in place of process.run; restart and bad input map as documented", async () => {
  const reply = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
  const messages: AgentMessage[] = [{ id: "u1", role: "user", content: "run it" }];
  const names = (body: Record<string, unknown>) => (body.tools as Array<{ name: string; type?: string }>).map((entry) => entry.type ?? entry.name);
  const both = capturingModel("claude-opus-5-5", reply, { bashAvailable: () => true });
  await both.model.complete({ sessionId: "s", messages, tools: EDIT_TOOLS });
  assert.deepEqual(names(both.bodies[0]!), ["text_editor_20250728", "bash_20250124", "fs_list"]);
  assert.deepEqual((both.bodies[0]!.tools as unknown[])[1], { type: "bash_20250124", name: "bash" });
  for (const [modelId, options] of [["claude-opus-5-5", { bashAvailable: () => false }], ["claude-3-7-sonnet-latest", { bashAvailable: () => true }],
    ["claude-opus-5-5", { bashAvailable: () => true, nativeTools: false }]] as const) {
    const plain = capturingModel(modelId, reply, options);
    await plain.model.complete({ sessionId: "s", messages, tools: EDIT_TOOLS });
    assert.ok(names(plain.bodies[0]!).includes("process_run") && !names(plain.bodies[0]!).includes("bash_20250124"), modelId);
  }
  assert.deepEqual(bashCall("t1", { command: "npm test" }).arguments, { shell: "bash", shellSession: BASH_SESSION, script: "npm test" });
  assert.equal(bashCall("t1", { command: "npm test" }).name, "process.run");
  assert.deepEqual(bashCall("t2", { restart: true }).arguments, { shell: "bash", shellSession: BASH_SESSION, script: "exit 0" });
  assert.equal(bashCall("t3", { command: "" }).name, "bash", "no tool is named bash, so nothing runs");
  assert.ok(supportsBash("claude-opus-4-1") && supportsBash("claude-sonnet-5-5") && !supportsBash("claude-3-7-sonnet-latest"));
});

test("bash results read like a terminal: output, then the exit code and what happened to the shell", () => {
  const run = (value: Record<string, unknown>, texts: string[], error?: { code: string; message: string }): ToolResult => ({ callId: "c", toolName: "process.run",
    isError: error !== undefined, ...(error ? { error } : {}), content: [{ type: "json", value }, ...texts.map((text) => ({ type: "text" as const, text }))] });
  const command = JSON.stringify({ command: "x" });
  assert.deepEqual(bashResult(command, run({ exitCode: 0, shellSession: { name: BASH_SESSION } }, ["STDOUT\nhello\n"])), { text: "hello", isError: false });
  assert.deepEqual(bashResult(command, run({ exitCode: 0, shellSession: {} }, [])), { text: "(no output)", isError: false });
  assert.deepEqual(bashResult(command, run({ exitCode: 2, shellSession: {} }, ["STDOUT\nout", "STDERR\nboom\n"])), { text: "out\nboom\n[exit code 2]", isError: false });
  const late = bashResult(command, run({ exitCode: null, timedOut: true, shellSession: { ended: "gone" } }, ["STDOUT\nstarted\n"], { code: "process_timeout", message: "Command exceeded 90000 ms." }));
  assert.equal(late.isError, true);
  assert.match(late.text, /^started\n\[The command ran past 90 s and was stopped\. The shell was restarted.*process_start\.\]$/u);
  assert.match(bashResult(command, run({ exitCode: 0, shellSession: { replaced: true } }, ["STDOUT\nx\n"])).text, /^x\n\[A new shell started/u);
  assert.deepEqual(bashResult(command, run({ exitCode: null }, [], { code: "benchmark_command_denied", message: "Command is not allowlisted." })),
    { text: "Error: Command is not allowlisted.", isError: true });
  assert.deepEqual(bashResult(JSON.stringify({ restart: true }), run({ exitCode: 0, shellSession: { ended: "exited" } }, [])), { text: "The bash shell has been restarted.", isError: false });
  assert.deepEqual(bashResult(JSON.stringify({ command: "" }), run({}, [])), { text: "Error: command is required: the bash command to run.", isError: true });
});

test("an editor call runs as an fs tool call and goes back to Claude as it wrote it, with the editor's result text", async () => {
  const input = { command: "view", path: "src/app.ts", view_range: [2, -1] };
  const first = capturingModel("claude-sonnet-5-5", { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_9", name: TEXT_EDITOR_NAME, input }] });
  const turn = await first.model.complete({ sessionId: "s", messages: [{ id: "u1", role: "user", content: "look" }], tools: EDIT_TOOLS });
  const call = turn.blocks[0] as ToolCallBlock;
  assert.equal(turn.stopReason, "tool_calls");
  assert.equal(call.name, "fs.read");
  assert.deepEqual(call.arguments, { path: "src/app.ts", startLine: 2, endLine: Number.MAX_SAFE_INTEGER });

  const second = capturingModel("claude-sonnet-5-5", { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] });
  await second.model.complete({ sessionId: "s", tools: EDIT_TOOLS, messages: [
    { id: "u1", role: "user", content: "look" },
    { id: "a1", role: "assistant", content: turn.blocks },
    { id: "t1", role: "tool", content: { callId: "toolu_9", toolName: "fs.read", isError: false, content: [
      { type: "json", value: { path: "src/app.ts", startLine: 2, endLine: 3, totalLines: 3 } },
      { type: "text", text: "const b = 2;\nconst c = 3;\n" },
    ] } },
  ] });
  const sent = second.bodies[0]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(sent[1]!.content, [{ type: "tool_use", id: "toolu_9", name: TEXT_EDITOR_NAME, input }]);
  assert.deepEqual(sent[2]!.content, [{ type: "tool_result", tool_use_id: "toolu_9", content: "2: const b = 2;\n3: const c = 3;" }]);
});
