"use client";

import type { SelectedModel } from "@/lib/providers/base";

// Promoted from CertifiedRunPanel's GameIqModelChecklist (2026-07-17 benchmark
// UX overhaul, Task 4 Step 4) into the ONE model-selection widget used for
// every preset on the Run tab. Selection persistence lives here (helpers
// below) so any caller can read/write the same localStorage-backed list; the
// panel owns the actual React state and calls these at the right points
// (initial read, and on every change) rather than this component reaching
// into localStorage itself, keeping it a plain presentational component like
// TeamCompositionBuilder.
const MODEL_CHECKLIST_STORAGE_KEY = "aiboard:benchmark:run:model-checklist";

export function readPersistedModelChecklistSelection(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_CHECKLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function persistModelChecklistSelection(modelIds: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MODEL_CHECKLIST_STORAGE_KEY,
      JSON.stringify(modelIds)
    );
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

export function ModelChecklist({
  models,
  selectedModelIds,
  onChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  onChange: (modelIds: string[]) => void;
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
            <label
              key={model.modelId}
              className={`flex min-h-16 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                checked ? "border-primary bg-primary/5" : "bg-card"
              }`}
            >
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
