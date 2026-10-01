import assert from "node:assert/strict";
import {
  CAPABILITY_PROBES,
  buildToolCapabilityProbeDefinitions,
  capabilityEvidenceFromToolProbe,
  toolCapabilityProbeId,
} from "../lib/providers/capability-probes";
import type { ResolvedCapabilityProfile } from "../lib/providers/capability-resolution";
import type { ToolCapabilityDescriptor, ToolCapabilityId, ToolExecutionLocation, ToolSupportStatus } from "../lib/providers/tool-capabilities";

const descriptor = (
  id: ToolCapabilityId,
  support: ToolSupportStatus,
  execution: ToolExecutionLocation = "provider",
): ToolCapabilityDescriptor => ({
  id,
  support,
  execution,
  transports: ["responses"],
  supportSource: "provider-docs" as const,
});

const profile: ResolvedCapabilityProfile = {
  providerId: "openai",
  modelId: "gpt-test",
  transientFailures: [],
  capabilities: {
    function_calling: {
      descriptor: descriptor("function_calling", "supported", "client"),
      readiness: { status: "available", missingPrerequisiteIds: [] },
    },
    file_search: {
      descriptor: {
        ...descriptor("file_search", "supported"),
        prerequisites: [{ id: "openai_vector_store", label: "OpenAI vector store", kind: "resource" }],
      },
      readiness: { status: "setup_required", missingPrerequisiteIds: ["openai_vector_store"] },
    },
    code_execution: {
      descriptor: descriptor("code_execution", "conditional"),
      readiness: { status: "conditional", missingPrerequisiteIds: [] },
    },
    web_search: {
      descriptor: descriptor("web_search", "unsupported"),
      readiness: { status: "unsupported", missingPrerequisiteIds: [] },
    },
  },
};

const definitions = buildToolCapabilityProbeDefinitions(profile);
assert.deepEqual(
  definitions.map((item) => [item.capabilityId, item.readiness]),
  [
    ["function_calling", "available"],
    ["file_search", "setup_required"],
    ["code_execution", "conditional"],
    ["web_search", "unsupported"],
  ],
  "Capability Lab tool rows must derive from the resolved provider profile without dropping unavailable capabilities",
);
assert.equal(definitions[0]?.id, "tool:function_calling");
assert.equal(toolCapabilityProbeId("image_generation"), "tool:image_generation");

assert(CAPABILITY_PROBES.some((probe) => probe.id === "buildProtocol"), "Build Protocol must have its own probe");
assert(!CAPABILITY_PROBES.some((probe) => probe.id === "toolCalls"), "legacy toolCalls probe must not masquerade as Build Protocol");

const functionEvidence = capabilityEvidenceFromToolProbe({
  providerId: "openai",
  modelId: "gpt-test",
  transport: "responses",
  testedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-08T00:00:00.000Z",
  result: {
    id: "tool:function_calling",
    status: "pass",
    detail: "Provider emitted the requested function call",
  },
});
assert.equal(functionEvidence?.capabilityId, "function_calling");
assert.equal(functionEvidence?.support, "supported");

const buildEvidence = capabilityEvidenceFromToolProbe({
  providerId: "openai",
  modelId: "gpt-test",
  transport: "responses",
  testedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-08T00:00:00.000Z",
  result: { id: "buildProtocol", status: "pass", detail: "Build protocol passed" },
});
assert.equal(buildEvidence, undefined, "Build Protocol is app behavior, not provider function-calling evidence");

console.log("PASS capability lab derives complete tool coverage and separates Build Protocol");
