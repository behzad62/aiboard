import type {
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
} from "@/lib/benchmark/types";

export interface TeamIqSoloCompositionInput {
  modelId: string;
  displayName?: string;
  providerId?: string;
  reasoningEffort?: BenchmarkTeamCompositionRole["reasoningEffort"];
  temperature?: number;
  maxTokens?: number;
  name?: string;
  id?: string;
  comboHash?: string;
}

export interface TeamIqCompositionInput {
  name: string;
  roles: BenchmarkTeamCompositionRole[];
  id?: string;
  comboHash?: string;
}

export function deriveSoloTeamComposition(
  input: TeamIqSoloCompositionInput
): BenchmarkTeamComposition {
  const providerId = input.providerId ?? inferProviderId(input.modelId);
  const displayName = input.displayName ?? input.modelId;
  const role: BenchmarkTeamCompositionRole = {
    role: "single",
    slot: "single",
    modelId: input.modelId,
    providerId,
    displayName,
    reasoningEffort: input.reasoningEffort,
    temperature: input.temperature ?? 0,
    maxTokens: input.maxTokens,
  };
  const roles = normalizeTeamRoles([role]);
  const comboHash = input.comboHash ?? comboHashFor("solo", roles);

  return {
    id: input.id ?? idFor("solo", comboHash),
    name: input.name ?? `${displayName} solo`,
    comboHash,
    roles,
  };
}

export function deriveTeamComposition(
  input: TeamIqCompositionInput
): BenchmarkTeamComposition {
  const roles = normalizeTeamRoles(input.roles);
  const comboHash = input.comboHash ?? comboHashFor("team", roles);

  return {
    id: input.id ?? idFor("team", comboHash),
    name: input.name,
    comboHash,
    roles,
  };
}

export function normalizeTeamRoles(
  roles: BenchmarkTeamCompositionRole[]
): BenchmarkTeamCompositionRole[] {
  return roles
    .map((role) => ({
      role: role.role,
      slot: role.slot,
      modelId: role.modelId,
      providerId: role.providerId || inferProviderId(role.modelId),
      displayName: role.displayName || role.modelId,
      reasoningEffort: role.reasoningEffort,
      temperature: Number.isFinite(role.temperature) ? role.temperature : 0,
      maxTokens: role.maxTokens,
    }))
    .sort((a, b) =>
      [a.slot, a.role, a.modelId].join("\u0000").localeCompare(
        [b.slot, b.role, b.modelId].join("\u0000")
      )
    );
}

export function getTeamCompositionModelIds(
  team: BenchmarkTeamComposition | undefined
): string[] {
  if (!team) return [];
  return Array.from(
    new Set(
      team.roles
        .map((role) => role.modelId)
        .filter((modelId): modelId is string => Boolean(modelId))
    )
  ).sort();
}

export function isSoloTeamComposition(
  team: BenchmarkTeamComposition | undefined
): boolean {
  return getTeamCompositionModelIds(team).length === 1;
}

export function inferProviderId(modelId: string): string {
  const index = modelId.indexOf(":");
  return index > 0 ? modelId.slice(0, index) : "custom";
}

function comboHashFor(
  prefix: "solo" | "team",
  roles: BenchmarkTeamCompositionRole[]
): string {
  const payload = roles.map((role) => ({
    role: role.role,
    slot: role.slot,
    modelId: role.modelId,
    providerId: role.providerId,
    reasoningEffort: role.reasoningEffort ?? null,
    temperature: role.temperature,
    maxTokens: role.maxTokens ?? null,
  }));
  return `${prefix}:${stableHash(stableStringify(payload))}`;
}

function idFor(prefix: "solo" | "team", comboHash: string): string {
  return `teamiq-${prefix}-${comboHash.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
