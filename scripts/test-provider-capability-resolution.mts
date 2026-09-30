import assert from "node:assert/strict";
import {
  CAPABILITY_MANIFEST_PROVIDER_IDS,
  getProviderCapabilityManifest,
} from "../lib/providers/capability-manifests";
import {
  mergeCapabilityEvidence,
  resolveProviderCapabilityProfile,
} from "../lib/providers/capability-resolution";
import type {
  CapabilityEvidence,
  ToolCapabilityDescriptor,
} from "../lib/providers/tool-capabilities";

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

assert.deepEqual(CAPABILITY_MANIFEST_PROVIDER_IDS, [
  "openai",
  "anthropic",
  "foundry",
  "google",
  "openrouter",
  "xai",
  "meta",
  "chatgpt",
  "github-copilot",
  "nvidia",
  "custom",
]);
pass("one canonical capability manifest exists for every provider path");

const transportSnapshot = Object.fromEntries(
  CAPABILITY_MANIFEST_PROVIDER_IDS.map((providerId) => [
    providerId,
    getProviderCapabilityManifest(providerId)?.transports,
  ]),
);
assert.deepEqual(transportSnapshot, {
  openai: ["responses", "chat_completions"],
  anthropic: ["messages"],
  foundry: ["messages"],
  google: ["gemini_interactions", "gemini_generate_content"],
  openrouter: ["responses", "chat_completions"],
  xai: ["responses"],
  meta: ["responses", "chat_completions"],
  chatgpt: ["runner_proxy"],
  "github-copilot": ["copilot_sdk", "runner_proxy"],
  nvidia: ["responses", "chat_completions", "runner_proxy"],
  custom: ["chat_completions", "responses"],
});
pass("provider manifests declare deterministic transport preference");

function capability(providerId: string, id: string): ToolCapabilityDescriptor {
  const descriptor = getProviderCapabilityManifest(providerId)?.capabilities.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(descriptor, `${providerId} should declare ${id}`);
  return descriptor;
}

