"use client";

import { useMemo } from "react";
import { ModelContextEditor } from "@/components/ModelContextEditor";
import { ModelPricingEditor } from "@/components/ModelPricingEditor";
import { getUserSettings } from "@/lib/client/store";
import { resolveModelContextProfile } from "@/lib/providers/model-context";
import { getModelPricing } from "@/lib/providers/pricing";

export function ProviderModelOptions({ providerId, modelId, catalogBacked, onSaved }: {
  providerId: string;
  modelId: string;
  catalogBacked: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const settings = getUserSettings();
  const fullModelId = `${providerId}:${modelId}`;
  const profile = useMemo(() => resolveModelContextProfile(modelId, providerId,
    settings.modelContextOverrides, settings.discoveredModelMetadata),
  [modelId, providerId, settings.modelContextOverrides, settings.discoveredModelMetadata]);
  const pricing = useMemo(() => getModelPricing(fullModelId, settings.modelPricingOverrides, settings.discoveredModelMetadata),
    [fullModelId, settings.modelPricingOverrides, settings.discoveredModelMetadata]);
  return <details className="mt-2 rounded-md border p-3 text-sm">
    <summary className="cursor-pointer font-medium">{catalogBacked ? "Advanced Build settings" : "Pricing and context settings"}</summary>
    <div className="mt-3 space-y-3">
      {!catalogBacked && <ModelPricingEditor fullModelId={fullModelId} pricing={pricing} onSaved={onSaved} title="Pricing" />}
      <ModelContextEditor fullModelId={fullModelId} profile={profile} override={settings.modelContextOverrides?.[fullModelId]}
        advancedOnly={catalogBacked} onSaved={onSaved} />
    </div>
  </details>;
}
