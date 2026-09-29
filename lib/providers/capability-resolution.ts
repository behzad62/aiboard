import { getProviderCapabilityManifest } from "./capability-manifests";
import {
  resolveToolReadiness,
  type CapabilityEvidence,
  type ProviderCapabilityManifest,
  type ProviderModelCapabilityRule,
  type ToolCapabilityDescriptor,
  type ToolCapabilityId,
  type ToolReadinessResult,
  type ToolResourceState,
} from "./tool-capabilities";

export type CapabilityTransientFailureKind =
  | "auth"
  | "network"
  | "rate_limit"
  | "provider_error";

export interface CapabilityTransientFailure {
  capabilityId: ToolCapabilityId;
  kind: CapabilityTransientFailureKind;
  detail?: string;
  observedAt: string;
}

export interface ResolvedCapabilityEntry {
  descriptor: ToolCapabilityDescriptor;
  readiness: ToolReadinessResult;
  evidence?: CapabilityEvidence;
}

export interface ResolvedCapabilityProfile {
  providerId: string;
  modelId: string;
  capabilities: Record<string, ResolvedCapabilityEntry>;
  transientFailures: CapabilityTransientFailure[];
}

export interface MergeCapabilityEvidenceInput {
  manifest: ProviderCapabilityManifest;
  modelId: string;
  catalogEvidence?: CapabilityEvidence[];
  runnerEvidence?: CapabilityEvidence[];
  resourceState?: ToolResourceState;
  customOverrides?: ToolCapabilityDescriptor[];
  transientFailures?: CapabilityTransientFailure[];
}

export interface ResolveProviderCapabilityProfileInput {
  providerId: string;
  modelId: string;
  catalogEvidence?: CapabilityEvidence[];
  runnerEvidence?: CapabilityEvidence[];
  resourceState?: ToolResourceState;
  customOverrides?: ToolCapabilityDescriptor[];
  transientFailures?: CapabilityTransientFailure[];
}

function cloneDescriptor(
  descriptor: ToolCapabilityDescriptor,
): ToolCapabilityDescriptor {
  return {
    ...descriptor,
    transports: [...descriptor.transports],
    ...(descriptor.prerequisites
      ? { prerequisites: descriptor.prerequisites.map((item) => ({ ...item })) }
      : {}),
    ...(descriptor.constraints
      ? { constraints: descriptor.constraints.map((item) => ({ ...item })) }
      : {}),
  };
}

function matchesRule(rule: ProviderModelCapabilityRule, modelId: string): boolean {
  if (rule.modelId !== undefined && rule.modelId !== modelId) return false;
  if (rule.modelPattern !== undefined) {
    rule.modelPattern.lastIndex = 0;
    if (!rule.modelPattern.test(modelId)) return false;
  }
  return rule.modelId !== undefined || rule.modelPattern !== undefined;
}

function applyModelRules(
  descriptors: Map<ToolCapabilityId, ToolCapabilityDescriptor>,
  rules: readonly ProviderModelCapabilityRule[] | undefined,
  modelId: string,
): void {
  for (const rule of rules ?? []) {
    if (!matchesRule(rule, modelId)) continue;
    for (const [capabilityId, patch] of Object.entries(rule.capabilities)) {
      const current = descriptors.get(capabilityId as ToolCapabilityId);
      if (!current || !patch) continue;
      descriptors.set(capabilityId as ToolCapabilityId, {
        ...current,
        ...patch,
        id: current.id,
        transports: patch.transports
          ? [...patch.transports]
          : [...current.transports],
      });
    }
  }
}

function evidenceApplies(
  evidence: CapabilityEvidence,
  providerId: string,
  modelId: string,
): boolean {
  return (
    evidence.providerId === providerId &&
    (evidence.modelId === undefined || evidence.modelId === modelId)
  );
}