assert.deepEqual(
  {
    openaiSearch: capability("openai", "web_search"),
    openaiFileSearch: capability("openai", "file_search"),
    anthropicShell: capability("anthropic", "shell"),
    foundrySearch: capability("foundry", "web_search"),
    googleComputer: capability("google", "computer_use"),
    xaiCollections: capability("xai", "file_search"),
    metaToolSearch: capability("meta", "tool_search"),
    copilotFunctions: capability("github-copilot", "function_calling"),
    nvidiaFunctions: capability("nvidia", "function_calling"),
    chatgptFunctions: capability("chatgpt", "function_calling"),
    customFunctions: capability("custom", "function_calling"),
  },
  {
    openaiSearch: {
      id: "web_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    openaiFileSearch: {
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
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    anthropicShell: {
      id: "shell",
      support: "supported",
      execution: "client",
      transports: ["messages"],
      prerequisites: [
        {
          id: "local_shell_executor",
          label: "Local shell executor",
          kind: "runtime",
          configurationPath: "tools.localShell",
        },
      ],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    foundrySearch: {
      id: "web_search",
      support: "conditional",
      execution: "provider",
      transports: ["messages"],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    googleComputer: {
      id: "computer_use",
      support: "unsupported",
      execution: "client",
      transports: ["gemini_interactions"],
      prerequisites: [
        {
          id: "computer_executor",
          label: "Computer-use executor",
          kind: "runtime",
          configurationPath: "tools.computerUse",
        },
      ],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    xaiCollections: {
      id: "file_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      prerequisites: [
        {
          id: "xai_collection",
          label: "xAI collection",
          kind: "resource",
          configurationPath: "providers.xai.collectionIds",
        },
      ],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    metaToolSearch: {
      id: "tool_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      constraints: [
        {
          when: "tool_choice",
          effect: "requires_tool_choice",
          value: "auto",
          reason: "Meta Model API supports only automatic tool choice.",
        },
        {
          when: "structured_output",
          effect: "forbid",
          reason: "Meta tool search cannot be combined with JSON-schema structured output.",
        },
      ],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    copilotFunctions: {
      id: "function_calling",
      support: "conditional",
      execution: "runner",
      transports: ["copilot_sdk", "runner_proxy"],
      supportSource: "runner",
    },
    nvidiaFunctions: {
      id: "function_calling",
      support: "conditional",
      execution: "client",
      transports: ["responses", "chat_completions", "runner_proxy"],
      supportSource: "provider-docs",
      verifiedAt: "2026-09-29",
    },
    chatgptFunctions: {
      id: "function_calling",
      support: "conditional",
      execution: "runner",
      transports: ["runner_proxy"],
      supportSource: "runner",
    },
    customFunctions: {
      id: "function_calling",
      support: "unknown",
      execution: "client",
      transports: ["chat_completions", "responses"],
      supportSource: "user-override",
    },
  },
);
pass("provider manifest baselines preserve execution, prerequisites, constraints, and evidence source");

const openRouterCatalogEvidence: CapabilityEvidence[] = [
  {
    providerId: "openrouter",
    modelId: "example/no-tools",
    capabilityId: "function_calling",
    transport: "responses",
    support: "unsupported",
    execution: "client",
    source: "provider-catalog",
    verifiedAt: "2026-09-29T12:00:00.000Z",
  },
];
const narrowed = resolveProviderCapabilityProfile({
  providerId: "openrouter",
  modelId: "example/no-tools",
  catalogEvidence: openRouterCatalogEvidence,
});
assert.equal(narrowed.capabilities.function_calling.descriptor.support, "unsupported");
assert.equal(
  narrowed.capabilities.function_calling.evidence?.source,
  "provider-catalog",
);
pass("provider catalog evidence narrows a provider baseline for the selected model");

const chatgptRunnerEvidence: CapabilityEvidence[] = [
  {
    providerId: "chatgpt",
    modelId: "gpt-account-model",
    capabilityId: "function_calling",
    transport: "runner_proxy",
    support: "supported",
    execution: "runner",
    source: "runner",
    verifiedAt: "2026-09-29T12:00:00.000Z",
  },
];
const runnerResolved = resolveProviderCapabilityProfile({
  providerId: "chatgpt",
  modelId: "gpt-account-model",
  runnerEvidence: chatgptRunnerEvidence,
});
assert.equal(runnerResolved.capabilities.function_calling.descriptor.support, "supported");
assert.equal(runnerResolved.capabilities.function_calling.evidence?.source, "runner");
pass("runner handshake evidence resolves account-provider conditional support");

const resourceResolved = resolveProviderCapabilityProfile({
  providerId: "openai",
  modelId: "gpt-current",
  resourceState: {
    prerequisites: {
      openai_vector_store: { ready: false, reason: "No vector store configured" },
    },
  },
});
assert.equal(resourceResolved.capabilities.file_search.descriptor.support, "supported");
assert.equal(resourceResolved.capabilities.file_search.readiness.status, "setup_required");
pass("resource state changes readiness without rewriting provider support evidence");

const customOverride: ToolCapabilityDescriptor = {
  id: "function_calling",
  support: "supported",
  execution: "client",
  transports: ["chat_completions"],
  supportSource: "user-override",
};
const customResolved = resolveProviderCapabilityProfile({
  providerId: "custom",
  modelId: "my-endpoint",
  customOverrides: [customOverride],
});
assert.equal(customResolved.capabilities.function_calling.descriptor.support, "supported");
assert.equal(customResolved.capabilities.function_calling.evidence?.source, "user-override");
const ignoredOverride = resolveProviderCapabilityProfile({
  providerId: "openai",
  modelId: "gpt-current",
  customOverrides: [{ ...customOverride, support: "unsupported" }],
});
assert.equal(ignoredOverride.capabilities.function_calling.descriptor.support, "supported");
pass("explicit capability overrides apply only to custom endpoints");

const baselineOpenAI = getProviderCapabilityManifest("openai");
assert.ok(baselineOpenAI);
const transient = mergeCapabilityEvidence({
  manifest: baselineOpenAI,
  modelId: "gpt-current",
  transientFailures: [
    {
      capabilityId: "function_calling",
      kind: "auth",
      detail: "401 while probing",
      observedAt: "2026-09-29T12:00:00.000Z",
    },
  ],
});
assert.equal(transient.capabilities.function_calling.descriptor.support, "supported");
assert.equal(transient.transientFailures.length, 1);
pass("transient auth/network probe failures never become permanent unsupported evidence");

console.log("PASS");
