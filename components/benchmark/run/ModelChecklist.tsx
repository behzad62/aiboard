"use client";

import type { SelectedModel } from "@/lib/providers/base";
import { migrateFullModelId } from "@/lib/providers/model-id-migration";
import {
  normalizeBenchmarkReasoningEffort,
  type BenchmarkModelEffortMap,
} from "@/lib/benchmark/model-effort";
import type { ReasoningEffort } from "@/lib/db/schema";
import { ModelEffortSelect } from "./ModelEffortSelect";

// Promoted from CertifiedRunPanel's GameIqModelChecklist (2026-07-17 benchmark
// UX overhaul, Task 4 Step 4) into the ONE model-selection widget used for
// every preset on the Run tab. Selection persistence lives here (helpers
// below) so any caller can read/write the same localStorage-backed list; the
// panel owns the actual React state and calls these at the right points
// (initial read, and on every change) rather than this component reaching
// into localStorage itself, keeping it a plain presentational component like
// TeamCompositionBuilder.
const MODEL_CHECKLIST_STORAGE_KEY = "aiboard:benchmark:run:model-checklist";

export interface PersistedBenchmarkModelSelectionV2 {
  version: 2;
  selectedModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
}

export interface BenchmarkModelChecklistConfig {
  selectedModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
}

const EMPTY_MODEL_CHECKLIST_CONFIG: BenchmarkModelChecklistConfig = {
  selectedModelIds: [],
  effortByModelId: {},
};

export function readPersistedModelChecklistConfig(): BenchmarkModelChecklistConfig {
  if (typeof window === "undefined") return EMPTY_MODEL_CHECKLIST_CONFIG;
  try {
    const raw = window.localStorage.getItem(MODEL_CHECKLIST_STORAGE_KEY);
    if (!raw) return EMPTY_MODEL_CHECKLIST_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const selectedModelIds = parsed
        .filter((id): id is string => typeof id === "string")
        .map(migrateFullModelId);
      const migrated = {
        selectedModelIds,
        effortByModelId: Object.fromEntries(
          selectedModelIds.map((modelId) => [modelId, "default"])
        ) as BenchmarkModelEffortMap,
      };
      persistModelChecklistConfig(migrated);
      return migrated;
    }
    if (!isPersistedBenchmarkModelSelectionV2(parsed)) {
      return EMPTY_MODEL_CHECKLIST_CONFIG;
    }
    const normalized = normalizePersistedModelChecklistConfig(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify({ version: 2, ...normalized })) {
      persistModelChecklistConfig(normalized);
    }
    return normalized;
  } catch {
    return EMPTY_MODEL_CHECKLIST_CONFIG;
  }
}

export function readPersistedModelChecklistSelection(): string[] {
  return readPersistedModelChecklistConfig().selectedModelIds;
}

export function persistModelChecklistConfig(
  config: BenchmarkModelChecklistConfig
): void {
  if (typeof window === "undefined") return;
  try {
    const normalized = normalizePersistedModelChecklistConfig({
      version: 2,
      ...config,
    });
    const persisted: PersistedBenchmarkModelSelectionV2 = {
      version: 2,
      ...normalized,
    };
    window.localStorage.setItem(
      MODEL_CHECKLIST_STORAGE_KEY,
      JSON.stringify(persisted)
    );
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

export function persistModelChecklistSelection(modelIds: string[]): void {
  persistModelChecklistConfig({
    selectedModelIds: modelIds,
    effortByModelId: Object.fromEntries(
      modelIds.map((modelId) => [modelId, "default"])
    ) as BenchmarkModelEffortMap,
  });
}

export function ModelChecklist({
  models,
  selectedModelIds,
  effortByModelId,
  onChange,
  onEffortChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
  onChange: (modelIds: string[]) => void;
  onEffortChange: (modelId: string, effort: ReasoningEffort) => void;
}) {
  if (models.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        Add and enable at least one provider model in Settings to run a
        benchmark.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-3">
        {models.map((model) => {
          const checked = selectedModelIds.includes(model.modelId);
          return (
            <div
              key={model.modelId}
              className={`grid min-h-16 gap-2 rounded-md border px-3 py-2 text-sm ${
                checked ? "border-primary bg-primary/5" : "bg-card"
              }`}
            >
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={checked}
                  onChange={(event) => {
                    if (event.target.checked) {
                      onChange([...selectedModelIds, model.modelId]);
                    } else {
                      onChange(
                        selectedModelIds.filter((id) => id !== model.modelId)
                      );
                    }
                  }}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {model.displayName || model.modelId}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {model.providerId}
                  </span>
                </span>
              </label>
              {checked && (
                <ModelEffortSelect
                  model={model}
                  value={effortByModelId[model.modelId] ?? "default"}
                  onChange={(effort) => onEffortChange(model.modelId, effort)}
                  compact
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedModelIds.length === 0
          ? "Select at least one model. Every preset below runs against this checklist."
          : `${selectedModelIds.length} model${
              selectedModelIds.length === 1 ? "" : "s"
            } selected. Every preset below runs against this checklist.`}
      </p>
    </div>
  );
}

function isPersistedBenchmarkModelSelectionV2(
  value: unknown
): value is PersistedBenchmarkModelSelectionV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedBenchmarkModelSelectionV2>;
  return (
    candidate.version === 2 &&
    Array.isArray(candidate.selectedModelIds) &&
    Boolean(candidate.effortByModelId) &&
    typeof candidate.effortByModelId === "object" &&
    !Array.isArray(candidate.effortByModelId)
  );
}

function normalizePersistedModelChecklistConfig(
  config: PersistedBenchmarkModelSelectionV2
): BenchmarkModelChecklistConfig {
  const selectedModelIds = config.selectedModelIds
    .filter((id): id is string => typeof id === "string")
    .map(migrateFullModelId);
  const effortByModelId: BenchmarkModelEffortMap = {};
  for (const [modelId, effort] of Object.entries(config.effortByModelId)) {
    effortByModelId[migrateFullModelId(modelId)] =
      normalizeBenchmarkReasoningEffort(effort);
  }
  for (const modelId of selectedModelIds) {
    effortByModelId[modelId] ??= "default";
  }
  return { selectedModelIds, effortByModelId };
}