function applyEvidenceLayer(
  descriptors: Map<ToolCapabilityId, ToolCapabilityDescriptor>,
  evidenceByCapability: Map<ToolCapabilityId, CapabilityEvidence>,
  evidenceItems: readonly CapabilityEvidence[] | undefined,
  providerId: string,
  modelId: string,
): void {
  for (const evidence of evidenceItems ?? []) {
    if (!evidenceApplies(evidence, providerId, modelId)) continue;
    const current = descriptors.get(evidence.capabilityId);
    if (!current && (!evidence.execution || !evidence.transport)) continue;
    const descriptor: ToolCapabilityDescriptor = current
      ? {
          ...current,
          support: evidence.support,
          ...(evidence.execution ? { execution: evidence.execution } : {}),
          ...(evidence.transport
            ? {
                transports: current.transports.includes(evidence.transport)
                  ? [...current.transports]
                  : [evidence.transport, ...current.transports],
              }
            : {}),
          supportSource: evidence.source,
          ...(evidence.verifiedAt ? { verifiedAt: evidence.verifiedAt } : {}),
        }
      : {
          id: evidence.capabilityId,
          support: evidence.support,
          execution: evidence.execution!,
          transports: [evidence.transport!],
          supportSource: evidence.source,
          ...(evidence.verifiedAt ? { verifiedAt: evidence.verifiedAt } : {}),
        };
    descriptors.set(evidence.capabilityId, descriptor);
    evidenceByCapability.set(evidence.capabilityId, { ...evidence });
  }
}

function applyCustomOverrides(
  descriptors: Map<ToolCapabilityId, ToolCapabilityDescriptor>,
  evidenceByCapability: Map<ToolCapabilityId, CapabilityEvidence>,
  providerId: string,
  modelId: string,
  overrides: readonly ToolCapabilityDescriptor[] | undefined,
): void {
  if (providerId !== "custom") return;
  for (const override of overrides ?? []) {
    const descriptor = cloneDescriptor({
      ...override,
      supportSource: "user-override",
    });
    descriptors.set(override.id, descriptor);
    evidenceByCapability.set(override.id, {
      providerId,
      modelId,
      capabilityId: override.id,
      support: override.support,
      execution: override.execution,
      transport: override.transports[0],
      source: "user-override",
      verifiedAt: override.verifiedAt,
    });
  }
}

export function mergeCapabilityEvidence(
  input: MergeCapabilityEvidenceInput,
): ResolvedCapabilityProfile {
  const descriptors = new Map<ToolCapabilityId, ToolCapabilityDescriptor>(
    input.manifest.capabilities.map((descriptor) => [
      descriptor.id,
      cloneDescriptor(descriptor),
    ]),
  );
  const evidenceByCapability = new Map<ToolCapabilityId, CapabilityEvidence>();

  applyModelRules(descriptors, input.manifest.modelRules, input.modelId);
  applyEvidenceLayer(
    descriptors,
    evidenceByCapability,
    input.catalogEvidence,
    input.manifest.providerId,
    input.modelId,
  );
  applyEvidenceLayer(
    descriptors,
    evidenceByCapability,
    input.runnerEvidence,
    input.manifest.providerId,
    input.modelId,
  );
  applyCustomOverrides(
    descriptors,
    evidenceByCapability,
    input.manifest.providerId,
    input.modelId,
    input.customOverrides,
  );

  const capabilities: Record<string, ResolvedCapabilityEntry> = {};
  for (const [capabilityId, descriptor] of descriptors) {
    capabilities[capabilityId] = {
      descriptor,
      readiness: resolveToolReadiness(descriptor, input.resourceState),
      ...(evidenceByCapability.has(capabilityId)
        ? { evidence: evidenceByCapability.get(capabilityId) }
        : {}),
    };
  }

  return {
    providerId: input.manifest.providerId,
    modelId: input.modelId,
    capabilities,
    transientFailures: [...(input.transientFailures ?? [])],
  };
}

export function resolveProviderCapabilityProfile(
  input: ResolveProviderCapabilityProfileInput,
): ResolvedCapabilityProfile {
  const manifest = getProviderCapabilityManifest(input.providerId);
  if (!manifest) {
    throw new Error(`No provider capability manifest for ${input.providerId}`);
  }
  return mergeCapabilityEvidence({
    manifest,
    modelId: input.modelId,
    catalogEvidence: input.catalogEvidence,
    runnerEvidence: input.runnerEvidence,
    resourceState: input.resourceState,
    customOverrides: input.customOverrides,
    transientFailures: input.transientFailures,
  });
}

export function getResolvedCapability(
  profile: ResolvedCapabilityProfile,
  capabilityId: ToolCapabilityId,
): ResolvedCapabilityEntry | undefined {
  return profile.capabilities[capabilityId];
}
