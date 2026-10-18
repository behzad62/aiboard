import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentModel, ModelTurn } from "../runner-v2/src/agent-contracts";
import type { SchedulerProjection } from "../runner-v2/src/scheduler-store";
import { classifyBuildMessage, parseBuildMessageIntent, respondToBuildMessage } from "../runner-v2/src/build-message-intent";

function one(text: string): ModelTurn {
  return { stopReason: "end_turn", blocks: [{ type: "text", text }] };
}
function fakeModel(turns: ModelTurn[]): AgentModel & { seen: Array<{ tools: readonly unknown[]; messages: readonly unknown[] }> } {
  const seen: Array<{ tools: readonly unknown[]; messages: readonly unknown[] }> = [];
  return {
    seen,
    complete: async (request) => {
      seen.push({ tools: request.tools, messages: request.messages });
      const turn = turns.shift();
      if (!turn) throw new Error("Unexpected extra model turn");
      return turn;
    },
  };
}
for (const intent of ["ask", "check", "change", "clarify"] as const) {
  assert.equal(parseBuildMessageIntent(JSON.stringify({ intent })), intent);
  assert.equal(parseBuildMessageIntent(intent), intent);
  assert.equal(await classifyBuildMessage(fakeModel([one(JSON.stringify({ intent }))]), "Example"), intent);
}
assert.throws(() => parseBuildMessageIntent("nonsense"), /invalid category/);
await assert.rejects(classifyBuildMessage(fakeModel([one("unsure")]), "Fix it"), /no build action/);
const root = await mkdtemp(join(tmpdir(), "aiboard-message-intent-"));
try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "auth.ts"), "export const isAuthorized = true;\n");
  await writeFile(join(root, ".env"), "SECRET=must-not-appear");
  const projection = { status: "running", planRevision: 1, tasks: {}, lastSequence: 1 } as unknown as SchedulerProjection;
  const answered = fakeModel([one("The current plan is running.")]);
  const answer = await respondToBuildMessage({ model: answered, intent: "ask", text: "What is the status?", objective: "Make app", projection, projectRoot: root });
  assert.equal(answer.intent, "ask");
  assert.match(answer.reply ?? "", /running/);
  assert.equal(answered.seen[0]?.tools.length, 0, "Question answers get no tools");
  const inspected = fakeModel([
    { stopReason: "tool_calls", blocks: [{ type: "tool_call", name: "list_project_files", callId: "first", arguments: { path: "src" } }] },
    { stopReason: "tool_calls", blocks: [{ type: "tool_call", name: "read_project_file", callId: "second", arguments: { path: "src/auth.ts" } }, { type: "tool_call", name: "read_project_file", callId: "third", arguments: { path: "../.env" } }] },
    one("The file defines an authorization flag; tests were not run."),
  ]);
  const result = await respondToBuildMessage({ model: inspected, intent: "check", text: "Inspect auth", objective: "Make app", projection, projectRoot: root });
  assert.equal(result.intent, "check");
  assert.deepEqual(result.inspectedPaths, ["src", "src/auth.ts"]);
  assert.equal(inspected.seen[0]?.tools.length, 2);
  const messages = JSON.stringify(inspected.seen[2]?.messages);
  assert.match(messages, /isAuthorized/);
  assert.doesNotMatch(messages, /must-not-appear/);
  assert.match(messages, /Inspection unavailable/);
  assert.equal(await readFile(join(root, "src", "auth.ts"), "utf8"), "export const isAuthorized = true;\n", "Inspection never edits files");
  const integration = fakeModel([
    { stopReason: "tool_calls", blocks: [{ type: "tool_call", name: "read_project_file", callId: "integration", arguments: { path: "src/auth.ts" } }] },
    one("The current integration requires authentication."),
  ]);
  const integrated = await respondToBuildMessage({ model: integration, intent: "check", text: "Inspect the current integration", objective: "Make app", projection, projectRoot: root,
    integrationFiles: { source: "integration", revision: "revision-new", appliedToProject: false, omittedFileCount: 0, files: [{ path: "src/auth.ts", content: "export const isAuthorized = false;" }] },
  });
  assert.equal(integrated.intent, "check");
  assert.match(JSON.stringify(integration.seen[1]?.messages), /isAuthorized = false/);
  assert.doesNotMatch(JSON.stringify(integration.seen[1]?.messages), /isAuthorized = true/);
  const question = fakeModel([one("Which environment?")]);
  const clarify = await respondToBuildMessage({ model: question, intent: "clarify", text: "That thing", objective: "Make app", projection, projectRoot: root });
  assert.equal(clarify.reply, "Which environment?");
  assert.equal(question.seen[0]?.tools.length, 0);
  console.log("PASS follow-up LLM intent classification, fail-closed routing and read-only inspection.");
} finally {
  await rm(root, { recursive: true, force: true });
}
