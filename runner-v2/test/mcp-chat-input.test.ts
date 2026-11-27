import assert from "node:assert/strict";
import test from "node:test";
import { McpChatInputs } from "../src/mcp-chat-input.js";
const request = { method: "elicitation/create", params: { mode: "form", message: "Choose an option", requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 1, maximum: 3 }, enabled: { type: "boolean" } }, required: ["name", "count"] } } };
test("session-bound prompts require valid explicit input and settle once", async () => {
  const inputs = new McpChatInputs(); const signal = new AbortController();
  const result = inputs.resolve("a", request, signal.signal, "example");
  const [prompt] = inputs.list("a");
  assert.equal(prompt.source, "example");
  assert.deepEqual(inputs.list("b"), []);
  assert.equal(inputs.answer("b", prompt.id, { action: "accept", content: {} }), "missing");
  for (const content of [{name:"x",count:2},{name:"ok",count:4},{name:"ok",count:1.5},{name:"ok",count:2,other:1}]) assert.equal(inputs.answer("a", prompt.id, {action:"accept",content}),"invalid");
  assert.equal(inputs.answer("a", prompt.id, { action:"accept",content:{name:"ok",count:2,enabled:false} }), "accepted");
  assert.deepEqual(JSON.parse(JSON.stringify(await result)), { action:"accept",content:{name:"ok",count:2,enabled:false} });
  assert.equal(inputs.answer("a",prompt.id,{action:"decline"}),"missing");
});
test("abort removes prompt; unsupported URL and schema modes decline", async () => {
  const inputs = new McpChatInputs(); const signal = new AbortController();
  const result = inputs.resolve("a", request, signal.signal);
  signal.abort();
  assert.deepEqual(await result, { action:"cancel" });
  assert.deepEqual(inputs.list("a"), []);
  assert.deepEqual(await inputs.resolve("a", {method:"elicitation/create",params:{mode:"url",message:"open",url:"https://example.com"}},new AbortController().signal),{action:"decline"});
  assert.deepEqual(await inputs.resolve("a", {method:"elicitation/create",params:{message:"open",requestedSchema:{type:"object",properties:{x:{type:"string",pattern:"x"}}}}},new AbortController().signal),{action:"decline"});
});
