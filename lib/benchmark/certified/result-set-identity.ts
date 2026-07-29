import { normalizeBenchmarkReasoningEffort } from "@/lib/benchmark/model-effort";
import type { BenchmarkResultConfiguration } from "@/lib/benchmark/types";

type CanonicalResultConfiguration = Omit<
  BenchmarkResultConfiguration,
  "displayName" | "providerId" | "modelId" | "reasoningEffort" | "strategy"
> & {
  providerId: string | null;
  modelId: string | null;
  reasoningEffort: string;
  strategy: string | null;
};

export function canonicalBenchmarkResultConfiguration(
  input: BenchmarkResultConfiguration
): CanonicalResultConfiguration {
  return {
    subjectKind: input.subjectKind,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    reasoningEffort: normalizeBenchmarkReasoningEffort(input.reasoningEffort),
    strategy: input.strategy ?? null,
    roles: input.roles.map((role) => ({
      role: role.role,
      slot: role.slot,
      providerId: role.providerId,
      modelId: role.modelId,
      reasoningEffort: normalizeBenchmarkReasoningEffort(role.reasoningEffort),
      maxTokens: role.maxTokens,
    })),
    tracks: [...input.tracks]
      .map((track) => ({
        ...track,
        caseManifest: [...track.caseManifest].sort((a, b) =>
          `${a.caseId}:${a.caseVersion}:${a.scoringVersion}`.localeCompare(
            `${b.caseId}:${b.caseVersion}:${b.scoringVersion}`
          )
        ),
      }))
      .sort((a, b) =>
        `${a.track}:${a.suiteId}`.localeCompare(`${b.track}:${b.suiteId}`)
      ),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function canonicalBenchmarkResultConfigurationString(
  input: BenchmarkResultConfiguration
): string {
  return stableStringify(canonicalBenchmarkResultConfiguration(input));
}

export function benchmarkResultConfigurationKey(
  input: BenchmarkResultConfiguration
): string {
  return `result-config-v1:${fnv1a(
    canonicalBenchmarkResultConfigurationString(input)
  )}`;
}
