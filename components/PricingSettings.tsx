"use client";

import { ModelPricingEditor } from "@/components/ModelPricingEditor";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Built-in reference rates drive the cost estimates on the dashboard.
        Override any model with your own pricing — overrides are stored locally
        and never leave your machine.
      </p>

      <Tabs defaultValue={providers[0]?.providerId}>
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          {providers.map((provider) => (
            <TabsTrigger key={provider.providerId} value={provider.providerId}>
              {provider.name}
            </TabsTrigger>
          ))}
        </TabsList>

        {providers.map((provider) => (
          <TabsContent
            key={provider.providerId}
            value={provider.providerId}
            className="space-y-4"
          >
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
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
