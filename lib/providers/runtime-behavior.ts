import { parseModelId } from "./base";
import {
  getProviderDefinition,
  type ModelRuntimeBehavior,
} from "./provider-registry";

export type { ModelRuntimeBehavior } from "./provider-registry";

export function getModelRuntimeBehavior(fullModelId: string): ModelRuntimeBehavior {
  const { providerId } = parseModelId(fullModelId);
  const definition = getProviderDefinition(providerId);
  if (definition) return definition.runtimeBehavior;

  return {
    temperatureLabel: "Temperature handling unknown",
    temperatureNote:
      "This provider does not have explicit runtime-behavior metadata yet.",
    promptCachingLabel: "Prompt caching unknown",
    promptCachingNote:
      "This provider does not have explicit runtime-behavior metadata yet.",
  };
}
