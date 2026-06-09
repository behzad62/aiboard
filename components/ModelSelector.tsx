"use client";

import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/providers/base";
import type { CapabilityInputType } from "@/lib/attachments/types";
import { getUnsupportedTypes } from "@/lib/providers/capabilities";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ModelSelectorProps {
  models: ModelInfo[];
  selected: string[];
  onChange: (selected: string[]) => void;
  requiredInputTypes?: CapabilityInputType[];
}

function formatUnsupported(types: CapabilityInputType[]): string {
  return types.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(", ");
}

export function ModelSelector({
  models,
  selected,
  onChange,
  requiredInputTypes = [],
}: ModelSelectorProps) {
  const toggle = (fullId: string, disabled: boolean) => {
    if (disabled) return;
    if (selected.includes(fullId)) {
      onChange(selected.filter((id) => id !== fullId));
    } else {
      onChange([...selected, fullId]);
    }
  };

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        No models available. Add API keys in Settings first.
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        <Label>
          Participating models ({selected.length} selected)
          {requiredInputTypes.length > 0 && (
            <span className="ml-2 font-normal text-muted-foreground">
              · Requires: {formatUnsupported(requiredInputTypes)}
            </span>
          )}
        </Label>
        <div className="flex flex-wrap gap-2">
          {models.map((model) => {
            const fullId = `${model.providerId}:${model.id}`;
            const isSelected = selected.includes(fullId);
            const unsupported = getUnsupportedTypes(fullId, requiredInputTypes);
            const disabled = unsupported.length > 0;

            const button = (
              <button
                key={fullId}
                type="button"
                disabled={disabled}
                onClick={() => toggle(fullId, disabled)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm transition-colors",
                  disabled &&
                    "cursor-not-allowed border-border/50 bg-muted/50 text-muted-foreground opacity-60",
                  !disabled && isSelected &&
                    "border-primary bg-primary text-primary-foreground",
                  !disabled && !isSelected &&
                    "border-border bg-background hover:bg-accent"
                )}
              >
                {model.name}
                <span className="ml-2 text-xs opacity-70">{model.providerId}</span>
                {disabled && (
                  <span className="ml-2 text-xs">(unsupported)</span>
                )}
              </button>
            );

            if (!disabled) return button;

            return (
              <Tooltip key={fullId}>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent>
                  Does not support: {formatUnsupported(unsupported)}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
