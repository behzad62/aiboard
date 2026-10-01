import assert from "node:assert/strict";
import { evaluateToolCapabilityProbeResult, type CollectedProbeOutput } from "../lib/client/capability-api";
import type { ToolCapabilityProbeDefinition } from "../lib/providers/capability-probes";
import type { ProviderCallPlan, ToolCapabilityId, ToolExecutionLocation } from "../lib/providers/tool-capabilities";

function definition(
  capabilityId: ToolCapabilityId,
  execution: ToolExecutionLocation = "provider",
): ToolCapabilityProbeDefinition {
  return {
    id: `tool:${capabilityId}`,
    capabilityId,
    label: capabilityId,
    description: capabilityId,
    readiness: "available",
    execution,
    transports: ["responses"],
    missingPrerequisiteIds: [],
    supportSource: "provider-docs",
  };
}

const plan: ProviderCallPlan = {
  transport: "responses",
  enabledTools: [],
  omittedOptionalTools: [],
  toolPolicyTrace: { requestedTools: [], enabledTools: [], omittedTools: [], transport: "responses", decisions: [] },
  toolChoice: "auto",
  parallelToolCalls: false,
};

function output(patch: Partial<CollectedProbeOutput> = {}): CollectedProbeOutput {
  return { text: "AIBOARD_TOOL_OK", chunks: 1, toolCalls: [], providerToolEvents: [], ...patch };
}

assert.equal(
  evaluateToolCapabilityProbeResult(definition("web_search"), plan, output()).status,
  "fail",
  "text alone must never prove a hosted tool ran",
);
assert.equal(
  evaluateToolCapabilityProbeResult(
    definition("web_search"),
    plan,
    output({ providerToolEvents: [{ tool: "web_search", phase: "started", providerManaged: true }] }),
  ).status,
  "fail",
  "a started event without completion must not pass",
);
assert.equal(
  evaluateToolCapabilityProbeResult(
    definition("web_search"),
    plan,
    output({ providerToolEvents: [{ tool: "web_search", phase: "completed", providerManaged: true }] }),
  ).status,
  "pass",
);
assert.equal(
  evaluateToolCapabilityProbeResult(
    definition("image_generation"),
    plan,
    output({ providerToolEvents: [{ tool: "image_generation", phase: "completed", providerManaged: true }] }),
  ).status,
  "fail",
  "image generation requires an artifact, not only an event",
);
assert.equal(
  evaluateToolCapabilityProbeResult(
    definition("image_generation"),
    plan,
    output({ providerToolEvents: [{
      tool: "image_generation",
      phase: "completed",
      providerManaged: true,
      artifacts: [{ id: "img", storageRef: "capability-probe://img", mimeType: "image/png", size: 4 }],
    }] }),
  ).status,
  "pass",
);
assert.equal(
  evaluateToolCapabilityProbeResult(
    definition("shell", "client"),
    plan,
    output({ toolCalls: [{ name: "shell", arguments: { command: "echo AIBOARD_SHELL_OK" } }] }),
  ).status,
  "pass",
);
assert.equal(
  evaluateToolCapabilityProbeResult(definition("memory", "runner"), plan, output()).status,
  "skipped",
  "runner-managed tools are not claimed as verified when the runner stream exposes no tool event",
);

console.log("PASS Capability Lab requires observable evidence for tool probes");
