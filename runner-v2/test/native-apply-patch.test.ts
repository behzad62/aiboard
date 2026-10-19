import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage, ToolDefinition, ToolResult } from "../src/agent-contracts.js";
import { mergeNativePatchResults, parseCodexPatch } from "../src/codex-apply-patch.js";
import { OpenAICompatibleModel } from "../src/openai-compatible-model.js";

test("a Codex patch envelope splits into per-file operations the V4A executor understands", () => {
  const operations = parseCodexPatch([
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export const a = 1;",
    "*** Update File: src/old.ts",
    " keep",
    "-before",
    "+after",
    "*** Delete File: src/gone.ts",
    "*** End Patch",
  ].join("\n"));
  assert.deepEqual(operations, [
    { type: "create_file", path: "src/new.ts", diff: "+export const a = 1;\n" },
    // A first hunk without @@ gets one; the executor requires it.
    { type: "update_file", path: "src/old.ts", diff: "@@\n keep\n-before\n+after\n" },
    { type: "delete_file", path: "src/gone.ts" },
  ]);
  for (const [text, message] of [
    ["*** Update File: a.ts\n+x\n*** End Patch", /must start with '\*\*\* Begin Patch'/],
    ["*** Begin Patch\n*** Update File: a.ts\n+x", /must end with '\*\*\* End Patch'/],
    ["*** Begin Patch\n*** Rename: a.ts\n*** End Patch", /Unexpected line/],
    ["*** Begin Patch\n*** Add File: a.ts\nno plus\n*** End Patch", /must start with '\+'/],
    ["*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** End Patch", /Move to/],
  ] as const) assert.throws(() => parseCodexPatch(text), message);
  assert.equal(mergeNativePatchResults([
    { operation: operations[0]!, isError: false, text: "Created src/new.ts" },
    { operation: operations[1]!, isError: false, text: "Updated src/old.ts" },
  ]), "Success. Updated the following files:\nA src/new.ts\nM src/old.ts");
});

const tool = (name: string, readOnly = false): ToolDefinition => ({
  name, description: name, inputSchema: { type: "object", properties: {} }, readOnly, effect: readOnly ? "none" : "workspace",
} as ToolDefinition);

test("DeepSeek on Responses gets its documented apply_patch, and its calls round-trip as one call and one output", async () => {
  const bodies: Array<{ tools?: Array<Record<string, unknown>>; input: Array<Record<string, unknown>> }> = [];
  const patch = "*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-y\n+z\n*** End Patch";
  const model = new OpenAICompatibleModel({
    baseUrl: "https://api.deepseek.example", apiKey: "secret", modelId: "deepseek-flash", providerId: "deepseek", protocol: "responses",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_1", status: "completed", output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "Add a.ts, then fix b.ts." }] },
        { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: patch },
      ] });
    },
  });
  const editing = [tool("fs.read", true), tool("fs.patch"), tool("fs.write")];
  const user: AgentMessage = { id: "u", role: "user", content: "go" };
  const turn = await model.complete({ sessionId: "s", tools: editing, messages: [user] } as never);
  const declared = bodies[0]!.tools!;
  assert.deepEqual(declared.filter((entry) => entry.type === "custom").map((entry) => entry.name), ["apply_patch"]);
  assert.equal(declared.some((entry) => /patch|write/.test(String(entry.name)) && entry.type === "function"), false, "the model never sees two edit tools");
  assert.ok(declared.some((entry) => entry.type === "function"), "read tools stay");
  assert.deepEqual(turn.blocks.map((block) => block.type === "tool_call" ? [block.callId, block.name, (block.arguments as { operation: { type: string } }).operation.type] : [block.type]), [
    ["reasoning"],
    ["call_p::apply_patch::1", "openrouter.apply_patch", "create_file"],
    ["call_p::apply_patch::2", "openrouter.apply_patch", "update_file"],
  ]);
  const result = (callId: string, text: string): AgentMessage => ({ id: callId, role: "tool", content: {
    callId, toolName: "openrouter.apply_patch", isError: false, content: [{ type: "text", text }],
  } as ToolResult });
  await model.complete({ sessionId: "s", tools: editing, messages: [
    user, { id: "a", role: "assistant", content: turn.blocks },
    result("call_p::apply_patch::1", "Created a.ts"), result("call_p::apply_patch::2", "Updated b.ts"),
  ] } as never);
  const input = bodies[1]!.input;
  assert.deepEqual(input.filter((item) => item.type === "reasoning"), [{ type: "reasoning", content: [{ type: "reasoning_text", text: "Add a.ts, then fix b.ts." }] }]);
  assert.deepEqual(input.filter((item) => item.type === "custom_tool_call"), [{ type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: patch }]);
  assert.deepEqual(input.filter((item) => item.type === "custom_tool_call_output"), [
    { type: "custom_tool_call_output", call_id: "call_p", output: "Success. Updated the following files:\nA a.ts\nM b.ts" },
  ]);
  assert.equal(input.some((item) => item.type === "function_call_output"), false);

  // A session that cannot edit is not offered the native tool.
  await model.complete({ sessionId: "r", tools: [tool("fs.read", true)], messages: [user] } as never);
  assert.equal(bodies[2]!.tools!.some((entry) => entry.type === "custom"), false);
});

test("an unparseable native patch reaches the model as its reason, not a silent drop", async () => {
  const model = new OpenAICompatibleModel({
    baseUrl: "https://api.deepseek.example", apiKey: "secret", modelId: "deepseek-flash", providerId: "deepseek", protocol: "responses",
    fetch: async () => Response.json({ status: "completed", output: [
      { type: "custom_tool_call", call_id: "call_bad", name: "apply_patch", input: "*** Update File: a.ts\n+x" },
    ] }),
  });
  const turn = await model.complete({ sessionId: "s", tools: [tool("fs.patch")], messages: [{ id: "u", role: "user", content: "go" }] } as never);
  assert.equal(turn.blocks.length, 1);
  assert.match(String((turn.blocks[0] as { arguments: { _nativePatchError: string } }).arguments._nativePatchError), /Begin Patch/);
});
