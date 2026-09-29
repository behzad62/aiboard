import {
  PROVIDER_TRANSPORT_IDS,
  isProviderTransportId,
  type ProviderTransportId,
} from "./tool-capabilities";

export interface ProviderTransportMetadata {
  id: ProviderTransportId;
  label: string;
  protocolFamily: "openai" | "anthropic" | "gemini" | "copilot" | "runner";
}

export const PROVIDER_TRANSPORT_REGISTRY: Readonly<
  Record<ProviderTransportId, ProviderTransportMetadata>
> = {
  responses: { id: "responses", label: "Responses", protocolFamily: "openai" },
  chat_completions: {
    id: "chat_completions",
    label: "Chat Completions",
    protocolFamily: "openai",
  },
  messages: { id: "messages", label: "Messages", protocolFamily: "anthropic" },
  gemini_interactions: {
    id: "gemini_interactions",
    label: "Gemini Interactions",
    protocolFamily: "gemini",
  },
  gemini_generate_content: {
    id: "gemini_generate_content",
    label: "Gemini Generate Content",
    protocolFamily: "gemini",
  },
  copilot_sdk: {
    id: "copilot_sdk",
    label: "Copilot SDK",
    protocolFamily: "copilot",
  },
  runner_proxy: {
    id: "runner_proxy",
    label: "Runner Proxy",
    protocolFamily: "runner",
  },
};

export function normalizeTransportOrder(
  transports: readonly ProviderTransportId[],
): ProviderTransportId[] {
  const seen = new Set<ProviderTransportId>();
  const ordered: ProviderTransportId[] = [];
  for (const transport of transports) {
    if (!isProviderTransportId(transport) || seen.has(transport)) continue;
    seen.add(transport);
    ordered.push(transport);
  }
  return ordered;
}

export function getTransportMetadata(
  transports: readonly ProviderTransportId[] = PROVIDER_TRANSPORT_IDS,
): ProviderTransportMetadata[] {
  return normalizeTransportOrder(transports).map(
    (transport) => PROVIDER_TRANSPORT_REGISTRY[transport],
  );
}
