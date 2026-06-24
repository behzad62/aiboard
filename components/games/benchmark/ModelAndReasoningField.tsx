"use client";

import type { ReasoningEffort } from "@/lib/db/schema";
import type { AvailableBenchmarkModel } from "./types";
import { REASONING_LEVELS } from "./types";

export function ModelAndReasoningField({
  label,
  modelId,
  models,
  onModelChange,
  onReasoningChange,
  reasoning,
  running,
}: {
  label: string;
  modelId: string;
  models: AvailableBenchmarkModel[];
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningEffort) => void;
  reasoning: ReasoningEffort;
  running: boolean;
}) {
  const reasoningIndex = Math.max(
    0,
    REASONING_LEVELS.findIndex((level) => level.value === reasoning)
  );
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-sm font-medium">{label} Model</label>
        <select
          value={modelId}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={running}
          className="w-full rounded-md border bg-background px-3 py-2 text-foreground disabled:opacity-50"
        >
          {models.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">
          {label} Reasoning: {REASONING_LEVELS[reasoningIndex].label}
        </label>
        <input
          type="range"
          min={0}
          max={REASONING_LEVELS.length - 1}
          value={reasoningIndex}
          onChange={(event) =>
            onReasoningChange(REASONING_LEVELS[Number(event.target.value)].value)
          }
          disabled={running}
          className="w-full"
        />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          {REASONING_LEVELS.map((level) => (
            <span key={level.value}>{level.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
