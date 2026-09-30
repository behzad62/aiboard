import assert from "node:assert/strict";
import {
  PROVIDER_TRANSPORT_IDS,
  TOOL_CAPABILITY_IDS,
  isToolCapabilityDescriptor,
  resolveToolReadiness,
  type ToolCapabilityDescriptor,
  type ToolResourceState,
} from "../lib/providers/tool-capabilities";
import {
  getTransportMetadata,
  normalizeTransportOrder,
} from "../lib/providers/transport-registry";

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

assert.deepEqual(TOOL_CAPABILITY_IDS, [
  "function_calling",
  "web_search",
  "web_fetch",
  "file_search",
  "url_context",
  "maps",
  "x_search",
  "code_execution",
  "shell",
  "apply_patch",
  "computer_use",
  "browser_use",
  "image_generation",
  "remote_mcp",
  "tool_search",
  "advisor",
  "subagent",
  "fusion",
  "datetime",
  "memory",
]);
pass("canonical tool capability ids match the approved contract");

assert.deepEqual(PROVIDER_TRANSPORT_IDS, [
  "responses",
  "chat_completions",
  "messages",
  "gemini_interactions",
  "gemini_generate_content",
  "copilot_sdk",
  "runner_proxy",
]);
pass("canonical provider transport ids match the approved contract");

const descriptor: ToolCapabilityDescriptor = {
  id: "file_search",
  support: "supported",
  execution: "provider",
  transports: ["responses"],
  prerequisites: [
    {
      id: "openai_vector_store",
      label: "OpenAI vector store",
      kind: "resource",
      configurationPath: "providers.openai.vectorStoreIds",
    },
  ],
  constraints: [
    {
      when: "structured_output",
      effect: "requires_transport",
      value: "responses",
      reason: "File search is serialized on Responses for this provider.",
    },
  ],
  supportSource: "provider-docs",
  verifiedAt: "2026-09-29T00:00:00.000Z",
};

assert.equal(isToolCapabilityDescriptor(descriptor), true);
assert.equal(isToolCapabilityDescriptor({ ...descriptor, id: "magic_search" }), false);
assert.equal(isToolCapabilityDescriptor({ ...descriptor, support: "maybe" }), false);
assert.equal(isToolCapabilityDescriptor({ ...descriptor, execution: "browser" }), false);
assert.equal(isToolCapabilityDescriptor({ ...descriptor, transports: ["legacy_chat"] }), false);
assert.equal(isToolCapabilityDescriptor({ ...descriptor, supportSource: "guess" }), false);
pass("descriptor validation rejects unknown capability contract values");

const notReady: ToolResourceState = {
  prerequisites: {
    openai_vector_store: { ready: false, reason: "No vector store configured" },
  },
};
const ready: ToolResourceState = {
  prerequisites: {
    openai_vector_store: { ready: true },
  },
};
assert.deepEqual(resolveToolReadiness(descriptor, notReady), {
  status: "setup_required",
  missingPrerequisiteIds: ["openai_vector_store"],
});
assert.deepEqual(resolveToolReadiness(descriptor, ready), {
  status: "available",
  missingPrerequisiteIds: [],
});
assert.equal(
  resolveToolReadiness({ ...descriptor, support: "conditional" }, ready).status,
  "conditional",
);
assert.equal(
  resolveToolReadiness({ ...descriptor, support: "unknown" }, ready).status,
  "unknown",
);
assert.equal(
  resolveToolReadiness({ ...descriptor, support: "unsupported" }, ready).status,
  "unsupported",
);
pass("provider support and runtime prerequisite readiness remain distinct");

assert.deepEqual(
  normalizeTransportOrder(["messages", "responses", "messages", "chat_completions"]),
  ["messages", "responses", "chat_completions"],
);
const metadata = getTransportMetadata(["gemini_interactions", "responses"]);
assert.deepEqual(
  metadata.map((entry) => entry.id),
  ["gemini_interactions", "responses"],
);
assert.equal(
  metadata.every((entry) => !("capabilities" in entry) && !("tools" in entry)),
  true,
);
pass("transport registry preserves declared preference order without capability assumptions");

console.log("PASS");