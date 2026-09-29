import assert from "node:assert/strict";
import {
  normalizeProviderToolEvent,
  type ProviderToolEvent,
} from "../lib/providers/provider-events";
import {
  clientToolCallFromChunk,
  providerToolEventFromChunk,
} from "../lib/client/engine";
import type { StreamChunk } from "../lib/providers/base";

const event = await normalizeProviderToolEvent({
  id: "search-1",
  tool: "web_search",
  phase: "completed",
  providerManaged: true,
  summary: "Search completed",
  rawType: "response.web_search_call.completed",
  citations: [
    {
      url: "https://example.com/source",
      title: "Example source",
      sourceSpan: { start: 5, end: 17 },
      providerData: { annotationType: "url_citation", rank: 1 },
    },
  ],
});
assert.deepEqual(event.citations, [
  {
    url: "https://example.com/source",
    title: "Example source",
    sourceSpan: { start: 5, end: 17 },
    providerData: { annotationType: "url_citation", rank: 1 },
  },
]);
console.log("PASS hosted provider citations preserve URL, title, span, and provider annotations");

const providerChunk: StreamChunk = {
  type: "provider_tool_event",
  providerToolEvent: event,
};
assert.equal(clientToolCallFromChunk(providerChunk), undefined);
assert.deepEqual(providerToolEventFromChunk(providerChunk), event);
console.log("PASS provider-managed tool events never become client tool calls");

const localChunk: StreamChunk = {
  type: "tool_call",
  toolCall: { id: "local-1", name: "read", arguments: { path: "README.md" } },
};
assert.deepEqual(clientToolCallFromChunk(localChunk), localChunk.toolCall);
assert.equal(providerToolEventFromChunk(localChunk), undefined);
console.log("PASS client tool calls remain distinct from provider-managed events");

const collected: ProviderToolEvent[] = [];
for (const chunk of [providerChunk, localChunk]) {
  const providerEvent = providerToolEventFromChunk(chunk);
  if (providerEvent) collected.push(providerEvent);
}
assert.deepEqual(collected, [event]);
console.log("PASS collection plumbing retains provider events on their own channel");

console.log("PASS");
