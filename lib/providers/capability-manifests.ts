import type {
  CapabilityPrerequisite,
  ProviderCapabilityManifest,
  ProviderModelCapabilityRule,
  ProviderTransportId,
  ToolCapabilityDescriptor,
  ToolCapabilityId,
  ToolCombinationConstraint,
  ToolExecutionLocation,
  ToolSupportStatus,
} from "./tool-capabilities";

const VERIFIED_AT = "2026-09-29";

export const CAPABILITY_MANIFEST_PROVIDER_IDS = [
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
] as const;

export type CapabilityManifestProviderId =
  (typeof CAPABILITY_MANIFEST_PROVIDER_IDS)[number];

function documentedCapability(input: {
  id: ToolCapabilityId;
  support?: ToolSupportStatus;
  execution: ToolExecutionLocation;
  transports: ProviderTransportId[];
  prerequisites?: CapabilityPrerequisite[];
  constraints?: ToolCombinationConstraint[];
}): ToolCapabilityDescriptor {
  return {
    id: input.id,
    support: input.support ?? "supported",
    execution: input.execution,
    transports: input.transports,
    ...(input.prerequisites ? { prerequisites: input.prerequisites } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
    supportSource: "provider-docs",
    verifiedAt: VERIFIED_AT,
  };
}

function runnerConditional(
  id: ToolCapabilityId,
  execution: ToolExecutionLocation,
  transports: ProviderTransportId[],
): ToolCapabilityDescriptor {
  return {
    id,
    support: "conditional",
    execution,
    transports,
    supportSource: "runner",
  };
}

const LOCAL_SHELL: CapabilityPrerequisite = {
  id: "local_shell_executor",
  label: "Local shell executor",
  kind: "runtime",
  configurationPath: "tools.localShell",
};
const LOCAL_EDITOR: CapabilityPrerequisite = {
  id: "local_editor_executor",
  label: "Local editor executor",
  kind: "runtime",
  configurationPath: "tools.localEditor",
};
const COMPUTER_EXECUTOR: CapabilityPrerequisite = {
  id: "computer_executor",
  label: "Computer-use executor",
  kind: "runtime",
  configurationPath: "tools.computerUse",
};
const BROWSER_EXECUTOR: CapabilityPrerequisite = {
  id: "browser_executor",
  label: "Browser-use executor",
  kind: "runtime",
  configurationPath: "tools.browserUse",
};
const REMOTE_MCP: CapabilityPrerequisite = {
  id: "remote_mcp_server",
  label: "Approved remote MCP server",
  kind: "configuration",
  configurationPath: "tools.remoteMcpServers",
};

const OPENROUTER_MODELS_WITH_FUNCTION_TOOLS = [
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "minimax/minimax-m3",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k3",
] as const;

const NVIDIA_MODELS_WITH_FUNCTION_TOOLS = [
  "z-ai/glm-5.2",
  "minimaxai/minimax-m3",
  "deepseek-ai/deepseek-v4-pro",
  "nvidia/nemotron-3-ultra-550b-a55b",
] as const;

function exactModelSupportRules(
  modelIds: readonly string[],
  capabilityId: ToolCapabilityId,
): ProviderModelCapabilityRule[] {
  return modelIds.map((modelId) => ({
    modelId,
    capabilities: {
      [capabilityId]: { support: "supported" },
    },
  }));
}

const OPENAI_MANIFEST: ProviderCapabilityManifest = {
  providerId: "openai",
  transports: ["responses", "chat_completions"],
  capabilities: [
    documentedCapability({
      id: "function_calling",
      execution: "client",
      transports: ["responses", "chat_completions"],
    }),
    documentedCapability({
      id: "web_search",
      execution: "provider",
      transports: ["responses"],
    }),
    documentedCapability({
      id: "file_search",
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
    }),
    documentedCapability({
      id: "remote_mcp",
      execution: "provider",
      transports: ["responses"],
      prerequisites: [REMOTE_MCP],
    }),
    documentedCapability({
      id: "tool_search",
      execution: "provider",
      transports: ["responses"],
    }),
    documentedCapability({
      id: "shell",
      execution: "provider",
      transports: ["responses"],
    }),
    documentedCapability({
      id: "code_execution",
      execution: "provider",
      transports: ["responses"],
    }),
    documentedCapability({
      id: "computer_use",
      execution: "client",
      transports: ["responses"],
      prerequisites: [COMPUTER_EXECUTOR],
    }),
    documentedCapability({
      id: "image_generation",
      execution: "provider",
      transports: ["responses"],
    }),
    documentedCapability({
      id: "apply_patch",
      execution: "client",
      transports: ["responses"],
      prerequisites: [LOCAL_EDITOR],
    }),
  ],
  modelRules: [
    {
      modelPattern: /codex/i,
      capabilities: { web_search: { support: "unsupported" } },
    },
    {
      modelPattern: /^gpt-(?:[1-4](?:\.|-|$)|5\.[0-3](?:-|$))/i,
      capabilities: { web_search: { support: "unsupported" } },
    },
  ],
};

const ANTHROPIC_MANIFEST: ProviderCapabilityManifest = {
  providerId: "anthropic",
  transports: ["messages"],
  capabilities: [
    documentedCapability({ id: "function_calling", execution: "client", transports: ["messages"] }),
    documentedCapability({ id: "web_search", execution: "provider", transports: ["messages"] }),
    documentedCapability({ id: "web_fetch", execution: "provider", transports: ["messages"] }),
    documentedCapability({ id: "code_execution", execution: "provider", transports: ["messages"] }),
    documentedCapability({ id: "advisor", execution: "provider", transports: ["messages"] }),
    documentedCapability({ id: "tool_search", execution: "provider", transports: ["messages"] }),
    documentedCapability({
      id: "remote_mcp",
      execution: "provider",
      transports: ["messages"],
      prerequisites: [REMOTE_MCP],
    }),
    documentedCapability({
      id: "shell",
      execution: "client",
      transports: ["messages"],
      prerequisites: [LOCAL_SHELL],
    }),
    documentedCapability({
      id: "apply_patch",
      execution: "client",
      transports: ["messages"],
      prerequisites: [LOCAL_EDITOR],
    }),
    documentedCapability({
      id: "computer_use",
      execution: "client",
      transports: ["messages"],
      prerequisites: [COMPUTER_EXECUTOR],
    }),
    documentedCapability({
      id: "browser_use",
      execution: "client",
      transports: ["messages"],
      prerequisites: [BROWSER_EXECUTOR],
    }),
  ],
};

const FOUNDRY_MANIFEST: ProviderCapabilityManifest = {
  providerId: "foundry",
  transports: ["messages"],
  capabilities: [
    documentedCapability({ id: "function_calling", execution: "client", transports: ["messages"] }),
    documentedCapability({
      id: "web_search",
      support: "conditional",
      execution: "provider",
      transports: ["messages"],
    }),
    documentedCapability({
      id: "web_fetch",
      support: "conditional",
      execution: "provider",
      transports: ["messages"],
    }),
    documentedCapability({
      id: "code_execution",
      support: "conditional",
      execution: "provider",
      transports: ["messages"],
    }),
    documentedCapability({
      id: "remote_mcp",
      support: "conditional",
      execution: "provider",
      transports: ["messages"],
      prerequisites: [REMOTE_MCP],
    }),
    documentedCapability({
      id: "shell",
      execution: "client",
      transports: ["messages"],
      prerequisites: [LOCAL_SHELL],
    }),
    documentedCapability({
      id: "apply_patch",
      execution: "client",
      transports: ["messages"],
      prerequisites: [LOCAL_EDITOR],
    }),
  ],
};

const GOOGLE_MANIFEST: ProviderCapabilityManifest = {
  providerId: "google",
  transports: ["gemini_interactions", "gemini_generate_content"],
  capabilities: [
    documentedCapability({
      id: "function_calling",
      execution: "client",
      transports: ["gemini_interactions", "gemini_generate_content"],
    }),
    documentedCapability({
      id: "web_search",
      execution: "provider",
      transports: ["gemini_interactions", "gemini_generate_content"],
    }),
    documentedCapability({
      id: "url_context",
      execution: "provider",
      transports: ["gemini_interactions", "gemini_generate_content"],
    }),
    documentedCapability({
      id: "file_search",
      execution: "provider",
      transports: ["gemini_interactions"],
      prerequisites: [
        {
          id: "gemini_file_search_store",
          label: "Gemini File Search store",
          kind: "resource",
          configurationPath: "providers.google.fileSearchStoreIds",
        },
      ],
    }),
    documentedCapability({
      id: "maps",
      execution: "provider",
      transports: ["gemini_interactions", "gemini_generate_content"],
    }),
    documentedCapability({
      id: "code_execution",
      execution: "provider",
      transports: ["gemini_interactions", "gemini_generate_content"],
    }),
    documentedCapability({
      id: "computer_use",
      execution: "client",
      transports: ["gemini_interactions"],
      prerequisites: [COMPUTER_EXECUTOR],
    }),
    documentedCapability({
      id: "remote_mcp",
      execution: "provider",
      transports: ["gemini_interactions"],
      prerequisites: [REMOTE_MCP],
    }),
  ],
};

const OPENROUTER_MANIFEST: ProviderCapabilityManifest = {
  providerId: "openrouter",
  transports: ["responses", "chat_completions"],
  capabilities: [
    documentedCapability({
      id: "function_calling",
      support: "conditional",
      execution: "client",
      transports: ["responses", "chat_completions"],
    }),
    documentedCapability({ id: "web_search", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "web_fetch", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "shell", execution: "provider", transports: ["responses"] }),
    documentedCapability({ id: "apply_patch", execution: "provider", transports: ["responses"] }),
    documentedCapability({ id: "datetime", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "image_generation", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "advisor", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "subagent", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "fusion", execution: "provider", transports: ["responses", "chat_completions"] }),
    documentedCapability({ id: "tool_search", execution: "provider", transports: ["responses"] }),
  ],
  modelRules: exactModelSupportRules(
    OPENROUTER_MODELS_WITH_FUNCTION_TOOLS,
    "function_calling",
  ),
};

const XAI_MANIFEST: ProviderCapabilityManifest = {
  providerId: "xai",
  transports: ["responses"],
  capabilities: [
    documentedCapability({ id: "function_calling", execution: "client", transports: ["responses"] }),
    documentedCapability({ id: "web_search", execution: "provider", transports: ["responses"] }),
    documentedCapability({ id: "x_search", execution: "provider", transports: ["responses"] }),
    documentedCapability({ id: "code_execution", execution: "provider", transports: ["responses"] }),
    documentedCapability({
      id: "file_search",
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
    }),
    documentedCapability({
      id: "remote_mcp",
      execution: "provider",
      transports: ["responses"],
      prerequisites: [REMOTE_MCP],
    }),
    documentedCapability({ id: "image_generation", execution: "provider", transports: ["responses"] }),
  ],
};

const META_MANIFEST: ProviderCapabilityManifest = {
  providerId: "meta",
  transports: ["responses", "chat_completions"],
  capabilities: [
    documentedCapability({
      id: "function_calling",
      execution: "client",
      transports: ["responses", "chat_completions"],
    }),
    documentedCapability({ id: "web_search", execution: "provider", transports: ["responses"] }),
    documentedCapability({
      id: "tool_search",
      execution: "provider",
      transports: ["responses"],
      constraints: [
        {
          when: "structured_output",
          effect: "forbid",
          reason: "Meta tool search cannot be combined with JSON-schema structured output.",
        },
      ],
    }),
  ],
};

const CHATGPT_MANIFEST: ProviderCapabilityManifest = {
  providerId: "chatgpt",
  transports: ["runner_proxy"],
  capabilities: [
    runnerConditional("function_calling", "runner", ["runner_proxy"]),
    runnerConditional("web_search", "provider", ["runner_proxy"]),
  ],
};

const COPILOT_MANIFEST: ProviderCapabilityManifest = {
  providerId: "github-copilot",
  transports: ["copilot_sdk", "runner_proxy"],
  capabilities: [
    runnerConditional("function_calling", "runner", ["copilot_sdk", "runner_proxy"]),
    runnerConditional("tool_search", "runner", ["copilot_sdk"]),
    runnerConditional("remote_mcp", "runner", ["copilot_sdk"]),
    runnerConditional("shell", "runner", ["copilot_sdk"]),
    runnerConditional("apply_patch", "runner", ["copilot_sdk"]),
    runnerConditional("browser_use", "runner", ["copilot_sdk"]),
    runnerConditional("memory", "runner", ["copilot_sdk"]),
  ],
};

const NVIDIA_MANIFEST: ProviderCapabilityManifest = {
  providerId: "nvidia",
  transports: ["responses", "chat_completions", "runner_proxy"],
  capabilities: [
    documentedCapability({
      id: "function_calling",
      support: "conditional",
      execution: "client",
      transports: ["responses", "chat_completions", "runner_proxy"],
    }),
  ],
  modelRules: exactModelSupportRules(
    NVIDIA_MODELS_WITH_FUNCTION_TOOLS,
    "function_calling",
  ),
};

const CUSTOM_MANIFEST: ProviderCapabilityManifest = {
  providerId: "custom",
  transports: ["chat_completions", "responses"],
  capabilities: [
    {
      id: "function_calling",
      support: "unknown",
      execution: "client",
      transports: ["chat_completions", "responses"],
      supportSource: "user-override",
    },
  ],
};

export const PROVIDER_CAPABILITY_MANIFESTS: Readonly<
  Record<CapabilityManifestProviderId, ProviderCapabilityManifest>
> = {
  openai: OPENAI_MANIFEST,
  anthropic: ANTHROPIC_MANIFEST,
  foundry: FOUNDRY_MANIFEST,
  google: GOOGLE_MANIFEST,
  openrouter: OPENROUTER_MANIFEST,
  xai: XAI_MANIFEST,
  meta: META_MANIFEST,
  chatgpt: CHATGPT_MANIFEST,
  "github-copilot": COPILOT_MANIFEST,
  nvidia: NVIDIA_MANIFEST,
  custom: CUSTOM_MANIFEST,
};

export function getProviderCapabilityManifest(
  providerId: string,
): ProviderCapabilityManifest | undefined {
  return PROVIDER_CAPABILITY_MANIFESTS[
    providerId as CapabilityManifestProviderId
  ];
}
