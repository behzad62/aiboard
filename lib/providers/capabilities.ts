import type { CapabilityInputType } from "../attachments/types";
import type { ModelCapabilities } from "./base";
import { getCapabilitiesMap } from "./catalog";

export type { ModelCapabilities } from "./base";

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  image: false,
  document: false,
  audio: false,
  video: false,
};

let capabilitiesCache: Record<string, ModelCapabilities> | null = null;

function getCapabilitiesRegistry(): Record<string, ModelCapabilities> {
  if (!capabilitiesCache) {
    capabilitiesCache = getCapabilitiesMap();
  }
  return capabilitiesCache;
}

export function getModelCapabilities(fullModelId: string): ModelCapabilities {
  return getCapabilitiesRegistry()[fullModelId] ?? DEFAULT_CAPABILITIES;
}

export function modelSupportsInputTypes(
  fullModelId: string,
  required: CapabilityInputType[]
): boolean {
  if (required.length === 0) return true;
  const caps = getModelCapabilities(fullModelId);
  return required.every((type) => caps[type]);
}

/**
 * Capability check against an explicit capabilities object. Used for custom
 * models, whose capabilities live on the model record / ModelInfo rather than
 * the static catalog registry.
 */
export function supportsInputTypes(
  caps: ModelCapabilities | undefined,
  required: CapabilityInputType[]
): boolean {
  if (required.length === 0) return true;
  if (!caps) return false;
  return required.every((type) => caps[type]);
}

export function unsupportedInputTypes(
  caps: ModelCapabilities | undefined,
  required: CapabilityInputType[]
): CapabilityInputType[] {
  const resolved = caps ?? DEFAULT_CAPABILITIES;
  return required.filter((type) => !resolved[type]);
}

export function getUnsupportedTypes(
  fullModelId: string,
  required: CapabilityInputType[]
): CapabilityInputType[] {
  const caps = getModelCapabilities(fullModelId);
  return required.filter((type) => !caps[type]);
}

export function capabilitiesToArray(caps: ModelCapabilities): CapabilityInputType[] {
  return (Object.entries(caps) as [CapabilityInputType, boolean][])
    .filter(([, supported]) => supported)
    .map(([type]) => type);
}
