import { parseModelId } from "@/lib/providers/base";
import type { UserSettings } from "@/lib/db/schema";
import type { CapabilityEvidence } from "@/lib/providers/tool-capabilities";

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function capabilityEvidenceKey(evidence: CapabilityEvidence): string {
  return [
    evidence.providerId,
    evidence.modelId ?? "*",
    evidence.capabilityId,
    evidence.transport ?? "*",
    evidence.source,
  ].join("|");
}

export function mergeCapabilityEvidenceRecords(
  existing: readonly CapabilityEvidence[] | undefined,
  incoming: readonly CapabilityEvidence[],
): CapabilityEvidence[] {
  const byKey = new Map<string, CapabilityEvidence>();
  for (const item of existing ?? []) byKey.set(capabilityEvidenceKey(item), { ...item });
  for (const item of incoming) byKey.set(capabilityEvidenceKey(item), { ...item });
  return [...byKey.values()];
}

export function migrateProviderCapabilitySettings(
  input: UserSettings,
): { settings: UserSettings; changed: boolean } {
  const legacy = input.discoveredModelCapabilities;
  if (!legacy) return { settings: input, changed: false };

  const settings = structuredClone(input);
  const metadata = { ...(settings.discoveredModelMetadata ?? {}) };
  const migratedEvidence: CapabilityEvidence[] = [];

  for (const [fullModelId, entry] of Object.entries(legacy)) {
    metadata[fullModelId] = {
      image: entry.image,
      document: entry.document,
      audio: entry.audio,
      video: entry.video,
      apiParameters: {
        ...(entry.toolChoice !== undefined ? { toolChoice: entry.toolChoice } : {}),
        ...(entry.structuredOutputs !== undefined
          ? { structuredOutputs: entry.structuredOutputs }
          : {}),
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        ...(entry.reasoningEffort !== undefined
          ? { reasoningEffort: entry.reasoningEffort }
          : {}),
        ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
        ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      },
      updatedAt: entry.updatedAt,
      source: entry.source,
    };

    if (entry.source === "openrouter-models" && entry.tools !== undefined) {
      const parsed = parseModelId(fullModelId);
      if (parsed.providerId === "openrouter") {
        migratedEvidence.push({
          providerId: "openrouter",
          modelId: parsed.model,
          capabilityId: "function_calling",
          transport: "responses",
          support: entry.tools ? "supported" : "unsupported",
          execution: "client",
          source: "provider-catalog",
          verifiedAt: entry.updatedAt,
          detail: "Migrated from OpenRouter supported_parameters.tools catalog metadata.",
        });
      }
    }
  }

  settings.discoveredModelMetadata = metadata;
  settings.providerToolCapabilityEvidence = mergeCapabilityEvidenceRecords(
    settings.providerToolCapabilityEvidence,
    migratedEvidence,
  );
  delete settings.discoveredModelCapabilities;

  return {
    settings,
    changed: !sameJson(settings, input),
  };
}
