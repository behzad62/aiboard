"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ClipboardCopy,
  Download,
  FileJson,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ensureReady } from "@/lib/client/api";
import {
  getBenchmarkCases,
  getBenchmarkFailures,
  getBenchmarkMetricValues,
  getBenchmarkRuns,
  getBenchmarkSuites,
  getBenchmarkTraces,
  getBuildCheckpoints,
  getGenericGameMatchRecords,
  getModelStats,
} from "@/lib/client/store";
import {
  buildBenchmarkDashboardData,
  type BenchmarkDashboardData,
  type BenchmarkEvidenceItem,
  type BenchmarkModelScore,
} from "@/lib/benchmark/metrics";
import {
  exportBenchmarkReportBundle,
  importBenchmarkReportBundle,
} from "@/lib/benchmark/store";
import {
  downloadBenchmarkJson,
  downloadBenchmarkMarkdown,
  formatBenchmarkMarkdownReport,
} from "@/lib/benchmark/reports";
import type { BenchmarkReportBundle } from "@/lib/benchmark/types";

const CHART_COLORS = [
  "#38bdf8",
  "#f59e0b",
  "#22c55e",
  "#a78bfa",
  "#ef4444",
  "#14b8a6",
];

function pct(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value * 100)}%`;
}

function compactPct(value: number): string {
  return `${Math.round(value)}%`;
}

function usd(value: number | null): string {
  return value == null ? "n/a" : `$${value.toFixed(3)}`;
}

function duration(value: number | null): string {
  if (value == null) return "n/a";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function shortModel(modelId: string): string {
  const parts = modelId.split(":");
  return parts[parts.length - 1] || modelId;
}

function readBundle(value: unknown): BenchmarkReportBundle {
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark import must be a JSON object.");
  }
  const bundle = value as Partial<BenchmarkReportBundle>;
  if (
    bundle.version !== 1 ||
    !Array.isArray(bundle.suites) ||
    !Array.isArray(bundle.runs) ||
    !Array.isArray(bundle.cases) ||
    !Array.isArray(bundle.attempts) ||
    !Array.isArray(bundle.metricValues) ||
    !Array.isArray(bundle.artifacts) ||
    !Array.isArray(bundle.failures) ||
    !Array.isArray(bundle.traces)
  ) {
    throw new Error("File is not an AI Board benchmark report bundle.");
  }
  return bundle as BenchmarkReportBundle;
}

function modelIdFromChartClick(value: unknown): string | null {
  const payload = (value as { activePayload?: Array<{ payload?: { modelId?: unknown } }> })
    ?.activePayload?.[0]?.payload?.modelId;
  return typeof payload === "string" && payload.length > 0 ? payload : null;
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {label}
    </div>
  );
}

export function BenchmarkLab() {
  const [dashboard, setDashboard] = useState<BenchmarkDashboardData | null>(null);
  const [locked, setLocked] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] =
    useState<BenchmarkEvidenceItem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const ready = await ensureReady();
    if (ready.needsPassphrase) {
      setLocked(true);
      setDashboard(null);
      return;
    }
    setLocked(false);
    setDashboard(
      buildBenchmarkDashboardData({
        gameMatches: [...getGenericGameMatchRecords()],
        buildStats: getModelStats(),
        buildCheckpoints: [...getBuildCheckpoints()],
        benchmarkRuns: [...getBenchmarkRuns()],
        benchmarkCases: [...getBenchmarkCases()],
        benchmarkMetricValues: [...getBenchmarkMetricValues()],
        benchmarkFailures: [...getBenchmarkFailures()],
      })
    );
  }, []);

  useEffect(() => {
    void load().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [load]);

  const selectedModel = useMemo(
    () => dashboard?.models.find((model) => model.modelId === selectedModelId) ?? null,
    [dashboard, selectedModelId]
  );
  const selectedEvidenceList = selectedModelId
    ? dashboard?.evidenceByModel[selectedModelId] ?? []
    : [];

  const exportJson = () => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundle();
    downloadBenchmarkJson(bundle);
    setMessage("Benchmark JSON exported.");
  };

  const exportMarkdown = async () => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundle();
    const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);
    downloadBenchmarkMarkdown(markdown);
    await navigator.clipboard.writeText(markdown);
    setMessage("Benchmark report downloaded and copied to clipboard.");
  };

  const importJson = async (file: File) => {
    const text = await file.text();
    const bundle = readBundle(JSON.parse(text));
    await importBenchmarkReportBundle(bundle);
    await load();
    setMessage(`Imported ${bundle.runs.length} run(s) and ${bundle.cases.length} case(s).`);
  };

  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark Lab</CardTitle>
          <CardDescription>Unlock storage to load benchmark reports.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!dashboard) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark Lab</CardTitle>
          <CardDescription>Loading benchmark evidence...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Benchmark Lab</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Local-first model scorecards from game matches, Build-mode results,
            saved benchmark cases, raw failures, and imported reports.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportMarkdown}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy report
          </Button>
          <Button variant="outline" size="sm" onClick={exportJson}>
            <Download className="mr-2 h-4 w-4" />
            Export JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Import
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) {
                void importJson(file).catch((error) => {
                  setMessage(error instanceof Error ? error.message : String(error));
                });
              }
            }}
          />
        </div>
      </div>

      {message && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {message}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        <SummaryCard label="Runs" value={String(dashboard.summary.totalRuns)} />
        <SummaryCard label="Cases" value={String(dashboard.summary.totalCases)} />
        <SummaryCard label="Models" value={String(dashboard.summary.totalModels)} />
        <SummaryCard
          label="Completion"
          value={pct(dashboard.summary.completionRate)}
        />
        <SummaryCard
          label="Schema valid"
          value={pct(dashboard.summary.schemaValidRate)}
        />
        <SummaryCard
          label="Legal actions"
          value={pct(dashboard.summary.legalActionRate)}
        />
        <SummaryCard
          label="Fallback"
          value={pct(dashboard.summary.fallbackRate)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Avg cost" value={usd(dashboard.summary.averageCostUsd)} />
        <SummaryCard
          label="Avg latency"
          value={duration(dashboard.summary.averageLatencyMs)}
        />
        <SummaryCard
          label="Saved suites"
          value={String(getBenchmarkSuites().length)}
        />
        <SummaryCard
          label="Raw traces"
          value={String(getBenchmarkTraces().length)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Capability Profile</CardTitle>
            <CardDescription>
              Multi-axis scorecard. Higher is better on every axis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.models.length > 0 ? (
              <div className="h-[320px]">
                <ResponsiveContainer>
                  <RadarChart data={dashboard.radarRows}>
                    <PolarGrid />
                    <PolarAngleAxis dataKey="axis" />
                    <Tooltip />
                    <Legend />
                    {dashboard.models.slice(0, 4).map((model, index) => (
                      <Radar
                        key={model.modelId}
                        name={model.displayName}
                        dataKey={model.displayName}
                        stroke={CHART_COLORS[index % CHART_COLORS.length]}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                        fillOpacity={0.16}
                      />
                    ))}
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyChart label="Run games or save Build cases to populate profile data." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reliability Rates</CardTitle>
            <CardDescription>
              Win, legality, schema, fallback, and verifier signals by model.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.rateBars.length > 0 ? (
              <div className="h-[320px]">
                <ResponsiveContainer>
                  <BarChart
                    data={dashboard.rateBars}
                    onClick={(event) => {
                      const modelId = modelIdFromChartClick(event);
                      if (modelId) setSelectedModelId(modelId);
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="displayName" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={compactPct} domain={[0, 100]} />
                    <Tooltip formatter={(value) => `${value}%`} />
                    <Legend />
                    <Bar dataKey="winRate" name="Win" fill="#22c55e" />
                    <Bar dataKey="legalActionRate" name="Legal" fill="#38bdf8" />
                    <Bar dataKey="schemaValidRate" name="Schema" fill="#a78bfa" />
                    <Bar dataKey="fallbackRate" name="Fallback" fill="#f59e0b" />
                    <Bar dataKey="verifierPassRate" name="Verifier" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyChart label="No model rates available yet." />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ScatterPanel
          title="Quality vs Cost"
          description="Use this to find cheap models that still perform well."
          data={dashboard.costQualityPoints}
          xKey="cost"
          xLabel="Average USD"
          onSelect={setSelectedModelId}
        />
        <ScatterPanel
          title="Quality vs Latency"
          description="Use this to find models that are both strong and responsive."
          data={dashboard.latencyQualityPoints}
          xKey="latency"
          xLabel="Average latency ms"
          onSelect={setSelectedModelId}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Performance Over Time</CardTitle>
            <CardDescription>Game and Build evidence grouped by day.</CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.trendRows.length > 0 ? (
              <div className="h-[280px]">
                <ResponsiveContainer>
                  <LineChart data={dashboard.trendRows}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 100]} />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="games"
                      name="Games"
                      stroke="#38bdf8"
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="buildAttempts"
                      name="Build attempts"
                      stroke="#f59e0b"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="quality"
                      name="Quality"
                      stroke="#22c55e"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyChart label="No dated benchmark evidence yet." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Failure Categories</CardTitle>
            <CardDescription>
              Provider, parser, rules, tool, verifier, and uncategorized issues.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.failureRows.length > 0 ? (
              <div className="h-[280px]">
                <ResponsiveContainer>
                  <BarChart
                    data={dashboard.failureRows}
                    onClick={(event) => {
                      const modelId = modelIdFromChartClick(event);
                      if (modelId && modelId !== "unknown") {
                        setSelectedModelId(modelId);
                      }
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="displayName" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="provider" stackId="failures" fill="#ef4444" />
                    <Bar dataKey="parser" stackId="failures" fill="#a78bfa" />
                    <Bar dataKey="rules" stackId="failures" fill="#f59e0b" />
                    <Bar dataKey="tool" stackId="failures" fill="#38bdf8" />
                    <Bar dataKey="verifier" stackId="failures" fill="#22c55e" />
                    <Bar dataKey="other" stackId="failures" fill="#64748b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyChart label="No categorized failures recorded." />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <ModelTable
          models={dashboard.models}
          selectedModelId={selectedModelId}
          onSelect={(model) => {
            setSelectedModelId(model.modelId);
            setSelectedEvidence(null);
          }}
        />
        <EvidencePanel
          model={selectedModel}
          evidence={selectedEvidenceList}
          selectedEvidence={selectedEvidence}
          onSelectEvidence={setSelectedEvidence}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Model vs Model Outcomes</CardTitle>
          <CardDescription>
            Head-to-head game outcomes. Use mirrored roles before treating these
            as stable ratings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dashboard.headToHeadRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-2 text-left">Model A</th>
                    <th className="py-2 text-left">Model B</th>
                    <th className="py-2 text-right">A wins</th>
                    <th className="py-2 text-right">B wins</th>
                    <th className="py-2 text-right">Draws</th>
                    <th className="py-2 text-right">Games</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.headToHeadRows.map((row) => (
                    <tr key={`${row.modelA}:${row.modelB}`} className="border-b">
                      <td className="py-2">{row.modelADisplay}</td>
                      <td className="py-2">{row.modelBDisplay}</td>
                      <td className="py-2 text-right">{row.modelAWins}</td>
                      <td className="py-2 text-right">{row.modelBWins}</td>
                      <td className="py-2 text-right">{row.draws}</td>
                      <td className="py-2 text-right">{row.games}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No head-to-head game outcomes recorded yet.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ScatterPanel({
  title,
  description,
  data,
  xKey,
  xLabel,
  onSelect,
}: {
  title: string;
  description: string;
  data: Array<{
    modelId: string;
    displayName: string;
    quality: number;
    cost?: number;
    latency?: number;
  }>;
  xKey: "cost" | "latency";
  xLabel: string;
  onSelect: (modelId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={xKey} name={xLabel} type="number" />
                <YAxis dataKey="quality" name="Quality" type="number" domain={[0, 100]} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  formatter={(value, name) => [value, name]}
                  labelFormatter={(_, payload) =>
                    payload?.[0]?.payload?.displayName ?? "Model"
                  }
                />
                <Scatter name={title} data={data} fill="#38bdf8">
                  {data.map((item, index) => (
                    <Cell
                      key={item.modelId}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                      onClick={() => onSelect(item.modelId)}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label={`No ${xLabel.toLowerCase()} samples yet.`} />
        )}
      </CardContent>
    </Card>
  );
}

function ModelTable({
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
        <CardDescription>Click a row to inspect the evidence behind it.</CardDescription>
      </CardHeader>
      <CardContent>
        {models.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 text-left">Model</th>
                  <th className="py-2 text-right">Quality</th>
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
                    className={`cursor-pointer border-b hover:bg-muted/50 ${
                      selectedModelId === model.modelId ? "bg-muted" : ""
                    }`}
                    onClick={() => onSelect(model)}
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
                    <td className="py-2 text-right">
                      {pct(model.legalActionRate)}
                    </td>
                    <td className="py-2 text-right">
                      {pct(model.schemaValidRate)}
                    </td>
                    <td className="py-2 text-right">
                      {pct(model.verifierPassRate)}
                    </td>
                    <td className="py-2 text-right">
                      {usd(model.averageCostUsd)}
                    </td>
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

function EvidencePanel({
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

export default BenchmarkLab;
