/** Single-model chat contract (run: npx tsx scripts/test-chat-mode.mts) */
import assert from "node:assert/strict";
import {
  buildChatMessages,
  chatSystemPrompt,
  chatTurns,
  nextChatRound,
  pendingChatRound,
} from "../lib/orchestrator/chat";
import { estimateDiscussionCost, getModeInfo } from "../lib/orchestrator/config";
import {
  __resetClientStoreForTests,
  getDiscussionById,
  getMessagesForDiscussion,
  upsertProviderKey,
} from "../lib/client/store";
import { runDiscussion } from "../lib/client/engine";
import { openaiProvider } from "../lib/providers/openai";
import type { ChatMessage, StreamChunk } from "../lib/providers/base";
import {
  createDiscussion,
  hasEnoughParticipatingModels,
  sendChatMessage,
} from "../lib/client/api";

const at = (n: number) => `2026-10-15T09:00:0${n}.000Z`;

// --- Turn ordering and the pending turn --------------------------------
const turns = chatTurns("Hi there", [
  { id: "a2", round: 2, role: "assistant", content: "Second reply", createdAt: at(4) },
  { id: "u2", round: 2, role: "user", content: "Follow-up", createdAt: at(3) },
  { id: "a1", round: 1, role: "assistant", content: "First reply", createdAt: at(2) },
]);
assert.deepEqual(
  turns.map((turn) => `${turn.role}:${turn.content}`),
  ["user:Hi there", "assistant:First reply", "user:Follow-up", "assistant:Second reply"]
);
assert.equal(pendingChatRound(turns), null, "answered conversation has no pending turn");
assert.equal(nextChatRound(turns), 3);
assert.equal(pendingChatRound(chatTurns("Hi", [])), 1, "a new chat awaits its first reply");
console.log("PASS turns are ordered and the pending turn is detected");

// --- Provider messages -------------------------------------------------
const system = chatSystemPrompt({
  modelName: "Test Model",
  verbosityInstruction: "Response style: brief.",
  now: new Date("2026-10-15T00:00:00Z"),
});
assert.match(system, /Test Model/);
assert.match(system, /2026-10-15/);
const built = buildChatMessages({
  systemPrompt: system,
  turns,
  inlineAttachmentText: "ATTACHED",
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
});
assert.equal(built.droppedTurns, 0);
assert.deepEqual(
  built.messages.map((message) => message.role),
  ["system", "user", "assistant", "user", "assistant"]
);
assert.match(built.messages[1]!.content, /Hi there\n\nATTACHED/, "inline attachments ride on the first turn");
console.log("PASS provider messages keep roles and attach inline files to the first turn");

const long = chatTurns("first question", [
  ...Array.from({ length: 6 }, (_, index) => [
    { id: `a${index}`, round: index + 1, role: "assistant", content: "x".repeat(4_000), createdAt: at(1) },
    { id: `u${index}`, round: index + 2, role: "user", content: `follow-up ${index}`, createdAt: at(1) },
  ]).flat(),
]);
const trimmed = buildChatMessages({
  systemPrompt: "sys",
  turns: long,
  contextWindowTokens: 6_000,
  maxOutputTokens: 2_000,
});
assert.ok(trimmed.droppedTurns > 0, "an oversized conversation drops old turns");
assert.equal(trimmed.messages[1]!.content.startsWith("first question"), true, "the opening question is kept");
assert.match(trimmed.messages.at(-1)!.content, /follow-up 5/, "the newest turn is kept");
for (let index = 1; index < trimmed.messages.length; index++) {
  assert.notEqual(
    trimmed.messages[index]!.role,
    trimmed.messages[index - 1]!.role,
    "roles stay alternating after trimming"
  );
}
console.log("PASS long conversations drop the oldest turns but keep the first and latest");

// --- Mode metadata -----------------------------------------------------
assert.equal(getModeInfo("chat").label, "Single model");
assert.equal(estimateDiscussionCost(1, "medium", "chat").maxCalls, 1);
assert.equal(hasEnoughParticipatingModels("chat", 1), true);
assert.equal(hasEnoughParticipatingModels("panel", 1), false);
console.log("PASS chat needs one model and costs one call per message");

// --- API: create and follow up ------------------------------------------
__resetClientStoreForTests();
const { id } = createDiscussion({
  topic: "hi",
  mode: "chat",
  effort: "medium",
  modelIds: ["openai:gpt-5.6"],
  judgeModelId: "openai:gpt-5.6",
});
assert.throws(
  () => sendChatMessage("missing", "hello"),
  /Chat not found/
);
sendChatMessage(id, "  tell me more  ");
const stored = getMessagesForDiscussion(id);
assert.equal(stored.length, 1);
assert.equal(stored[0]!.role, "user");
assert.equal(stored[0]!.content, "tell me more");
assert.equal(stored[0]!.round, 2, "follow-ups get the next round");
assert.throws(() => sendChatMessage(id, "   "), /Type a message/);
assert.throws(
  () =>
    createDiscussion({
      topic: "",
      mode: "chat",
      effort: "medium",
      modelIds: ["openai:gpt-5.6"],
    }),
  /Type a message/
);
console.log("PASS chats start from a short message and follow-ups are stored as user turns");

// --- Engine: a real run with a stubbed provider ---------------------------
{
  __resetClientStoreForTests();
  upsertProviderKey({
    providerId: "openai",
    apiKey: "test-key",
    keyHint: "test",
    updatedAt: new Date().toISOString(),
    defaultModel: null,
    enabled: true,
  });
  const seen: ChatMessage[][] = [];
  const original = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (params): AsyncIterable<StreamChunk> {
    seen.push(params.messages.map((message) => ({ ...message })));
    yield { type: "token", content: `Reply ${seen.length}` };
    yield { type: "done" };
  };
  try {
    const { id: chatId } = createDiscussion({
      topic: "hello",
      mode: "chat",
      effort: "medium",
      modelIds: ["openai:gpt-5.6"],
      judgeModelId: "openai:gpt-5.6",
    });
    const events: string[] = [];
    await runDiscussion(chatId, (event) => events.push(event.type));
    assert.equal(getDiscussionById(chatId)?.status, "completed");
    assert.ok(events.includes("message_start") && events.includes("message_complete"));
    sendChatMessage(chatId, "and then?");
    await runDiscussion(chatId, () => undefined);
    const conversation = getMessagesForDiscussion(chatId).map((message) => `${message.role}:${message.content}`);
    assert.deepEqual(conversation, ["assistant:Reply 1", "user:and then?", "assistant:Reply 2"]);
    assert.deepEqual(
      seen[1]!.map((message) => message.role),
      ["system", "user", "assistant", "user"],
      "the follow-up call carries the whole conversation"
    );
    // Running again with nothing pending must not call the model.
    await runDiscussion(chatId, () => undefined);
    assert.equal(seen.length, 2);
  } finally {
    openaiProvider.streamChat = original;
  }
  console.log("PASS the engine answers each pending turn with the full conversation");
}

console.log("PASS");
