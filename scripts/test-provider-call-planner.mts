import assert from "node:assert/strict";
import {
  resolveProviderCallPlan,
  type ResolveProviderCallPlanInput,
} from "../lib/providers/call-planner";
import {
  ProviderCallPlanError,
  type ProviderRuntimeContext,
  type ToolCapabilityDescriptor,
  type ToolIntent,
} from "../lib/providers/tool-capabilities";
import { structuredOutputCallFeatures } from "../lib/providers/structured-output";

function context(
  providerId: string,
  modelId: string,
  patch: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext {
  return {
    providerId,
    modelId,
    features: {},
    ...patch,
  };
}

function customDescriptor(
  patch: Partial<ToolCapabilityDescriptor> = {},
): ToolCapabilityDescriptor {
  return {
    id: "function_calling",
    support: "supported",
    execution: "client",
    transports: ["chat_completions"],
    supportSource: "user-override",
    ...patch,
  };
}

function required(id: ToolIntent["id"], parameters?: Record<string, unknown>): ToolIntent {
  return { id, requirement: "required", ...(parameters ? { parameters } : {}) };
}

function optional(id: ToolIntent["id"], parameters?: Record<string, unknown>): ToolIntent {
  return { id, requirement: "optional", ...(parameters ? { parameters } : {}) };
}

function plan(input: ResolveProviderCallPlanInput) {
  return resolveProviderCallPlan(input);
}

const responsesOnly = plan({
  context: context("custom", "responses-only", {
    customOverrides: [
      customDescriptor({ transports: ["responses"] }),
    ],
  }),
  requestedTools: [required("function_calling")],
});
assert.equal(responsesOnly.transport, "responses");
assert.deepEqual(responsesOnly.enabledTools.map((tool) => tool.intent.id), [
  "function_calling",
]);
console.log("PASS planner chooses the richest compatible declared transport");

let networkInvoked = false;
const fakeProviderFetch = (): never => {
  networkInvoked = true;
  throw new Error("network must not be reached");
};
let requiredError: ProviderCallPlanError | undefined;
try {
  const planned = plan({
    context: context("chatgpt", "gpt-account-model"),
    requestedTools: [required("web_search")],
  });
  void planned;
  fakeProviderFetch();
} catch (error) {
  assert.ok(error instanceof ProviderCallPlanError);
  requiredError = error;
}
assert.equal(networkInvoked, false);
assert.deepEqual(requiredError?.decisions.map((item) => item.code), [
  "conditional_unverified",
]);
console.log("PASS required unavailable tools reject before provider I/O");

const omittedUnknown = plan({
  context: context("custom", "unknown-custom"),
  requestedTools: [optional("function_calling")],
});
assert.equal(omittedUnknown.enabledTools.length, 0);
assert.equal(omittedUnknown.omittedOptionalTools[0]?.code, "unknown");
assert.equal(omittedUnknown.toolPolicyTrace.omittedTools[0]?.capabilityId, "function_calling");
console.log("PASS optional unavailable tools are omitted with stable reasons");

assert.throws(
  () =>
    plan({
      context: context("openai", "gpt-5.6-sol"),
      requestedTools: [required("file_search")],
    }),
  (error: unknown) =>
    error instanceof ProviderCallPlanError &&
    error.decisions.some(
      (decision) =>
        decision.code === "missing_prerequisite" &&
        decision.prerequisiteId === "openai_vector_store",
    ),
);
const readyFileSearch = plan({
  context: context("openai", "gpt-5.6-sol", {
    resourceState: {
      prerequisites: {
        openai_vector_store: { ready: true },
      },
    },
  }),
  requestedTools: [required("file_search")],
});
assert.equal(readyFileSearch.transport, "responses");
assert.equal(readyFileSearch.enabledTools[0]?.readiness, "available");
console.log("PASS supported resource-backed tools distinguish support from readiness");

const structuredFunctions = plan({
  context: context("openai", "gpt-5.6-sol", {
    features: structuredOutputCallFeatures({
      name: "answer",
      schema: { type: "object" },
    }),
  }),
  requestedTools: [required("function_calling")],
});
assert.equal(structuredFunctions.enabledTools[0]?.intent.id, "function_calling");
console.log("PASS structured output does not globally suppress unrelated function tools");

assert.throws(
  () =>
    plan({
      context: context("meta", "muse-spark-1.2", {
        features: { structuredOutput: true },
      }),
      requestedTools: [required("tool_search")],
    }),
  (error: unknown) =>
    error instanceof ProviderCallPlanError &&
    error.decisions.some((decision) => decision.code === "combination_forbidden"),
);
const optionalMetaToolSearch = plan({
  context: context("meta", "muse-spark-1.2", {
    features: { structuredOutput: true },
  }),
  requestedTools: [optional("tool_search")],
});
assert.equal(optionalMetaToolSearch.enabledTools.length, 0);
assert.equal(optionalMetaToolSearch.omittedOptionalTools[0]?.code, "combination_forbidden");
console.log("PASS exact structured-output incompatibilities reject or omit by requirement");

const constrained = customDescriptor({
  transports: ["chat_completions", "responses"],
  constraints: [
    {
      when: "reasoning",
      effect: "requires_transport",
      value: "responses",
      reason: "Reasoning tools require Responses for this endpoint.",
    },
    {
      when: "parallel_tools",
      effect: "forbid",
      reason: "Parallel tools are not accepted by this endpoint.",
    },
    {
      when: "attachments",
      effect: "requires_tool_choice",
      value: "required",
      reason: "Attachment analysis requires a tool call.",
    },
  ],
});
const reasoningTransport = plan({
  context: context("custom", "constrained", {
    customOverrides: [constrained],
    features: { reasoning: true, toolChoice: "required" },
  }),
  requestedTools: [required("function_calling")],
});
assert.equal(reasoningTransport.transport, "responses");
assert.equal(reasoningTransport.toolChoice, "required");
assert.equal(reasoningTransport.parallelToolCalls, false);
assert.throws(
  () =>
    plan({
      context: context("custom", "constrained", {
        customOverrides: [constrained],
        features: { parallelTools: true },
      }),
      requestedTools: [required("function_calling")],
    }),
  ProviderCallPlanError,
);
assert.throws(
  () =>
    plan({
      context: context("custom", "constrained", {
        customOverrides: [constrained],
        features: { attachments: true, toolChoice: "auto" },
      }),
      requestedTools: [required("function_calling")],
    }),
  ProviderCallPlanError,
);
console.log("PASS reasoning, tool choice, and parallel-tool constraints are centralized");

const noTools = plan({
  context: context("custom", "no-tools", {
    customOverrides: [customDescriptor()],
    features: { toolChoice: "none" },
  }),
  requestedTools: [optional("function_calling")],
});
assert.equal(noTools.enabledTools.length, 0);
assert.equal(noTools.omittedOptionalTools[0]?.code, "combination_forbidden");
assert.equal(noTools.toolChoice, "none");
console.log("PASS normalized tool choice none disables optional tool execution centrally");

const mcpPlan = plan({
  context: context("openai", "gpt-5.6-sol", {
    resourceState: {
      prerequisites: {
        remote_mcp_server: { ready: true },
      },
    },
  }),
  requestedTools: [
    optional("function_calling", {
      mcpSourceId: "docs-mcp",
      mcpExecution: "client",
    }),
    optional("remote_mcp", {
      mcpSourceId: "docs-mcp",
      mcpExecution: "provider",
    }),
  ],
});
assert.deepEqual(mcpPlan.enabledTools.map((tool) => tool.intent.id), ["remote_mcp"]);
assert.equal(mcpPlan.omittedOptionalTools[0]?.code, "duplicate_mcp_path");
assert.equal(mcpPlan.transport, "responses");
console.log("PASS one logical MCP source is exposed through exactly one execution path");

assert.deepEqual(mcpPlan.toolPolicyTrace, {
  requestedTools: mcpPlan.toolPolicyTrace.requestedTools,
  enabledTools: ["remote_mcp"],
  omittedTools: mcpPlan.omittedOptionalTools,
  transport: "responses",
  decisions: mcpPlan.toolPolicyTrace.decisions,
});
assert.equal(mcpPlan.toolPolicyTrace.requestedTools.length, 2);
console.log("PASS planner emits an explainable non-persistent tool policy trace");

console.log("PASS");
