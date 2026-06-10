"use client";

import { ModelPricingEditor } from "@/components/ModelPricingEditor";
import {
  getModelPricing,
  type ModelPricingOverride,
} from "@/lib/providers/pricing";
import type { ModelInfo } from "@/lib/providers/base";

interface ProviderModels {
  providerId: string;
  name: string;
  models: ModelInfo[];
}

interface PricingSettingsProps {
  providers: ProviderModels[];
  overrides?: Record<string, ModelPricingOverride>;
  onSaved: () => Promise<void> | void;
}

export function PricingSettings({
  providers,
  overrides,
  onSaved,
}: PricingSettingsProps) {
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Built-in reference rates drive the cost estimates on the dashboard.
        Override any model with your own pricing — overrides are stored locally
        and never leave your machine.
      </p>

      {providers.map((provider) => (
        <section key={provider.providerId} className="space-y-3">
          <h3 className="font-display text-lg font-semibold">{provider.name}</h3>
          <div className="space-y-4">
            {provider.models.map((model) => {
              const fullId = `${provider.providerId}:${model.id}`;
              return (
                <div key={fullId} className="space-y-1.5">
                  <p className="text-sm font-medium">
                    {model.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {fullId}
                    </span>
                  </p>
                  <ModelPricingEditor
                    fullModelId={fullId}
                    pricing={getModelPricing(fullId, overrides)}
                    onSaved={onSaved}
                    title="Pricing"
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
