"use client";

import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import { CapabilityRadarChart } from "@/components/benchmark/CapabilityRadarChart";
import { FailureCategoriesChart } from "@/components/benchmark/FailureCategoriesChart";
import { PerformanceTrendChart } from "@/components/benchmark/PerformanceTrendChart";
import { QualityScatterChart } from "@/components/benchmark/QualityScatterChart";
import { ReliabilityRatesChart } from "@/components/benchmark/ReliabilityRatesChart";

export function BenchmarkCharts({
  dashboard,
  onSelectModel,
}: {
  dashboard: BenchmarkDashboardData;
  onSelectModel: (modelId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <CapabilityRadarChart dashboard={dashboard} />
        <ReliabilityRatesChart dashboard={dashboard} onSelectModel={onSelectModel} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <QualityScatterChart
          title="Quality vs Cost"
          description="Use this to find cheap models that still perform well."
          data={dashboard.costQualityPoints}
          xKey="cost"
          xLabel="Average USD"
          emptyLabel="No average usd samples yet."
          onSelectModel={onSelectModel}
        />
        <QualityScatterChart
          title="Quality vs Latency"
          description="Use this to find models that are both strong and responsive."
          data={dashboard.latencyQualityPoints}
          xKey="latency"
          xLabel="Average latency ms"
          emptyLabel="No average latency ms samples yet."
          onSelectModel={onSelectModel}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <PerformanceTrendChart dashboard={dashboard} />
        <FailureCategoriesChart dashboard={dashboard} onSelectModel={onSelectModel} />
      </div>
    </div>
  );
}
