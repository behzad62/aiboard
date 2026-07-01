"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkModelScore } from "@/lib/benchmark/metrics";
import { duration, pct, shortModel, usd } from "@/components/benchmark/format";

export function BenchmarkModelScorecards({
  models,
  selectedModelId,
  onSelect,
}: {
  models: BenchmarkModelScore[];
  selectedModelId: string | null;
  onSelect: (model: BenchmarkModelScore) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Scorecards</CardTitle>
        <CardDescription>Select a row to inspect the evidence behind it.</CardDescription>
      </CardHeader>
      <CardContent>
        {models.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 text-left">Model</th>
                  <th className="py-2 text-right">Architect-reviewed quality</th>
                  <th className="py-2 text-right">Win</th>
                  <th className="py-2 text-right">Legal</th>
                  <th className="py-2 text-right">Schema</th>
                  <th className="py-2 text-right">Verifier</th>
                  <th className="py-2 text-right">Cost</th>
                  <th className="py-2 text-right">Latency</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr
                    key={model.modelId}
                    tabIndex={0}
                    role="button"
                    aria-pressed={selectedModelId === model.modelId}
                    className={`cursor-pointer border-b hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring ${
                      selectedModelId === model.modelId ? "bg-muted" : ""
                    }`}
                    onClick={() => onSelect(model)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(model);
                      }
                    }}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{model.displayName}</div>
                      <div className="text-xs text-muted-foreground">
                        {shortModel(model.modelId)}
                      </div>
                    </td>
                    <td className="py-2 text-right font-semibold">
                      {model.qualityScore}
                    </td>
                    <td className="py-2 text-right">{pct(model.winRate)}</td>
                    <td className="py-2 text-right">{pct(model.legalActionRate)}</td>
                    <td className="py-2 text-right">{pct(model.schemaValidRate)}</td>
                    <td className="py-2 text-right">{pct(model.verifierPassRate)}</td>
                    <td className="py-2 text-right">{usd(model.averageCostUsd)}</td>
                    <td className="py-2 text-right">
                      {duration(model.averageLatencyMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No model evidence yet. Run AI-vs-AI games or save Build cases.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
