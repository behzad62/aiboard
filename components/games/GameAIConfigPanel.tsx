"use client";

import { useId } from "react";
import type { ReasoningEffort } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export interface GameAIModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
}

export interface GameAIConfigValue {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

interface GameAIConfigPanelProps {
  title: string;
  accent: "red" | "yellow" | "white" | "black";
  config: GameAIConfigValue;
  models: GameAIModelOption[];
  onChange: (config: GameAIConfigValue) => void;
}

const REASONING_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: "default", label: "Disabled" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const PANEL_STYLES: Record<GameAIConfigPanelProps["accent"], string> = {
  red: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30",
  yellow:
    "border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-950/30",
  white: "border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-700/50",
  black: "border-gray-400 bg-gray-100 dark:border-gray-500 dark:bg-gray-800/50",
};

const DOT_STYLES: Record<GameAIConfigPanelProps["accent"], string> = {
  red: "border-red-700 bg-red-500",
  yellow: "border-yellow-600 bg-yellow-400",
  white: "border-gray-400 bg-white",
  black: "border-gray-600 bg-gray-900",
};

export function GameAIConfigPanel({
  title,
  accent,
  config,
  models,
  onChange,
}: GameAIConfigPanelProps) {
  const reasoningIndex = REASONING_LEVELS.findIndex(
    (level) => level.value === config.reasoningEffort
  );
  const safeReasoningIndex = reasoningIndex >= 0 ? reasoningIndex : 0;
  const reasoningLabel = REASONING_LEVELS[safeReasoningIndex].label;
  const modelSelectId = useId();
  const reasoningRangeId = useId();

  return (
    <div
      className={cn("rounded-xl border-2 p-4", PANEL_STYLES[accent])}
      data-testid={`ai-config-${accent}`}
    >
      <div className="mb-3 flex items-center gap-2">
        <div
          className={cn("h-4 w-4 rounded-full border-2", DOT_STYLES[accent])}
          aria-hidden="true"
        />
        <span className="font-semibold text-gray-900 dark:text-white">
          {title}
        </span>
      </div>

      <div className="mb-4">
        <label
          htmlFor={modelSelectId}
          className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400"
        >
          Model
        </label>
        <select
          id={modelSelectId}
          value={config.modelId}
          onChange={(event) =>
            onChange({ ...config, modelId: event.target.value })
          }
          className={cn(
            "w-full rounded-lg border p-2 text-sm",
            "border-gray-300 bg-white text-gray-900",
            "focus:border-amber-500 focus:ring-2 focus:ring-amber-500",
            "dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          )}
          data-testid={`model-select-${accent}`}
        >
          {models.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <label
            htmlFor={reasoningRangeId}
            className="text-xs font-medium text-gray-600 dark:text-gray-400"
          >
            Reasoning Level
          </label>
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
            {reasoningLabel}
          </span>
        </div>
        <input
          id={reasoningRangeId}
          type="range"
          min={0}
          max={REASONING_LEVELS.length - 1}
          value={safeReasoningIndex}
          aria-valuetext={reasoningLabel}
          onChange={(event) => {
            const index = Number.parseInt(event.target.value, 10);
            onChange({
              ...config,
              reasoningEffort: REASONING_LEVELS[index].value,
            });
          }}
          className={cn(
            "h-2 w-full cursor-pointer appearance-none rounded-lg",
            "bg-gray-200 dark:bg-gray-600",
            "[&::-webkit-slider-thumb]:h-4",
            "[&::-webkit-slider-thumb]:w-4",
            "[&::-webkit-slider-thumb]:cursor-pointer",
            "[&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-amber-500"
          )}
          data-testid={`reasoning-slider-${accent}`}
        />
        <div className="mt-1 flex justify-between text-[10px] text-gray-400">
          {REASONING_LEVELS.map((level) => (
            <span key={level.value}>{level.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default GameAIConfigPanel;
