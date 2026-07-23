"use client";

import { RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  DecisionFilters as DecisionFilterState,
  DecisionRow,
} from "@/lib/benchmark/certified/decision-dashboard";

export const EMPTY_DECISION_FILTERS: DecisionFilterState = {
  query: "",
  track: "all",
  kind: "all",
  provider: "all",
  effort: "all",
  evidence: "all",
};

export function DecisionFilters({
  value,
  rows,
  onChange,
}: {
  value: DecisionFilterState;
  rows: DecisionRow[];
  onChange: (next: DecisionFilterState) => void;
}) {
  const tracks = unique(rows.flatMap((row) => row.tracks));
  const providers = unique(rows.flatMap((row) => row.providerIds ?? []));
  const efforts = unique(rows.flatMap((row) => row.reasoningEfforts ?? []));
  const dirty = JSON.stringify(value) !== JSON.stringify(EMPTY_DECISION_FILTERS);

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.6fr)_repeat(5,minmax(120px,1fr))_auto]">
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Search evidence
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
            <Input
              value={value.query}
              onChange={(event) => onChange({ ...value, query: event.target.value })}
              placeholder="Model, team, or case"
              className="pl-9"
            />
          </span>
        </label>
        <FilterSelect
          label="Track"
          value={value.track}
          options={[{ value: "all", label: "All tracks" }, ...tracks.map(option)]}
          onChange={(track) => onChange({ ...value, track })}
        />
        <FilterSelect
          label="Run type"
          value={value.kind}
          options={[
            { value: "all", label: "Solo + teams" },
            { value: "solo", label: "Solo" },
            { value: "team", label: "Teams" },
          ]}
          onChange={(kind) =>
            onChange({ ...value, kind: kind as DecisionFilterState["kind"] })
          }
        />
        <FilterSelect
          label="Provider"
          value={value.provider}
          options={[
            { value: "all", label: "All providers" },
            ...providers.map(option),
          ]}
          onChange={(provider) => onChange({ ...value, provider })}
          disabled={providers.length === 0}
        />
        <FilterSelect
          label="Reasoning"
          value={value.effort}
          options={[
            { value: "all", label: "All efforts" },
            ...efforts.map(option),
          ]}
          onChange={(effort) => onChange({ ...value, effort })}
          disabled={efforts.length === 0}
        />
        <FilterSelect
          label="Evidence"
          value={value.evidence}
          options={[
            { value: "all", label: "Any sample size" },
            { value: "mature", label: "Mature" },
            { value: "preliminary", label: "Preliminary" },
          ]}
          onChange={(evidence) =>
            onChange({
              ...value,
              evidence: evidence as DecisionFilterState["evidence"],
            })
          }
        />
        <div className="flex items-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(EMPTY_DECISION_FILTERS)}
            disabled={!dirty}
            className="h-10 w-full xl:w-auto"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function option(value: string): { value: string; label: string } {
  return { value, label: formatOption(value) };
}

function formatOption(value: string): string {
  if (value === "gameiq") return "GameIQ";
  if (value === "teamiq") return "TeamIQ";
  if (value === "workbench") return "WorkBench";
  if (value === "toolreliability") return "Tool Reliability";
  if (value === "harnessbench") return "HarnessBench";
  if (value === "chatgpt") return "ChatGPT";
  if (value === "xhigh") return "Extra high";
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
