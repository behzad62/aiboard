"use client";

import { FileJson } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  BenchmarkEvidenceItem,
  BenchmarkModelScore,
} from "@/lib/benchmark/metrics";

export function BenchmarkEvidencePanel({
  model,
  evidence,
  selectedEvidence,
  onSelectEvidence,
}: {
  model: BenchmarkModelScore | null;
  evidence: BenchmarkEvidenceItem[];
  selectedEvidence: BenchmarkEvidenceItem | null;
  onSelectEvidence: (item: BenchmarkEvidenceItem | null) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Evidence Drilldown</CardTitle>
            <CardDescription>
              Raw records, model responses, retries, fallbacks, and artifacts.
            </CardDescription>
          </div>
          <Badge variant="secondary">{evidence.length}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {!model ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Select a chart point or model row.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-muted-foreground" />
              <div className="font-medium">{model.displayName}</div>
            </div>
            <div className="max-h-56 space-y-2 overflow-auto pr-1">
              {evidence.map((item) => (
                <button
                  key={item.id}
                  className={`block w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60 ${
                    selectedEvidence?.id === item.id ? "bg-muted" : ""
                  }`}
                  onClick={() => onSelectEvidence(item)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.title}</span>
                    <Badge variant="secondary">{item.domain}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.timestamp}
                  </div>
                  <div className="mt-1 text-xs">{item.summary}</div>
                </button>
              ))}
            </div>
            {selectedEvidence && (
              <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                {selectedEvidence.detailsJson}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
