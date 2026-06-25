"use client";

import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/providers/base";
import {
  formatContextWindowTokens,
  type ModelContextProfile,
} from "@/lib/providers/model-context";
import type { CapabilityInputType } from "@/lib/attachments/types";
import { unsupportedInputTypes } from "@/lib/providers/capabilities";
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

export function formatModelContextIndicator(
  profile: ModelContextProfile
): string {
  const context = `${formatContextWindowTokens(profile.contextWindowTokens)} ctx`;
  return profile.buildOutputReserveTokens
    ? `${context} / ${formatContextWindowTokens(
        profile.buildOutputReserveTokens
      )} reserve`
    : context;
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
            const unsupported = unsupportedInputTypes(
              model.capabilities,
              requiredInputTypes
            );
            const disabled = unsupported.length > 0;
            const contextIndicator = model.contextProfile
              ? formatModelContextIndicator(model.contextProfile)
              : null;

            const button = (
              <button
                key={fullId}
                type="button"
                disabled={disabled}
                onClick={() => toggle(fullId, disabled)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors",
                  disabled &&
                    "cursor-not-allowed border-border/50 bg-muted/50 text-muted-foreground opacity-60",
                  !disabled && isSelected &&
                    "border-primary bg-primary text-primary-foreground",
                  !disabled && !isSelected &&
                    "border-border bg-background hover:bg-accent"
                )}
              >
                <span>{model.name}</span>
                <span className="text-xs opacity-70">{model.providerId}</span>
                {contextIndicator && (
                  <span className="rounded-full border border-current/20 px-1.5 py-0.5 text-[11px] leading-none opacity-80">
                    {contextIndicator}
                  </span>
                )}
                {disabled && (
                  <span className="text-xs">(unsupported)</span>
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
