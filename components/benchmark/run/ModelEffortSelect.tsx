"use client";

import {
  benchmarkVariantLabel,
  normalizeBenchmarkEffortForModel,
  supportedBenchmarkReasoningEfforts,
} from "@/lib/benchmark/model-effort";
import type { ReasoningEffort } from "@/lib/db/schema";
import type { SelectedModel } from "@/lib/providers/base";

export interface ModelEffortSelectProps {
  model: SelectedModel;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  compact?: boolean;
}

export function ModelEffortSelect({
  model,
  value,
  onChange,
  compact = false,
}: ModelEffortSelectProps) {
  const efforts = supportedBenchmarkReasoningEfforts(model);
  const normalizedValue = normalizeBenchmarkEffortForModel(model, value);
  const displayName = model.displayName || model.modelId;

  return (
    <select
      aria-label={`Reasoning effort for ${displayName}`}
      className={`w-full rounded-md border bg-background px-2 text-sm ${
        compact ? "h-8" : "h-10"
      }`}
      value={normalizedValue}
      disabled={efforts.length === 1}
      onChange={(event) => onChange(event.target.value as ReasoningEffort)}
    >
      {efforts.map((effort) => (
        <option key={effort} value={effort}>
          {effortOptionLabel(displayName, effort)}
        </option>
      ))}
    </select>
  );
}

function effortOptionLabel(
  displayName: string,
  effort: ReasoningEffort
): string {
  const variantLabel = benchmarkVariantLabel(displayName, effort);
  return variantLabel.slice(displayName.length + 3);
}
